/**
 * Sender nonce cache — lightweight KV-backed tracking of agent transaction nonces.
 *
 * Prevents wasting sponsor slots on transactions that can't mine:
 * - Stale nonce (already confirmed) → reject before enqueuing
 * - Gap in nonce sequence → accept with warning
 * - Healthy (sequential) → proceed normally
 *
 * Cache builds from data already flowing through the relay — no Hiro queries
 * during normal operation. Cold cache (first-time sender) does one Hiro query.
 */

import { getHiroBaseUrl, getHiroHeaders } from "../utils";

// KV key prefix and TTL
const SENDER_NONCE_KEY_PREFIX = "sender_nonce:";
const SENDER_NONCE_TTL_SECONDS = 86_400; // 24 hours

// In-flight marker key prefix and TTL
const SENDER_INFLIGHT_KEY_PREFIX = "sender_inflight:";
const SENDER_INFLIGHT_TTL_SECONDS = 300; // 5 minutes — self-healing if consumer crashes

/** Timeout for Hiro nonce seed query (ms) */
const HIRO_NONCE_SEED_TIMEOUT_MS = 8_000;

/**
 * Cached sender nonce state.
 */
export interface SenderNonceCache {
  /** Highest nonce seen in a broadcast (mempool or pending) */
  lastSeen: number;
  /** Highest nonce confirmed on-chain */
  lastConfirmed: number;
  /** Txid of the most recent broadcast for this sender */
  lastTxid?: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Result of checking a sender's nonce against the cache.
 */
export type SenderNonceCheckResult =
  | {
      outcome: "healthy";
      provided: number;
      expected: number;
    }
  | {
      outcome: "stale";
      provided: number;
      lastConfirmed: number;
      currentNonce: number;
      help: string;
      action: string;
    }
  | {
      outcome: "gap";
      provided: number;
      expected: number;
      lastSeen: number;
      help: string;
      action: string;
    }
  | {
      outcome: "duplicate";
      provided: number;
      lastSeen: number;
    }
  | {
      outcome: "unknown";
      provided: number;
    };

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

function senderNonceKey(signerHash: string): string {
  return `${SENDER_NONCE_KEY_PREFIX}${signerHash}`;
}

function inFlightKey(signerHash: string, nonce: number): string {
  return `${SENDER_INFLIGHT_KEY_PREFIX}${signerHash}:${nonce}`;
}

// ---------------------------------------------------------------------------
// In-flight marker helpers
// ---------------------------------------------------------------------------

/**
 * Write a short-lived KV marker indicating this sender/nonce is in-flight.
 * Called at RPC acceptance time, before the payment is enqueued.
 * TTL of 5 minutes is self-healing: if the queue consumer crashes without
 * calling clearInFlight, the marker expires automatically.
 */
export async function markInFlight(
  kv: KVNamespace,
  signerHash: string,
  nonce: number
): Promise<void> {
  await kv.put(inFlightKey(signerHash, nonce), "1", {
    expirationTtl: SENDER_INFLIGHT_TTL_SECONDS,
  });
}

/**
 * Delete the in-flight marker for a sender/nonce.
 * Called by the queue consumer after broadcast succeeds or a terminal failure occurs.
 */
export async function clearInFlight(
  kv: KVNamespace,
  signerHash: string,
  nonce: number
): Promise<void> {
  await kv.delete(inFlightKey(signerHash, nonce));
}

async function getCache(
  kv: KVNamespace,
  signerHash: string
): Promise<SenderNonceCache | null> {
  const raw = await kv.get(senderNonceKey(signerHash), "text");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SenderNonceCache;
  } catch {
    return null;
  }
}

async function putCache(
  kv: KVNamespace,
  signerHash: string,
  cache: SenderNonceCache
): Promise<void> {
  await kv.put(senderNonceKey(signerHash), JSON.stringify(cache), {
    expirationTtl: SENDER_NONCE_TTL_SECONDS,
  });
}

/**
 * Build the Hiro nonce help URL for a given Stacks address.
 * Uses mainnet URL as a reference — testnet agents can swap the base URL.
 */
