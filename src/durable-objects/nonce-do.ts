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

interface BroadcastOutcomeRequest {
  nonce: number;
  /** Which wallet pool owns this nonce (default: 0) */
  walletIndex?: number;
  /** Transaction ID returned by the broadcast node on success */
  txid?: string;
  /** HTTP status code returned by the broadcast node */
  httpStatus?: number;
  /** Base URL of the broadcast node */
  nodeUrl?: string;
  /** Error string returned by the broadcast node on failure */
  errorReason?: string;
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
  /** Highest nonce seen in this node's mempool for this address (null if none) */
  last_mempool_tx_nonce: number | null;
  /** Next nonce the network considers valid for submission */
  possible_next_nonce: number;
  /** Nonces in the mempool that are creating gaps (missing nonces below them) */
  detected_missing_nonces: number[];
  /** All nonces currently visible in Hiro's mempool view for this address */
  detected_mempool_nonces: number[];
}

/** Result of a nonce reconciliation pass (shared by alarm and resync) */
interface ReconcileResult {
  previousNonce: number | null;
  newNonce: number | null;
  changed: boolean;
  reason: string;
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
/**
 * Maximum allowed lookahead distance beyond Hiro's possible_next_nonce.
 * If the next nonce to assign would exceed hiroNextNonce + LOOKAHEAD_GUARD_BUFFER,
 * we refuse the assignment and return a 429. This prevents the head from running so
 * far ahead of confirmed chain state that a resync would lose already-assigned nonces.
 * Set equal to CHAINING_LIMIT (20) — same as the in-flight cap for symmetry.
 */
const LOOKAHEAD_GUARD_BUFFER = CHAINING_LIMIT;

const ALARM_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Alarm interval used when there are in-flight nonces (assigned state > 0).
 * Fires at 60s so reconciliation catches conflicts during traffic bursts.
 */
const ALARM_INTERVAL_ACTIVE_MS = 60 * 1000;
/**
 * Alarm interval used when all wallets are idle (no assigned nonces in ledger).
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
  // Per-wallet address and round-robin helpers
  // ---------------------------------------------------------------------------

  /** KV key for per-wallet sponsor address */
  private sponsorAddressKey(walletIndex: number): string {
    return `sponsor_address:${walletIndex}`;
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
      last_mempool_tx_nonce: typeof data.last_mempool_tx_nonce === "number"
        ? data.last_mempool_tx_nonce
        : null,
      possible_next_nonce: data.possible_next_nonce,
      detected_missing_nonces: Array.isArray(data.detected_missing_nonces)
        ? data.detected_missing_nonces
        : [],
      detected_mempool_nonces: Array.isArray(data.detected_mempool_nonces)
        ? data.detected_mempool_nonces
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

  // ---------------------------------------------------------------------------
  // Nonce intent ledger helpers
  // These methods write to nonce_intents and nonce_events tables.
  // They are NEVER allowed to throw — errors are logged at debug level so the
  // critical nonce assignment / release path is never disrupted by ledger failures.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Nonce intent ledger reads (Phase 2: replace pool-array reads with SQL queries)
  // All decisional reads (chaining-limit checks, pool pressure, stats) are
  // driven by ledger queries. nonce_intents is the sole source of truth.
  // ---------------------------------------------------------------------------

  /**
   * Count in-flight nonces for a specific wallet from the ledger.
   * 'assigned' state = nonce was handed out but not yet released.
   * Used for chaining-limit checks and pool-pressure calculations.
   */
  private ledgerReservedCount(walletIndex: number): number {
    const rows = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM nonce_intents WHERE wallet_index = ? AND state = 'assigned'",
        walletIndex
      )
      .toArray();
    return rows[0]?.count ?? 0;
  }

