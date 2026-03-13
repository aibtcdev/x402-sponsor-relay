import {
  makeSTXTokenTransfer,
  broadcastTransaction,
} from "@stacks/transactions";
import { generateNewAccount, generateWallet } from "@stacks/wallet-sdk";
import type { Env, LogsRPC } from "../types";
import { getHiroBaseUrl, getHiroHeaders } from "../utils";

const APP_ID = "x402-relay";

/**
 * Type guard to check if LOGS binding has the required RPC methods.
 * Mirrors the same guard in src/middleware/logger.ts for use in Durable Objects.
 */
function isLogsRPC(logs: unknown): logs is LogsRPC {
  return (
    typeof logs === "object" &&
    logs !== null &&
    typeof (logs as LogsRPC).info === "function" &&
    typeof (logs as LogsRPC).warn === "function" &&
    typeof (logs as LogsRPC).error === "function" &&
    typeof (logs as LogsRPC).debug === "function"
  );
}

interface AssignNonceRequest {
  sponsorAddress: string;
  /** Number of wallets in rotation (default: 1). Controls round-robin range. */
  walletCount?: number;
  /** Per-wallet sponsor addresses for multi-wallet mode.
   *  Map of walletIndex (as string key) → Stacks address.
   *  Required when walletCount > 1 so each wallet pool seeds from its own on-chain nonce. */
  addresses?: Record<string, string>;
}

interface AssignNonceResponse {
  nonce: number;
  /** Index of the wallet that was assigned this nonce (0-based) */
  walletIndex: number;
  /** Sponsor address echoed back for convenience */
  sponsorAddress: string;
  /** Total reserved nonces across all wallets at time of assignment (pool pressure signal) */
  totalReserved: number;
}

interface RecordTxidRequest {
  txid: string;
  nonce: number;
}

interface LookupTxidRequest {
  txid: string;
}

interface LookupTxidResponse {
  found: boolean;
  nonce?: number;
}

interface ReleaseNonceRequest {
  nonce: number;
  txid?: string;
  /** Which wallet pool to release to (default: 0) */
  walletIndex?: number;
  /** Fee paid for this transaction in microSTX (optional, used for cumulative tracking) */
  fee?: string;
}

/**
 * Per-wallet fee statistics (daily + cumulative)
 */
interface WalletFeeStats {
  totalFeesSpent: string;
  txCount: number;
  txCountToday: number;
  feesToday: string;
  /** Cumulative fees paid for gap-fill transactions (microSTX string) */
  gapFillFeesTotal: string;
  /** Number of gap-fill transactions broadcast by the alarm for this wallet */
  gapFillCount: number;
}

/**
 * Full response from Hiro GET /extended/v1/address/{addr}/nonces
 */
interface HiroNonceInfo {
  /** Last confirmed nonce for this address (null if no confirmed txs yet) */
  last_executed_tx_nonce: number | null;
  /** Next nonce the network considers valid for submission */
  possible_next_nonce: number;
  /** Nonces in the mempool that are creating gaps (missing nonces below them) */
  detected_missing_nonces: number[];
}

/** Result of a nonce reconciliation pass (shared by alarm and resync) */
interface ReconcileResult {
  previousNonce: number | null;
  newNonce: number | null;
  changed: boolean;
  reason: string;
}

/**
 * Tracks how many consecutive alarm cycles a specific gap nonce has been stuck.
 * Persisted in DO storage (key: gap_persist:N) so state survives alarm restarts.
 */
interface GapPersistState {
  stuckNonce: number;  // The lowest missing nonce that keeps reappearing
  cycleCount: number;  // Consecutive alarm cycles the gap has been stuck
  firstSeen: string;   // ISO timestamp of first detection
  lastSeen: string;    // ISO timestamp of most recent detection
}

/**
 * Tracks RBF attempts for a specific nonce occupying the mempool beyond the stuck threshold.
 * Persisted in DO storage (key: stuck_tx:{walletIndex}:{nonce}).
 * Prevents infinite RBF fee escalation and enables observability.
 */
interface StuckTxState {
  nonce: number;
  /** txid of the original stuck transaction (if discoverable from mempool API) */
  originalTxid: string | null;
  firstSeen: string;       // ISO timestamp of first stuck detection
  lastSeen: string;        // ISO timestamp of most recent detection
  rbfAttempts: number;     // number of RBF broadcasts sent so far
  lastRbfTxid: string | null;  // txid of the last RBF broadcast
}

/**
 * Parsed entry from Hiro GET /extended/v1/tx/mempool response.
 * Used to detect pending transactions by nonce and age.
 */
interface MempoolTxEntry {
  tx_id: string;
  nonce: number;
  tx_status: string;         // "pending" | other
  receipt_time_iso: string;  // ISO timestamp (Hiro field: receipt_time_iso)
}

/**
 * Reservation pool state — persisted as a single JSON object per wallet.
 * available: nonces ready to be assigned (pre-seeded, sorted ascending)
 * reserved: nonces currently in-flight (assigned but not yet confirmed or released)
 * spent: nonces that were broadcast (txid recorded) and must never be reused.
 *        Once a nonce appears in spent[], it is permanently quarantined from available[].
 * maxNonce: highest nonce ever placed in the pool (used to extend when available runs low)
 * reservedAt: unix ms timestamp of when each nonce was reserved (keyed by nonce as string)
 */
interface PoolState {
  available: number[];
  reserved: number[];
  spent: number[];
  maxNonce: number;
  reservedAt: Record<number, number>;
}

interface WalletPoolStats {
  walletIndex: number;
  available: number;
  reserved: number;
  spent: number;
  maxNonce: number;
  sponsorAddress: string | null;
}

interface NonceStatsResponse {
  totalAssigned: number;
  conflictsDetected: number;
  lastAssignedNonce: number | null;
  lastAssignedAt: string | null;
  nextNonce: number | null;
  txidCount: number;
  /** Number of times the alarm has recovered from a nonce gap */
  gapsRecovered: number;
  /** ISO timestamp of last successful Hiro nonce sync (null if never synced) */
  lastHiroSync: string | null;
  /** ISO timestamp of last gap detection (null if no gaps detected) */
  lastGapDetected: string | null;
  /** Number of gap-fill transactions broadcast by the alarm */
  gapsFilled: number;
  /** Number of nonces currently available in the pool (wallet 0, backward compat) */
  poolAvailable: number;
  /** Number of nonces currently in-flight (wallet 0, backward compat) */
  poolReserved: number;
  /** Maximum allowed concurrent in-flight nonces per wallet */
  chainingLimit: number;
  /** Per-wallet pool state (multi-wallet rotation) */
  wallets: WalletPoolStats[];
  /** Total RBF replacements successfully broadcast for stuck mempool transactions */
  stuckTxRbfBroadcast: number;
  /** Total nonces successfully unstuck via RBF (confirmed after replacement) */
  stuckTxRbfConfirmed: number;
}

/**
 * Maximum number of in-flight nonces allowed concurrently per sponsor wallet.
 * The Stacks node hard-rejects at 25 (TooMuchChaining). We cap at 20 to leave
 * a buffer of 5 for concurrent in-flight requests and gap-fill transactions.
 */
const CHAINING_LIMIT = 20;
/** Initial pool pre-seeds this many nonces ahead of the current head */
const POOL_SEED_SIZE = CHAINING_LIMIT;
/**
 * Maximum allowed lookahead distance beyond Hiro's possible_next_nonce.
 * If pool.maxNonce would exceed hiroNextNonce + LOOKAHEAD_GUARD_BUFFER, we refuse
 * to extend the pool further. This prevents the pool from running so far ahead of
 * confirmed chain state that a resync would discard a large batch of pre-assigned nonces.
 * Set equal to CHAINING_LIMIT (20) — same as the in-flight cap for symmetry.
 */
const LOOKAHEAD_GUARD_BUFFER = CHAINING_LIMIT;

const ALARM_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Alarm interval used when there are in-flight nonces (reserved.length > 0).
 * Fires at 60s so reconciliation catches conflicts during traffic bursts.
 */
const ALARM_INTERVAL_ACTIVE_MS = 60 * 1000;
/**
 * Alarm interval used when all wallets are idle (reserved.length === 0).
 * Reverts to the standard 5-minute cadence to avoid unnecessary Hiro API calls.
 */
const ALARM_INTERVAL_IDLE_MS = ALARM_INTERVAL_MS;
/** Reset to possible_next_nonce if no assignment in this window and we are ahead */
const STALE_THRESHOLD_MS = 10 * 60 * 1000;
/** Maximum number of sponsor wallets supported */
const MAX_WALLET_COUNT = 10;
/** Valid BIP-39 mnemonic word counts */
const VALID_MNEMONIC_LENGTHS = [12, 24];
/** Gap-fill transfer: 1 uSTX (minimal amount to fill a nonce gap) */
const GAP_FILL_AMOUNT = 1n;
/** Gap-fill fee: 30,000 uSTX (high enough for RBF priority) */
const GAP_FILL_FEE = 30_000n;
/** Default recipient for gap-fill self-transfers, per network */
const DEFAULT_FLUSH_RECIPIENT_MAINNET = "SPEB8Z3TAY2130B8M5THXZEQQ4D6S3RMYT37WTAC";
const DEFAULT_FLUSH_RECIPIENT_TESTNET = "STEB8Z3TAY2130B8M5THXZEQQ4D6S3RMYRENN2KB";
/** Maximum number of gap-fill broadcasts per alarm cycle per wallet */
const MAX_GAP_FILLS_PER_ALARM = 5;
/**
 * Age threshold for considering a mempool transaction "stuck" (15 minutes).
 * Transactions that remain pending beyond this window have a very low confirmation
 * probability and are candidates for RBF replacement.
 */
const STUCK_TX_AGE_MS = 15 * 60 * 1000;
/**
 * Fee for RBF replacement self-transfers (90,000 uSTX = 3× GAP_FILL_FEE).
 * Must exceed the original stuck tx fee to guarantee replacement acceptance
 * by the Stacks node's mempool eviction policy.
 */
const RBF_FEE = 90_000n;
/** Maximum RBF broadcast attempts per nonce to prevent runaway fee escalation */
const MAX_RBF_ATTEMPTS = 3;
/**
 * Per-wallet circuit breaker: if a wallet accumulates this many quarantines
 * within CIRCUIT_BREAKER_WINDOW_MS, it is skipped during nonce assignment
 * and an eager resync is triggered for that wallet only.
 */
const CIRCUIT_BREAKER_QUARANTINE_THRESHOLD = 3;
/** Time window for circuit breaker quarantine counting (10 minutes) */
const CIRCUIT_BREAKER_WINDOW_MS = 10 * 60 * 1000;
/**
 * Cross-wallet cascade detection: log a cascade_detected event when quarantine
 * count across all wallets exceeds this threshold within CIRCUIT_BREAKER_WINDOW_MS.
 */
const CASCADE_DETECTION_THRESHOLD = 3;

// Legacy single-wallet pool key (migrated to pool:0 on first access)
const POOL_KEY = "pool";
const STATE_KEYS = {
  current: "current",
  totalAssigned: "total_assigned",
  conflictsDetected: "conflicts_detected",
  lastAssignedNonce: "last_assigned_nonce",
  lastAssignedAt: "last_assigned_at",
  gapsRecovered: "gaps_recovered",
  gapsFilled: "gaps_filled",
  lastHiroSync: "last_hiro_sync",
  lastGapDetected: "last_gap_detected",
  stuckTxRbfBroadcast: "stuck_tx_rbf_attempted",
  stuckTxRbfConfirmed: "stuck_tx_rbf_confirmed",
} as const;

/** Round-robin wallet index storage key */
const NEXT_WALLET_INDEX_KEY = "next_wallet_index";

/**
 * Structured error thrown when all sponsor wallets are at the chaining limit.
 * Carries mempoolDepth so the /assign handler can build an actionable 429 response.
 */
class ChainingLimitError extends Error {
  readonly mempoolDepth: number;

  constructor(mempoolDepth: number) {
    super("CHAINING_LIMIT_EXCEEDED");
    this.name = "ChainingLimitError";
    this.mempoolDepth = mempoolDepth;
  }
}

/** Insert a nonce into a sorted ascending array at the correct position. */
function insertSorted(arr: number[], nonce: number): void {
  if (arr.includes(nonce)) return;
  const idx = arr.findIndex((n) => n > nonce);
  if (idx === -1) {
    arr.push(nonce);
  } else {
    arr.splice(idx, 0, nonce);
  }
}