export function hiroNonceUrl(
  address: string,
  network: "mainnet" | "testnet" = "mainnet"
): string {
  const base = getHiroBaseUrl(network);
  return `${base}/extended/v1/address/${address}/nonces`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a sender's nonce against the KV cache.
 *
 * @param kv - RELAY_KV namespace
 * @param signerHash - Sender's hash160 hex (from tx.auth.spendingCondition.signer)
 * @param providedNonce - Nonce from the sender's transaction
 * @param senderAddress - Human-readable Stacks address (for help URLs)
 * @param network - Network for help URL generation (default: mainnet)
 */
export async function checkSenderNonce(
  kv: KVNamespace,
  signerHash: string,
  providedNonce: number,
  senderAddress: string,
  network: "mainnet" | "testnet" = "mainnet"
): Promise<SenderNonceCheckResult> {
  const cache = await getCache(kv, signerHash);

  if (!cache) {
    return { outcome: "unknown", provided: providedNonce };
  }

  const help = hiroNonceUrl(senderAddress, network);

  // Stale: nonce already confirmed on-chain
  if (providedNonce <= cache.lastConfirmed) {
    return {
      outcome: "stale",
      provided: providedNonce,
      lastConfirmed: cache.lastConfirmed,
      currentNonce: cache.lastConfirmed + 1,
      help,
      action: `Re-sign your transaction with nonce ${cache.lastConfirmed + 1} and resubmit.`,
    };
  }

  // In-flight marker: a concurrent RPC request already accepted this nonce but
  // the queue consumer hasn't broadcast yet (and therefore hasn't updated lastSeen).
  // Reject to prevent duplicate transactions reaching the queue.
  const inFlight = await kv.get(inFlightKey(signerHash, providedNonce), "text");
  if (inFlight !== null) {
    return {
      outcome: "duplicate",
      provided: providedNonce,
      lastSeen: providedNonce,
    };
  }

  // Duplicate: same nonce as last seen (might be dedup)
  if (providedNonce === cache.lastSeen) {
    return {
      outcome: "duplicate",
      provided: providedNonce,
      lastSeen: cache.lastSeen,
    };
  }

  const expected = cache.lastSeen + 1;

  // Out-of-order: nonce is between lastConfirmed and lastSeen (already in-flight)
  if (providedNonce < expected) {
    return {
      outcome: "stale",
      provided: providedNonce,
      lastConfirmed: cache.lastConfirmed,
      currentNonce: expected,
      help,
      action: `Nonce ${providedNonce} is already in-flight. Re-sign with nonce ${expected} and resubmit.`,
    };
  }

  // Gap: nonce is more than 1 ahead of last seen
  if (providedNonce > expected) {
    return {
      outcome: "gap",
      provided: providedNonce,
      expected,
      lastSeen: cache.lastSeen,
      help,
      action: `Submit a transaction with nonce ${expected} to unblock, or wait for mempool expiry (~42 hours).`,
    };
  }

  // Healthy: nonce is exactly the next expected
  return {
    outcome: "healthy",
    provided: providedNonce,
    expected,
  };
}

/**
 * Update the sender nonce cache after a successful broadcast.
 * Sets lastSeen = max(lastSeen, nonce).
 */
export async function updateSenderNonceOnBroadcast(
  kv: KVNamespace,
  signerHash: string,
  nonce: number,
  txid: string
): Promise<void> {
  const existing = await getCache(kv, signerHash);
  const cache: SenderNonceCache = existing ?? {
    lastSeen: -1,
    lastConfirmed: -1,
    updatedAt: "",
  };

  cache.lastSeen = Math.max(cache.lastSeen, nonce);
  cache.lastTxid = txid;
  cache.updatedAt = new Date().toISOString();

  await putCache(kv, signerHash, cache);
}

/**
 * Update the sender nonce cache after on-chain confirmation.
 * Sets lastConfirmed = max(lastConfirmed, nonce).
 * Called by chainhook webhook (Phase 2).
 */
export async function updateSenderNonceOnConfirm(
  kv: KVNamespace,
  signerHash: string,
  nonce: number
): Promise<void> {
  const existing = await getCache(kv, signerHash);
  const cache: SenderNonceCache = existing ?? {
    lastSeen: -1,
    lastConfirmed: -1,
    updatedAt: "",
  };

  cache.lastConfirmed = Math.max(cache.lastConfirmed, nonce);
  // Also update lastSeen if confirmation reveals a higher nonce
  cache.lastSeen = Math.max(cache.lastSeen, nonce);
  cache.updatedAt = new Date().toISOString();

  await putCache(kv, signerHash, cache);
}

/**
 * Seed the sender nonce cache from Hiro API for a cold (first-contact) sender.
 * Makes one HTTP request to Hiro. Returns the seeded cache or null on failure.
 */
export async function seedSenderNonceFromHiro(
  kv: KVNamespace,
  signerHash: string,
  senderAddress: string,
  network: "mainnet" | "testnet",
  hiroApiKey?: string
): Promise<SenderNonceCache | null> {
  const baseUrl = getHiroBaseUrl(network);
  const url = `${baseUrl}/extended/v1/address/${senderAddress}/nonces`;
  const headers = getHiroHeaders(hiroApiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HIRO_NONCE_SEED_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      last_executed_tx_nonce: number | null;
      possible_next_nonce: number;
      detected_missing_nonces?: number[];
    };

    const lastConfirmed = data.last_executed_tx_nonce ?? -1;
    // possible_next_nonce accounts for pending txs in mempool
    const lastSeen = Math.max(lastConfirmed, data.possible_next_nonce - 1);

    const cache: SenderNonceCache = {
      lastSeen,
      lastConfirmed,
      updatedAt: new Date().toISOString(),
    };

    await putCache(kv, signerHash, cache);
    return cache;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