  /**
   * Count in-flight nonces across all wallets with index < walletCount.
   * Used to compute totalReserved (pool pressure signal) in assignNonce().
   */
  private ledgerTotalReservedForWallets(walletCount: number): number {
    const rows = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM nonce_intents WHERE wallet_index < ? AND state = 'assigned'",
        walletCount
      )
      .toArray();
    return rows[0]?.count ?? 0;
  }

  /**
   * Count in-flight nonces across ALL wallets from the ledger.
   * Used by alarm() to determine whether to schedule at active or idle interval.
   */
  private ledgerTotalAssigned(): number {
    const rows = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM nonce_intents WHERE state = 'assigned'"
      )
      .toArray();
    return rows[0]?.count ?? 0;
  }

  /**
   * Return per-state counts for a specific wallet from the ledger.
   * Used by getStats() to report reserved count from the authoritative source.
   */
  private ledgerCountsByWallet(walletIndex: number): {
    assigned: number;
    confirmed: number;
    failed: number;
    expired: number;
  } {
    const rows = this.sql
      .exec<{ state: string; count: number }>(
        "SELECT state, COUNT(*) as count FROM nonce_intents WHERE wallet_index = ? GROUP BY state",
        walletIndex
      )
      .toArray();
    const result = { assigned: 0, confirmed: 0, failed: 0, expired: 0 };
    for (const row of rows) {
      if (row.state in result) {
        result[row.state as keyof typeof result] = row.count;
      }
    }
    return result;
  }

  /**
   * Write 'assigned' intent + event for a newly reserved nonce.
   * This is the authoritative assignment record — the sole source of truth.
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
   * txid absent + no reason → 'expired' state (nonce never broadcast, creates a gap)
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
        // 'confirmed' here means "broadcast accepted by the network".
        // Reconciliation will further validate on-chain confirmation.
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
        // Nonce was never broadcast — mark expired (creates a gap that reconciliation may fill).
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
   * Write broadcast outcome to the intent ledger.
   * Called from the public recordBroadcastOutcome() method and the POST /broadcast-outcome route.
   *
   * txid present   → state='broadcasted': broadcast accepted, txid/http_status/broadcast_node recorded
   * txid absent    → state='conflict' (ConflictingNonceInMempool) or state='failed' (other 4xx)
   *
   * This is separate from ledgerRelease() which handles pool-maintenance concerns
   * (fee accounting, pool availability). ledgerBroadcastOutcome() records the HTTP-level
   * broadcast signal with full provenance (http_status, node_url, error_reason).
   *
   * Never throws — fail-open, errors logged at debug.
   */
  private ledgerBroadcastOutcome(
    walletIndex: number,
    nonce: number,
    txid: string | undefined,
    httpStatus: number | undefined,
    nodeUrl: string | undefined,
    errorReason: string | undefined
  ): void {
    try {
      const now = new Date().toISOString();
      if (txid) {
        // Broadcast accepted — record txid, status, node URL
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = 'broadcasted', txid = ?, http_status = ?,
               broadcast_node = ?, broadcasted_at = ?
           WHERE wallet_index = ? AND nonce = ?`,
          txid,
          httpStatus ?? 200,
          nodeUrl ?? null,
          now,
          walletIndex,
          nonce
        );
        this.sql.exec(
          `INSERT INTO nonce_events
             (wallet_index, nonce, event, detail, created_at)
           VALUES (?, ?, 'broadcasted', ?, ?)`,
          walletIndex,
          nonce,
          JSON.stringify({ txid, httpStatus: httpStatus ?? 200, nodeUrl: nodeUrl ?? null }),
          now
        );
      } else {
        // Determine if this is a nonce conflict (quarantine) or generic failure
        const isConflict =
          errorReason !== undefined &&
          (errorReason.includes("ConflictingNonceInMempool") ||
            errorReason.includes("conflict:quarantine"));
        const newState = isConflict ? "conflict" : "failed";
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = ?, http_status = ?, broadcast_node = ?,
               error_reason = ?, broadcasted_at = ?
           WHERE wallet_index = ? AND nonce = ?`,
          newState,
          httpStatus ?? null,
          nodeUrl ?? null,
          errorReason ?? null,
          now,
          walletIndex,
          nonce
        );
        this.sql.exec(
          `INSERT INTO nonce_events
             (wallet_index, nonce, event, detail, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          walletIndex,
          nonce,
          isConflict ? "conflict" : "broadcast_fail",
          JSON.stringify({
            httpStatus: httpStatus ?? null,
            nodeUrl: nodeUrl ?? null,
            errorReason: errorReason ?? null,
          }),
          now
        );
      }
    } catch (e) {
      this.log("debug", "ledger_broadcast_outcome_error", {
        walletIndex,
        nonce,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Record the HTTP-level broadcast outcome for a nonce in the intent ledger.
   * Exposed as a public method for access via the DO stub RPC.
   *
   * On success (txid non-empty): updates state → 'broadcasted' with txid, http_status, broadcast_node.
   * On conflict (ConflictingNonceInMempool): updates state → 'conflict'.
   * On other failure (4xx): updates state → 'failed' with error_reason.
   *
   * This call is fire-and-forget from the relay/sponsor broadcast path.
   * It runs alongside releaseNonceDO() which handles pool-maintenance side-effects.
   */
  async recordBroadcastOutcome(
    nonce: number,
    walletIndex: number,
    txid: string | undefined,
    httpStatus: number | undefined,
    nodeUrl: string | undefined,
    errorReason: string | undefined
  ): Promise<void> {
    this.ledgerBroadcastOutcome(walletIndex, nonce, txid, httpStatus, nodeUrl, errorReason);
  }

  // ---------------------------------------------------------------------------
  // Nonce intent ledger reads (Phase 3: reconciliation cross-reference helpers)
  // These methods query nonce_intents and nonce_events for ledger-first reconciliation.
  // All write helpers are NEVER allowed to throw — fail-open, errors logged at debug.
  // ---------------------------------------------------------------------------

  /**
   * Return all nonce_intents rows for a wallet that have a txid recorded.
   * Covers both 'confirmed' (successful broadcast) and 'failed' (broadcast attempted) states.
   * Used by reconcileNonceForWallet to cross-reference broadcasted nonces against Hiro state.
   */
  private ledgerGetBroadcastedNonces(walletIndex: number): Array<{
    nonce: number;
    txid: string;
    assigned_at: string;
    broadcasted_at: string | null;
  }> {
    return this.sql
      .exec<{ nonce: number; txid: string; assigned_at: string; broadcasted_at: string | null }>(
        "SELECT nonce, txid, assigned_at, broadcasted_at FROM nonce_intents WHERE wallet_index = ? AND txid IS NOT NULL",
        walletIndex
      )
      .toArray();
  }

  /**
   * Return all nonce_intents rows for a wallet currently in 'assigned' state.
   * These are nonces handed out but not yet released (in-flight, pending broadcast).
   * Used by reconcileNonceForWallet to detect stale assignments.
   */
  private ledgerGetAssignedNonces(walletIndex: number): Array<{
    nonce: number;
    assigned_at: string;
  }> {
    return this.sql
      .exec<{ nonce: number; assigned_at: string }>(
        "SELECT nonce, assigned_at FROM nonce_intents WHERE wallet_index = ? AND state = 'assigned'",
        walletIndex
      )
      .toArray();
  }

  /**
   * Mark a nonce as confirmed during reconciliation (chain advanced past it).
   * Updates the intent state to 'confirmed' if not already; writes a reconcile_confirmed event.
   * Fail-open — never throws.
   */
  private ledgerMarkConfirmedByReconcile(walletIndex: number, nonce: number, txid: string): void {
    try {
      const now = new Date().toISOString();
      this.sql.exec(
        `UPDATE nonce_intents
         SET state = 'confirmed', txid = ?, broadcasted_at = COALESCE(broadcasted_at, ?), confirmed_at = ?
         WHERE wallet_index = ? AND nonce = ? AND state != 'confirmed'`,
        txid,
        now,
        now,
        walletIndex,
        nonce
      );
      this.sql.exec(
        `INSERT INTO nonce_events (wallet_index, nonce, event, detail, created_at)
         VALUES (?, ?, 'reconcile_confirmed', ?, ?)`,
        walletIndex,
        nonce,
        JSON.stringify({ txid, reason: "chain_advanced_past_nonce" }),
        now
      );
    } catch (e) {
      this.log("debug", "ledger_reconcile_confirmed_error", {
        walletIndex,
        nonce,
        txid,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Mark an assigned nonce as expired during reconciliation (stale, never broadcast).
   * Updates the intent state to 'expired'; writes a reconcile_expired event.
   * Fail-open — never throws.
   */
  private ledgerMarkExpiredByReconcile(walletIndex: number, nonce: number, reason: string): void {
    try {
      const now = new Date().toISOString();
      this.sql.exec(
        `UPDATE nonce_intents
         SET state = 'expired', error_reason = ?
         WHERE wallet_index = ? AND nonce = ? AND state = 'assigned'`,
        reason,
        walletIndex,
        nonce
      );
      this.sql.exec(
        `INSERT INTO nonce_events (wallet_index, nonce, event, detail, created_at)
         VALUES (?, ?, 'reconcile_expired', ?, ?)`,
        walletIndex,
        nonce,
        JSON.stringify({ reason }),
        now
      );
    } catch (e) {
      this.log("debug", "ledger_reconcile_expired_error", {
        walletIndex,
        nonce,
        reason,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Record a gap-fill broadcast in the ledger for a nonce with no prior intent.
   * Inserts or replaces an intent row in 'confirmed' state with the fill txid.
   * Fail-open — never throws.
   */
  private ledgerInsertGapFill(walletIndex: number, nonce: number, txid: string): void {
    try {
      const now = new Date().toISOString();
      this.sql.exec(
        `INSERT OR REPLACE INTO nonce_intents
           (wallet_index, nonce, state, txid, assigned_at, broadcasted_at, confirmed_at)
         VALUES (?, ?, 'confirmed', ?, ?, ?, ?)`,
        walletIndex,
        nonce,
        txid,
        now,
        now,
        now
      );
      this.sql.exec(
        `INSERT INTO nonce_events (wallet_index, nonce, event, detail, created_at)
         VALUES (?, ?, 'gap_fill_broadcast', ?, ?)`,
        walletIndex,
        nonce,
        JSON.stringify({ txid }),
        now
      );
    } catch (e) {
      this.log("debug", "ledger_gap_fill_insert_error", {
        walletIndex,
        nonce,
        txid,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Per-wallet nonce head helpers (ledger-authoritative)
  // ---------------------------------------------------------------------------

  /**
   * Get the next nonce head for a specific wallet from the ledger.
   * Wallet 0: uses STATE_KEYS.current (the existing SQL nonce counter).
   * Wallets 1+: uses `wallet_next_nonce:{walletIndex}` key in nonce_state.
   * Returns null if the wallet has never been seeded.
   */
  private ledgerGetWalletHead(walletIndex: number): number | null {
    if (walletIndex === 0) {
      return this.getStoredNonce();
    }
    return this.getStateValue(`wallet_next_nonce:${walletIndex}`);
  }

  /**
   * Advance the per-wallet nonce head to `nextNonce`.
   * Wallet 0: updates STATE_KEYS.current.
   * Wallets 1+: updates `wallet_next_nonce:{walletIndex}` in nonce_state.
   */
  private ledgerAdvanceWalletHead(walletIndex: number, nextNonce: number): void {
    if (walletIndex === 0) {
      this.setStoredNonce(nextNonce);
    } else {
      this.setStateValue(`wallet_next_nonce:${walletIndex}`, nextNonce);
    }
  }

  /**
   * Initialize the per-wallet nonce head from Hiro if not yet seeded.
   * Returns the head nonce to use for the first assignment.
   */
  private async initWalletHeadFromHiro(
    walletIndex: number,
    sponsorAddress: string
  ): Promise<number> {
    const existing = this.ledgerGetWalletHead(walletIndex);
    if (existing !== null) return existing;
    const nonceInfo = await this.fetchNonceInfo(sponsorAddress);
    const seedNonce = nonceInfo.possible_next_nonce;
    this.ledgerAdvanceWalletHead(walletIndex, seedNonce);
    return seedNonce;
  }

  /**
   * Assign a nonce for a specific wallet using the ledger as sole source of truth.
   *
   * With walletCount=1 (default): identical behavior to single-wallet mode.
   * With walletCount=N: round-robin across N wallets, each with independent CHAINING_LIMIT.
   *
   * On first call for a wallet: seeds head nonce from Hiro.
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

      // Resolve the correct sponsor address for a given wallet index.
      // In multi-wallet mode, each wallet has its own Stacks address for nonce seeding.
      const resolveAddress = (wi: number): string =>
        addresses?.[String(wi)] ?? sponsorAddress;

      // Try each wallet in round-robin order; skip any at chaining limit or degraded (stuck nonce)
      let attempts = 0;
      let totalMempoolDepth = 0;
      // Track degraded wallets for fallback (walletIndex only — no pool state needed)
      const degradedWallets: Array<{ walletIndex: number; cycleCount: number }> = [];
      let selectedWalletIndex: number | null = null;

      while (attempts < effectiveWalletCount) {
        // Ensure wallet head is initialized before circuit breaker check
        await this.initWalletHeadFromHiro(walletIndex, resolveAddress(walletIndex));

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
          degradedWallets.push({ walletIndex, cycleCount: 0 });
          walletIndex = (walletIndex + 1) % effectiveWalletCount;
          attempts++;
          continue;
        }

        if (this.ledgerReservedCount(walletIndex) < CHAINING_LIMIT) {
          selectedWalletIndex = walletIndex;
          break;
        }
        // This wallet is at its chaining limit; accumulate depth and try the next
        totalMempoolDepth += this.ledgerReservedCount(walletIndex);
        walletIndex = (walletIndex + 1) % effectiveWalletCount;
        attempts++;
      }

      if (selectedWalletIndex === null) {
        // All wallets are either at chaining limit or degraded.
        // If there are degraded-but-not-full wallets, use the least-degraded one as fallback
        // rather than failing with a misleading CHAINING_LIMIT_EXCEEDED error.
        const degradedNotFull = degradedWallets.filter(
          (d) => this.ledgerReservedCount(d.walletIndex) < CHAINING_LIMIT
        );
        if (degradedNotFull.length > 0) {
          // Sort ascending by cycleCount, pick least-degraded wallet
          degradedNotFull.sort((a, b) => a.cycleCount - b.cycleCount);
          const fallback = degradedNotFull[0];
          selectedWalletIndex = fallback.walletIndex;
          this.log("warn", "all_wallets_degraded_using_least_degraded", {
            walletIndex: selectedWalletIndex,
            cycleCount: fallback.cycleCount,
            degradedCount: degradedWallets.length,
          });
        } else {
          throw new ChainingLimitError(totalMempoolDepth);
        }
      }

      walletIndex = selectedWalletIndex;

      // Store the per-wallet sponsor address (used by alarm reconciliation)
      await this.setStoredSponsorAddressForWallet(walletIndex, resolveAddress(walletIndex));

      // Fetch current Hiro possible_next_nonce (with 30s cache) for stale-head guard.
      // Also used by lookahead cap guard below. Fail-open: null means Hiro unreachable.
      const walletAddr = resolveAddress(walletIndex);
      const hiroNextNonce = await this.fetchNextNonceForWallet(walletIndex, walletAddr);

      // Compute the nonce to assign from the stored head.
      let assignedNonce = this.ledgerGetWalletHead(walletIndex)!;

      // Guard: if Hiro's possible_next_nonce is ahead of our stored head, advance head.
      // This catches the case where txs were confirmed between alarm cycles and the
      // relay's head is stale. Advance to hiroNextNonce to avoid re-using confirmed nonces.
      if (hiroNextNonce !== null && assignedNonce < hiroNextNonce) {
        this.log("warn", "nonce_stale_head_advanced", {
          walletIndex,
          oldHead: assignedNonce,
          hiroNextNonce,
        });
        assignedNonce = hiroNextNonce;
      }

      // Lookahead cap guard: refuse to assign if we are already LOOKAHEAD_GUARD_BUFFER
      // nonces ahead of Hiro's possible_next_nonce. This prevents runaway pre-assignment.
      // Fail-open when Hiro is unreachable (hiroNextNonce === null).
      if (hiroNextNonce !== null && assignedNonce > hiroNextNonce + LOOKAHEAD_GUARD_BUFFER) {
        const reservedCount = this.ledgerReservedCount(walletIndex);
        this.log("warn", "nonce_lookahead_capped", {
          walletIndex,
          assignedNonce,
          hiroNextNonce,
          limit: hiroNextNonce + LOOKAHEAD_GUARD_BUFFER,
          reservedCount,
        });
        // Treat this the same as chaining limit — caller returns 429 so agent can retry
        throw new ChainingLimitError(reservedCount);
      }

      // Advance the stored head to assignedNonce + 1 (next wallet assignment)
      this.ledgerAdvanceWalletHead(walletIndex, assignedNonce + 1);

      // Record the assignment in the intent ledger (authoritative nonce state)
      this.ledgerAssign(walletIndex, assignedNonce);

      this.updateAssignedStats(assignedNonce);

      this.log("info", "nonce_assigned", {
        walletIndex,
        nonce: assignedNonce,
        ledgerReserved: this.ledgerReservedCount(walletIndex),
        nextHead: assignedNonce + 1,
      });

      // Advance round-robin to next wallet
      await this.setNextWalletIndex((walletIndex + 1) % effectiveWalletCount);

      // Compute totalReserved across all wallets for pool pressure signaling.
      const totalReserved = this.ledgerTotalReservedForWallets(effectiveWalletCount);

      this.log("debug", "nonce_pool_pressure", {
        walletIndex,
        totalReserved,
        poolCapacity: effectiveWalletCount * CHAINING_LIMIT,
      });

      return { nonce: assignedNonce, walletIndex, totalReserved };
    });
  }

  /**
   * Release a nonce for the specified wallet — updates only the intent ledger.
   *
   * txid present  → nonce was broadcast successfully; mark as 'confirmed' in ledger.
   * txid absent   → nonce was NOT broadcast (e.g. broadcast failure).
   *                 If a txid was previously recorded in nonce_txids for this nonce,
   *                 mark as 'failed' (quarantine). Otherwise mark as 'expired'.
   * walletIndex   → which wallet the nonce belongs to (default: 0)
   * fee           → when provided with txid (broadcast succeeded), recorded in cumulative wallet stats
   */
  async releaseNonce(nonce: number, txid?: string, walletIndex: number = 0, fee?: string): Promise<void> {
    return this.state.blockConcurrencyWhile(async () => {
      // Verify this nonce is actually in 'assigned' state in the ledger
      const intentRows = this.sql
        .exec<{ state: string; txid: string | null }>(
          "SELECT state, txid FROM nonce_intents WHERE wallet_index = ? AND nonce = ? LIMIT 1",
          walletIndex,
          nonce
        )
        .toArray();

      const intent = intentRows[0] ?? null;
      if (intent === null || intent.state !== "assigned") {
        // Nonce not in assigned state — already released or was never assigned
        return;
      }

      // Track whether this is a failure quarantine (for circuit breaker)
      let failureQuarantined = false;

      if (!txid) {
        // No txid provided: check if a txid was previously recorded in nonce_txids.
        // If so, the nonce was broadcast at some point — quarantine as failure.
        const txidRows = this.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) as count FROM nonce_txids WHERE nonce = ?",
            nonce
          )
          .toArray();
        const hasPriorTxid = (txidRows[0]?.count ?? 0) > 0;

        if (hasPriorTxid) {
          // Nonce was broadcast at some point — quarantine permanently
          failureQuarantined = true;
          this.log("warn", "nonce_quarantined", {
            walletIndex,
            nonce,
            reason: "txid_recorded_on_failed_release",
          });
          this.ledgerRelease(walletIndex, nonce, undefined, "txid_recorded_on_failed_release");
        } else {
          // Truly unused nonce (never broadcast) — mark expired
          // The ledger head already advanced past this nonce on assignment,
          // so this creates a gap that reconciliation will fill if needed.
          this.ledgerRelease(walletIndex, nonce, undefined);
        }
      } else {
        // txid provided: nonce was broadcast successfully — consumed
        if (fee && fee !== "0") {
          // Broadcast succeeded and fee provided — record in wallet stats
          await this.recordWalletFee(walletIndex, fee);
        }
        this.ledgerRelease(walletIndex, nonce, txid);
      }

      this.log("info", "nonce_released", {
        walletIndex,
        nonce,
        consumed: !!txid,
        txid: txid ?? null,
        ledgerReserved: this.ledgerReservedCount(walletIndex),
      });

      // Circuit breaker: only record failure quarantines (not normal consumption).
      if (failureQuarantined) {
        await this.recordQuarantineEvent(walletIndex);
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

    // Build per-wallet stats entirely from ledger SQL queries.
    const initializedWallets = await this.getInitializedWallets();
    const wallets: WalletPoolStats[] = [];
    for (const { walletIndex, address } of initializedWallets) {
      const ledgerCounts = this.ledgerCountsByWallet(Number(walletIndex));
      // available = capacity remaining for new assignments
      const available = Math.max(0, CHAINING_LIMIT - ledgerCounts.assigned);
      // spent = all non-assigned historical nonces (confirmed + failed + expired)
      const spentRows = this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM nonce_intents WHERE wallet_index = ? AND state IN ('confirmed','failed','expired')",
          Number(walletIndex)
        )
        .toArray();
      const spent = spentRows[0]?.count ?? 0;
      // maxNonce = highest nonce ever used for this wallet (or head if no intents)
      const maxNonceRows = this.sql
        .exec<{ maxNonce: number | null }>(
          "SELECT MAX(nonce) as maxNonce FROM nonce_intents WHERE wallet_index = ?",
          Number(walletIndex)
        )
        .toArray();
      const maxNonce = maxNonceRows[0]?.maxNonce ?? (this.ledgerGetWalletHead(Number(walletIndex)) ?? 0);
      wallets.push({
        walletIndex: Number(walletIndex),
        available,
        reserved: ledgerCounts.assigned,   // ledger-authoritative: in-flight nonces
        spent,
        maxNonce,
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
   * Fetch transaction status from Hiro for a specific txid.
   * Returns the tx_status string ("success", "pending", "abort_*", "dropped_*") or null on error.
   * Used by reconcileNonceForWallet to distinguish terminal abort from transient drops.
   * Fail-open — null means skip the status check and proceed conservatively.
   */
  private async fetchTxStatus(txid: string): Promise<string | null> {
    const base = getHiroBaseUrl(this.env.STACKS_NETWORK ?? "testnet");
    const headers = getHiroHeaders(this.env.HIRO_API_KEY);
    try {
      const response = await fetch(`${base}/extended/v1/tx/${txid}`, {
        headers,
        signal: AbortSignal.timeout(HIRO_NONCE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as Record<string, unknown>;
      return typeof data.tx_status === "string" ? data.tx_status : null;
    } catch {
      return null;
    }
  }

  /**
   * Ledger-first nonce reconciliation against Hiro for a specific wallet.
   * The ledger is the primary authority for nonce state.
   * Hiro data points are corroborating signals — they tell us what the network sees;
   * the ledger tells us what we intended.
   *
   * Cross-reference logic:
   * - broadcasted(txid) at N, N <= last_executed_tx_nonce → confirmed
   * - broadcasted(txid) at N, N in detected_mempool_nonces → pending_agree (healthy)
   * - broadcasted(txid) at N, age < 15min, N in detected_missing_nonces → pending_diverge (Hiro lag, wait)
   * - broadcasted(txid) at N, age >= 15min, N in detected_missing_nonces → rbf_candidate (check tx status)
   * - broadcasted(txid) at N, age >= 15min, N not in mempool, N > last_executed → rbf_candidate (evicted)
   * - assigned at N, age > 10min → expired (never broadcast, return nonce to available)
   * - no ledger entry at N, N in detected_missing_nonces → gap_fill (true gap we didn't create)
   * - confirmed at N, N in detected_missing_nonces → ignore (Hiro stale)
   * - failed at N, N in detected_missing_nonces → gap_fill (known failure, fill the gap)
   *
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

    // Populate Hiro nonce cache (used by assignNonce stale-head guard)
    this.hiroNonceCache.set(walletIndex, {
      value: nonceInfo.possible_next_nonce,
      expiresAt: Date.now() + HIRO_NONCE_CACHE_TTL_MS,
    });

    const previousNonce = this.ledgerGetWalletHead(walletIndex);

    // First-time initialization: seed head from Hiro when no local state exists
    if (previousNonce === null) {
      this.ledgerAdvanceWalletHead(walletIndex, nonceInfo.possible_next_nonce);
      return {
        previousNonce: null,
        newNonce: nonceInfo.possible_next_nonce,
        changed: true,
        reason: "initialized from Hiro possible_next_nonce",
      };
    }

    const {
      possible_next_nonce,
      detected_missing_nonces,
      detected_mempool_nonces,
      last_executed_tx_nonce,
    } = nonceInfo;

    // Build Hiro signal lookup sets
    const mempoolNonceSet = new Set(detected_mempool_nonces);
    const missingNonceSet = new Set(detected_missing_nonces);

    // Query ledger for this wallet's known nonces
    const broadcastedIntents = this.ledgerGetBroadcastedNonces(walletIndex);
    const broadcastedByNonce = new Map(broadcastedIntents.map((r) => [r.nonce, r]));
    const assignedIntents = this.ledgerGetAssignedNonces(walletIndex);
    const assignedByNonce = new Map(assignedIntents.map((r) => [r.nonce, r]));

    // Verdict counters for reconciliation_summary
    let verdictConfirmed = 0;
    let verdictPendingAgree = 0;
    let verdictPendingDiverge = 0;
    let verdictExpired = 0;
    let verdictIgnoreStaleHiro = 0;
    let verdictRbfCandidate = 0;
    const rbfCandidates: Array<{ nonce: number; txid: string }> = [];
    const gapFillNonces: number[] = [];

    // -------------------------------------------------------------------------
    // Cross-reference: broadcasted nonces (have a txid recorded in ledger)
    // -------------------------------------------------------------------------
    for (const [nonce, intent] of broadcastedByNonce) {
      const txid = intent.txid;
      const broadcastedAtMs = intent.broadcasted_at
        ? new Date(intent.broadcasted_at).getTime()
        : new Date(intent.assigned_at).getTime();
      const ageMs = Date.now() - broadcastedAtMs;

      let verdict: string;
      let reason: string;

      if (last_executed_tx_nonce !== null && nonce <= last_executed_tx_nonce) {
        // Chain advanced past this nonce — confirmed on-chain
        verdict = "confirmed";
        reason = "chain_advanced_past_nonce";
        verdictConfirmed++;
        this.ledgerMarkConfirmedByReconcile(walletIndex, nonce, txid);
      } else if (mempoolNonceSet.has(nonce)) {
        // Both ledger and Hiro agree tx is pending — healthy
        verdict = "pending_agree";
        reason = "ledger_and_hiro_both_pending";
        verdictPendingAgree++;
      } else if (missingNonceSet.has(nonce) && ageMs < STUCK_TX_AGE_MS) {
        // Hiro lost sight of tx we know we sent — tx is young, wait for Hiro to catch up
        verdict = "pending_diverge";
        reason = "hiro_missing_but_tx_young";
        verdictPendingDiverge++;
        this.log("warn", "reconcile_hiro_divergence", {
          walletIndex,
          nonce,
          txid,
          ageMs,
          reason: "hiro_reports_missing_but_we_broadcasted_recently",
        });
      } else if (missingNonceSet.has(nonce) && ageMs >= STUCK_TX_AGE_MS) {
        // Hiro and time both say trouble — RBF candidate (tx status check in RBF section)
        verdict = "rbf_candidate";
        reason = "hiro_missing_and_tx_old";
        rbfCandidates.push({ nonce, txid });
        verdictRbfCandidate++;
      } else if (
        !mempoolNonceSet.has(nonce) &&
        (last_executed_tx_nonce === null || nonce > last_executed_tx_nonce) &&
        ageMs >= STUCK_TX_AGE_MS
      ) {
        // Not in mempool AND not confirmed AND old — likely evicted from all mempools
        verdict = "rbf_candidate";
        reason = "not_in_mempool_not_confirmed_old";
        rbfCandidates.push({ nonce, txid });
        verdictRbfCandidate++;
      } else {
        // Tx is recent or still somewhere we can't see — wait
        verdict = "pending_wait";
        reason = "tx_recent_or_status_unclear";
        verdictPendingAgree++;
      }

      this.log("debug", "reconcile_verdict", {
        walletIndex,
        nonce,
        txid,
        ledger_state: "broadcasted",
        hiro_signal: mempoolNonceSet.has(nonce)
          ? "mempool"
          : missingNonceSet.has(nonce)
            ? "missing"
            : last_executed_tx_nonce !== null && nonce <= last_executed_tx_nonce
              ? "confirmed"
              : "unknown",
        verdict,
        reason,
        ageMs,
      });
    }

    // -------------------------------------------------------------------------
    // Cross-reference: assigned nonces (handed out, not yet broadcast)
    // -------------------------------------------------------------------------
    for (const [nonce, intent] of assignedByNonce) {
      const assignedAtMs = new Date(intent.assigned_at).getTime();
      const ageMs = Date.now() - assignedAtMs;

      let verdict: string;
      let reason: string;

      if (ageMs > STALE_THRESHOLD_MS) {
        // Assigned > 10 min ago, never broadcast — mark expired in ledger.
        // The assigned nonce creates a gap that Hiro will detect; gap-fill handles it below.
        verdict = "expired";
        reason = "stale_assigned_never_broadcast";
        verdictExpired++;
        this.ledgerMarkExpiredByReconcile(walletIndex, nonce, reason);
      } else {
        // Still within grace period — wait
        verdict = "pending_assign";
        reason = "within_grace_period";
        verdictPendingAgree++;
      }

      this.log("debug", "reconcile_verdict", {
        walletIndex,
        nonce,
        ledger_state: "assigned",
        hiro_signal: mempoolNonceSet.has(nonce)
          ? "mempool"
          : missingNonceSet.has(nonce)
            ? "missing"
            : "unknown",
        verdict,
        reason,
        ageMs,
      });
    }

    // -------------------------------------------------------------------------
    // Cross-reference: Hiro-detected missing nonces not in our ledger
    // -------------------------------------------------------------------------
    if (detected_missing_nonces.length > 0) {
      this.setStateValue(STATE_KEYS.lastGapDetected, Date.now());

      for (const nonce of detected_missing_nonces) {
        // Already handled above in broadcastedByNonce or assignedByNonce loops
        if (broadcastedByNonce.has(nonce) || assignedByNonce.has(nonce)) continue;

        // Query ledger directly for this nonce's state
        const intentRows = this.sql
          .exec<{ state: string }>(
            "SELECT state FROM nonce_intents WHERE wallet_index = ? AND nonce = ? LIMIT 1",
            walletIndex,
            nonce
          )
          .toArray();
        const intentState = intentRows[0]?.state ?? null;

        let verdict: string;
        let reason: string;

        if (intentState === null) {
          // No ledger entry — true gap we didn't create — fill it
          verdict = "gap_fill";
          reason = "no_ledger_entry_hiro_missing";
          gapFillNonces.push(nonce);
        } else if (intentState === "failed") {
          // Known failure — fill the gap (we know why it failed)
          verdict = "gap_fill";
          reason = "known_failure_hiro_missing";
          gapFillNonces.push(nonce);
        } else if (intentState === "confirmed") {
          // We know this nonce confirmed — Hiro is stale, log and ignore
          verdict = "ignore_stale_hiro";
          reason = "confirmed_in_ledger_hiro_still_missing";
          verdictIgnoreStaleHiro++;
        } else if (intentState === "expired") {
          // Nonce expired in ledger (was returned to available) — fill the gap
          verdict = "gap_fill";
          reason = "expired_in_ledger_hiro_missing";
          gapFillNonces.push(nonce);
        } else {
          // Unexpected state — log and skip conservatively
          verdict = "unknown_state";
          reason = `unexpected_ledger_state_${intentState}`;
          verdictPendingAgree++;
        }

        this.log("debug", "reconcile_verdict", {
          walletIndex,
          nonce,
          ledger_state: intentState ?? "none",
          hiro_signal: "missing",
          verdict,
          reason,
        });
      }
    }

    // -------------------------------------------------------------------------
    // Execute RBF for candidates (both ledger age AND Hiro absence must agree)
    // -------------------------------------------------------------------------
    const rbfAttempted: number[] = [];
    const rbfTxids: string[] = [];

    if (rbfCandidates.length > 0) {
      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      if (privateKey) {
        for (const candidate of rbfCandidates) {
          const { nonce, txid } = candidate;
          // Optional: check if tx is abort_* (terminal) before RBF — skip RBF if so
          const txStatus = await this.fetchTxStatus(txid);
          if (txStatus !== null && txStatus.startsWith("abort_")) {
            // Transaction was definitively rejected on-chain — mark failed, no RBF
            this.log("warn", "reconcile_tx_aborted", {
              walletIndex,
              nonce,
              txid,
              txStatus,
              reason: "abort_status_skip_rbf",
            });
            // Update ledger to reflect the on-chain rejection
            try {
              const now = new Date().toISOString();
              this.sql.exec(
                `UPDATE nonce_intents SET state = 'failed', error_reason = ?
                 WHERE wallet_index = ? AND nonce = ?`,
                `on_chain_abort:${txStatus}`,
                walletIndex,
                nonce
              );
              this.sql.exec(
                `INSERT INTO nonce_events (wallet_index, nonce, event, detail, created_at)
                 VALUES (?, ?, 'reconcile_aborted', ?, ?)`,
                walletIndex,
                nonce,
                JSON.stringify({ txid, txStatus }),
                now
              );
            } catch { /* fail-open */ }
            continue;
          }
          if (txStatus === "success") {
            // Tx actually confirmed (Hiro eventually returned it) — mark confirmed
            this.ledgerMarkConfirmedByReconcile(walletIndex, nonce, txid);
            verdictConfirmed++;
            verdictRbfCandidate--;
            continue;
          }
          // Tx is dropped/not found/null — proceed with RBF
          const rbfTxid = await this.broadcastRbfForNonce(walletIndex, nonce, privateKey, txid);
          if (rbfTxid) {
            rbfAttempted.push(nonce);
            rbfTxids.push(rbfTxid);
          }
        }
      }
    }

    if (rbfAttempted.length > 0) {
      this.log("info", "rbf_deferred_reset", {
        walletIndex,
        rbfNonces: rbfAttempted,
        rbfTxids,
        possibleNextNonce: possible_next_nonce,
      });
    }

    // -------------------------------------------------------------------------
    // Execute gap-fills for nonces not in our ledger or in failed state
    // -------------------------------------------------------------------------
    const gapFillFilled: number[] = [];
    if (gapFillNonces.length > 0) {
      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      const gapsToFill = gapFillNonces
        .slice()
        .sort((a, b) => a - b)
        .slice(0, MAX_GAP_FILLS_PER_ALARM);
      if (privateKey) {
        for (const gapNonce of gapsToFill) {
          const txid = await this.fillGapNonce(walletIndex, gapNonce, privateKey);
          if (txid) {
            this.log("info", "gap_filled", { walletIndex, nonce: gapNonce, txid });
            this.incrementGapsFilled();
            gapFillFilled.push(gapNonce);
            this.ledgerInsertGapFill(walletIndex, gapNonce, txid);
            await this.recordGapFillFee(walletIndex, GAP_FILL_FEE.toString());
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Log reconciliation_summary for this wallet
    // -------------------------------------------------------------------------
    this.log("info", "reconciliation_summary", {
      walletIndex,
      total_nonces: broadcastedByNonce.size + assignedByNonce.size + gapFillNonces.length,
      confirmed: verdictConfirmed,
      pending_agree: verdictPendingAgree,
      pending_diverge: verdictPendingDiverge,
      expired: verdictExpired,
      gap_filled: gapFillFilled.length,
      rbf_candidates: verdictRbfCandidate,
      rbf_broadcast: rbfAttempted.length,
      ignore_stale_hiro: verdictIgnoreStaleHiro,
      hiro_missing_count: detected_missing_nonces.length,
      hiro_mempool_count: detected_mempool_nonces.length,
      possible_next_nonce,
      last_executed_tx_nonce,
    });

    // -------------------------------------------------------------------------
    // Head maintenance: forward bump and stale reset based on Hiro signals.
    // RBF deferral: if we just broadcast RBF replacements, skip the stale reset
    // for one cycle to let the replacement confirm.
    // -------------------------------------------------------------------------

    if (previousNonce !== null && possible_next_nonce > previousNonce) {
      // Chain has advanced past our stored head — forward bump the head.
      this.ledgerAdvanceWalletHead(walletIndex, possible_next_nonce);
      this.incrementConflictsDetected();

      this.log("warn", "nonce_reconcile_forward_bump", {
        walletIndex,
        previousNonce,
        newNonce: possible_next_nonce,
        hiroNextNonce: possible_next_nonce,
        ledgerReserved: this.ledgerReservedCount(walletIndex),
      });

      return {
        previousNonce,
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
      previousNonce !== null &&
      previousNonce > possible_next_nonce
    ) {
      // If RBF was just broadcast for stuck nonces, defer the reset by one cycle.
      if (rbfAttempted.length > 0) {
        return {
          previousNonce,
          newNonce: previousNonce,
          changed: false,
          reason: `RBF_DEFERRED_RESET: broadcast ${rbfAttempted.length} replacement(s) for stuck nonces [${rbfAttempted.join(",")}], deferring head reset`,
        };
      }

      this.ledgerAdvanceWalletHead(walletIndex, possible_next_nonce);
      this.incrementConflictsDetected();

      this.log("warn", "nonce_reconcile_stale", {
        walletIndex,
        previousNonce,
        newNonce: possible_next_nonce,
        idleSeconds: Math.round(idleMs / 1000),
        hiroNextNonce: possible_next_nonce,
        ledgerReserved: this.ledgerReservedCount(walletIndex),
      });

      return {
        previousNonce,
        newNonce: possible_next_nonce,
        changed: true,
        reason: `STALE DETECTION: idle ${Math.round(idleMs / 1000)}s, reset to chain nonce ${possible_next_nonce}`,
      };
    }

    const gapFilledSummary = gapFillFilled.length > 0
      ? ` gap_filled [${gapFillFilled.join(",")}]`
      : "";
    const rbfSummary = rbfAttempted.length > 0
      ? ` rbf [${rbfAttempted.join(",")}]`
      : "";
    return {
      previousNonce,
      newNonce: previousNonce,
      changed: gapFillFilled.length > 0 || rbfAttempted.length > 0,
      reason: `nonce is consistent with chain state${gapFilledSummary}${rbfSummary}`,
    };
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

      const previousNonce = this.ledgerGetWalletHead(walletIndex);
      const changed = previousNonce !== safeFloor;

      this.ledgerAdvanceWalletHead(walletIndex, safeFloor);
      if (changed) {
        this.incrementConflictsDetected();
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

        for (const { walletIndex, address } of initializedWallets) {
          // reconcileNonceForWallet returns null when Hiro is unreachable — skip silently
          await this.reconcileNonceForWallet(walletIndex, address);

          // Clean up StuckTxState entries for nonces that have been confirmed on-chain.
          // Use the ledger to find recently-confirmed nonces below Hiro's possible_next_nonce - 1.
          const cached = this.hiroNonceCache.get(walletIndex);
          if (cached) {
            const confirmedThreshold = cached.value - 1; // nonces <= this are confirmed
            // Query ledger for confirmed nonces that may have RBF state to clean up
            const confirmedNonces = this.sql
              .exec<{ nonce: number }>(
                "SELECT nonce FROM nonce_intents WHERE wallet_index = ? AND state = 'confirmed' AND nonce <= ?",
                walletIndex,
                confirmedThreshold
              )
              .toArray()
              .map((r) => r.nonce);
            for (const confirmedNonce of confirmedNonces) {
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

        // Dynamic alarm interval: use active (60s) when any wallet has in-flight nonces,
        // idle (5min) when all wallets are drained. This ensures rapid reconciliation
        // during traffic bursts and doesn't hammer Hiro unnecessarily when idle.
        const totalReservedAfterCycle = this.ledgerTotalAssigned();
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
   * Clear all per-wallet state and stored addresses.
   * Wallets will reinitialize from Hiro on the next /assign call.
   * Also resets nonce heads and clears the nonce_intents ledger for each wallet.
   */
  private async handleClearPools(): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const initializedWallets = await this.getInitializedWallets();
      for (const { walletIndex } of initializedWallets) {
        // Clear sponsor address
        await this.state.storage.delete(this.sponsorAddressKey(walletIndex));
        // Reset the ledger head for this wallet
        if (walletIndex === 0) {
          this.sql.exec("DELETE FROM nonce_state WHERE key = ?", STATE_KEYS.current);
        } else {
          this.sql.exec("DELETE FROM nonce_state WHERE key = ?", `wallet_next_nonce:${walletIndex}`);
        }
        // Clear nonce_intents for this wallet
        this.sql.exec("DELETE FROM nonce_intents WHERE wallet_index = ?", walletIndex);
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

    if (request.method === "POST" && url.pathname === "/broadcast-outcome") {
      const { value: body, errorResponse } =
        await this.parseJson<BroadcastOutcomeRequest>(request);
      if (errorResponse) return errorResponse;
      if (typeof body?.nonce !== "number") return this.badRequest("Missing nonce");
      const walletIndex = typeof body.walletIndex === "number"
        ? Math.max(0, Math.min(body.walletIndex, MAX_WALLET_COUNT - 1))
        : 0;
      try {
        await this.recordBroadcastOutcome(
          body.nonce,
          walletIndex,
          body.txid,
          body.httpStatus,
          body.nodeUrl,
          body.errorReason
        );
        return this.jsonResponse({ success: true });
      } catch (error) {
        return this.internalError(error);
      }
    }

    // GET /history/:wallet/:nonce — diagnostic endpoint for full nonce event trail.
    // Returns the nonce_intents row and all nonce_events for a specific (wallet, nonce) pair.
    // This is an internal DO endpoint; exposed through the Hono router at GET /nonce/history/:wallet/:nonce.
    const historyMatch = url.pathname.match(/^\/history\/(\d+)\/(\d+)$/);
    if (request.method === "GET" && historyMatch) {
      const walletIdx = parseInt(historyMatch[1], 10);
      const nonceVal = parseInt(historyMatch[2], 10);
      if (!Number.isInteger(walletIdx) || !Number.isInteger(nonceVal)) {
        return this.badRequest("Invalid wallet or nonce");
      }
      try {
        const intent = this.sql
          .exec(
            "SELECT * FROM nonce_intents WHERE wallet_index = ? AND nonce = ? LIMIT 1",
            walletIdx,
            nonceVal
          )
          .toArray();
        const events = this.sql
          .exec(
            "SELECT * FROM nonce_events WHERE wallet_index = ? AND nonce = ? ORDER BY id ASC",
            walletIdx,
            nonceVal
          )
          .toArray();
        return this.jsonResponse({
          intent: intent[0] ?? null,
          events,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        return this.internalError(error);
      }
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