/** Safely add two microSTX string amounts using BigInt to avoid overflow */
function addMicroSTX(a: string, b: string): string {
  try {
    return (BigInt(a || "0") + BigInt(b || "0")).toString();
  } catch {
    return a || "0";
  }
}

/** TTL for cached Hiro next_nonce values used by the lookahead cap guard (ms) */
const HIRO_NONCE_CACHE_TTL_MS = 30 * 1000;
/** Timeout for Hiro nonce info fetch requests (ms) */
const HIRO_NONCE_FETCH_TIMEOUT_MS = 10000;

export class NonceDO {
  private readonly sql: DurableObjectStorage["sql"];
  private readonly state: DurableObjectState;
  private readonly env: Env;
  /** Per-wallet cache of Hiro possible_next_nonce to avoid redundant API calls */
  private readonly hiroNonceCache = new Map<number, { value: number; expiresAt: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.state = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nonce_state (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nonce_txids (
        txid TEXT PRIMARY KEY,
        nonce INTEGER NOT NULL,
        assigned_at TEXT NOT NULL
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_nonce_txids_assigned
        ON nonce_txids(assigned_at DESC);
    `);

    // Nonce intent ledger: tracks lifecycle state per (wallet_index, nonce).
    // This is the source-of-truth table for the nonce-sovereignty refactor.
    // Phase 1: written alongside existing pool state (dual-write) for validation.
    // Phase 2+: reads will migrate here as the authoritative nonce state.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nonce_intents (
        wallet_index INTEGER NOT NULL,
        nonce        INTEGER NOT NULL,
        state        TEXT    NOT NULL,
        txid         TEXT,
        http_status  INTEGER,
        broadcast_node TEXT,
        assigned_at    TEXT NOT NULL,
        broadcasted_at TEXT,
        confirmed_at   TEXT,
        block_height   INTEGER,
        error_reason   TEXT,
        PRIMARY KEY (wallet_index, nonce)
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_nonce_intents_state
        ON nonce_intents(state, wallet_index);
    `);

    // Nonce event log: append-only audit trail for every nonce lifecycle transition.
    // Immutable once written — never updated, only inserted and optionally pruned.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nonce_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_index INTEGER NOT NULL,
        nonce        INTEGER NOT NULL,
        event        TEXT    NOT NULL,
        detail       TEXT,
        created_at   TEXT    NOT NULL
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_nonce_events_wallet_nonce
        ON nonce_events(wallet_index, nonce, created_at DESC);
    `);
  }

  private jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private async parseJson<T>(request: Request): Promise<{
    value: T | null;
    errorResponse: Response | null;
  }> {
    try {
      const value = (await request.json()) as T;
      return { value, errorResponse: null };
    } catch (error) {
      return {
        value: null,
        errorResponse: this.jsonResponse({ error: "Invalid JSON body" }, 400),
      };
    }
  }

  private badRequest(message: string): Response {
    return this.jsonResponse({ error: message }, 400);
  }

  private internalError(error: unknown): Response {
    const message = error instanceof Error ? error.message : "Unknown error";
    return this.jsonResponse({ error: message }, 500);
  }

  /**
   * Structured logger for NonceDO events.
   * Sends to worker-logs RPC binding (env.LOGS) when available; falls back to console.
   * Uses this.state.waitUntil() to fire-and-forget async RPC calls without blocking.
   */
  private log(
    level: "info" | "warn" | "error" | "debug",
    message: string,
    context?: Record<string, unknown>
  ): void {
    if (isLogsRPC(this.env.LOGS)) {
      this.state.waitUntil(this.env.LOGS[level](APP_ID, message, context));
    } else {
      const line = context
        ? `${message} ${JSON.stringify(context)}`
        : message;
      if (level === "warn" || level === "error") {
        console[level](`[${level.toUpperCase()}] ${line}`);
      } else {
        console.log(`[${level.toUpperCase()}] ${line}`);
      }
    }
  }

  private getStateValue(key: string): number | null {
    const rows = this.sql
      .exec<{ value: number }>(
        "SELECT value FROM nonce_state WHERE key = ? LIMIT 1",
        key
      )
      .toArray();

    if (rows.length === 0) {
      return null;
    }

    return rows[0].value;
  }

  private setStateValue(key: string, value: number): void {
    this.sql.exec(
      "INSERT INTO nonce_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  private getStoredNonce(): number | null {
    return this.getStateValue(STATE_KEYS.current);
  }

  private setStoredNonce(value: number): void {
    this.setStateValue(STATE_KEYS.current, value);
  }

  private getStoredCount(key: string): number {
    return this.getStateValue(key) ?? 0;
  }

  private updateAssignedStats(assignedNonce: number): void {
    const totalAssigned = this.getStoredCount(STATE_KEYS.totalAssigned) + 1;
    this.setStateValue(STATE_KEYS.totalAssigned, totalAssigned);
    this.setStateValue(STATE_KEYS.lastAssignedNonce, assignedNonce);
    this.setStateValue(STATE_KEYS.lastAssignedAt, Date.now());
  }

  private incrementConflictsDetected(): void {
    const conflictsDetected = this.getStoredCount(STATE_KEYS.conflictsDetected) + 1;
    this.setStateValue(STATE_KEYS.conflictsDetected, conflictsDetected);
  }

  private incrementGapsRecovered(): void {
    const gapsRecovered = this.getStoredCount(STATE_KEYS.gapsRecovered) + 1;
    this.setStateValue(STATE_KEYS.gapsRecovered, gapsRecovered);
  }

  private incrementGapsFilled(): void {
    const gapsFilled = this.getStoredCount(STATE_KEYS.gapsFilled) + 1;
    this.setStateValue(STATE_KEYS.gapsFilled, gapsFilled);
  }

  private incrementStuckTxRbfBroadcast(): void {
    const count = this.getStoredCount(STATE_KEYS.stuckTxRbfBroadcast) + 1;
    this.setStateValue(STATE_KEYS.stuckTxRbfBroadcast, count);
  }

  private incrementStuckTxRbfConfirmed(): void {
    const count = this.getStoredCount(STATE_KEYS.stuckTxRbfConfirmed) + 1;
    this.setStateValue(STATE_KEYS.stuckTxRbfConfirmed, count);
  }

  /**
   * Return true if any txid has been recorded for this nonce in nonce_txids.
   * Used by cleanStaleReservations to distinguish reserved-but-broadcast nonces
   * from reserved-but-never-broadcast (orphaned) nonces.
   */
  private hasTxidForNonce(nonce: number): boolean {
    const rows = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM nonce_txids WHERE nonce = ?",
        nonce
      )
      .toArray();
    return rows[0].count > 0;
  }

  /**
   * Batch version of hasTxidForNonce: returns the set of nonces (from the input)
   * that have at least one txid recorded in nonce_txids.
   * Uses a single SQL query with WHERE nonce IN (...) for efficiency.
   */
  private getNoncesWithTxids(nonces: number[]): Set<number> {
    if (nonces.length === 0) return new Set();
    const placeholders = nonces.map(() => "?").join(",");
    const rows = this.sql
      .exec<{ nonce: number }>(
        `SELECT DISTINCT nonce FROM nonce_txids WHERE nonce IN (${placeholders})`,
        ...nonces
      )
      .toArray();
    return new Set(rows.map((r) => r.nonce));
  }

  /**
   * Release stale reservations for a wallet pool back to available.
   * A reservation is "stale" when:
   *   - It has been reserved longer than STALE_THRESHOLD_MS (10 minutes), AND
   *   - No txid has been recorded for it in nonce_txids (never broadcast).
   *
   * This recovers pool capacity lost to fire-and-forget releaseNonceDO failures.
   * Returns the number of nonces reclaimed (returned to available or quarantined to spent).
   */
  private cleanStaleReservations(pool: PoolState, walletIndex: number): number {
    const now = Date.now();
    const staleCandidates: number[] = [];

    for (const nonce of pool.reserved) {
      const reservedAt = pool.reservedAt[nonce];
      // No timestamp means we can't determine age -- conservatively skip
      if (reservedAt === undefined) continue;
      // Still within the grace window
      if (now - reservedAt < STALE_THRESHOLD_MS) continue;
      staleCandidates.push(nonce);
    }

    if (staleCandidates.length === 0) return 0;

    // Batch check which stale nonces have txids recorded
    const noncesWithTxids = this.getNoncesWithTxids(staleCandidates);
    const staleNonces = new Set<number>();
    const staleWithTxid = new Set<number>();
    for (const nonce of staleCandidates) {
      if (noncesWithTxids.has(nonce)) {
        staleWithTxid.add(nonce);
      } else {
        staleNonces.add(nonce);
      }
    }

    const totalReclaimed = staleNonces.size + staleWithTxid.size;
    if (totalReclaimed === 0) {
      return 0;
    }

    // Filter all stale nonces from reserved
    const allStale = new Set([...staleNonces, ...staleWithTxid]);
    pool.reserved = pool.reserved.filter((n) => !allStale.has(n));

    // Nonces without txid: safe to return to available
    for (const nonce of staleNonces) {
      delete pool.reservedAt[nonce];
      insertSorted(pool.available, nonce);
    }

    // Nonces with txid: quarantine to spent[] — they were broadcast
    for (const nonce of staleWithTxid) {
      delete pool.reservedAt[nonce];
      if (!pool.spent.includes(nonce)) {
        pool.spent.push(nonce);
      }
      this.log("warn", "nonce_quarantined_stale", {
        walletIndex,
        nonce,
        reason: "stale_reservation_with_txid",
        poolSpent: pool.spent.length,
      });
    }

    return totalReclaimed;
  }

  /**
   * Remove confirmed nonces from pool.reserved[] for a specific wallet.
   * A nonce is "confirmed" when it is <= Hiro's last_executed_tx_nonce for that wallet,
   * meaning the transaction was included in a block and can never conflict again.
   * Returns the count of nonces removed.
   *
   * pool is mutated in place but NOT saved here — callers must save if count > 0.
   * This prevents reserved[] from accumulating indefinitely across alarm cycles.
   */
  private pruneConfirmedReservations(
    pool: PoolState,
    lastExecutedTxNonce: number | null
  ): number {
    if (lastExecutedTxNonce === null || pool.reserved.length === 0) {
      return 0;
    }
    const before = pool.reserved.length;
    pool.reserved = pool.reserved.filter((n) => n > lastExecutedTxNonce);
    // Clean up reservedAt entries for pruned nonces
    for (const key of Object.keys(pool.reservedAt)) {
      const n = Number(key);
      if (n <= lastExecutedTxNonce) {
        delete pool.reservedAt[n];
      }
    }
    return before - pool.reserved.length;
  }

  /**
   * Remove confirmed nonces from pool.spent[] for a specific wallet.
   * Nonces far below last_executed_tx_nonce can never conflict again and are safe to discard.
   * This prevents spent[] from growing unbounded over the lifetime of the DO.
   * Returns the count of nonces removed.
   *
   * pool is mutated in place but NOT saved here — callers must save if count > 0.
   */
  private pruneConfirmedSpent(
    pool: PoolState,
    lastExecutedTxNonce: number | null
  ): number {
    if (lastExecutedTxNonce === null || pool.spent.length === 0) {
      return 0;
    }
    const before = pool.spent.length;
    pool.spent = pool.spent.filter((n) => n > lastExecutedTxNonce);
    return before - pool.spent.length;
  }

  /**
   * Derive the private key for a specific wallet index from the mnemonic.
   * Falls back to SPONSOR_PRIVATE_KEY for wallet 0 if no mnemonic is set.
   * Uses the same derivation pattern as SponsorService.deriveSponsorKeyForIndex.
   */
  private async derivePrivateKeyForWallet(walletIndex: number): Promise<string | null> {
    if (this.env.SPONSOR_MNEMONIC) {
      const words = this.env.SPONSOR_MNEMONIC.trim().split(/\s+/);
      if (!VALID_MNEMONIC_LENGTHS.includes(words.length)) return null;
      try {
        let wallet = await generateWallet({
          secretKey: this.env.SPONSOR_MNEMONIC,
          password: "",
        });
        // generateNewAccount returns a new wallet object (wallet-sdk v7)
        for (let i = wallet.accounts.length; i <= walletIndex; i++) {
          wallet = generateNewAccount(wallet);
        }
        const account = wallet.accounts[walletIndex];
        return account?.stxPrivateKey ?? null;
      } catch {
        return null;
      }
    }
    // Fallback: SPONSOR_PRIVATE_KEY is only valid for wallet 0
    if (walletIndex === 0 && this.env.SPONSOR_PRIVATE_KEY) {
      return this.env.SPONSOR_PRIVATE_KEY;
    }
    return null;
  }

  /**
   * Broadcast a gap-fill STX transfer for a specific nonce.
   * Returns the txid on success, null if the nonce is already occupied or on error.
   * Amount: 1 uSTX. Fee: 30,000 uSTX (RBF-capable). Memo: gap-fill-{nonce}.
   */
  private async fillGapNonce(
    walletIndex: number,
    gapNonce: number,
    privateKey: string
  ): Promise<string | null> {
    const network = this.env.STACKS_NETWORK ?? "testnet";
    const defaultRecipient = network === "mainnet"
      ? DEFAULT_FLUSH_RECIPIENT_MAINNET
      : DEFAULT_FLUSH_RECIPIENT_TESTNET;
    const recipient = this.env.FLUSH_RECIPIENT ?? defaultRecipient;
    try {
      const tx = await makeSTXTokenTransfer({
        recipient,
        amount: GAP_FILL_AMOUNT,
        senderKey: privateKey,
        network,
        nonce: BigInt(gapNonce),
        fee: GAP_FILL_FEE,
        memo: `gap-fill-${gapNonce}`,
      });
      const result = await broadcastTransaction({ transaction: tx, network });
      if ("txid" in result) {
        return result.txid;
      }
      // Cast to access raw reason string — Hiro may return values not in the typed union
      // (e.g. "ConflictingNonceInMempool" when a tx with same nonce is already in mempool)
      const rejection = result as unknown as { reason?: string; error?: string };
      if (rejection.reason === "ConflictingNonceInMempool") {
        // Nonce already occupied — not an error, just skip
        return null;
      }
      // Other rejection — log and continue
      this.log("warn", "gap_fill_rejected", {
        walletIndex,
        nonce: gapNonce,
        reason: rejection.reason ?? "unknown",
        error: rejection.error ?? "",
      });
      return null;
    } catch (e) {
      this.log("warn", "gap_fill_error", {
        walletIndex,
        nonce: gapNonce,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Fetch all pending mempool transactions for a specific sponsor address from Hiro.
   * Returns an array of MempoolTxEntry objects, filtered to tx_status === "pending".
   * Returns [] on any error — fail-open so a Hiro outage never blocks alarm reconciliation.
   */
  private async fetchMempoolTxsForAddress(address: string): Promise<MempoolTxEntry[]> {
    const base = getHiroBaseUrl(this.env.STACKS_NETWORK ?? "testnet");
    const headers = getHiroHeaders(this.env.HIRO_API_KEY);
    const pageLimit = 50;
    const maxPages = 10; // Cap at 500 entries to bound API calls
    const pending: MempoolTxEntry[] = [];

    try {
      for (let page = 0; page < maxPages; page++) {
        const offset = page * pageLimit;
        const url = `${base}/extended/v1/tx/mempool?sender_address=${encodeURIComponent(address)}&limit=${pageLimit}&offset=${offset}`;
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(HIRO_NONCE_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          this.log("warn", "mempool_fetch_failed", {
            address,
            status: response.status,
            page,
          });
          break;
        }
        const data = (await response.json()) as { results?: unknown[] };
        if (!Array.isArray(data.results) || data.results.length === 0) break;

        for (const item of data.results) {
          const entry = item as Record<string, unknown>;
          if (
            typeof entry.tx_id === "string" &&
            typeof entry.nonce === "number" &&
            typeof entry.tx_status === "string" &&
            entry.tx_status === "pending" &&
            typeof entry.receipt_time_iso === "string"
          ) {
            pending.push({
              tx_id: entry.tx_id,
              nonce: entry.nonce,
              tx_status: entry.tx_status,
              receipt_time_iso: entry.receipt_time_iso,
            });
          }
        }

        // Stop paginating when last page returned fewer results than the limit
        if (data.results.length < pageLimit) break;
      }
      return pending;
    } catch (e) {
      this.log("warn", "mempool_fetch_error", {
        address,
        error: e instanceof Error ? e.message : String(e),
      });
      return pending; // Return whatever we collected before the error
    }
  }

  /**
   * Broadcast a replace-by-fee (RBF) self-transfer for a nonce that is stuck in the mempool.
   * Uses RBF_FEE (90,000 uSTX = 3× GAP_FILL_FEE) to guarantee eviction of the stuck tx.
   * Tracks attempt count in DO storage to cap retries at MAX_RBF_ATTEMPTS.
   * Returns the replacement txid on success, null if capped or broadcast failed.
   */
  private async broadcastRbfForNonce(
    walletIndex: number,
    nonce: number,
    privateKey: string,
    originalTxid: string | null
  ): Promise<string | null> {
    const key = this.walletStuckTxKey(walletIndex, nonce);
    const existing = await this.state.storage.get<StuckTxState>(key);
    const now = new Date().toISOString();

    // Load or initialise stuck-tx state
    const state: StuckTxState = existing ?? {
      nonce,
      originalTxid,
      firstSeen: now,
      lastSeen: now,
      rbfAttempts: 0,
      lastRbfTxid: null,
    };

    if (state.rbfAttempts >= MAX_RBF_ATTEMPTS) {
      this.log("warn", "rbf_max_attempts_reached", {
        walletIndex,
        nonce,
        rbfAttempts: state.rbfAttempts,
        maxAttempts: MAX_RBF_ATTEMPTS,
        originalTxid: state.originalTxid,
      });
      return null;
    }

    const network = this.env.STACKS_NETWORK ?? "testnet";
    const defaultRecipient = network === "mainnet"
      ? DEFAULT_FLUSH_RECIPIENT_MAINNET
      : DEFAULT_FLUSH_RECIPIENT_TESTNET;
    const recipient = this.env.FLUSH_RECIPIENT ?? defaultRecipient;
    const attemptNum = state.rbfAttempts + 1;

    try {
      const tx = await makeSTXTokenTransfer({
        recipient,
        amount: GAP_FILL_AMOUNT,
        senderKey: privateKey,
        network,
        nonce: BigInt(nonce),
        fee: RBF_FEE,
        memo: `rbf-${nonce}-attempt-${attemptNum}`,
      });
      const result = await broadcastTransaction({ transaction: tx, network });

      // Update state regardless of outcome (increment attempt count to prevent runaway)
      state.lastSeen = now;
      state.rbfAttempts = attemptNum;
      state.originalTxid = state.originalTxid ?? originalTxid;

      if ("txid" in result) {
        state.lastRbfTxid = result.txid;
        await this.state.storage.put(key, state);
        this.incrementStuckTxRbfBroadcast();
        this.log("info", "rbf_broadcast_success", {
          walletIndex,
          nonce,
          txid: result.txid,
          fee: RBF_FEE.toString(),
          attemptNum,
          originalTxid: state.originalTxid,
        });
        return result.txid;
      }

      // Broadcast rejected — update state with incremented attempt count
      await this.state.storage.put(key, state);
      const rejection = result as unknown as { reason?: string; error?: string };
      this.log("warn", "rbf_broadcast_rejected", {
        walletIndex,
        nonce,
        reason: rejection.reason ?? "unknown",
        error: rejection.error ?? "",
        attemptNum,
      });
      return null;
    } catch (e) {
      // On unexpected error: still increment attempt count so we don't spin
      state.lastSeen = now;
      state.rbfAttempts = attemptNum;
      await this.state.storage.put(key, state);
      this.log("warn", "rbf_broadcast_error", {
        walletIndex,
        nonce,
        error: e instanceof Error ? e.message : String(e),
        attemptNum,
      });
      return null;
    }
  }

  /**
   * Schedule the next alarm.
   * active=true  → 60s interval (in-flight nonces present, frequent reconciliation needed)
   * active=false → 5min interval (all wallets idle, normal cadence)
   */
  private async scheduleAlarm(active = false): Promise<void> {
    const intervalMs = active ? ALARM_INTERVAL_ACTIVE_MS : ALARM_INTERVAL_IDLE_MS;
    await this.state.storage.setAlarm(Date.now() + intervalMs);
  }

  // ---------------------------------------------------------------------------
  // Per-wallet pool helpers
  // ---------------------------------------------------------------------------

  /** KV key for per-wallet pool state */
  private poolKey(walletIndex: number): string {
    return `pool:${walletIndex}`;
  }

  /** KV key for per-wallet sponsor address */
  private sponsorAddressKey(walletIndex: number): string {
    return `sponsor_address:${walletIndex}`;
  }

  /**
   * Load the reservation pool state for a specific wallet.
   * Handles one-time migration from legacy "pool" key (wallet 0 only).
   */
  private async loadPoolForWallet(walletIndex: number): Promise<PoolState | null> {
    // Try per-wallet key first
    const pool = await this.state.storage.get<PoolState>(this.poolKey(walletIndex));
    if (pool != null) {
      // Backward compat: pools persisted before reservedAt was added won't have the field
      if (!pool.reservedAt) {
        pool.reservedAt = {};
      }
      // Backward compat: pools persisted before spent[] was added won't have the field
      if (!pool.spent) {
        pool.spent = [];
      }
      return pool;
    }

    // Migration: wallet 0 may have state under legacy "pool" key
    if (walletIndex === 0) {
      const legacy = await this.state.storage.get<PoolState>(POOL_KEY);
      if (legacy != null) {
        // Migrate to per-wallet key, remove legacy
        if (!legacy.reservedAt) {
          legacy.reservedAt = {};
        }
        if (!legacy.spent) {
          legacy.spent = [];
        }
        await this.state.storage.put(this.poolKey(0), legacy);
        await this.state.storage.delete(POOL_KEY);
        return legacy;
      }
    }

    return null;
  }

  /** Persist the reservation pool state for a specific wallet. */
  private async savePoolForWallet(walletIndex: number, pool: PoolState): Promise<void> {
    await this.state.storage.put(this.poolKey(walletIndex), pool);
  }

  /** Get the stored sponsor address for a specific wallet.
   *  For wallet 0, also checks the legacy "sponsor_address" key and migrates it. */
  private async getStoredSponsorAddressForWallet(walletIndex: number): Promise<string | null> {
    const key = this.sponsorAddressKey(walletIndex);
    const stored = await this.state.storage.get<string>(key);
    if (typeof stored === "string" && stored.length > 0) return stored;

    // Migration: wallet 0 may have address under legacy key
    if (walletIndex === 0) {
      const legacy = await this.state.storage.get<string>("sponsor_address");
      if (typeof legacy === "string" && legacy.length > 0) {
        await this.state.storage.put(key, legacy);
        await this.state.storage.delete("sponsor_address");
        return legacy;
      }
    }

    return null;
  }

  /** Store the sponsor address for a specific wallet. */
  private async setStoredSponsorAddressForWallet(walletIndex: number, address: string): Promise<void> {
    await this.state.storage.put(this.sponsorAddressKey(walletIndex), address);
  }

  /** Get the current round-robin wallet index. */
  private async getNextWalletIndex(): Promise<number> {
    return (await this.state.storage.get<number>(NEXT_WALLET_INDEX_KEY)) ?? 0;
  }

  /** Persist the round-robin wallet index. */
  private async setNextWalletIndex(index: number): Promise<void> {
    await this.state.storage.put(NEXT_WALLET_INDEX_KEY, index);
  }

  // ---------------------------------------------------------------------------
  // Per-wallet fee tracking helpers
  // ---------------------------------------------------------------------------

  /** KV key for cumulative fee total for a specific wallet */
  private walletFeesKey(walletIndex: number): string {
    return `wallet_fees:${walletIndex}`;
  }

  /** KV key for cumulative tx count for a specific wallet */
  private walletTxCountKey(walletIndex: number): string {
    return `wallet_tx_count:${walletIndex}`;
  }

  /**
   * KV key for today's fee stats for a specific wallet.
   * Uses UTC date (YYYY-MM-DD) so stats roll over at midnight UTC.
   */
  private walletTxTodayKey(walletIndex: number): string {
    const today = new Date().toISOString().slice(0, 10);
    return `wallet_tx_today:${walletIndex}:${today}`;
  }

  /** KV key for cumulative gap-fill fee total for a specific wallet */
  private walletGapFillFeesKey(walletIndex: number): string {
    return `wallet_gap_fill_fees:${walletIndex}`;
  }

  /** KV key for cumulative gap-fill tx count for a specific wallet */
  private walletGapFillCountKey(walletIndex: number): string {
    return `wallet_gap_fill_count:${walletIndex}`;
  }

  /** KV key for per-wallet gap persistence tracking state */
  private walletGapPersistKey(walletIndex: number): string {
    return `gap_persist:${walletIndex}`;
  }

  /** KV key for per-nonce RBF attempt state (stuck mempool tx tracking) */
  private walletStuckTxKey(walletIndex: number, nonce: number): string {
    return `stuck_tx:${walletIndex}:${nonce}`;
  }

  /** KV key for per-wallet recent quarantine timestamps (circuit breaker window) */
  private walletQuarantineRecentKey(walletIndex: number): string {
    return `wallet_quarantine_recent:${walletIndex}`;
  }

  /** KV key for cross-wallet cascade quarantine tracking */
  private readonly cascadeQuarantineKey = "cascade_quarantine_window";

  /**
   * Record a quarantine event for a specific wallet.
   * Maintains a rolling window of recent quarantine timestamps for the circuit breaker.
   * Also contributes to cross-wallet cascade detection.
   * Called from releaseNonce() only for failure quarantines (not normal consumption).
   */
  private async recordQuarantineEvent(walletIndex: number): Promise<void> {
    const now = new Date().toISOString();
    const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;

    // Update per-wallet recent quarantine list
    const recentKey = this.walletQuarantineRecentKey(walletIndex);
    const existing = (await this.state.storage.get<string[]>(recentKey)) ?? [];
    const pruned = existing.filter((ts) => new Date(ts).getTime() >= cutoff);
    pruned.push(now);
    await this.state.storage.put(recentKey, pruned);

    if (pruned.length >= CIRCUIT_BREAKER_QUARANTINE_THRESHOLD) {
      this.log("warn", "circuit_breaker_triggered", {
        walletIndex,
        quarantineCount: pruned.length,
        windowMs: CIRCUIT_BREAKER_WINDOW_MS,
        threshold: CIRCUIT_BREAKER_QUARANTINE_THRESHOLD,
      });
    }

    // Update cross-wallet cascade window
    await this.checkCascadeThreshold(walletIndex, now);
  }

  /**
   * Check if cross-wallet quarantines have crossed the cascade detection threshold.
   * Logs a cascade_detected event when >= CASCADE_DETECTION_THRESHOLD quarantines
   * have occurred across any wallets within the circuit breaker time window.
   */
  private async checkCascadeThreshold(walletIndex: number, ts: string): Promise<void> {
    const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
    const existing = (await this.state.storage.get<Array<{ walletIndex: number; ts: string }>>(
      this.cascadeQuarantineKey
    )) ?? [];

    const pruned = existing.filter((e) => new Date(e.ts).getTime() >= cutoff);
    pruned.push({ walletIndex, ts });
    await this.state.storage.put(this.cascadeQuarantineKey, pruned);

    if (pruned.length >= CASCADE_DETECTION_THRESHOLD) {
      const uniqueWallets = [...new Set(pruned.map((e) => e.walletIndex))];
      this.log("warn", "cascade_detected", {
        totalQuarantinesInWindow: pruned.length,
        affectedWallets: uniqueWallets,
        windowMs: CIRCUIT_BREAKER_WINDOW_MS,
        threshold: CASCADE_DETECTION_THRESHOLD,
        detectedAt: ts,
      });
    }
  }

  /**
   * Trigger an eager pool refill for a specific wallet when its available[] pool
   * has dropped below the low-water threshold after a nonce is moved to spent[].
   * Calls reconcileNonceForWallet() inline rather than waiting for the next alarm cycle.
   * Must be called from within blockConcurrencyWhile context.
   */
  private async triggerEagerRefillForWallet(walletIndex: number, pool: PoolState): Promise<void> {
    const lowWaterMark = Math.ceil(POOL_SEED_SIZE / 2);
    if (pool.available.length >= lowWaterMark) {
      // Pool is still healthy — no eager refill needed
      return;
    }
    const address = await this.getStoredSponsorAddressForWallet(walletIndex);
    if (!address) {
      // Wallet not yet fully initialized — skip
      return;
    }
    this.log("info", "eager_pool_refill_triggered", {
      walletIndex,
      availableBeforeRefill: pool.available.length,
      lowWaterMark,
    });
    // reconcileNonceForWallet is the same path the alarm uses; it will call
    // resetPoolAvailableForWallet if the pool is below target.
    await this.reconcileNonceForWallet(walletIndex, address);
  }

  /**
   * Record a successful gap-fill transaction fee for a specific wallet.
   * Increments gap-fill-specific counters separately from sponsored tx fees
   * so gap-fill costs are distinguishable in per-wallet stats.
   */
  private async recordGapFillFee(walletIndex: number, fee: string): Promise<void> {
    // Update cumulative gap-fill total fees
    const prevTotal = (await this.state.storage.get<string>(this.walletGapFillFeesKey(walletIndex))) ?? "0";
    await this.state.storage.put(this.walletGapFillFeesKey(walletIndex), addMicroSTX(prevTotal, fee));

    // Update cumulative gap-fill tx count
    const prevCount = (await this.state.storage.get<number>(this.walletGapFillCountKey(walletIndex))) ?? 0;
    await this.state.storage.put(this.walletGapFillCountKey(walletIndex), prevCount + 1);
  }

  /**
   * Record a successful transaction fee for a specific wallet.
   * Increments cumulative total fees, total tx count, and today's counters.
   */
  private async recordWalletFee(walletIndex: number, fee: string): Promise<void> {
    // Update cumulative total fees
    const prevTotal = (await this.state.storage.get<string>(this.walletFeesKey(walletIndex))) ?? "0";
    await this.state.storage.put(this.walletFeesKey(walletIndex), addMicroSTX(prevTotal, fee));

    // Update cumulative tx count
    const prevCount = (await this.state.storage.get<number>(this.walletTxCountKey(walletIndex))) ?? 0;
    await this.state.storage.put(this.walletTxCountKey(walletIndex), prevCount + 1);

    // Update today's stats
    const todayKey = this.walletTxTodayKey(walletIndex);
    const today = (await this.state.storage.get<{ txCount: number; fees: string }>(todayKey)) ?? { txCount: 0, fees: "0" };
    await this.state.storage.put(todayKey, {
      txCount: today.txCount + 1,
      fees: addMicroSTX(today.fees, fee),
    });
  }

  /**
   * Get fee statistics for a specific wallet.
   * Returns cumulative totals, today's stats, and gap-fill breakdown.
   */
  async getWalletFeeStats(walletIndex: number): Promise<WalletFeeStats> {
    const totalFeesSpent = (await this.state.storage.get<string>(this.walletFeesKey(walletIndex))) ?? "0";
    const txCount = (await this.state.storage.get<number>(this.walletTxCountKey(walletIndex))) ?? 0;
    const todayKey = this.walletTxTodayKey(walletIndex);
    const today = (await this.state.storage.get<{ txCount: number; fees: string }>(todayKey)) ?? { txCount: 0, fees: "0" };
    const gapFillFeesTotal = (await this.state.storage.get<string>(this.walletGapFillFeesKey(walletIndex))) ?? "0";
    const gapFillCount = (await this.state.storage.get<number>(this.walletGapFillCountKey(walletIndex))) ?? 0;

    return {
      totalFeesSpent,
      txCount,
      txCountToday: today.txCount,
      feesToday: today.fees,
      gapFillFeesTotal,
      gapFillCount,
    };
  }

  /**
   * Collect all initialized wallets (those with a stored sponsor address).
   * Returns an array of { walletIndex, address } in index order.
   * Stops at the first uninitialized wallet index.
   */
  private async getInitializedWallets(): Promise<Array<{ walletIndex: number; address: string }>> {
    const wallets: Array<{ walletIndex: number; address: string }> = [];
    for (let wi = 0; wi < MAX_WALLET_COUNT; wi++) {
      const address = await this.getStoredSponsorAddressForWallet(wi);
      if (!address) break;
      wallets.push({ walletIndex: wi, address });
    }
    return wallets;
  }

  private async fetchNonceInfo(sponsorAddress: string): Promise<HiroNonceInfo> {
    const url = `${getHiroBaseUrl(this.env.STACKS_NETWORK)}/extended/v1/address/${sponsorAddress}/nonces`;
    const headers = getHiroHeaders(this.env.HIRO_API_KEY);
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(HIRO_NONCE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Hiro nonce endpoint responded with ${response.status}`);
    }

    const data = (await response.json()) as Partial<HiroNonceInfo>;
    if (typeof data?.possible_next_nonce !== "number") {
      throw new Error("Hiro nonce response missing possible_next_nonce");
    }

    return {
      last_executed_tx_nonce: typeof data.last_executed_tx_nonce === "number"
        ? data.last_executed_tx_nonce
        : null,
      possible_next_nonce: data.possible_next_nonce,
      detected_missing_nonces: Array.isArray(data.detected_missing_nonces)
        ? data.detected_missing_nonces
        : [],
    };
  }

  /**
   * Fetch possible_next_nonce from Hiro for a specific wallet address.
   * Returns the nonce on success, null on any failure (network error, timeout, bad response).
   * Used exclusively by the lookahead cap guard in assignNonce() — must be fail-open.
   */
  private async fetchNextNonceForWallet(
    walletIndex: number,
    address: string
  ): Promise<number | null> {
    // Check cache first to avoid redundant Hiro API calls during high traffic
    const cached = this.hiroNonceCache.get(walletIndex);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    try {
      const info = await this.fetchNonceInfo(address);
      this.hiroNonceCache.set(walletIndex, {
        value: info.possible_next_nonce,
        expiresAt: Date.now() + HIRO_NONCE_CACHE_TTL_MS,
      });
      return info.possible_next_nonce;
    } catch (_e) {
      this.log("debug", "nonce_lookahead_check_skipped", {
        walletIndex,
        reason: "hiro_unreachable",
      });
      return null;
    }
  }

  /**
   * Load or initialize a pool for a specific wallet.
   * On first init, fetches nonce from Hiro for that wallet's address.
   */
  private async loadPoolOrInit(walletIndex: number, sponsorAddress: string): Promise<PoolState> {
    let pool = await this.loadPoolForWallet(walletIndex);

    // Detect address change: if the stored address differs from the requested one
    // (e.g. after a wallet derivation fix), wipe the stale pool so it reinitializes
    // from Hiro with the correct address's nonce.
    if (pool !== null) {
      const storedAddr = await this.getStoredSponsorAddressForWallet(walletIndex);
      if (storedAddr && storedAddr !== sponsorAddress) {
        this.log("info", "pool_address_changed", {
          walletIndex,
          oldAddress: storedAddr,
          newAddress: sponsorAddress,
        });
        pool = null;
      }
    }

    if (pool !== null) return pool;

    // Pool not yet initialized for this wallet — seed from Hiro
    let seedNonce: number;
    if (walletIndex === 0) {
      // Wallet 0: prefer the SQL counter if it exists (backward compat migration)
      const stored = this.getStoredNonce();
      if (stored !== null) {
        seedNonce = stored;
      } else {
        const nonceInfo = await this.fetchNonceInfo(sponsorAddress);
        seedNonce = nonceInfo.possible_next_nonce;
        this.setStoredNonce(seedNonce);
      }
    } else {
      // Other wallets: always fetch fresh from Hiro
      const nonceInfo = await this.fetchNonceInfo(sponsorAddress);
      seedNonce = nonceInfo.possible_next_nonce;
    }

    pool = await this.initPoolForWallet(walletIndex, seedNonce);
    return pool;
  }

  /**
   * Create and persist a fresh pool seeded from the given nonce for a specific wallet.
   */
  private async initPoolForWallet(walletIndex: number, seedNonce: number): Promise<PoolState> {
    const available: number[] = [];
    for (let i = 0; i < POOL_SEED_SIZE; i++) {
      available.push(seedNonce + i);
    }
    const pool: PoolState = {
      available,
      reserved: [],
      spent: [],
      maxNonce: seedNonce + POOL_SEED_SIZE - 1,
      reservedAt: {},
    };
    await this.savePoolForWallet(walletIndex, pool);
    return pool;
  }

  // ---------------------------------------------------------------------------
  // Nonce intent ledger helpers (Phase 1: dual-write alongside pool state)
  // These methods write to nonce_intents and nonce_events tables.
  // They are NEVER allowed to throw — errors are logged at debug level so the
  // critical nonce assignment / release path is never disrupted by ledger failures.
  // ---------------------------------------------------------------------------

  /**
   * Write 'assigned' intent + event for a newly reserved nonce.
   * Called immediately after the nonce is moved from available[] to reserved[].
   */
  private ledgerAssign(walletIndex: number, nonce: number): void {
    try {
      const now = new Date().toISOString();
      this.sql.exec(
        `INSERT OR REPLACE INTO nonce_intents
           (wallet_index, nonce, state, assigned_at)
         VALUES (?, ?, 'assigned', ?)`,
        walletIndex,
        nonce,
        now
      );
      this.sql.exec(
        `INSERT INTO nonce_events
           (wallet_index, nonce, event, created_at)
         VALUES (?, ?, 'assigned', ?)`,
        walletIndex,
        nonce,
        now
      );
    } catch (e) {
      this.log("debug", "ledger_assign_error", {
        walletIndex,
        nonce,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Write release outcome to the intent ledger for a nonce being released.
   *
   * txid present            → 'confirmed' state (successful broadcast + consumed)
   * txid absent + reason    → 'failed' state (broadcast failed, nonce quarantined)
   * txid absent + no reason → 'expired' state (nonce returned to available[], never broadcast)
   */
  private ledgerRelease(
    walletIndex: number,
    nonce: number,
    txid: string | undefined,
    errorReason?: string
  ): void {
    try {
      const now = new Date().toISOString();
      if (txid) {
        // Nonce was broadcast successfully — mark as confirmed in the intent ledger.
        // Note: we don't have on-chain confirmation here; 'confirmed' means "broadcast accepted".
        // Phase 2+ will upgrade this to a true on-chain confirmation state.
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = 'confirmed', txid = ?, broadcasted_at = ?, confirmed_at = ?
           WHERE wallet_index = ? AND nonce = ?`,
          txid,
          now,
          now,
          walletIndex,
          nonce
        );
        this.sql.exec(
          `INSERT INTO nonce_events
             (wallet_index, nonce, event, detail, created_at)
           VALUES (?, ?, 'confirmed', ?, ?)`,
          walletIndex,
          nonce,
          JSON.stringify({ txid }),
          now
        );
      } else if (errorReason) {
        // Broadcast was attempted (txid recorded previously) but release has no txid —
        // this means the nonce is quarantined due to a failed/conflicting broadcast.
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = 'failed', error_reason = ?
           WHERE wallet_index = ? AND nonce = ?`,
          errorReason,
          walletIndex,
          nonce
        );
        this.sql.exec(
          `INSERT INTO nonce_events
             (wallet_index, nonce, event, detail, created_at)
           VALUES (?, ?, 'broadcast_fail', ?, ?)`,
          walletIndex,
          nonce,
          JSON.stringify({ errorReason }),
          now
        );
      } else {
        // Nonce was never broadcast — safely returned to available[].
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = 'expired'
           WHERE wallet_index = ? AND nonce = ?`,
          walletIndex,
          nonce
        );
        this.sql.exec(
          `INSERT INTO nonce_events
             (wallet_index, nonce, event, created_at)
           VALUES (?, ?, 'expired', ?)`,
          walletIndex,
          nonce,
          now
        );
      }
    } catch (e) {
      this.log("debug", "ledger_release_error", {
        walletIndex,
        nonce,
        txid: txid ?? null,
        errorReason: errorReason ?? null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Assign a nonce from the reservation pool using round-robin wallet selection.
   *
   * With walletCount=1 (default): identical behavior to single-wallet mode.
   * With walletCount=N: round-robin across N wallets, each with independent CHAINING_LIMIT.
   *
   * On first call for a wallet: seeds pool from chain nonce via Hiro.
   * Enforces CHAINING_LIMIT per wallet — throws if all wallets are at limit.
   * Returns both the nonce and the walletIndex for the caller to use.
   */
  async assignNonce(
    sponsorAddress: string,
    walletCount: number = 1,
    addresses?: Record<string, string>
  ): Promise<{ nonce: number; walletIndex: number; totalReserved: number }> {
    if (!sponsorAddress) {
      throw new Error("Missing sponsor address");
    }

    return this.state.blockConcurrencyWhile(async () => {
      const currentAlarm = await this.state.storage.getAlarm();
      if (currentAlarm === null) {
        // Assigning a nonce means we have active traffic — schedule at active interval
        await this.scheduleAlarm(true);
      }

      const effectiveWalletCount = Math.max(1, Math.min(walletCount, MAX_WALLET_COUNT));

      // Round-robin: start from stored nextWalletIndex, find a wallet under chaining limit
      let walletIndex = (await this.getNextWalletIndex()) % effectiveWalletCount;
      let pool: PoolState | null = null;

      // Resolve the correct sponsor address for a given wallet index.
      // In multi-wallet mode, each wallet has its own Stacks address for nonce seeding.
      const resolveAddress = (wi: number): string =>
        addresses?.[String(wi)] ?? sponsorAddress;

      // Try each wallet in round-robin order; skip any at chaining limit or degraded (stuck nonce)
      let attempts = 0;
      let totalMempoolDepth = 0;
      // Track degraded wallets for fallback: { walletIndex, cycleCount, pool }
      const degradedWallets: Array<{ walletIndex: number; cycleCount: number; pool: PoolState }> = [];
      while (attempts < effectiveWalletCount) {
        pool = await this.loadPoolOrInit(walletIndex, resolveAddress(walletIndex));

        // Check if this wallet is degraded (stuck gap nonce for >= 2 cycles)
        const gapState = await this.state.storage.get<GapPersistState>(
          this.walletGapPersistKey(walletIndex)
        );
        if (gapState && gapState.cycleCount >= 2) {
          this.log("warn", "skipping_degraded_wallet", {
            walletIndex,
            stuckNonce: gapState.stuckNonce,
            cycleCount: gapState.cycleCount,
          });
          degradedWallets.push({ walletIndex, cycleCount: gapState.cycleCount, pool });
          walletIndex = (walletIndex + 1) % effectiveWalletCount;
          pool = null;
          attempts++;
          continue;
        }

        // Check per-wallet circuit breaker: skip if too many recent quarantines
        const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
        const recentQuarantines = (
          await this.state.storage.get<string[]>(this.walletQuarantineRecentKey(walletIndex))
        ) ?? [];
        const activeQuarantines = recentQuarantines.filter(
          (ts) => new Date(ts).getTime() >= cutoff
        );
        if (activeQuarantines.length >= CIRCUIT_BREAKER_QUARANTINE_THRESHOLD) {
          this.log("warn", "circuit_breaker_skip", {
            walletIndex,
            quarantineCount: activeQuarantines.length,
            windowMs: CIRCUIT_BREAKER_WINDOW_MS,
            threshold: CIRCUIT_BREAKER_QUARANTINE_THRESHOLD,
          });
          // Use cycleCount=0 so these are treated as degraded-but-not-fully-stuck
          degradedWallets.push({ walletIndex, cycleCount: 0, pool });
          walletIndex = (walletIndex + 1) % effectiveWalletCount;
          pool = null;
          attempts++;
          continue;
        }

        if (pool.reserved.length < CHAINING_LIMIT) {
          break;
        }
        // This wallet is at its chaining limit; accumulate depth and try the next
        totalMempoolDepth += pool.reserved.length;
        walletIndex = (walletIndex + 1) % effectiveWalletCount;
        pool = null;
        attempts++;
      }

      if (attempts === effectiveWalletCount || pool === null) {
        // All wallets are either at chaining limit or degraded.
        // If there are degraded-but-not-full wallets, use the least-degraded one as fallback
        // rather than failing with a misleading CHAINING_LIMIT_EXCEEDED error.
        const degradedNotFull = degradedWallets.filter(
          (d) => d.pool.reserved.length < CHAINING_LIMIT
        );
        if (degradedNotFull.length > 0) {
          // Sort ascending by cycleCount, pick least-degraded wallet
          degradedNotFull.sort((a, b) => a.cycleCount - b.cycleCount);
          const fallback = degradedNotFull[0];
          walletIndex = fallback.walletIndex;
          pool = fallback.pool;
          this.log("warn", "all_wallets_degraded_using_least_degraded", {
            walletIndex,
            cycleCount: fallback.cycleCount,
            degradedCount: degradedWallets.length,
          });
        } else {
          throw new ChainingLimitError(totalMempoolDepth);
        }
      }

      // Store the per-wallet sponsor address (used by alarm reconciliation)
      await this.setStoredSponsorAddressForWallet(walletIndex, resolveAddress(walletIndex));

      // Fetch current Hiro possible_next_nonce (with 30s cache) for stale-head guard.
      // Also used by lookahead cap guard below. Fail-open: null means Hiro unreachable.
      const walletAddr = resolveAddress(walletIndex);
      const hiroNextNonce = await this.fetchNextNonceForWallet(walletIndex, walletAddr);

      // Guard: evict stale nonces from pool head.
      // Between alarm cycles, confirmed txs advance possible_next_nonce past the
      // pool head, leaving already-confirmed nonces in available[]. Evict them.
      if (hiroNextNonce !== null) {
        let evicted = false;
        while (pool.available.length > 0 && pool.available[0] < hiroNextNonce) {
          const staleNonce = pool.available.shift()!;
          evicted = true;
          this.log("warn", "nonce_stale_evicted_on_assign", {
            walletIndex,
            nonce: staleNonce,
            hiroNextNonce,
          });
        }
        if (evicted) {
          await this.savePoolForWallet(walletIndex, pool);
        }
      }

      // Extend pool if available is exhausted
      if (pool.available.length === 0) {
        // Start from the higher of maxNonce+1 and hiroNextNonce to avoid stale extensions
        let nextNonce = pool.maxNonce + 1;
        if (hiroNextNonce !== null && nextNonce < hiroNextNonce) {
          nextNonce = hiroNextNonce;
        }
        // Lookahead cap guard: refuse to extend the pool past hiroNextNonce + LOOKAHEAD_GUARD_BUFFER.
        // This prevents the pool from running so far ahead of confirmed chain state that a
        // resync would discard a large batch of pre-assigned nonces, causing a sudden gap.
        // Fail-open when Hiro is unreachable: if we can't check, allow the extension.
        if (hiroNextNonce !== null && nextNonce > hiroNextNonce + LOOKAHEAD_GUARD_BUFFER) {
          this.log("warn", "nonce_lookahead_capped", {
            walletIndex,
            poolMaxNonce: pool.maxNonce,
            nextNonce,
            hiroNextNonce,
            limit: hiroNextNonce + LOOKAHEAD_GUARD_BUFFER,
            poolReserved: pool.reserved.length,
          });
          // Treat this the same as chaining limit — caller returns 429 so agent can retry
          throw new ChainingLimitError(pool.reserved.length);
        }
        pool.available.push(nextNonce);
        pool.maxNonce = nextNonce;
      }

      // Assign the next available nonce
      const assignedNonce = pool.available.shift()!;
      pool.reserved.push(assignedNonce);
      pool.reservedAt[assignedNonce] = Date.now();

      await this.savePoolForWallet(walletIndex, pool);
      this.updateAssignedStats(assignedNonce);
      // Keep the SQL counter in sync for wallet 0 (stats compatibility)
      if (walletIndex === 0) {
        this.setStoredNonce(pool.available[0] ?? assignedNonce + 1);
      }

      // Dual-write: record assignment in intent ledger (fail-open, never throws)
      this.ledgerAssign(walletIndex, assignedNonce);

      this.log("info", "nonce_assigned", {
        walletIndex,
        nonce: assignedNonce,
        poolAvailable: pool.available.length,
        poolReserved: pool.reserved.length,
        maxNonce: pool.maxNonce,
      });

      // Advance round-robin to next wallet
      await this.setNextWalletIndex((walletIndex + 1) % effectiveWalletCount);

      // Compute totalReserved across all wallets for pool pressure signaling
      let totalReserved = 0;
      for (let wi = 0; wi < effectiveWalletCount; wi++) {
        const wp = await this.loadPoolForWallet(wi);
        totalReserved += wp?.reserved.length ?? 0;
      }

      this.log("debug", "nonce_pool_pressure", {
        walletIndex,
        totalReserved,
        poolCapacity: effectiveWalletCount * CHAINING_LIMIT,
      });

      return { nonce: assignedNonce, walletIndex, totalReserved };
    });
  }

  /**
   * Release a nonce back to the specified wallet's pool or mark it as consumed.
   *
   * txid present  → nonce was broadcast successfully (consumed); remove from reserved only.
   * txid absent   → nonce was NOT broadcast (e.g. broadcast failure); return to available
   *                 in sorted order so it can be reused.
   * walletIndex   → which wallet pool to release to (default: 0)
   * fee           → when provided with txid (broadcast succeeded), recorded in cumulative wallet stats
   */
  async releaseNonce(nonce: number, txid?: string, walletIndex: number = 0, fee?: string): Promise<void> {
    return this.state.blockConcurrencyWhile(async () => {
      const pool = await this.loadPoolForWallet(walletIndex);
      if (pool === null) {
        // Pool not initialized yet — nothing to release
        return;
      }

      const reservedIdx = pool.reserved.indexOf(nonce);
      if (reservedIdx === -1) {
        // Nonce not in reserved — already released or was never assigned from this pool
        return;
      }

      // Remove from reserved and clear the reservation timestamp
      pool.reserved.splice(reservedIdx, 1);
      delete pool.reservedAt[nonce];

      // Track whether the nonce moved to spent[] due to a failure (true quarantine)
      // vs normal consumption (successful broadcast). Only failure quarantines should
      // count toward the circuit breaker — normal consumption is the happy path.
      let failureQuarantined = false;
      let movedToSpent = false;
      if (!txid) {
        // No txid provided: broadcast may have failed. Check if we previously recorded
        // a txid for this nonce (e.g. a retry scenario). If a txid was ever recorded,
        // the nonce was broadcast and must go to spent[] — never back to available[].
        if (this.getNoncesWithTxids([nonce]).has(nonce)) {
          // Nonce was broadcast at some point — quarantine it permanently
          if (!pool.spent.includes(nonce)) {
            pool.spent.push(nonce);
          }
          failureQuarantined = true;
          movedToSpent = true;
          this.log("warn", "nonce_quarantined", {
            walletIndex,
            nonce,
            reason: "txid_recorded_on_failed_release",
            poolSpent: pool.spent.length,
          });
        } else {
          // Truly unused nonce (never broadcast): safe to return to available
          insertSorted(pool.available, nonce);
        }
      } else {
        // txid provided: nonce was broadcast successfully — consumed, not reusable
        if (!pool.spent.includes(nonce)) {
          pool.spent.push(nonce);
        }
        movedToSpent = true;
        if (fee && fee !== "0") {
          // Broadcast succeeded and fee provided — record in wallet stats
          await this.recordWalletFee(walletIndex, fee);
        }
      }

      await this.savePoolForWallet(walletIndex, pool);

      // Dual-write: record release outcome in intent ledger (fail-open, never throws)
      if (txid) {
        // Successful broadcast — nonce consumed
        this.ledgerRelease(walletIndex, nonce, txid);
      } else if (failureQuarantined) {
        // No txid on release, but a txid was previously recorded → quarantine failure
        this.ledgerRelease(walletIndex, nonce, undefined, "txid_recorded_on_failed_release");
      } else {
        // Nonce returned to available[] — was never broadcast
        this.ledgerRelease(walletIndex, nonce, undefined);
      }

      this.log("info", "nonce_released", {
        walletIndex,
        nonce,
        consumed: !!txid,
        txid: txid ?? null,
        poolAvailable: pool.available.length,
        poolReserved: pool.reserved.length,
        poolSpent: pool.spent.length,
      });

      // Circuit breaker: only record failure quarantines (not normal consumption).
      // Normal successful broadcasts should not count toward the circuit breaker
      // threshold — otherwise 3 successful txs within 10 min would trip the breaker.
      if (failureQuarantined) {
        await this.recordQuarantineEvent(walletIndex);
      }

      // Eager refill: trigger for any nonce moved to spent[] (both success and failure)
      // since both shrink the available pool.
      if (movedToSpent) {
        await this.triggerEagerRefillForWallet(walletIndex, pool);
      }
    });
  }

  async recordTxid(txid: string, nonce: number): Promise<void> {
    if (!txid) {
      throw new Error("Missing txid");
    }

    if (!Number.isInteger(nonce) || nonce < 0) {
      throw new Error("Invalid nonce");
    }

    const assignedAt = new Date().toISOString();
    this.sql.exec(
      "INSERT INTO nonce_txids (txid, nonce, assigned_at) VALUES (?, ?, ?) ON CONFLICT(txid) DO UPDATE SET nonce = excluded.nonce, assigned_at = excluded.assigned_at",
      txid,
      nonce,
      assignedAt
    );

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    this.sql.exec("DELETE FROM nonce_txids WHERE assigned_at < ?", cutoff);
  }

  async getNonceForTxid(txid: string): Promise<number | null> {
    if (!txid) {
      throw new Error("Missing txid");
    }

    const rows = this.sql
      .exec<{ nonce: number }>(
        "SELECT nonce FROM nonce_txids WHERE txid = ? LIMIT 1",
        txid
      )
      .toArray();

    if (rows.length === 0) {
      return null;
    }

    return rows[0].nonce;
  }

  async getStats(): Promise<NonceStatsResponse> {
    const totalAssigned = this.getStoredCount(STATE_KEYS.totalAssigned);
    const conflictsDetected = this.getStoredCount(STATE_KEYS.conflictsDetected);
    const lastAssignedNonce = this.getStateValue(STATE_KEYS.lastAssignedNonce);
    const lastAssignedAtMs = this.getStateValue(STATE_KEYS.lastAssignedAt);
    const nextNonce = this.getStoredNonce();
    const gapsRecovered = this.getStoredCount(STATE_KEYS.gapsRecovered);
    const gapsFilled = this.getStoredCount(STATE_KEYS.gapsFilled);
    const lastHiroSyncMs = this.getStateValue(STATE_KEYS.lastHiroSync);
    const lastGapDetectedMs = this.getStateValue(STATE_KEYS.lastGapDetected);

    const txidRows = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM nonce_txids")
      .toArray();
    const txidCount = txidRows.length > 0 ? txidRows[0].count : 0;

    // Load per-wallet pool state for reporting
    const initializedWallets = await this.getInitializedWallets();
    const wallets: WalletPoolStats[] = [];
    for (const { walletIndex, address } of initializedWallets) {
      const pool = await this.loadPoolForWallet(walletIndex);
      wallets.push({
        walletIndex: Number(walletIndex),  // explicit integer coercion
        available: pool?.available.length ?? 0,
        reserved: pool?.reserved.length ?? 0,
        spent: pool?.spent.length ?? 0,
        maxNonce: pool?.maxNonce ?? 0,
        sponsorAddress: address ?? null,
      });
    }

    // Wallet 0 backward-compat fields
    const wallet0 = wallets[0];

    const stuckTxRbfBroadcast = this.getStoredCount(STATE_KEYS.stuckTxRbfBroadcast);
    const stuckTxRbfConfirmed = this.getStoredCount(STATE_KEYS.stuckTxRbfConfirmed);

    return {
      totalAssigned,
      conflictsDetected,
      lastAssignedNonce,
      lastAssignedAt: lastAssignedAtMs ? new Date(lastAssignedAtMs).toISOString() : null,
      nextNonce,
      txidCount,
      gapsRecovered,
      gapsFilled,
      lastHiroSync: lastHiroSyncMs ? new Date(lastHiroSyncMs).toISOString() : null,
      lastGapDetected: lastGapDetectedMs ? new Date(lastGapDetectedMs).toISOString() : null,
      poolAvailable: wallet0?.available ?? 0,
      poolReserved: wallet0?.reserved ?? 0,
      chainingLimit: CHAINING_LIMIT,
      wallets,
      stuckTxRbfBroadcast,
      stuckTxRbfConfirmed,
    };
  }

  /**
   * Core gap-aware nonce reconciliation against Hiro for a specific wallet.
   * Shared by alarm(), performResync(), and performReset() — all iterate every initialized wallet.
   */
  private async reconcileNonceForWallet(
    walletIndex: number,
    sponsorAddress: string
  ): Promise<ReconcileResult | null> {
    let nonceInfo: HiroNonceInfo;
    try {
      nonceInfo = await this.fetchNonceInfo(sponsorAddress);
    } catch (_e) {
      return null;
    }

    this.setStateValue(STATE_KEYS.lastHiroSync, Date.now());

    // Populate Hiro nonce cache (used by assignNonce stale-head guard and alarm invariant check)
    this.hiroNonceCache.set(walletIndex, {
      value: nonceInfo.possible_next_nonce,
      expiresAt: Date.now() + HIRO_NONCE_CACHE_TTL_MS,
    });

    // Prune confirmed nonces from reserved[] before any pool manipulation.
    // This keeps reserved[] lean and prevents phantom reservations from accumulating
    // across alarm cycles. Must happen before resetPoolAvailableForWallet() so the
    // reserved set is accurate when computing available slots.
    const poolForPrune = await this.loadPoolForWallet(walletIndex);
    if (poolForPrune !== null) {
      const prunedReserved = this.pruneConfirmedReservations(poolForPrune, nonceInfo.last_executed_tx_nonce);
      const prunedSpent = this.pruneConfirmedSpent(poolForPrune, nonceInfo.last_executed_tx_nonce);
      if (prunedReserved > 0 || prunedSpent > 0) {
        await this.savePoolForWallet(walletIndex, poolForPrune);
        this.log("info", "reserved_pruned", {
          walletIndex,
          prunedReserved,
          prunedSpent,
          lastExecutedTxNonce: nonceInfo.last_executed_tx_nonce,
          poolReserved: poolForPrune.reserved.length,
          poolAvailable: poolForPrune.available.length,
          poolSpent: poolForPrune.spent.length,
        });
      }
    }

    const previousNonce = walletIndex === 0 ? this.getStoredNonce() : null;

    if (walletIndex === 0 && previousNonce === null) {
      this.setStoredNonce(nonceInfo.possible_next_nonce);
      const pool = await this.loadPoolForWallet(walletIndex);
      if (pool !== null) {
        await this.resetPoolAvailableForWallet(walletIndex, pool, nonceInfo.possible_next_nonce);
      }
      return {
        previousNonce: null,
        newNonce: nonceInfo.possible_next_nonce,
        changed: true,
        reason: "initialized from Hiro possible_next_nonce",
      };
    }

    const { possible_next_nonce, detected_missing_nonces } = nonceInfo;

    if (detected_missing_nonces.length > 0) {
      const sortedGaps = [...detected_missing_nonces].sort((a, b) => a - b);
      const lowestGap = sortedGaps[0];

      if (previousNonce !== null && previousNonce > lowestGap) {
        if (walletIndex === 0) this.setStoredNonce(lowestGap);
        this.incrementGapsRecovered();
        this.setStateValue(STATE_KEYS.lastGapDetected, Date.now());
        this.incrementConflictsDetected();

        const pool = await this.loadPoolForWallet(walletIndex);
        if (pool !== null) {
          await this.resetPoolAvailableForWallet(walletIndex, pool, lowestGap);
        }

        this.log("warn", "nonce_reconcile_gap_recovery", {
          walletIndex,
          previousNonce,
          newNonce: lowestGap,
          gaps: sortedGaps,
          hiroNextNonce: possible_next_nonce,
          hiroMissingNonces: detected_missing_nonces,
          poolReserved: pool?.reserved.length ?? 0,
          poolAvailable: pool?.available.length ?? 0,
        });

        return {
          previousNonce,
          newNonce: lowestGap,
          changed: true,
          reason: `GAP RECOVERY: reset to lowest gap nonce ${lowestGap} (gaps: ${sortedGaps.join(",")})`,
        };
      }

      this.setStateValue(STATE_KEYS.lastGapDetected, Date.now());

      // Gap persistence tracking: detect stuck gap nonces across consecutive alarm cycles.
      // If the same lowestGap nonce reappears for 3+ cycles, the gap-fill tx is itself stuck
      // (e.g. confirmed but Hiro hasn't caught up, or tx dropped). Reset the pool instead of
      // filling indefinitely.
      const gapPersistKey = this.walletGapPersistKey(walletIndex);
      const existingGapState = await this.state.storage.get<GapPersistState>(gapPersistKey);
      const now = new Date().toISOString();

      let gapPersistState: GapPersistState;
      if (existingGapState && existingGapState.stuckNonce === lowestGap) {
        // Same gap nonce seen again — increment cycle counter
        gapPersistState = {
          stuckNonce: lowestGap,
          cycleCount: existingGapState.cycleCount + 1,
          firstSeen: existingGapState.firstSeen,
          lastSeen: now,
        };
      } else {
        // New gap or different nonce — start fresh tracking
        gapPersistState = {
          stuckNonce: lowestGap,
          cycleCount: 1,
          firstSeen: now,
          lastSeen: now,
        };
      }
      await this.state.storage.put(gapPersistKey, gapPersistState);

      // After 3 consecutive cycles with the same stuck nonce, reset the pool instead of
      // retrying gap-fill. The gap-fill tx may be stuck in mempool and will never clear.
      if (gapPersistState.cycleCount >= 3) {
        this.log("warn", "stuck_nonce_pool_reset", {
          walletIndex,
          stuckNonce: lowestGap,
          cycleCount: gapPersistState.cycleCount,
          firstSeen: gapPersistState.firstSeen,
          possibleNextNonce: possible_next_nonce,
        });
        const poolToReset = await this.loadPoolForWallet(walletIndex);
        if (poolToReset !== null) {
          await this.resetPoolAvailableForWallet(walletIndex, poolToReset, possible_next_nonce);
        }
        if (walletIndex === 0) {
          this.setStoredNonce(possible_next_nonce);
        }
        await this.state.storage.delete(gapPersistKey);
        this.log("info", "stuck_nonce_pool_reset_complete", {
          walletIndex,
          newHead: possible_next_nonce,
          stuckNonce: lowestGap,
        });
        return {
          previousNonce,
          newNonce: possible_next_nonce,
          changed: true,
          reason: `STUCK NONCE RESET: nonce ${lowestGap} stuck for ${gapPersistState.cycleCount} alarm cycles, reset pool to ${possible_next_nonce}`,
        };
      }

      // Actively fill gaps: derive key and broadcast 1 uSTX transfers for each gap nonce.
      // Cap per-alarm fills to avoid exceeding Cloudflare alarm execution time limits.
      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      const filled: number[] = [];
      const gapsToFill = sortedGaps.slice(0, MAX_GAP_FILLS_PER_ALARM);
      if (privateKey) {
        for (const gapNonce of gapsToFill) {
          const txid = await this.fillGapNonce(walletIndex, gapNonce, privateKey);
          if (txid) {
            this.log("info", "gap_filled", { walletIndex, nonce: gapNonce, txid });
            this.incrementGapsFilled();
            filled.push(gapNonce);
            // Record gap-fill fee in per-wallet stats (separate counter for observability)
            await this.recordGapFillFee(walletIndex, GAP_FILL_FEE.toString());
          }
        }
      }

      return {
        previousNonce,
        newNonce: previousNonce,
        changed: filled.length > 0,
        reason:
          filled.length > 0
            ? `gap_filled: broadcast ${filled.length} fill tx(s) for nonces [${filled.join(",")}]`
            : `gaps detected (${sortedGaps.join(",")}) but could not fill (no key or already occupied)`,
      };
    }

    // Auto-recovery: clear gap persist state when no gaps are detected.
    // This ensures wallets return to healthy status once the stuck nonce resolves.
    const existingGapStateForRecovery = await this.state.storage.get<GapPersistState>(
      this.walletGapPersistKey(walletIndex)
    );
    if (existingGapStateForRecovery) {
      await this.state.storage.delete(this.walletGapPersistKey(walletIndex));
      this.log("info", "stuck_nonce_gap_cleared", {
        walletIndex,
        previousStuckNonce: existingGapStateForRecovery.stuckNonce,
        previousCycleCount: existingGapStateForRecovery.cycleCount,
        firstSeen: existingGapStateForRecovery.firstSeen,
      });
    }

    // For wallets other than 0 we don't have a SQL counter, so compare pool head
    const poolHead = await this.loadPoolForWallet(walletIndex);
    const effectivePreviousNonce = walletIndex === 0
      ? previousNonce
      : (poolHead?.available[0] ?? null);

    if (effectivePreviousNonce !== null && possible_next_nonce > effectivePreviousNonce) {
      if (walletIndex === 0) {
        this.setStoredNonce(possible_next_nonce);
      }
      this.incrementConflictsDetected();

      if (poolHead !== null) {
        await this.resetPoolAvailableForWallet(walletIndex, poolHead, possible_next_nonce);
      }

      this.log("warn", "nonce_reconcile_forward_bump", {
        walletIndex,
        previousNonce: effectivePreviousNonce,
        newNonce: possible_next_nonce,
        hiroNextNonce: possible_next_nonce,
        poolReserved: poolHead?.reserved.length ?? 0,
        poolAvailable: poolHead?.available.length ?? 0,
      });

      return {
        previousNonce: effectivePreviousNonce,
        newNonce: possible_next_nonce,
        changed: true,
        reason: `FORWARD BUMP: chain advanced to ${possible_next_nonce}`,
      };
    }

    const lastAssignedAtMs = this.getStateValue(STATE_KEYS.lastAssignedAt);
    const idleMs = lastAssignedAtMs !== null
      ? Date.now() - lastAssignedAtMs
      : Infinity;

    if (
      idleMs > STALE_THRESHOLD_MS &&
      effectivePreviousNonce !== null &&
      effectivePreviousNonce > possible_next_nonce
    ) {
      // Before resetting the pool backward, check for stuck mempool transactions.
      // If transactions are stuck in the mempool at in-flight nonces, a pool reset
      // would only loop: every reset returns to possible_next_nonce which is blocked
      // by the stuck tx. Instead, broadcast a higher-fee replacement (RBF) and defer
      // the pool reset by one alarm cycle to let the replacement confirm.
      const reservedNonces = poolHead?.reserved ?? [];
      if (reservedNonces.length > 0) {
        const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
        if (privateKey) {
          const mempoolTxs = await this.fetchMempoolTxsForAddress(sponsorAddress);
          // Build a map of nonce → mempool entry for O(1) lookup
          const mempoolByNonce = new Map<number, MempoolTxEntry>();
          for (const entry of mempoolTxs) {
            mempoolByNonce.set(entry.nonce, entry);
          }
          const rbfAttempted: number[] = [];
          const rbfTxids: string[] = [];
          for (const reservedNonce of reservedNonces) {
            const mempoolEntry = mempoolByNonce.get(reservedNonce);
            if (!mempoolEntry) continue;
            // Check if the mempool tx has been stuck beyond the threshold
            const receiptMs = new Date(mempoolEntry.receipt_time_iso).getTime();
            if (!Number.isFinite(receiptMs)) {
              this.log("warn", "invalid_mempool_receipt_time", {
                walletIndex,
                reservedNonce,
                txId: mempoolEntry.tx_id,
                receiptTimeIso: mempoolEntry.receipt_time_iso,
              });
              continue;
            }
            const ageMs = Date.now() - receiptMs;
            if (ageMs < STUCK_TX_AGE_MS) continue;
            const rbfTxid = await this.broadcastRbfForNonce(
              walletIndex,
              reservedNonce,
              privateKey,
              mempoolEntry.tx_id
            );
            if (rbfTxid) {
              rbfAttempted.push(reservedNonce);
              rbfTxids.push(rbfTxid);
            }
          }
          if (rbfAttempted.length > 0) {
            this.log("info", "rbf_deferred_reset", {
              walletIndex,
              rbfNonces: rbfAttempted,
              rbfTxids,
              idleSeconds: Math.round(idleMs / 1000),
              possibleNextNonce: possible_next_nonce,
              poolReserved: reservedNonces.length,
            });
            // Defer pool reset: give the RBF tx a chance to confirm on the next alarm cycle
            return {
              previousNonce: effectivePreviousNonce,
              newNonce: effectivePreviousNonce,
              changed: false,
              reason: `RBF_DEFERRED_RESET: broadcast ${rbfAttempted.length} replacement(s) for stuck nonces [${rbfAttempted.join(",")}], deferring pool reset`,
            };
          }
        }
      }

      if (walletIndex === 0) {
        this.setStoredNonce(possible_next_nonce);
      }
      this.incrementConflictsDetected();

      if (poolHead !== null) {
        await this.resetPoolAvailableForWallet(walletIndex, poolHead, possible_next_nonce);
      }

      this.log("warn", "nonce_reconcile_stale", {
        walletIndex,
        previousNonce: effectivePreviousNonce,
        newNonce: possible_next_nonce,
        idleSeconds: Math.round(idleMs / 1000),
        hiroNextNonce: possible_next_nonce,
        poolReserved: poolHead?.reserved.length ?? 0,
        poolAvailable: poolHead?.available.length ?? 0,
      });

      return {
        previousNonce: effectivePreviousNonce,
        newNonce: possible_next_nonce,
        changed: true,
        reason: `STALE DETECTION: idle ${Math.round(idleMs / 1000)}s, reset to chain nonce ${possible_next_nonce}`,
      };
    }

    // POOL REFILL: pool is aligned with chain but below target size — refill without bumping head
    if (
      poolHead !== null &&
      poolHead.available.length < POOL_SEED_SIZE &&
      poolHead.reserved.length === 0 &&
      (effectivePreviousNonce === null || possible_next_nonce === effectivePreviousNonce)
    ) {
      await this.resetPoolAvailableForWallet(
        walletIndex,
        poolHead,
        effectivePreviousNonce ?? possible_next_nonce
      );
      return {
        previousNonce: effectivePreviousNonce,
        newNonce: effectivePreviousNonce ?? possible_next_nonce,
        changed: true,
        reason: `POOL REFILL: available ${poolHead.available.length} < ${POOL_SEED_SIZE}, re-seeded from nonce ${effectivePreviousNonce ?? possible_next_nonce}`,
      };
    }

    return {
      previousNonce: effectivePreviousNonce,
      newNonce: effectivePreviousNonce,
      changed: false,
      reason: "nonce is consistent with chain state",
    };
  }

  /**
   * Reset pool.available for a specific wallet to a fresh range starting at newHead.
   * NEVER touches pool.reserved or pool.spent.
   * Skips any nonce already in pool.reserved[] or pool.spent[] to prevent overlap.
   * Enforces the invariant: available ∩ reserved = ∅ and available ∩ spent = ∅.
   */
  private async resetPoolAvailableForWallet(
    walletIndex: number,
    pool: PoolState,
    newHead: number
  ): Promise<void> {
    const availableSlots = Math.max(1, POOL_SEED_SIZE - pool.reserved.length);
    // Exclude both reserved and spent nonces from the new available range
    const excludedSet = new Set([...pool.reserved, ...pool.spent]);
    const newAvailable: number[] = [];
    const prevAvailableCount = pool.available.length;
    // Search up to 2x the seed size beyond newHead to find enough non-excluded slots
    const searchLimit = newHead + POOL_SEED_SIZE * 2;
    for (
      let candidate = newHead;
      candidate < searchLimit && newAvailable.length < availableSlots;
      candidate++
    ) {
      if (!excludedSet.has(candidate)) {
        newAvailable.push(candidate);
      }
    }
    // unfilled > 0 means we couldn't find enough non-excluded candidates within the search limit
    const unfilled = availableSlots - newAvailable.length;
    if (unfilled > 0) {
      this.log("warn", "pool_reset_unfilled", {
        walletIndex,
        unfilled,
        availableSlots,
        filled: newAvailable.length,
        excludedCount: excludedSet.size,
        searchLimit,
      });
    }
    pool.available = newAvailable;
    pool.maxNonce =
      newAvailable.length > 0
        ? newAvailable[newAvailable.length - 1]
        : newHead + availableSlots - 1;
    await this.savePoolForWallet(walletIndex, pool);

    this.log("info", "pool_available_reset", {
      walletIndex,
      newHead,
      availableSlots,
      newAvailableCount: newAvailable.length,
      prevAvailableCount,
      reservedCount: pool.reserved.length,
      spentCount: pool.spent.length,
      unfilled,
      maxNonce: pool.maxNonce,
    });
  }

  /**
   * Gap-aware nonce reconciliation for all initialized wallets, returning a structured response.
   */
  private async performResync(): Promise<{
    success: true;
    action: "resync";
    wallets: Array<{
      walletIndex: number;
      previousNonce: number | null;
      newNonce: number | null;
      changed: boolean;
      reason: string;
    }>;
  }> {
    const initializedWallets = await this.getInitializedWallets();
    const wallets: Array<{
      walletIndex: number;
      previousNonce: number | null;
      newNonce: number | null;
      changed: boolean;
      reason: string;
    }> = [];
    for (const { walletIndex, address } of initializedWallets) {
      const result = await this.reconcileNonceForWallet(walletIndex, address);
      if (result === null) {
        throw new Error("Hiro API unavailable");
      }
      wallets.push({ walletIndex, ...result });
    }
    return { success: true, action: "resync", wallets };
  }

  /**
   * Perform a hard nonce reset for all initialized wallets to safe floor: last_executed_tx_nonce + 1.
   */
  private async performReset(): Promise<{
    success: true;
    action: "reset";
    wallets: Array<{
      walletIndex: number;
      previousNonce: number | null;
      newNonce: number;
      changed: boolean;
    }>;
  }> {
    const initializedWallets = await this.getInitializedWallets();
    const wallets: Array<{
      walletIndex: number;
      previousNonce: number | null;
      newNonce: number;
      changed: boolean;
    }> = [];
    for (const { walletIndex, address } of initializedWallets) {
      let nonceInfo: HiroNonceInfo;
      try {
        nonceInfo = await this.fetchNonceInfo(address);
      } catch (_e) {
        throw new Error("Hiro API unavailable");
      }

      this.setStateValue(STATE_KEYS.lastHiroSync, Date.now());

      const safeFloor = nonceInfo.last_executed_tx_nonce === null
        ? 0
        : nonceInfo.last_executed_tx_nonce + 1;

      // Determine previous head: wallet 0 uses SQL counter, others use pool head
      const pool = await this.loadPoolForWallet(walletIndex);
      const previousNonce = walletIndex === 0
        ? this.getStoredNonce()
        : (pool?.available[0] ?? null);
      const changed = previousNonce !== safeFloor;

      // Wallet 0: also update the stored scalar nonce used by legacy paths
      if (walletIndex === 0) {
        this.setStoredNonce(safeFloor);
      }
      if (changed) {
        this.incrementConflictsDetected();
      }

      if (pool !== null) {
        await this.resetPoolAvailableForWallet(walletIndex, pool, safeFloor);
      }

      wallets.push({
        walletIndex,
        previousNonce,
        newNonce: safeFloor,
        changed,
      });
    }
    return { success: true, action: "reset", wallets };
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      try {
        const initializedWallets = await this.getInitializedWallets();
        let totalReservedAfterCycle = 0;

        for (const { walletIndex, address } of initializedWallets) {
          // reconcileNonceForWallet returns null when Hiro is unreachable — skip silently
          await this.reconcileNonceForWallet(walletIndex, address);

          // Pool invariant self-check: evict any available nonce below Hiro's possible_next_nonce.
          // Catches nonces that became confirmed between alarm cycles (time-window stale heads).
          const cached = this.hiroNonceCache.get(walletIndex);
          let pool = await this.loadPoolForWallet(walletIndex);
          if (cached && pool !== null) {
            const staleCount = pool.available.filter(n => n < cached.value).length;
            if (staleCount > 0) {
              pool.available = pool.available.filter(n => n >= cached.value);
              await this.savePoolForWallet(walletIndex, pool);
              this.log("warn", "pool_invariant_violation", {
                walletIndex,
                staleEvicted: staleCount,
                possibleNextNonce: cached.value,
                poolAvailable: pool.available.length,
              });
            }
          }

          // Clean up StuckTxState entries for nonces that have been confirmed on-chain.
          // A nonce is confirmed when it is <= possible_next_nonce - 1 (i.e., the chain
          // has advanced past it). If the confirmed nonce had RBF attempts, it means our
          // replacement tx succeeded — increment the stuckTxRbfConfirmed counter.
          if (cached) {
            const confirmedThreshold = cached.value - 1; // nonces <= this are confirmed
            pool = await this.loadPoolForWallet(walletIndex);
            if (pool !== null) {
              // Check recently-spent nonces: these are the ones that were broadcast and
              // may have been stuck. We can't enumerate all possible nonces cheaply, so
              // check the spent[] array for any nonce that has RBF state and is now confirmed.
              const spentConfirmed = pool.spent.filter(n => n <= confirmedThreshold);
              for (const confirmedNonce of spentConfirmed) {
                const stuckKey = this.walletStuckTxKey(walletIndex, confirmedNonce);
                const stuckState = await this.state.storage.get<StuckTxState>(stuckKey);
                if (stuckState && stuckState.rbfAttempts > 0) {
                  this.incrementStuckTxRbfConfirmed();
                  this.log("info", "stuck_tx_rbf_confirmed", {
                    walletIndex,
                    nonce: confirmedNonce,
                    rbfAttempts: stuckState.rbfAttempts,
                    lastRbfTxid: stuckState.lastRbfTxid,
                    originalTxid: stuckState.originalTxid,
                  });
                }
                if (stuckState) {
                  await this.state.storage.delete(stuckKey);
                }
              }
            }
          }

          // Clean stale reservations: release nonces reserved > 10 min ago with no broadcast
          if (pool !== null) {
            const released = this.cleanStaleReservations(pool, walletIndex);
            if (released > 0) {
              await this.savePoolForWallet(walletIndex, pool);
              this.log("info", "stale_reservations_cleaned", { walletIndex, released });
              // Trigger eager refill if any stale nonces were quarantined (moved to spent[]),
              // which would have shrunk available[]. The alarm reconciliation already ran
              // above, but cleanStaleReservations may have further reduced available[].
              await this.triggerEagerRefillForWallet(walletIndex, pool);
            }
            totalReservedAfterCycle += pool.reserved.length;
          }
        }

        // Dynamic alarm interval: use active (60s) when any wallet has in-flight nonces,
        // idle (5min) when all wallets are drained. This ensures rapid reconciliation
        // during traffic bursts and doesn't hammer Hiro unnecessarily when idle.
        const isActive = totalReservedAfterCycle > 0;
        const intervalMs = isActive ? ALARM_INTERVAL_ACTIVE_MS : ALARM_INTERVAL_IDLE_MS;
        this.log("info", "nonce_alarm_scheduled", {
          intervalMs,
          activeWallets: initializedWallets.length,
          totalReserved: totalReservedAfterCycle,
          isActive,
        });
        await this.scheduleAlarm(isActive);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const stack = error instanceof Error ? error.stack : undefined;
        this.log("error", "nonce_alarm_failed", { message, stack });
        // Ensure we always reschedule even if the cycle threw an unexpected error
        await this.scheduleAlarm(false);
      }
    });
  }

  /**
   * Shared handler for /resync and /reset RPC routes (operates on all initialized wallets).
   */
  private async handleRecoveryAction(action: "resync" | "reset"): Promise<Response> {
    try {
      // Verify at least wallet 0 is initialized before attempting recovery
      const wallet0Address = await this.getStoredSponsorAddressForWallet(0);
      if (!wallet0Address) {
        return this.badRequest("No sponsor address stored; call /assign first");
      }
      const result = action === "reset"
        ? await this.state.blockConcurrencyWhile(() => this.performReset())
        : await this.state.blockConcurrencyWhile(() => this.performResync());
      return this.jsonResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message === "Hiro API unavailable") {
        return this.jsonResponse({ error: "Hiro API unavailable" }, 503);
      }
      return this.internalError(error);
    }
  }

  /**
   * Clear all per-wallet pool state and stored addresses.
   * Pools will reinitialize from Hiro on the next /assign call.
   */
  private async handleClearPools(): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const initializedWallets = await this.getInitializedWallets();
      for (const { walletIndex } of initializedWallets) {
        await this.state.storage.delete(this.poolKey(walletIndex));
        await this.state.storage.delete(this.sponsorAddressKey(walletIndex));
      }
      // Reset round-robin index
      await this.state.storage.put(NEXT_WALLET_INDEX_KEY, 0);

      const cleared = initializedWallets.length;
      const reason = cleared > 0
        ? `Cleared ${cleared} wallet${cleared === 1 ? "" : "s"}`
        : "No wallets to clear";
      const result = {
        success: true,
        action: "clear_pools",
        previousNonce: null,
        newNonce: null,
        changed: cleared > 0,
        reason,
      };
      this.log("info", "clear_pools", { action: result.action, changed: result.changed, reason: result.reason });
      return this.jsonResponse(result);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/assign") {
      const { value: body, errorResponse } =
        await this.parseJson<AssignNonceRequest>(request);
      if (errorResponse) {
        return errorResponse;
      }

      if (!body?.sponsorAddress) {
        return this.badRequest("Missing sponsorAddress");
      }

      const walletCount = typeof body.walletCount === "number"
        ? Math.max(1, Math.min(body.walletCount, MAX_WALLET_COUNT))
        : 1;

      try {
        const result = await this.assignNonce(body.sponsorAddress, walletCount, body.addresses);
        const response: AssignNonceResponse = {
          nonce: result.nonce,
          walletIndex: result.walletIndex,
          sponsorAddress: body.sponsorAddress,
          totalReserved: result.totalReserved,
        };
        return this.jsonResponse(response);
      } catch (error) {
        if (error instanceof ChainingLimitError) {
          const mempoolDepth = error.mempoolDepth;
          // Assume ~2 txs/s drain rate (conservative estimate for Stacks testnet/mainnet)
          const estimatedDrainSeconds = Math.ceil(mempoolDepth / 2);
          return this.jsonResponse(
            {
              error: "Chaining limit exceeded; too many in-flight nonces",
              code: "CHAINING_LIMIT_EXCEEDED",
              mempoolDepth,
              estimatedDrainSeconds,
            },
            429
          );
        }
        return this.internalError(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const { value: body, errorResponse } =
        await this.parseJson<ReleaseNonceRequest>(request);
      if (errorResponse) {
        return errorResponse;
      }

      if (typeof body?.nonce !== "number") {
        return this.badRequest("Missing nonce");
      }

      const walletIndex = typeof body.walletIndex === "number"
        ? Math.max(0, Math.min(body.walletIndex, MAX_WALLET_COUNT - 1))
        : 0;

      // fee is optional; only recorded when present and txid is also present
      const fee = typeof body.fee === "string" && body.fee.length > 0 ? body.fee : undefined;

      try {
        await this.releaseNonce(body.nonce, body.txid, walletIndex, fee);
        return this.jsonResponse({ success: true });
      } catch (error) {
        return this.internalError(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/record") {
      const { value: body, errorResponse } =
        await this.parseJson<RecordTxidRequest>(request);
      if (errorResponse) {
        return errorResponse;
      }

      if (!body?.txid || typeof body.nonce !== "number") {
        return this.badRequest("Missing txid or nonce");
      }

      try {
        await this.recordTxid(body.txid, body.nonce);
        return this.jsonResponse({ success: true });
      } catch (error) {
        return this.internalError(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/lookup") {
      const { value: body, errorResponse } =
        await this.parseJson<LookupTxidRequest>(request);
      if (errorResponse) {
        return errorResponse;
      }

      if (!body?.txid) {
        return this.badRequest("Missing txid");
      }

      try {
        const nonce = await this.getNonceForTxid(body.txid);
        const response: LookupTxidResponse =
          nonce === null ? { found: false } : { found: true, nonce };
        return this.jsonResponse(response);
      } catch (error) {
        return this.internalError(error);
      }
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      try {
        const stats = await this.getStats();
        return this.jsonResponse(stats);
      } catch (error) {
        return this.internalError(error);
      }
    }

    // GET /wallet-fees/:walletIndex — returns fee stats for a specific wallet
    const walletFeesMatch = url.pathname.match(/^\/wallet-fees\/(\d+)$/);
    if (request.method === "GET" && walletFeesMatch) {
      const wi = parseInt(walletFeesMatch[1], 10);
      if (!Number.isInteger(wi) || wi < 0 || wi >= MAX_WALLET_COUNT) {
        return this.badRequest("Invalid wallet index");
      }
      try {
        const feeStats = await this.getWalletFeeStats(wi);
        return this.jsonResponse(feeStats);
      } catch (error) {
        return this.internalError(error);
      }
    }

    if (request.method === "POST" && (url.pathname === "/resync" || url.pathname === "/reset")) {
      return this.handleRecoveryAction(
        url.pathname === "/reset" ? "reset" : "resync"
      );
    }

    if (request.method === "POST" && url.pathname === "/clear-pools") {
      return this.handleClearPools();
    }

    // GET /ledger — diagnostic endpoint for inspecting nonce intent ledger state.
    // Returns current nonce_intents rows, last 100 nonce_events, and state counts.
    // This is an internal DO endpoint (not exposed through the Hono router).
    if (request.method === "GET" && url.pathname === "/ledger") {
      try {
        const intents = this.sql
          .exec("SELECT * FROM nonce_intents ORDER BY wallet_index ASC, nonce ASC")
          .toArray();
        const recentEvents = this.sql
          .exec("SELECT * FROM nonce_events ORDER BY id DESC LIMIT 100")
          .toArray();
        const intentCounts = this.sql
          .exec("SELECT state, COUNT(*) as count FROM nonce_intents GROUP BY state")
          .toArray();
        return this.jsonResponse({
          intents,
          recentEvents,
          intentCounts,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        return this.internalError(error);
      }
    }

    return new Response("Not found", { status: 404 });
  }
}
