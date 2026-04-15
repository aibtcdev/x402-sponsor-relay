import {
  makeSTXTokenTransfer,
  getAddressFromPrivateKey,
  sponsorTransaction,
  deserializeTransaction,
} from "@stacks/transactions";
import type { StacksTransactionWire } from "@stacks/transactions";
import { hexToBytes } from "@stacks/common";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import { generateNewAccount, generateWallet } from "@stacks/wallet-sdk";
import type {
  Env,
  LogsRPC,
  PoolHealthResponse,
  SenderWedgeStatus,
  SponsorStatusResult,
  WalletHealthSnapshot,
  HandSubmitResult,
  RunDispatchResult,
} from "../types";
import { getHiroBaseUrl, getHiroHeaders } from "../utils";
import {
  getPaymentRecord,
  inferReplacementTerminalReason,
  putPaymentRecord,
  transitionPayment,
} from "../services/payment-status";
import {
  SPONSOR_STATUS_RECENT_CONFLICT_WINDOW_MS,
  toSponsorStatusResult,
  type StoredSponsorStatusSnapshot,
} from "../services/sponsor-status";
import { parseBroadcastOutcome, decideBroadcastAction } from "../utils/broadcast-outcome";

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
  /** Error reason for quarantine (e.g. "TooMuchChaining", "nonce_conflict") */
  errorReason?: string;
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

interface SenderStateRow {
  next_expected_nonce: number;
  seeded_from: string;
  seeded_at: string;
  last_advanced_at: string | null;
  last_refresh_attempt_at: string | null;
  last_refresh_failure_at: string | null;
}

interface SenderHandRow {
  sender_address: string;
  sender_nonce: number;
  tx_hex: string;
  payment_id: string | null;
  source: string;
  received_at: string;
  expires_at: string;
}

interface StaleSenderRepairCandidate {
  nextExpectedNonce: number;
  lowestHeldNonce: number;
  oldestHeldAgeMs: number;
  handSize: number;
}

/**
 * Per-wallet utilization metrics over the last hour.
 * Counts nonce_intents rows by state with assigned_at within the last 60 minutes.
 */
interface WalletUtilization {
  walletIndex: number;
  /** Nonces still in 'assigned' state within the last hour */
  assigned_count: number;
  /** Nonces that reached 'broadcasted' state within the last hour */
  broadcasted_count: number;
  /** Nonces that reached 'confirmed' state within the last hour */
  confirmed_count: number;
  /** Nonces that reached 'failed' or 'conflict' state within the last hour */
  failed_count: number;
  /** Time window in hours */
  window_hours: number;
  /** Chain gap headroom (CHAINING_LIMIT - (head - chainFrontier)), null if no frontier */
  chain_gap_headroom: number | null;
  /** Monotonic chain frontier (highest confirmed nonce from Hiro) */
  chain_frontier: number | null;
}

/**
 * A single pending transaction visible to MCP clients.
 */
interface ObservablePendingTx {
  sponsorNonce: number;
  state: "assigned" | "broadcasted" | "replaced";
  txid?: string;
  assignedAt: string;
  broadcastedAt?: string;
  /** Original txid of the sponsored tx that was replaced (only when state is "replaced"). */
  originalTxid?: string;
  /** Replacement txid when state is "replaced" (RBF or head-bump replacement). */
  replacementTxid?: string;
  /** Contention reason string from error_reason column (e.g. "contention:dropped_replace_by_fee"). */
  replacedReason?: string;
  /** Stacks address of the transaction sender (from dispatch_queue). */
  senderAddress?: string;
}

/**
 * Per-wallet observable state for MCP client diagnostics (issue #229).
 */
interface ObservableWalletState {
  walletIndex: number;
  sponsorAddress: string;
  chainFrontier?: number;
  assignmentHead?: number;
  pendingTxs: ObservablePendingTx[];
  gaps: number[];
  available: number;
  reserved: number;
  /** @deprecated Always false — circuit breaker removed in favor of per-nonce tracking */
  circuitBreakerOpen: boolean;
  healthy: boolean;
  /** Total non-confirmed dispatch_queue rows (queued + dispatched + replaying) */
  queueDepth?: number;
  /** Rows in replay_buffer for this wallet (waiting for re-sponsoring) */
  replayBufferDepth?: number;
  /** Settlement time percentiles for this wallet (last 24h, null if no data) */
  settlementTimes?: SettlementTimeStats;
}

/**
 * Full observable nonce state returned by GET /nonce/state (public) and DO GET /nonce-state (internal).
 * Designed for MCP tools like tx_status_deep to cross-reference
 * sender nonces with sponsor nonces.
 *
 * `recommendation` is derived here (single source of truth) so that
 * endpoints don't duplicate the fallback decision logic.
 */
/** Summary of a sender's hand queue — senders with held transactions pending gap fill. */
interface SenderHandSummary {
  /** Sender Stacks address */
  address: string;
  /** Lowest sender nonce in the hand (next needed to form a gapless run) */
  nextExpected: number;
  /** Number of transactions held in the sender's hand */
  handSize: number;
  /** Milliseconds since the oldest entry was received */
  oldestEntryAge: number;
}

/** Backward probe queue status for ghost mempool eviction. */
interface ProbeQueueStatus {
  /** Number of nonces still waiting to be probed */
  pending: number;
  /** Number of ghost entries successfully replaced */
  replaced: number;
  /** Number of nonces with ConflictingNonceInMempool (slot occupied, no ghost) */
  conflict: number;
  /** Number of probes that failed (BadNonce, network error, etc.) */
  rejected: number;
  /** Per-wallet breakdown of pending probe counts */
  wallets: Array<{ walletIndex: number; pending: number }>;
}

interface ObservableNonceState {
  wallets: ObservableWalletState[];
  /** Active sender hands — senders with held transactions waiting for gap fill (capped at 50) */
  senderHands: SenderHandSummary[];
  healthy: boolean;
  healInProgress: boolean;
  gapsFilled: number;
  totalAvailable: number;
  totalReserved: number;
  totalCapacity: number;
  lastGapDetected: string | null;
  /** When non-null, clients should bypass sponsored submission */
  recommendation: "fallback_to_direct" | null;
  /** Global settlement time percentiles from dispatch_queue (last 24h confirmed txs) */
  settlementTimes: SettlementTimeStats;
  /** Backward probe queue status (null when no probes are active or completed) */
  probeQueue: ProbeQueueStatus | null;
  timestamp: string;
}

/**
 * Settlement time percentiles computed from dispatch_queue entries with non-null settlement_ms.
 * Used for broadcast-to-confirm latency tracking per wallet and globally.
 */
interface SettlementTimeStats {
  /** Median settlement time in milliseconds (0 if no data) */
  p50: number;
  /** 95th percentile settlement time in milliseconds (0 if no data) */
  p95: number;
  /** Mean settlement time in milliseconds (0 if no data) */
  avg: number;
  /** Number of confirmed entries with settlement_ms recorded in the last 24 hours */
  count: number;
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
  /** Per-wallet utilization metrics over the last hour */
  walletUtilization: WalletUtilization[];
  /** Dynamic wallet count stored in ledger (null if no scale-up has occurred) */
  dynamicWalletCount: number | null;
  /** Total non-confirmed dispatch_queue rows across all wallets */
  totalQueueDepth: number;
  /** Total replay_buffer rows across all wallets (waiting for re-sponsoring) */
  totalReplayBufferDepth: number;
  /** Global settlement time percentiles from confirmed dispatch_queue entries (last 24h) */
  settlementTimes: SettlementTimeStats;
  /** Per-wallet settlement time percentiles (last 24h) */
  walletSettlementTimes: Record<number, SettlementTimeStats>;
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
/**
 * Soft-reject threshold: if the best available wallet has headroom at or below this
 * value, return 503 (Low Headroom) instead of assigning. Prevents burst traffic from
 * exhausting the last nonce slots and hitting TooMuchChaining rejections.
 */
const SOFT_REJECT_HEADROOM_THRESHOLD = Math.ceil(CHAINING_LIMIT * 0.1);

const ALARM_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Alarm interval used when there are in-flight nonces (assigned state > 0).
 * Fires at 60s so reconciliation catches conflicts during traffic bursts.
 */
const ALARM_INTERVAL_ACTIVE_MS = 60 * 1000;
/** Alias for readability: idle wallets revert to the standard 5-minute cadence. */
const ALARM_INTERVAL_IDLE_MS = ALARM_INTERVAL_MS;
/** Reset to possible_next_nonce if no assignment in this window and we are ahead */
const STALE_THRESHOLD_MS = 10 * 60 * 1000;
/** Maximum number of sponsor wallets supported */
const MAX_WALLET_COUNT = 10;
/** Valid BIP-39 mnemonic word counts */
const VALID_MNEMONIC_LENGTHS = [12, 24];
/** Gap-fill transfer: 1 uSTX (minimal amount to fill a nonce gap) */
const GAP_FILL_AMOUNT = 1n;
/**
 * Minimum fee floor for gap-fill and RBF self-transfers.
 * Used when no original_fee is recorded (legacy entries) or for fresh gap-fills
 * where no prior tx exists. The Stacks mempool clears fast when nonce sequences
 * are correct, so a low fee is sufficient.
 */
const MIN_FLUSH_FEE = 30_000n;
/** Gap-fill fee: alias for MIN_FLUSH_FEE (backward compat with log references) */
const GAP_FILL_FEE = MIN_FLUSH_FEE;
/** Default recipient for gap-fill self-transfers, per network */
const DEFAULT_FLUSH_RECIPIENT_MAINNET = "SPEB8Z3TAY2130B8M5THXZEQQ4D6S3RMYT37WTAC";
const DEFAULT_FLUSH_RECIPIENT_TESTNET = "STEB8Z3TAY2130B8M5THXZEQQ4D6S3RMYRENN2KB";
/** Maximum number of gap-fill broadcasts per alarm cycle per wallet */
const MAX_GAP_FILLS_PER_ALARM = 5;
/** Maximum gap-fills per admin /fill-gaps call (prevents DO stall on degenerate ranges) */
const MAX_ADMIN_GAP_FILLS = 50;
/**
 * How long a sender transaction stays in the hand queue before expiry.
 * Keep this comfortably above the stale-sender repair hold age so the alarm
 * gets multiple chances to repair and re-dispatch before expiry.
 */
const HAND_HOLD_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_SENDER_REPAIR_HOLD_AGE_MS = 5 * 60 * 1000;
const SENDER_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const SENDER_REFRESH_FAILURE_BACKOFF_MS = 2 * 60 * 1000;
/**
 * Age threshold for considering a mempool transaction "stuck" (15 minutes).
 * Transactions that remain pending beyond this window have a very low confirmation
 * probability and are candidates for RBF replacement.
 */
const STUCK_TX_AGE_MS = 15 * 60 * 1000;
/**
 * Compute the RBF fee for replacing a stuck tx.
 * Stacks only requires original_fee + 1 uSTX to replace. When original_fee is known
 * (tracked in dispatch_queue/wallet_hand since Phase 4), use it directly.
 * Falls back to MIN_FLUSH_FEE when no original fee is recorded (legacy entries).
 *
 * Ghost mempool entries clear slowly on their own but are instantly replaced by
 * broadcasting a valid tx (even 1 uSTX self-transfer) at original_fee + 1.
 * This is cheaper than the old fixed 90k uSTX and equally effective.
 */
function computeRbfFee(originalFee: string | null | undefined): bigint {
  if (originalFee) {
    try {
      return BigInt(originalFee) + 1n;
    } catch {
      // Malformed fee string — fall back to floor
    }
  }
  return MIN_FLUSH_FEE;
}
/** Legacy constant kept for backward compat with existing log queries */
const RBF_FEE = MIN_FLUSH_FEE * 3n;
/** Maximum RBF broadcast attempts per nonce to prevent runaway fee escalation */
const MAX_RBF_ATTEMPTS = 3;
/**
 * Fee for head-bump RBF after gap-fill: original_fee + 1 when known, else MIN_FLUSH_FEE.
 * Applied to the first real pending tx after gap-fills to signal miners to
 * re-evaluate the pending nonce sequence.
 *
 * NOTE: Head-bump replaces a real agent-sponsored tx with a self-transfer.
 * Agents are notified via replaced_tx KV → GET /payment/:id (status: "replaced",
 * resubmittable: true). Time-sensitive contract calls may fail if the
 * replacement + resubmission window exceeds the call's deadline.
 */
const HEAD_BUMP_FEE = MIN_FLUSH_FEE * 2n;
/** Maximum fee cap for gap-fill escalation and RBF broadcasts (90,000 uSTX) */
const MAX_BROADCAST_FEE = 90_000n;

// ---------------------------------------------------------------------------
// Gin rummy dealing constants (Phase 3 — fairness and bounded alarm work)
// ---------------------------------------------------------------------------

/**
 * Maximum number of transactions dispatched per sender per alarm cycle.
 * Prevents one chatty agent from consuming all available wallet capacity in a single cycle.
 */
const MAX_RUN_PER_DISPATCH = 5;

/**
 * Number of sponsor nonce slots reserved per wallet for new senders.
 * assignRunToWallet() uses effective headroom = walletHeadroom - WALLET_RESERVE_SLOTS
 * (clamped to 0) so a wallet never appears completely full to an incoming sender.
 */
const WALLET_RESERVE_SLOTS = 2;

/**
 * Number of wallets reconciled per alarm tick (round-robin cursor model).
 * Full 10-wallet reconciliation completes in ceil(10/3) = 4 ticks (~4 min at 60s cadence).
 */
const MAX_RECONCILE_WALLETS = 3;

/**
 * Maximum number of sender hands swept per alarm tick.
 * Prevents the alarm from doing O(senders) work regardless of active-sender count.
 */
const MAX_SWEEP_SENDERS = 5;

/**
 * Maximum total broadcast operations per alarm tick across all wallets.
 * Caps Hiro API calls per tick to stay within Cloudflare CPU limits.
 */
const MAX_BROADCASTS_PER_TICK = 10;
/** Maximum probe broadcasts per alarm tick (backward ghost eviction) */
const MAX_PROBES_PER_TICK = 5;

/** nonce_state key for the round-robin wallet reconciliation cursor */
const ALARM_WALLET_CURSOR_KEY = "alarm_wallet_cursor";

/** nonce_state key for the round-robin sender sweep cursor */
const ALARM_SENDER_CURSOR_KEY = "alarm_sender_cursor";

/** nonce_state key for the confirmation notification cursor (nonce_events id) */
const ALARM_CONFIRMATION_CURSOR_KEY = "alarm_confirmation_cursor";

/** Maximum reconcile_confirmed/reconcile_aborted events processed per alarm tick */
const MAX_CONFIRMATION_EVENTS_PER_TICK = 50;

/** Payment statuses that should never be regressed by notification processors */
const TERMINAL_PAYMENT_STATUSES = new Set(["confirmed", "failed", "replaced"]);

/**
 * Pool pressure threshold (0.80 = 80%) above which a surge event is recorded.
 * A surge is active while overall pressure stays above this threshold.
 */
const SURGE_PRESSURE_THRESHOLD = 0.80;

/**
 * Per-wallet pressure threshold (0.75 = 75%) above which a wallet is considered
 * "high pressure" for dynamic scale-up decisions.
 * Dynamic scaling triggers only when ALL initialized wallets exceed this threshold.
 */
const SCALE_UP_THRESHOLD = 0.75;

/**
 * Hard ceiling for dynamic wallet scaling — wallets will never be scaled beyond
 * this value regardless of SPONSOR_WALLET_MAX env var.
 */
const ABSOLUTE_MAX_WALLET_COUNT = 100;

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
const SPONSOR_STATUS_SNAPSHOT_STORAGE_KEY = "sponsor_status_snapshot";

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

/**
 * Thrown when all wallets have headroom at or below SOFT_REJECT_HEADROOM_THRESHOLD.
 * The pool is not full yet, but a burst would likely cause TooMuchChaining rejections.
 * Callers should back off and retry after `retryAfterSeconds`.
 */
class LowHeadroomError extends Error {
  readonly maxHeadroom: number;
  readonly retryAfterSeconds: number;

  constructor(maxHeadroom: number) {
    super("LOW_HEADROOM");
    this.name = "LowHeadroomError";
    this.maxHeadroom = maxHeadroom;
    // Estimate: each confirmed tx frees one nonce slot. ~2 txs/s drain rate.
    // Backoff scales with pool pressure: more reserved nonces → longer wait.
    this.retryAfterSeconds = Math.ceil((CHAINING_LIMIT - maxHeadroom) / 2) + 5;
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

  /**
   * Monotonic chain frontier per wallet — the highest `possible_next_nonce` ever
   * observed from Hiro for each wallet. Only advances forward (Math.max), so
   * load-balanced Hiro nodes returning stale/inconsistent values can never regress it.
   *
   * Used for O(1) headroom calculation: headroom = CHAINING_LIMIT - (head - chainFrontier).
   * Stored in nonce_state as `chain_frontier:{walletIndex}` for persistence across restarts.
   * Also cached in-memory for fast reads during nonce assignment.
   */
  private readonly chainFrontierCache = new Map<number, number>();

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

    // Surge event log: records pool pressure surge events and dynamic scale-up triggers.
    // An active surge is tracked via the "active_surge_id" key in nonce_state.
    // resolved_at and duration_ms are null while the surge is still active.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS surge_events (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at          TEXT    NOT NULL,
        peak_pressure_pct   INTEGER NOT NULL DEFAULT 0,
        peak_reserved       INTEGER NOT NULL DEFAULT 0,
        wallet_count_at_peak INTEGER NOT NULL DEFAULT 1,
        duration_ms         INTEGER,
        resolved_at         TEXT
      );
    `);

    // Dispatch queue: tracks (senderTx, sponsorNonce) pairs flowing through the relay.
    // The relay owns the sponsor nonce sequence — this table is the authoritative record
    // of what has been dispatched (broadcast) and what is waiting (queued).
    // States: 'queued' → 'dispatched' → 'confirmed' | 'replaying' | 'retired'
    // 'replaying' means the sponsor nonce slot was stuck and is being flushed; the sender tx
    // will be moved to replay_buffer for re-sponsoring with a fresh nonce.
    // 'retired' means the queued row is terminal because the sponsor nonce was already
    // consumed elsewhere (e.g. bounded-broadcast hit BadNonce before first dispatch).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_queue (
        wallet_index    INTEGER NOT NULL,
        position        INTEGER NOT NULL DEFAULT 0,
        payment_id      TEXT,
        sender_tx_hex   TEXT    NOT NULL,
        sender_address  TEXT    NOT NULL,
        sender_nonce    INTEGER NOT NULL,
        sponsor_nonce   INTEGER NOT NULL,
        state           TEXT    NOT NULL DEFAULT 'queued',
        queued_at       TEXT    NOT NULL,
        dispatched_at   TEXT,
        confirmed_at    TEXT,
        PRIMARY KEY (wallet_index, sponsor_nonce)
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatch_queue_state
        ON dispatch_queue(wallet_index, state);
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatch_queue_sender
        ON dispatch_queue(sender_address, state);
    `);

    // Index for computeSettlementPercentiles() ORDER BY settlement_ms queries
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_dq_settlement
        ON dispatch_queue(state, confirmed_at);
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_dq_wallet_settlement
        ON dispatch_queue(wallet_index, state, confirmed_at);
    `);

    // Migration: add original_fee column to dispatch_queue (nullable, text for bigint safety).
    // The standard SQLite ADD COLUMN IF NOT EXISTS is not supported — use try/catch instead.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('dispatch_queue') WHERE name = 'payment_id'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE dispatch_queue ADD COLUMN payment_id TEXT");
      }
    } catch { /* already present or error — fail-open */ }

    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('dispatch_queue') WHERE name = 'original_fee'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE dispatch_queue ADD COLUMN original_fee TEXT");
      }
    } catch { /* already present or error — fail-open */ }

    // Migration: add settlement_ms column to dispatch_queue (null until confirmed).
    // Computed as confirmed_at − dispatched_at in milliseconds.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('dispatch_queue') WHERE name = 'settlement_ms'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE dispatch_queue ADD COLUMN settlement_ms INTEGER");
      }
    } catch (err) {
      console.warn(
        "[nonce-do] Failed to ensure dispatch_queue.settlement_ms column exists; continuing without migration:",
        err
      );
    }

    // Migration: add submitted_at column to dispatch_queue.
    // ISO timestamp of when the client HTTP request first arrived at the relay endpoint.
    // NULL for gap-fill entries, replay re-dispatches, and pre-migration rows.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('dispatch_queue') WHERE name = 'submitted_at'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE dispatch_queue ADD COLUMN submitted_at TEXT");
      }
    } catch (err) {
      console.warn(
        "[nonce-do] Failed to ensure dispatch_queue.submitted_at column exists; continuing without migration:",
        err
      );
    }

    // Migration: add is_gap_fill column to dispatch_queue.
    // 1 for gap-fill/flush/replay-respon system txs, 0 for user-submitted txs.
    // These entries are excluded from settlement time percentiles.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('dispatch_queue') WHERE name = 'is_gap_fill'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE dispatch_queue ADD COLUMN is_gap_fill INTEGER DEFAULT 0");
      }
    } catch (err) {
      console.warn(
        "[nonce-do] Failed to ensure dispatch_queue.is_gap_fill column exists; continuing without migration:",
        err
      );
    }

    // Migration: add gap_fill_attempts column to nonce_intents (nullable INTEGER, default 0).
    // Tracks how many gap-fill broadcasts have been attempted for a conflict nonce,
    // used to escalate the fee by +1 uSTX per attempt (30000, 30001, 30002, ...).
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('nonce_intents') WHERE name = 'gap_fill_attempts'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE nonce_intents ADD COLUMN gap_fill_attempts INTEGER DEFAULT 0");
      }
    } catch { /* already present or error — fail-open */ }

    // ---------------------------------------------------------------------------
    // Phase 1 (sponsor-ledger-integration): extend nonce_intents with 7 new columns
    // required by SponsorLedgerSchema so Phase 2 can adopt tx-schemas helpers without
    // a second migration. All additions use check-then-add (PRAGMA table_info) pattern.
    // ---------------------------------------------------------------------------

    // sponsored: whether the occupying tx was submitted as a sponsored transaction.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('nonce_intents') WHERE name = 'sponsored'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE nonce_intents ADD COLUMN sponsored INTEGER DEFAULT NULL");
      }
    } catch { /* already present or error — fail-open */ }

    // sponsor_address: the sponsor address recorded on the occupying tx (Hiro response).
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('nonce_intents') WHERE name = 'sponsor_address'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE nonce_intents ADD COLUMN sponsor_address TEXT DEFAULT NULL");
      }
    } catch { /* already present or error — fail-open */ }

    // sender_address: the origin address of the tx occupying this nonce slot.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('nonce_intents') WHERE name = 'sender_address'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE nonce_intents ADD COLUMN sender_address TEXT DEFAULT NULL");
      }
    } catch { /* already present or error — fail-open */ }

    // occupant_visible: 1 if the occupying tx is visible in Hiro mempool/chain; 0 if ghost.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('nonce_intents') WHERE name = 'occupant_visible'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE nonce_intents ADD COLUMN occupant_visible INTEGER DEFAULT NULL");
      }
    } catch { /* already present or error — fail-open */ }

    // abandon_after: ISO-8601 timestamp after which this nonce slot should be quarantined.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('nonce_intents') WHERE name = 'abandon_after'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE nonce_intents ADD COLUMN abandon_after TEXT DEFAULT NULL");
      }
    } catch { /* already present or error — fail-open */ }

    // status: SponsorLedgerEntry lifecycle status (pending_broadcast | broadcast_sent | broadcast_failed).
    // Required in tx-schemas 1.0.0 — must be non-null on every row before Phase 2 schema parses.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('nonce_intents') WHERE name = 'status'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE nonce_intents ADD COLUMN status TEXT DEFAULT NULL");
      }
    } catch { /* already present or error — fail-open */ }

    // broadcast_at: ISO-8601 timestamp of when the broadcast was initiated (beginPendingBroadcast).
    // Distinct from broadcasted_at which is the Hiro response timestamp. Used by reconcile() grace math.
    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('nonce_intents') WHERE name = 'broadcast_at'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE nonce_intents ADD COLUMN broadcast_at TEXT DEFAULT NULL");
      }
    } catch { /* already present or error — fail-open */ }

    // Backfill: set status on existing rows that predate this migration.
    // - Rows with a txid (broadcasted, confirmed) → broadcast_sent
    // - Rows in terminal states without txid (failed, conflict, expired) → broadcast_failed
    // - Rows in 'assigned' state (still in-flight, no broadcast yet) → status remains NULL
    //   (Phase 3 will set pending_broadcast via beginPendingBroadcast before the network call)
    // Fail-open: if backfill errors, the system continues but Phase 2 will handle stragglers.
    try {
      this.sql.exec(`
        UPDATE nonce_intents
        SET status = CASE
          WHEN txid IS NOT NULL THEN 'broadcast_sent'
          WHEN state IN ('failed', 'conflict', 'expired', 'confirmed') THEN 'broadcast_failed'
          ELSE NULL
        END
        WHERE status IS NULL
      `);
    } catch (e) {
      console.warn("[nonce-do] Phase 1 backfill of nonce_intents.status failed (fail-open):", e);
    }

    // Replay buffer: sender txs waiting for a fresh sponsor nonce assignment.
    // Populated when a dispatched slot is stuck and needs to be flushed.
    // The relay will re-sponsor these txs with new nonces in the next alarm cycle.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS replay_buffer (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_index          INTEGER NOT NULL,
        payment_id            TEXT,
        sender_tx_hex         TEXT    NOT NULL,
        sender_address        TEXT    NOT NULL,
        sender_nonce          INTEGER NOT NULL,
        original_sponsor_nonce INTEGER NOT NULL,
        queued_at             TEXT    NOT NULL,
        assigned_at           TEXT
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_replay_buffer_wallet
        ON replay_buffer(wallet_index, queued_at ASC);
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_replay_buffer_sender
        ON replay_buffer(sender_address);
    `);

    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('replay_buffer') WHERE name = 'payment_id'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE replay_buffer ADD COLUMN payment_id TEXT");
      }
    } catch { /* already present or error — fail-open */ }

    // Probe queue: alarm-driven backward probe for ghost mempool eviction.
    // When flush-wallet detects an empty forward range + probeDepth, nonces are
    // enqueued here and processed in batches by the alarm (5/tick, RBF_FEE).
    // States: 'pending' → 'replaced' | 'conflict' | 'rejected'
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS probe_queue (
        wallet_index  INTEGER NOT NULL,
        nonce         INTEGER NOT NULL,
        state         TEXT    NOT NULL DEFAULT 'pending',
        txid          TEXT,
        reason        TEXT,
        created_at    TEXT    NOT NULL,
        completed_at  TEXT,
        PRIMARY KEY (wallet_index, nonce)
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_probe_queue_pending
        ON probe_queue(wallet_index, state, nonce ASC);
    `);

    // ---------------------------------------------------------------------------
    // Gin rummy dispatch tables (Phase 1 — data model only)
    // ---------------------------------------------------------------------------

    // sender_state: per-sender nonce tracking, seeded from Hiro on first contact
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sender_state (
        sender_address       TEXT    PRIMARY KEY,
        next_expected_nonce  INTEGER NOT NULL,
        seeded_from          TEXT    NOT NULL,
        seeded_at            TEXT    NOT NULL,
        last_advanced_at     TEXT,
        last_refresh_attempt_at TEXT,
        last_refresh_failure_at TEXT
      );
    `);

    try {
      const cols = this.sql
        .exec<{ name: string }>(
          "SELECT name FROM pragma_table_info('sender_state') WHERE name = 'last_refresh_attempt_at'"
        )
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE sender_state ADD COLUMN last_refresh_attempt_at TEXT");
      }
    } catch (err) {
      console.warn(
        "[nonce-do] Failed to ensure sender_state.last_refresh_attempt_at column exists; continuing without migration:",
        err
      );
    }

    try {
      const cols = this.sql
        .exec<{ name: string }>(
          "SELECT name FROM pragma_table_info('sender_state') WHERE name = 'last_refresh_failure_at'"
        )
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE sender_state ADD COLUMN last_refresh_failure_at TEXT");
      }
    } catch (err) {
      console.warn(
        "[nonce-do] Failed to ensure sender_state.last_refresh_failure_at column exists; continuing without migration:",
        err
      );
    }

    // sender_hand: per-sender queue of transactions waiting to form a gapless run
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sender_hand (
        sender_address  TEXT    NOT NULL,
        sender_nonce    INTEGER NOT NULL,
        tx_hex          TEXT    NOT NULL,
        payment_id      TEXT,
        source          TEXT    NOT NULL DEFAULT 'agent',
        received_at     TEXT    NOT NULL,
        expires_at      TEXT    NOT NULL,
        PRIMARY KEY (sender_address, sender_nonce)
      );
    `);

    try {
      const cols = this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('sender_hand') WHERE name = 'payment_id'")
        .toArray();
      if (cols.length === 0) {
        this.sql.exec("ALTER TABLE sender_hand ADD COLUMN payment_id TEXT");
      }
    } catch { /* already present or error — fail-open */ }

    // sender_expiry_log: records recently expired sender_hand entries for agent feedback
    // TTL: entries older than 30 minutes are pruned each alarm cycle
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sender_expiry_log (
        sender_address  TEXT NOT NULL,
        expired_nonces  TEXT NOT NULL,
        expired_at      TEXT NOT NULL,
        PRIMARY KEY (sender_address, expired_at)
      );
    `);

    // wallet_hand: per-wallet sponsor nonce slot tracking (replaces dispatch_queue for decisions)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS wallet_hand (
        wallet_index    INTEGER NOT NULL,
        sponsor_nonce   INTEGER NOT NULL,
        state           TEXT    NOT NULL DEFAULT 'available',
        sender_address  TEXT,
        sender_nonce    INTEGER,
        original_fee    TEXT,
        dispatched_at   TEXT,
        confirmed_at    TEXT,
        PRIMARY KEY (wallet_index, sponsor_nonce)
      );
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_wallet_hand_state
        ON wallet_hand(wallet_index, state);
    `);
  }

  // ---------------------------------------------------------------------------
  // Dispatch queue helpers (proactive queue-based dispatch, phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Insert or replace a sender tx + sponsor nonce pair into the dispatch queue.
   * Called when a sender tx is ready to be dispatched with a specific sponsor nonce.
   * Uses INSERT OR REPLACE to handle re-queue on duplicate sponsor_nonce.
   */
  private queueDispatch(
    walletIndex: number,
    senderTxHex: string,
    senderAddress: string,
    senderNonce: number,
    sponsorNonce: number,
    paymentId: string | null = null,
    fee: string | null = null,
    submittedAt: string | null = null,
    isGapFill: boolean = false
  ): void {
    const now = new Date().toISOString();
    // Compute position as next slot (max position + 1) for ordering within the wallet queue
    const posRows = this.sql
      .exec<{ max_pos: number | null }>(
        "SELECT MAX(position) as max_pos FROM dispatch_queue WHERE wallet_index = ?",
        walletIndex
      )
      .toArray();
    const position = (posRows[0]?.max_pos ?? -1) + 1;

    this.sql.exec(
      `INSERT OR REPLACE INTO dispatch_queue
         (wallet_index, position, payment_id, sender_tx_hex, sender_address, sender_nonce,
          sponsor_nonce, original_fee, state, queued_at, dispatched_at, confirmed_at,
          submitted_at, is_gap_fill)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?, NULL, ?, ?)`,
      walletIndex,
      position,
      paymentId,
      senderTxHex,
      senderAddress,
      senderNonce,
      sponsorNonce,
      fee,
      now,
      now,
      submittedAt,
      isGapFill ? 1 : 0
    );
  }

  /**
   * Return all active dispatch_queue rows for a wallet, ordered by sponsor_nonce ASC.
   */
  private getQueuedForWallet(walletIndex: number): Array<{
    sender_tx_hex: string;
    sender_address: string;
    sender_nonce: number;
    sponsor_nonce: number;
    state: string;
    queued_at: string;
    dispatched_at: string | null;
  }> {
    return this.sql
      .exec<{
        sender_tx_hex: string;
        sender_address: string;
        sender_nonce: number;
        sponsor_nonce: number;
        state: string;
        queued_at: string;
        dispatched_at: string | null;
      }>(
        `SELECT sender_tx_hex, sender_address, sender_nonce, sponsor_nonce,
                state, queued_at, dispatched_at
         FROM dispatch_queue
         WHERE wallet_index = ? AND state NOT IN ('confirmed', 'retired')
         ORDER BY sponsor_nonce ASC`,
        walletIndex
      )
      .toArray();
  }

  /**
   * Fast O(1) count of active dispatch_queue rows per state for a wallet.
   * The `total` field is the sum of active states (queued + dispatched + replaying).
   */
  private getDispatchQueueDepth(walletIndex: number): {
    queued: number;
    dispatched: number;
    replaying: number;
    total: number;
  } {
    const rows = this.sql
      .exec<{ state: string; cnt: number }>(
        `SELECT state, COUNT(*) as cnt FROM dispatch_queue
         WHERE wallet_index = ? AND state NOT IN ('confirmed', 'retired')
         GROUP BY state`,
        walletIndex
      )
      .toArray();

    const result = { queued: 0, dispatched: 0, replaying: 0, total: 0 };
    for (const row of rows) {
      if (row.state === "queued") result.queued = row.cnt;
      else if (row.state === "dispatched") result.dispatched = row.cnt;
      else if (row.state === "replaying") result.replaying = row.cnt;
    }
    result.total = result.queued + result.dispatched + result.replaying;
    return result;
  }

  /**
   * Compute settlement time percentiles (p50, p95, avg, count) from confirmed dispatch_queue
   * entries with non-null settlement_ms in the last 24 hours.
   * Optionally scoped to a single wallet; omit walletIndex for global stats.
   * Returns zeros when no data is available.
   */
  private computeSettlementPercentiles(walletIndex?: number): SettlementTimeStats {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let rows: Array<{ settlement_ms: number }>;
    if (walletIndex !== undefined) {
      rows = this.sql
        .exec<{ settlement_ms: number }>(
          `SELECT settlement_ms FROM dispatch_queue
           WHERE state = 'confirmed' AND settlement_ms IS NOT NULL
             AND (is_gap_fill IS NULL OR is_gap_fill = 0)
             AND wallet_index = ? AND confirmed_at >= ?
           ORDER BY settlement_ms ASC`,
          walletIndex,
          cutoff
        )
        .toArray();
    } else {
      rows = this.sql
        .exec<{ settlement_ms: number }>(
          `SELECT settlement_ms FROM dispatch_queue
           WHERE state = 'confirmed' AND settlement_ms IS NOT NULL
             AND (is_gap_fill IS NULL OR is_gap_fill = 0)
             AND confirmed_at >= ?
           ORDER BY settlement_ms ASC`,
          cutoff
        )
        .toArray();
    }

    const count = rows.length;
    if (count === 0) {
      return { p50: 0, p95: 0, avg: 0, count: 0 };
    }

    const values = rows.map((r) => r.settlement_ms);
    const p50 = values[Math.floor(count * 0.5)] ?? values[count - 1];
    const p95 = values[Math.floor(count * 0.95)] ?? values[count - 1];
    const avg = Math.round(values.reduce((s, v) => s + v, 0) / count);

    return { p50, p95, avg, count };
  }

  /**
   * Transition a dispatch_queue entry to a new state.
   * For 'dispatched' and 'confirmed', also sets the corresponding timestamp column.
   */
  private transitionQueueEntry(
    walletIndex: number,
    sponsorNonce: number,
    newState: "dispatched" | "confirmed" | "replaying" | "retired"
  ): void {
    const now = new Date().toISOString();

    if (newState === "confirmed") {
      // On confirmation: set confirmed_at and compute settlement_ms.
      // Use submitted_at (client HTTP request arrival) as the start time when available,
      // falling back to dispatched_at for pre-migration entries. This ensures settlement
      // percentiles reflect actual user-perceived latency rather than internal queue timing.
      const preRow = this.sql
        .exec<{ dispatched_at: string | null; submitted_at: string | null; original_fee: string | null; sender_address: string | null }>(
          "SELECT dispatched_at, submitted_at, original_fee, sender_address FROM dispatch_queue WHERE wallet_index = ? AND sponsor_nonce = ? LIMIT 1",
          walletIndex,
          sponsorNonce
        )
        .toArray()[0];

      let settlementMs: number | null = null;
      const startTime = preRow?.submitted_at ?? preRow?.dispatched_at;
      if (startTime) {
        settlementMs = Math.max(0, Date.now() - new Date(startTime).getTime());
      }

      this.sql.exec(
        `UPDATE dispatch_queue
         SET state = 'confirmed', confirmed_at = ?, settlement_ms = ?
         WHERE wallet_index = ? AND sponsor_nonce = ?`,
        now,
        settlementMs,
        walletIndex,
        sponsorNonce
      );

      // Emit structured log for settlement latency tracking
      this.log("info", "settlement_confirmed", {
        walletIndex,
        sponsorNonce,
        settlementMs,
        originalFee: preRow?.original_fee ?? null,
        senderAddress: preRow?.sender_address ?? null,
      });
    } else if (newState === "dispatched") {
      this.sql.exec(
        `UPDATE dispatch_queue SET state = 'dispatched', dispatched_at = ?
         WHERE wallet_index = ? AND sponsor_nonce = ?`,
        now,
        walletIndex,
        sponsorNonce
      );
    } else if (newState === "retired") {
      this.sql.exec(
        `UPDATE dispatch_queue SET state = 'retired'
         WHERE wallet_index = ? AND sponsor_nonce = ?`,
        walletIndex,
        sponsorNonce
      );
    } else {
      // replaying — no timestamp column to set
      this.sql.exec(
        `UPDATE dispatch_queue SET state = ?
         WHERE wallet_index = ? AND sponsor_nonce = ?`,
        newState,
        walletIndex,
        sponsorNonce
      );
    }
  }

  /**
   * Retire a queued dispatch entry that will never succeed on future broadcast retries.
   * Transitions both dispatch_queue and wallet_hand to 'retired' and releases the ledger slot.
   */
  private retireQueuedEntry(walletIndex: number, sponsorNonce: number, reason: string): void {
    this.transitionQueueEntry(walletIndex, sponsorNonce, "retired");
    this.sql.exec(
      `UPDATE wallet_hand
       SET state = 'retired'
       WHERE wallet_index = ? AND sponsor_nonce = ?`,
      walletIndex,
      sponsorNonce
    );
    this.ledgerRelease(walletIndex, sponsorNonce, undefined, reason);
  }

  /**
   * Move a sender tx into the replay buffer.
   * Called when its sponsor nonce slot is being flushed with a self-transfer.
   * The entry will be picked up by the next alarm cycle for re-sponsoring.
   */
  private addToReplayBuffer(
    walletIndex: number,
    senderTxHex: string,
    senderAddress: string,
    senderNonce: number,
    originalSponsorNonce: number,
    paymentId: string | null = null
  ): void {
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO replay_buffer
         (wallet_index, payment_id, sender_tx_hex, sender_address, sender_nonce,
          original_sponsor_nonce, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      walletIndex,
      paymentId,
      senderTxHex,
      senderAddress,
      senderNonce,
      originalSponsorNonce,
      now
    );
  }

  /**
   * Return all replay_buffer rows for a wallet ordered by queued_at ASC.
   * These are sender txs awaiting re-sponsoring with fresh nonces.
   */
  private getReplayBuffer(walletIndex: number): Array<{
    id: number;
    payment_id: string | null;
    sender_tx_hex: string;
    sender_address: string;
    sender_nonce: number;
    original_sponsor_nonce: number;
    queued_at: string;
  }> {
    return this.sql
      .exec<{
        id: number;
        payment_id: string | null;
        sender_tx_hex: string;
        sender_address: string;
        sender_nonce: number;
        original_sponsor_nonce: number;
        queued_at: string;
      }>(
        `SELECT id, payment_id, sender_tx_hex, sender_address, sender_nonce,
                original_sponsor_nonce, queued_at
         FROM replay_buffer
         WHERE wallet_index = ?
         ORDER BY queued_at ASC`,
        walletIndex
      )
      .toArray();
  }

  /** Remove a specific entry from the replay buffer (after it has been re-sponsored). */
  private removeFromReplayBuffer(id: number): void {
    this.sql.exec("DELETE FROM replay_buffer WHERE id = ?", id);
  }

  /** Count replay_buffer rows for a specific wallet. */
  private getReplayBufferDepth(walletIndex: number): number {
    const rows = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM replay_buffer WHERE wallet_index = ?",
        walletIndex
      )
      .toArray();
    return rows[0]?.cnt ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Gin rummy dispatch helpers (Phase 1 — data model)
  // ---------------------------------------------------------------------------

  /**
   * Seed sender_state for a new address on first contact.
   * Queries Hiro for possible_next_nonce; falls back to the observed tx nonce.
   * Idempotent — returns immediately if the sender already has a state row.
   */
  private async seedSenderState(senderAddress: string, txNonce: number): Promise<void> {
    const existing = this.sql
      .exec<{ sender_address: string }>(
        "SELECT sender_address FROM sender_state WHERE sender_address = ? LIMIT 1",
        senderAddress
      )
      .toArray();
    if (existing.length > 0) return;

    const now = new Date().toISOString();
    try {
      const info = await this.fetchNonceInfo(senderAddress);
      this.sql.exec(
        `INSERT OR IGNORE INTO sender_state
           (sender_address, next_expected_nonce, seeded_from, seeded_at)
         VALUES (?, ?, 'hiro', ?)`,
        senderAddress,
        info.possible_next_nonce,
        now
      );
    } catch {
      // Hiro unreachable — seed from the observed tx nonce; re-seed path in alarm will upgrade
      this.sql.exec(
        `INSERT OR IGNORE INTO sender_state
           (sender_address, next_expected_nonce, seeded_from, seeded_at)
         VALUES (?, ?, 'first_tx', ?)`,
        senderAddress,
        txNonce,
        now
      );
    }
  }

  /**
   * Add a transaction to the sender's hand queue.
   * - source='agent': INSERT OR REPLACE (agent can resubmit same nonce with updated tx)
   * - source='replay': INSERT OR IGNORE (don't overwrite a fresher agent submission)
   */
  private addToHand(
    senderAddress: string,
    senderNonce: number,
    txHex: string,
    source: "agent" | "replay",
    paymentId: string | null = null
  ): void {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + HAND_HOLD_TIMEOUT_MS).toISOString();
    if (source === "agent") {
      this.sql.exec(
        `INSERT OR REPLACE INTO sender_hand
           (sender_address, sender_nonce, tx_hex, payment_id, source, received_at, expires_at)
         VALUES (?, ?, ?, ?, 'agent', ?, ?)`,
        senderAddress,
        senderNonce,
        txHex,
        paymentId,
        now,
        expiresAt
      );
    } else {
      this.sql.exec(
        `INSERT OR IGNORE INTO sender_hand
           (sender_address, sender_nonce, tx_hex, payment_id, source, received_at, expires_at)
         VALUES (?, ?, ?, ?, 'replay', ?, ?)`,
        senderAddress,
        senderNonce,
        txHex,
        paymentId,
        now,
        expiresAt
      );
    }
  }

  /**
   * Return all entries in a sender's hand, ordered by sender_nonce ASC.
   */
  private getHand(senderAddress: string): SenderHandRow[] {
    return this.sql
      .exec<{
        sender_address: string;
        sender_nonce: number;
        tx_hex: string;
        payment_id: string | null;
        source: string;
        received_at: string;
        expires_at: string;
      }>(
        `SELECT sender_address, sender_nonce, tx_hex, payment_id, source, received_at, expires_at
         FROM sender_hand
         WHERE sender_address = ?
         ORDER BY sender_nonce ASC`,
        senderAddress
      )
      .toArray();
  }

  /**
   * Advance a sender's next_expected_nonce after on-chain confirmation.
   * Also prunes stale hand entries below the new frontier.
   *
   * Called during reconciliation when a sender tx is confirmed on-chain.
   */
  private advanceSenderNonce(senderAddress: string, confirmedNonce: number): void {
    const newFrontier = confirmedNonce + 1;
    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE sender_state
       SET next_expected_nonce = MAX(next_expected_nonce, ?),
           last_advanced_at = ?
       WHERE sender_address = ?`,
      newFrontier,
      now,
      senderAddress
    );
    // Prune hand entries that are now behind the frontier (already confirmed or stale)
    this.sql.exec(
      `DELETE FROM sender_hand
       WHERE sender_address = ? AND sender_nonce < ?`,
      senderAddress,
      newFrontier
    );
  }

  /**
   * Read a sender's current state row (next_expected_nonce).
   * Returns null if the sender has never been seeded.
   */
  private getSenderState(senderAddress: string): SenderStateRow | null {
    try {
      const rows = this.sql
        .exec<{
          next_expected_nonce: number;
          seeded_from: string;
          seeded_at: string;
          last_advanced_at: string | null;
          last_refresh_attempt_at: string | null;
          last_refresh_failure_at: string | null;
        }>(
          `SELECT next_expected_nonce, seeded_from, seeded_at, last_advanced_at, last_refresh_attempt_at, last_refresh_failure_at
           FROM sender_state
           WHERE sender_address = ? LIMIT 1`,
          senderAddress
        )
        .toArray();
      return rows[0] ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("no such column")) {
        throw err;
      }

      console.warn(
        "[nonce-do] sender_state refresh columns unavailable; falling back to legacy sender_state SELECT:",
        err
      );

      const legacyRows = this.sql
        .exec<{
          next_expected_nonce: number;
          seeded_from: string;
          seeded_at: string;
          last_advanced_at: string | null;
        }>(
          `SELECT next_expected_nonce, seeded_from, seeded_at, last_advanced_at
           FROM sender_state
           WHERE sender_address = ? LIMIT 1`,
          senderAddress
        )
        .toArray();

      const legacyRow = legacyRows[0];
      if (!legacyRow) {
        return null;
      }

      return {
        ...legacyRow,
        last_refresh_attempt_at: null,
        last_refresh_failure_at: null,
      };
    }
  }

  private evaluateStaleSenderRepairCandidate(
    stateRow: Pick<SenderStateRow, "next_expected_nonce" | "last_refresh_attempt_at" | "last_refresh_failure_at"> | null,
    hand: Array<Pick<SenderHandRow, "sender_nonce" | "received_at" | "expires_at">>,
    nowMs: number
  ): StaleSenderRepairCandidate | null {
    if (!stateRow || hand.length === 0) {
      return null;
    }

    const activeHand = hand
      .filter((entry) => new Date(entry.expires_at).getTime() > nowMs)
      .sort((a, b) => a.sender_nonce - b.sender_nonce);
    if (activeHand.length === 0) {
      return null;
    }

    const lowestHeldNonce = activeHand[0]?.sender_nonce;
    if (lowestHeldNonce === undefined || lowestHeldNonce <= stateRow.next_expected_nonce) {
      return null;
    }

    const oldestHeldAt = activeHand.reduce((min, entry) => {
      const receivedAtMs = new Date(entry.received_at).getTime();
      return Number.isFinite(receivedAtMs) ? Math.min(min, receivedAtMs) : min;
    }, Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(oldestHeldAt) || oldestHeldAt === Number.MAX_SAFE_INTEGER) {
      return null;
    }

    const oldestHeldAgeMs = Math.max(0, nowMs - oldestHeldAt);
    if (oldestHeldAgeMs < STALE_SENDER_REPAIR_HOLD_AGE_MS) {
      return null;
    }

    const lastRefreshAttemptMs = stateRow.last_refresh_attempt_at
      ? new Date(stateRow.last_refresh_attempt_at).getTime()
      : null;
    if (
      lastRefreshAttemptMs !== null &&
      Number.isFinite(lastRefreshAttemptMs) &&
      nowMs - lastRefreshAttemptMs < SENDER_REFRESH_COOLDOWN_MS
    ) {
      return null;
    }

    const lastRefreshFailureMs = stateRow.last_refresh_failure_at
      ? new Date(stateRow.last_refresh_failure_at).getTime()
      : null;
    if (
      lastRefreshFailureMs !== null &&
      Number.isFinite(lastRefreshFailureMs) &&
      nowMs - lastRefreshFailureMs < SENDER_REFRESH_FAILURE_BACKOFF_MS
    ) {
      return null;
    }

    return {
      nextExpectedNonce: stateRow.next_expected_nonce,
      lowestHeldNonce,
      oldestHeldAgeMs,
      handSize: activeHand.length,
    };
  }

  private recordSenderRefreshAttempt(senderAddress: string, attemptedAt: string): void {
    try {
      this.sql.exec(
        `UPDATE sender_state
         SET last_refresh_attempt_at = ?,
             last_refresh_failure_at = NULL
         WHERE sender_address = ?`,
        attemptedAt,
        senderAddress
      );
    } catch (err) {
      console.warn(
        "[nonce-do] Failed to record sender refresh attempt; proceeding without cooldown update:",
        err
      );
    }
  }

  private recordSenderRefreshFailure(senderAddress: string, failedAt: string): void {
    try {
      this.sql.exec(
        `UPDATE sender_state
         SET last_refresh_failure_at = ?
         WHERE sender_address = ?`,
        failedAt,
        senderAddress
      );
    } catch (err) {
      console.warn(
        "[nonce-do] Failed to record sender refresh failure; proceeding without failure backoff:",
        err
      );
    }
  }

  private conservativeBumpSenderFrontier(
    senderAddress: string,
    newFrontier: number
  ): { advanced: boolean; previousFrontier: number | null; prunedCount: number } {
    const stateRow = this.getSenderState(senderAddress);
    const previousFrontier = stateRow?.next_expected_nonce ?? null;
    if (previousFrontier !== null && previousFrontier >= newFrontier) {
      return { advanced: false, previousFrontier, prunedCount: 0 };
    }

    const staleLowRows = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt
         FROM sender_hand
         WHERE sender_address = ? AND sender_nonce < ?`,
        senderAddress,
        newFrontier
      )
      .toArray();
    const prunedCount = staleLowRows[0]?.cnt ?? 0;
    const now = new Date().toISOString();

    this.sql.exec(
      `UPDATE sender_state
       SET next_expected_nonce = ?,
           last_advanced_at = ?
       WHERE sender_address = ?`,
      newFrontier,
      now,
      senderAddress
    );
    this.sql.exec(
      `DELETE FROM sender_hand
       WHERE sender_address = ? AND sender_nonce < ?`,
      senderAddress,
      newFrontier
    );

    return { advanced: true, previousFrontier, prunedCount };
  }

  private async maybeRepairStaleSenderFrontier(senderAddress: string): Promise<boolean> {
    const nowMs = Date.now();
    const stateRow = this.getSenderState(senderAddress);
    const candidate = this.evaluateStaleSenderRepairCandidate(
      stateRow,
      this.getHand(senderAddress),
      nowMs
    );
    if (!candidate) {
      return false;
    }

    try {
      const hiroNonceInfo = await this.fetchNonceInfo(senderAddress);
      const attemptedAt = new Date(nowMs).toISOString();
      this.recordSenderRefreshAttempt(senderAddress, attemptedAt);

      if (hiroNonceInfo.possible_next_nonce < candidate.lowestHeldNonce) {
        this.log("info", "sender_frontier_refresh_skipped", {
          senderAddress,
          nextExpectedNonce: candidate.nextExpectedNonce,
          lowestHeldNonce: candidate.lowestHeldNonce,
          hiroPossibleNextNonce: hiroNonceInfo.possible_next_nonce,
          oldestHeldAgeMs: candidate.oldestHeldAgeMs,
          handSize: candidate.handSize,
        });
        return false;
      }

      const bump = this.conservativeBumpSenderFrontier(senderAddress, candidate.lowestHeldNonce);
      if (!bump.advanced) {
        return false;
      }

      this.log("info", "sender_frontier_repaired", {
        senderAddress,
        previousNextExpectedNonce: bump.previousFrontier,
        newNextExpectedNonce: candidate.lowestHeldNonce,
        lowestHeldNonce: candidate.lowestHeldNonce,
        hiroPossibleNextNonce: hiroNonceInfo.possible_next_nonce,
        prunedStaleLowEntries: bump.prunedCount,
        oldestHeldAgeMs: candidate.oldestHeldAgeMs,
        handSize: candidate.handSize,
      });
      return true;
    } catch (error) {
      this.recordSenderRefreshFailure(senderAddress, new Date(nowMs).toISOString());
      this.log("warn", "sender_frontier_refresh_failed", {
        senderAddress,
        nextExpectedNonce: candidate.nextExpectedNonce,
        lowestHeldNonce: candidate.lowestHeldNonce,
        oldestHeldAgeMs: candidate.oldestHeldAgeMs,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private buildSenderWedgeStatus(
    senderAddress: string,
    opts?: { repairTriggered?: boolean; repairAdvanced?: boolean }
  ): SenderWedgeStatus {
    const nowMs = Date.now();
    const stateRow = this.getSenderState(senderAddress);
    const activeHand = this.getHand(senderAddress)
      .filter((entry) => new Date(entry.expires_at).getTime() > nowMs)
      .sort((a, b) => a.sender_nonce - b.sender_nonce);

    const lowestHeldNonce = activeHand[0]?.sender_nonce ?? null;
    const nextExpectedNonce = stateRow?.next_expected_nonce ?? null;
    const blockedOnFrontierMismatch =
      lowestHeldNonce !== null &&
      nextExpectedNonce !== null &&
      lowestHeldNonce > nextExpectedNonce;
    const candidate = this.evaluateStaleSenderRepairCandidate(stateRow, activeHand, nowMs);
    const missingNonces: number[] = [];

    if (blockedOnFrontierMismatch && nextExpectedNonce !== null && lowestHeldNonce !== null) {
      for (let nonce = nextExpectedNonce; nonce < lowestHeldNonce && missingNonces.length < 10; nonce++) {
        missingNonces.push(nonce);
      }
    }

    const oldestHeldAgeMs = activeHand.length > 0
      ? activeHand.reduce((min, entry) => {
          const receivedAtMs = new Date(entry.received_at).getTime();
          return Number.isFinite(receivedAtMs) ? Math.min(min, receivedAtMs) : min;
        }, Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    const resolvedOldestHeldAgeMs =
      oldestHeldAgeMs === Number.MAX_SAFE_INTEGER ? null : Math.max(0, nowMs - oldestHeldAgeMs);
    const recentRepairFailure = stateRow?.last_refresh_failure_at != null;
    const nearExpiry =
      resolvedOldestHeldAgeMs !== null &&
      resolvedOldestHeldAgeMs >= Math.floor(HAND_HOLD_TIMEOUT_MS * 0.75);

    return {
      senderAddress,
      blocked: activeHand.length > 0,
      blockedOnFrontierMismatch,
      adminRecoveryLikely:
        blockedOnFrontierMismatch && Boolean(recentRepairFailure || nearExpiry),
      nextExpectedNonce,
      lowestHeldNonce,
      missingNonces,
      heldCount: activeHand.length,
      oldestHeldAgeMs: resolvedOldestHeldAgeMs,
      lastRepairAttemptAt: stateRow?.last_refresh_attempt_at ?? null,
      lastRepairFailureAt: stateRow?.last_refresh_failure_at ?? null,
      repairEligible: candidate !== null,
      repairTriggered: opts?.repairTriggered,
      repairAdvanced: opts?.repairAdvanced,
      activePaymentIds: activeHand
        .map((entry) => entry.payment_id)
        .filter((paymentId): paymentId is string => typeof paymentId === "string"),
    };
  }

  private async repairSenderWedge(senderAddress: string): Promise<SenderWedgeStatus> {
    const repairAdvanced = await this.maybeRepairStaleSenderFrontier(senderAddress);
    if (repairAdvanced) {
      await this.checkAndAssignRun(senderAddress);
    }

    return this.buildSenderWedgeStatus(senderAddress, {
      repairTriggered: true,
      repairAdvanced,
    });
  }

  /**
   * Gather the sender's active hand entries and detect gaps relative to next_expected_nonce.
   * Shared by checkAndAssignRun() and checkWouldDispatch() to avoid duplicating gap detection logic.
   */
  private getHandGapInfo(senderAddress: string): {
    hand: Array<{ sender_nonce: number; tx_hex: string; payment_id: string | null; expires_at: string }>;
    missingNonces: number[];
    nextExpected: number;
    handSize: number;
  } {
    const now = new Date().toISOString();

    const stateRow = this.getSenderState(senderAddress);
    const nextExpected = stateRow?.next_expected_nonce ?? 0;

    const rawHand = this.getHand(senderAddress);
    const hand = rawHand.filter(
      (e) => e.sender_nonce >= nextExpected && e.expires_at > now
    );

    // Detect missing nonces between nextExpected and the first entry in the hand
    const missingNonces: number[] = [];
    const lowestInHand = hand.length > 0 ? hand[0].sender_nonce : null;
    if (lowestInHand !== null && lowestInHand > nextExpected) {
      for (let n = nextExpected; n < lowestInHand && missingNonces.length < 10; n++) {
        missingNonces.push(n);
      }
    } else if (lowestInHand === null) {
      // Hand is empty — report nextExpected as the single missing nonce
      missingNonces.push(nextExpected);
    }

    return { hand, missingNonces, nextExpected, handSize: hand.length };
  }

  /**
   * Check the sender's hand for a gapless run starting at next_expected_nonce.
   * Delegates the actual dispatch to assignRunToWallet() for fairness-first selection.
   *
   * Returns HandSubmitResult:
   * - dispatched:true with sponsorNonce/walletIndex/sponsorAddress for the first tx
   * - dispatched:false with missingNonces when a gap exists
   */
  private async checkAndAssignRun(senderAddress: string): Promise<HandSubmitResult> {
    const { hand, missingNonces, nextExpected, handSize } = this.getHandGapInfo(senderAddress);

    // Build the gapless run starting at nextExpected
    const run: Array<{ senderNonce: number; txHex: string; paymentId: string | null }> = [];
    let expectedNonce = nextExpected;
    for (const entry of hand) {
      if (entry.sender_nonce === expectedNonce) {
        run.push({
          senderNonce: entry.sender_nonce,
          txHex: entry.tx_hex,
          paymentId: entry.payment_id,
        });
        expectedNonce++;
      } else {
        break; // gap detected
      }
    }

    if (run.length === 0) {
      // No run available — hand is empty or starts with a gap
      const oldestExpiry = hand.length > 0
        ? hand[0].expires_at
        : new Date(Date.now() + HAND_HOLD_TIMEOUT_MS).toISOString();
      return {
        dispatched: false,
        held: true,
        nextExpected,
        missingNonces,
        handSize,
        holdReason: "gap" as const,
        expiresAt: oldestExpiry,
      };
    }

    // Delegate dispatch to assignRunToWallet (fairness-first, bounded per-sender cap)
    const dispatchResult = this.assignRunToWallet(senderAddress, run);

    if (dispatchResult.assigned.length === 0) {
      // No headroom on any wallet — return held with empty missingNonces (capacity issue)
      const oldestExpiry = hand[0]?.expires_at ?? new Date(Date.now() + HAND_HOLD_TIMEOUT_MS).toISOString();
      return {
        dispatched: false,
        held: true,
        nextExpected,
        missingNonces: [],
        handSize,
        holdReason: "capacity" as const,
        expiresAt: oldestExpiry,
      };
    }

    const firstAssigned = dispatchResult.assigned[0];

    this.log("info", "hand_run_assigned", {
      senderAddress,
      runLength: dispatchResult.assigned.length,
      walletIndex: firstAssigned.walletIndex,
      firstSponsorNonce: firstAssigned.sponsorNonce,
      heldCount: dispatchResult.held.length,
      nextSenderNonce: nextExpected + dispatchResult.assigned.length,
    });

    try {
      await this.syncPaymentsAfterQueueAssignment(run, dispatchResult.assigned);
    } catch (error) {
      this.log("warn", "payment_sync_after_assign_failed", {
        senderAddress,
        assignedCount: dispatchResult.assigned.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // sponsor_address is in async KV storage — return empty string.
    // SponsorService derives the correct key from walletIndex + mnemonic.
    return {
      dispatched: true,
      sponsorNonce: firstAssigned.sponsorNonce,
      walletIndex: firstAssigned.walletIndex,
      sponsorAddress: "",
    };
  }

  /**
   * Check whether a new tx with the given senderNonce would be dispatched immediately
   * (i.e., it fills a gapless run from nextExpected) WITHOUT inserting it into sender_hand.
   * Used by the mode:"immediate" path in /hand-submit so /sponsor can reject gap submissions
   * without polluting the hand queue with transactions that will never be dispatched.
   *
   * Returns { dispatches: true } when the tx would be assigned immediately,
   * or { dispatches: false, heldResult: HandSubmitResult } with the held reason.
   */
  private checkWouldDispatch(
    senderAddress: string,
    senderNonce: number
  ):
    | { dispatches: true }
    | { dispatches: false; heldResult: Extract<import("../types").HandSubmitResult, { dispatched: false }> } {
    const { hand, nextExpected, handSize } = this.getHandGapInfo(senderAddress);

    // Simulate adding the submitted nonce to the existing hand and check whether
    // the combined set forms a gapless run starting at nextExpected.
    // This correctly handles:
    //   - Empty hand + senderNonce === nextExpected (first tx for a sender)
    //   - Hand has [5,6,7] + senderNonce=8 when nextExpected=5
    //   - Internal gaps in the hand
    const handNonceSet = new Set(hand.map((e) => e.sender_nonce));
    handNonceSet.add(senderNonce);

    // Walk from nextExpected — every nonce must be present in hand or submitted tx
    let cursor = nextExpected;
    while (handNonceSet.has(cursor)) {
      cursor++;
    }

    if (cursor <= senderNonce) {
      // Gap exists: cursor stopped before reaching senderNonce.
      // Compute the specific missing nonces for the error response.
      const gapNonces: number[] = [];
      for (let n = nextExpected; n <= senderNonce && gapNonces.length < 10; n++) {
        if (!handNonceSet.has(n)) {
          gapNonces.push(n);
        }
      }
      const oldestExpiry = hand[0]?.expires_at ?? new Date(Date.now() + HAND_HOLD_TIMEOUT_MS).toISOString();
      return {
        dispatches: false,
        heldResult: {
          dispatched: false,
          held: true,
          nextExpected,
          missingNonces: gapNonces,
          handSize,
          holdReason: "gap" as const,
          expiresAt: oldestExpiry,
        },
      };
    }

    // No gap — this tx would be dispatched immediately
    return { dispatches: true };
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

  private getStoredCount(key: string): number {
    return this.getStateValue(key) ?? 0;
  }

  private updateAssignedStats(assignedNonce: number): void {
    const totalAssigned = this.getStoredCount(STATE_KEYS.totalAssigned) + 1;
    this.setStateValue(STATE_KEYS.totalAssigned, totalAssigned);
    this.setStateValue(STATE_KEYS.lastAssignedNonce, assignedNonce);
    this.setStateValue(STATE_KEYS.lastAssignedAt, Date.now());
  }

  /** Increment a counter in nonce_state by 1. */
  private incrementCounter(key: string): void {
    this.setStateValue(key, this.getStoredCount(key) + 1);
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
   * Resolve the network and flush recipient for gap-fill/RBF transactions.
   *
   * Strategy:
   * - If FLUSH_RECIPIENT env var is set: return it (funds publisher for payouts)
   * - Else: derive wallet address for (walletIndex + 1) % walletCount (rotation fallback)
   *   Keeps flush funds circulating within the sponsor pool instead of going to a static address.
   *   If derivation fails or walletIndex is undefined: fall back to default constants.
   *
   * walletIndex is optional (callers that don't need rotation can omit it).
   */
  private getFlushRecipient(walletIndex?: number): { network: "mainnet" | "testnet"; recipient: string } {
    const network: "mainnet" | "testnet" = this.env.STACKS_NETWORK ?? "testnet";

    // If FLUSH_RECIPIENT is explicitly set, always use it
    if (this.env.FLUSH_RECIPIENT) {
      return { network, recipient: this.env.FLUSH_RECIPIENT };
    }

    // Rotation fallback is handled by getFlushRecipientAsync() in async contexts.
    // This sync version cannot derive wallet addresses, so it falls through to the default.

    // Default constant fallback (original behavior)
    const defaultRecipient = network === "mainnet"
      ? DEFAULT_FLUSH_RECIPIENT_MAINNET
      : DEFAULT_FLUSH_RECIPIENT_TESTNET;
    return { network, recipient: defaultRecipient };
  }

  /**
   * Async version of getFlushRecipient that can derive wallet addresses.
   * Use this when the caller is already in an async context (alarm, processReplayBuffer).
   * walletIndex: the wallet that is doing the gap-fill/RBF — next wallet is the rotation target.
   */
  private async getFlushRecipientAsync(walletIndex: number): Promise<{ network: "mainnet" | "testnet"; recipient: string }> {
    const network: "mainnet" | "testnet" = this.env.STACKS_NETWORK ?? "testnet";

    if (this.env.FLUSH_RECIPIENT) {
      return { network, recipient: this.env.FLUSH_RECIPIENT };
    }

    // Rotation: derive the next wallet's address from the mnemonic
    const walletCountRaw = this.env.SPONSOR_WALLET_COUNT ?? "1";
    const walletCount = Math.max(1, parseInt(walletCountRaw, 10) || 1);
    const nextWalletIndex = (walletIndex + 1) % walletCount;

    try {
      const privateKey = await this.derivePrivateKeyForWallet(nextWalletIndex);
      if (privateKey) {
        const stacksNetwork = network === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
        const address = getAddressFromPrivateKey(privateKey, stacksNetwork);
        return { network, recipient: address };
      }
    } catch {
      // Derivation failed — fall through to default
    }

    const defaultRecipient = network === "mainnet"
      ? DEFAULT_FLUSH_RECIPIENT_MAINNET
      : DEFAULT_FLUSH_RECIPIENT_TESTNET;
    return { network, recipient: defaultRecipient };
  }

  /**
   * Broadcast a serialized transaction via direct fetch to /v2/transactions.
   * Returns { ok: true, txid } on success, { ok: false, status, reason, body } on failure.
   *
   * Uses direct fetch instead of broadcastTransaction() from @stacks/transactions
   * to capture the raw HTTP status and response body on all failures — the library
   * function throws a generic "unable to parse node response" error when the node
   * returns a non-JSON body, losing all diagnostic information.
   */
  private async broadcastRawTx(
    tx: StacksTransactionWire,
    context: string
  ): Promise<
    | { ok: true; txid: string }
    | { ok: false; status: number; reason: string; body: string; reasonData?: Record<string, unknown> }
  > {
    const network: "mainnet" | "testnet" = this.env.STACKS_NETWORK ?? "testnet";
    const baseUrl = getHiroBaseUrl(network);
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      ...getHiroHeaders(this.env.HIRO_API_KEY),
    };

    const txHex = tx.serialize();
    const txBytes = hexToBytes(txHex);

    const response = await fetch(`${baseUrl}/v2/transactions`, {
      method: "POST",
      headers,
      body: txBytes,
      signal: AbortSignal.timeout(12_000),
    });

    const responseText = await response.text();

    if (response.ok) {
      let txid: string;
      try {
        txid = JSON.parse(responseText) as string;
      } catch {
        txid = responseText.trim().replace(/^"|"$/g, "");
      }
      return { ok: true, txid };
    }

    // Non-OK: try to parse JSON error, fall back to raw text
    let reason = `http_${response.status}`;
    let body = responseText.slice(0, 500);
    let parsedJson = false;
    let reasonData: Record<string, unknown> | undefined;
    try {
      const errorJson = JSON.parse(responseText) as {
        error?: string;
        reason?: string;
        reason_data?: Record<string, unknown>;
      };
      parsedJson = true;
      if (errorJson.reason) reason = errorJson.reason;
      if (errorJson.error) body = errorJson.error;
      if (errorJson.reason_data && typeof errorJson.reason_data === "object") {
        reasonData = errorJson.reason_data;
      }
    } catch {
      // Non-JSON response — keep raw text (could be HTML error page)
    }

    // Only log here for unexpected cases (5xx or non-JSON responses).
    // Callers log expected outcomes (ConflictingNonceInMempool, BadNonce) at appropriate levels.
    if (response.status >= 500 || !parsedJson) {
      this.log("warn", `${context}_raw_response`, {
        httpStatus: response.status,
        reason,
        body: responseText.slice(0, 500),
      });
    }

    return { ok: false, status: response.status, reason, body, reasonData };
  }

  /**
   * Broadcast a gap-fill STX transfer for a specific nonce.
   * Returns the txid on success, null if the nonce is already occupied or on error.
   * Amount: 1 uSTX. Fee: 30,000 uSTX (RBF-capable). Memo: gap-fill-{nonce}.
   */
  private async fillGapNonce(
    walletIndex: number,
    gapNonce: number,
    privateKey: string,
    feeOverride?: bigint
  ): Promise<string | null> {
    const fee = feeOverride ?? GAP_FILL_FEE;
    // Track gap-fill attempts for this nonce (used for fee escalation).
    // Uses INSERT ON CONFLICT so the counter is created even when no nonce_intents
    // row exists (e.g. gap nonces discovered by Hiro that the relay never assigned).
    try {
      this.sql.exec(
        `INSERT INTO nonce_intents (wallet_index, nonce, state, assigned_at, gap_fill_attempts)
         VALUES (?, ?, 'gap_fill', datetime('now'), 1)
         ON CONFLICT (wallet_index, nonce)
         DO UPDATE SET gap_fill_attempts = COALESCE(gap_fill_attempts, 0) + 1`,
        walletIndex,
        gapNonce
      );
    } catch { /* fail-open — counter is advisory */ }
    const { network, recipient } = await this.getFlushRecipientAsync(walletIndex);
    try {
      const tx = await makeSTXTokenTransfer({
        recipient,
        amount: GAP_FILL_AMOUNT,
        senderKey: privateKey,
        network,
        nonce: BigInt(gapNonce),
        fee,
        memo: `gap-fill-${gapNonce}`,
      });
      const result = await this.broadcastRawTx(tx, "gap_fill");
      if (result.ok) {
        return result.txid;
      }
      if (result.reason === "ConflictingNonceInMempool") {
        // Nonce already occupied — update ledger to prevent re-queuing on next alarm cycle.
        // Three cases:
        //   (a) We have a prior gap-fill txid: our own fill is still pending → mark broadcasted.
        //   (b) No ledger entry at all: unknown occupant → insert a conflict entry.
        //   (c) Ledger entry exists but no txid: genuine conflict, no txid to discover → mark conflict.
        try {
          const existingRows = this.sql
            .exec<{ txid: string | null; state: string }>(
              "SELECT txid, state FROM nonce_intents WHERE wallet_index = ? AND nonce = ? LIMIT 1",
              walletIndex,
              gapNonce
            )
            .toArray();
          const existingTxid = existingRows[0]?.txid ?? null;
          const existingState = existingRows[0]?.state ?? null;

          if (existingTxid !== null) {
            // Case (a): our own prior gap-fill is still pending in the mempool
            this.log("info", "gap_fill_conflict_own_pending", {
              walletIndex,
              nonce: gapNonce,
              existingTxid,
              existingState,
            });
            this.sql.exec(
              `UPDATE nonce_intents SET state = 'broadcasted'
               WHERE wallet_index = ? AND nonce = ?
               AND state NOT IN ('confirmed', 'broadcasted')`,
              walletIndex,
              gapNonce
            );
          } else if (existingState === null) {
            // Case (b): no ledger entry — insert a conflict entry so reconciler can handle it
            this.log("info", "gap_fill_conflict_unknown_occupant", { walletIndex, nonce: gapNonce });
            const now = new Date().toISOString();
            this.sql.exec(
              `INSERT OR IGNORE INTO nonce_intents (wallet_index, nonce, state, assigned_at)
               VALUES (?, ?, 'conflict', ?)`,
              walletIndex,
              gapNonce,
              now
            );
          } else {
            // Case (c): ledger entry with no txid — mark conflict to stop re-queuing
            this.log("info", "gap_fill_conflict_no_txid", {
              walletIndex,
              nonce: gapNonce,
              existingState,
            });
            this.sql.exec(
              `UPDATE nonce_intents SET state = 'conflict', error_reason = 'gap_fill_conflict_no_txid'
               WHERE wallet_index = ? AND nonce = ?
               AND state NOT IN ('confirmed', 'broadcasted')`,
              walletIndex,
              gapNonce
            );
          }
        } catch { /* fail-open */ }
        return null;
      }
      this.log("warn", "gap_fill_rejected", {
        walletIndex,
        nonce: gapNonce,
        httpStatus: result.status,
        reason: result.reason,
        body: result.body,
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
   * Fetch the fee paid by the current occupant of a sponsor nonce slot.
   * Used by broadcastRbfForNonce to compute the minimum fee needed to replace the occupant.
   *
   * Strategy:
   * - Look up txid from nonce_intents for (walletIndex, sponsorNonce).
   * - If txid found: GET /extended/v1/tx/{txid} from Hiro → extract fee_rate.
   *   This works for mempool txs (Hiro returns fee_rate for pending txs).
   * - If no txid: return null — the occupant is a "ghost" (node holds a tx invisible to Hiro).
   *
   * Fail-open: returns null on any network/parse error.
   */
  private async fetchOccupantFee(
    walletIndex: number,
    sponsorNonce: number
  ): Promise<
    | { fee: bigint; source: "hiro"; reason?: undefined }
    | { fee: null; source?: undefined; reason: "no_txid" | "not_found" | "hiro_error" }
  > {
    try {
      const rows = this.sql
        .exec<{ txid: string | null }>(
          "SELECT txid FROM nonce_intents WHERE wallet_index = ? AND nonce = ? LIMIT 1",
          walletIndex,
          sponsorNonce
        )
        .toArray();
      const txid = rows[0]?.txid ?? null;
      if (!txid) return { fee: null, reason: "no_txid" };

      const base = getHiroBaseUrl(this.env.STACKS_NETWORK ?? "testnet");
      const headers = getHiroHeaders(this.env.HIRO_API_KEY);
      const response = await fetch(`${base}/extended/v1/tx/${txid}`, {
        headers,
        signal: AbortSignal.timeout(HIRO_NONCE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        // 404 = tx not in Hiro's index (evicted/unknown). Other errors = transient Hiro failure.
        return { fee: null, reason: response.status === 404 ? "not_found" : "hiro_error" };
      }
      const data = (await response.json()) as Record<string, unknown>;
      const feeRate = data.fee_rate;
      if (typeof feeRate === "string" || typeof feeRate === "number") {
        const fee = BigInt(feeRate);
        if (fee > 0n) return { fee, source: "hiro" };
      }
      return { fee: null, reason: "not_found" };
    } catch {
      return { fee: null, reason: "hiro_error" };
    }
  }

  /**
   * Write a replaced_tx:{originalTxid} KV entry so agents can detect the replacement.
   * Fail-open — agents lose notification but relay keeps functioning.
   */
  private async writeReplacedTxEntry(
    originalTxid: string,
    replacementTxid: string,
    reason: "rbf" | "head_bump",
    walletIndex: number,
    nonce: number
  ): Promise<void> {
    try {
      await this.env.RELAY_KV?.put(
        `replaced_tx:${originalTxid}`,
        JSON.stringify({
          replacementTxid,
          reason,
          walletIndex,
          nonce,
          replacedAt: new Date().toISOString(),
        }),
        { expirationTtl: 3600 }
      );
    } catch { /* fail-open */ }
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

    const { network, recipient } = await this.getFlushRecipientAsync(walletIndex);
    const attemptNum = state.rbfAttempts + 1;

    try {
      // Discover the occupant's fee via Hiro API (preferred) or fall back to dispatch_queue.
      // Using the actual occupant fee prevents "guaranteed failure" attempts where our fee
      // is too low to replace the occupant — those should not burn the attempt counter.
      const occupantResult = await this.fetchOccupantFee(walletIndex, nonce);
      const occupantFee = occupantResult.fee;

      // Also read original_fee from dispatch_queue as fallback
      const dispatchRow = this.sql
        .exec<{ original_fee: string | null }>(
          "SELECT original_fee FROM dispatch_queue WHERE wallet_index = ? AND sponsor_nonce = ? LIMIT 1",
          walletIndex,
          nonce
        )
        .toArray()[0];
      const dispatchFeeStr = dispatchRow?.original_fee ?? null;
      const dispatchFee = dispatchFeeStr ? (() => { try { return BigInt(dispatchFeeStr); } catch { return null; } })() : null;

      // RBF fee = max(occupant_fee, dispatch_fee) + 1, capped at MAX_BROADCAST_FEE
      const baseFee = occupantFee !== null && dispatchFee !== null
        ? (occupantFee > dispatchFee ? occupantFee : dispatchFee)
        : (occupantFee ?? dispatchFee);

      // Short-circuit: if baseFee already at/above cap, broadcast can never succeed
      if (baseFee !== null && baseFee >= MAX_BROADCAST_FEE) {
        this.log("warn", "rbf_fee_cap_reached", {
          walletIndex,
          nonce,
          baseFee: baseFee.toString(),
          maxBroadcastFee: MAX_BROADCAST_FEE.toString(),
          occupantFee: occupantFee?.toString() ?? null,
          dispatchFee: dispatchFeeStr,
          attemptNum,
        });
        state.rbfAttempts = attemptNum;
        await this.state.storage.put(key, state);
        return null;
      }

      const rbfFee = baseFee !== null
        ? baseFee + 1n
        : MIN_FLUSH_FEE;

      this.log("info", "rbf_fee_used", {
        walletIndex,
        nonce,
        rbfFee: rbfFee.toString(),
        occupantFee: occupantFee?.toString() ?? null,
        dispatchFee: dispatchFeeStr,
        feeSource: occupantResult.source ?? (dispatchFeeStr ? "dispatch_queue" : "floor"),
        occupantLookupReason: occupantResult.reason ?? null,
        attemptNum,
      });

      const tx = await makeSTXTokenTransfer({
        recipient,
        amount: GAP_FILL_AMOUNT,
        senderKey: privateKey,
        network,
        nonce: BigInt(nonce),
        fee: rbfFee,
        memo: `rbf-${nonce}-attempt-${attemptNum}`,
      });
      const result = await this.broadcastRawTx(tx, "rbf");

      state.lastSeen = now;
      state.originalTxid = state.originalTxid ?? originalTxid;

      if (result.ok) {
        // Broadcast succeeded — increment attempt counter and reset ghost state
        state.rbfAttempts = attemptNum;
        state.lastRbfTxid = result.txid;
        await this.state.storage.put(key, state);
        this.incrementCounter(STATE_KEYS.stuckTxRbfBroadcast);
        // Update the ledger txid so reconciliation tracks the replacement
        try {
          this.sql.exec(
            `UPDATE nonce_intents SET txid = ? WHERE wallet_index = ? AND nonce = ?`,
            result.txid,
            walletIndex,
            nonce
          );
        } catch { /* fail-open */ }
        // Notify agents when a real sponsored tx is replaced (gap-fills have no original tx)
        if (state.originalTxid) {
          await this.writeReplacedTxEntry(state.originalTxid, result.txid, "rbf", walletIndex, nonce);
        }
        this.log("info", "rbf_broadcast_success", {
          walletIndex,
          nonce,
          txid: result.txid,
          fee: rbfFee.toString(),
          attemptNum,
          originalTxid: state.originalTxid,
        });
        return result.txid;
      }

      // If the node reports BadNonce, the nonce was consumed by a confirmed tx.
      // Cap attempts to prevent further retries — the reconcile loop's
      // last_executed_tx_nonce check will mark it confirmed on the next cycle.
      if (result.reason === "BadNonce") {
        // Terminal — delete stuck-tx state entirely to avoid orphaned entries
        state.rbfAttempts = attemptNum;
        await this.state.storage.delete(key);
        this.log("info", "rbf_nonce_consumed", {
          walletIndex,
          nonce,
          reason: result.reason,
          body: result.body,
          attemptNum,
        });
        return null;
      }

      if (result.reason === "ConflictingNonceInMempool") {
        // Classify the conflict for logging — no per-wallet degradation flags.
        const occupantReason = occupantResult.reason;
        const isGhost = occupantReason === "no_txid" || occupantReason === "not_found";
        const isHiroError = occupantReason === "hiro_error";

        if (isGhost) {
          // Ghost — node holds tx invisible to Hiro. Log but don't penalize wallet.
          this.log("warn", "rbf_ghost_conflict", {
            walletIndex,
            nonce,
            rbfFee: rbfFee.toString(),
            occupantReason,
          });
        } else if (isHiroError) {
          // Hiro unavailable — can't determine occupant fee, don't blame the wallet.
          this.log("warn", "rbf_conflict_hiro_unavailable", {
            walletIndex,
            nonce,
            rbfFee: rbfFee.toString(),
            attemptNum,
          });
        } else {
          // Fee too low — occupant fee discovered but ours wasn't enough.
          state.rbfAttempts = attemptNum;
          this.log("warn", "rbf_fee_too_low", {
            walletIndex,
            nonce,
            rbfFee: rbfFee.toString(),
            occupantFee: occupantFee!.toString(),
            attemptNum,
          });
        }
        await this.state.storage.put(key, state);
        return null;
      }

      // Other rejection — increment attempt count to prevent runaway and log details
      state.rbfAttempts = attemptNum;
      await this.state.storage.put(key, state);
      this.log("warn", "rbf_broadcast_rejected", {
        walletIndex,
        nonce,
        httpStatus: result.status,
        reason: result.reason,
        body: result.body,
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
  // Dynamic scaling and surge tracking helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse SPONSOR_WALLET_MAX from env.
   * Returns a number in [1, ABSOLUTE_MAX_WALLET_COUNT], defaulting to MAX_WALLET_COUNT (10).
   */
  private getSponsorWalletMax(): number {
    const raw = this.env.SPONSOR_WALLET_MAX;
    if (!raw) return MAX_WALLET_COUNT;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > ABSOLUTE_MAX_WALLET_COUNT) {
      return MAX_WALLET_COUNT;
    }
    return n;
  }

  /**
   * Check overall pool pressure and record/update/resolve surge events.
   * Called from alarm() after all wallet reconciliations complete.
   * Never throws — fail-open.
   */
  private checkAndRecordSurge(
    walletCount: number
  ): void {
    try {
      if (walletCount === 0) return;

      const poolCapacity = walletCount * CHAINING_LIMIT;
      const totalReserved = this.poolTotalReserved(walletCount);
      const overallPressure = poolCapacity > 0 ? totalReserved / poolCapacity : 0;
      const pressurePct = Math.round(overallPressure * 100);
      const now = new Date().toISOString();

      // Read active surge id from nonce_state (stored as integer, 0 = none)
      const activeSurgeId = this.getStateValue("active_surge_id");

      if (overallPressure >= SURGE_PRESSURE_THRESHOLD) {
        if (activeSurgeId === null || activeSurgeId === 0) {
          // Start a new surge event
          const result = this.sql
            .exec<{ id: number }>(
              `INSERT INTO surge_events
                 (started_at, peak_pressure_pct, peak_reserved, wallet_count_at_peak)
               VALUES (?, ?, ?, ?)
               RETURNING id`,
              now,
              pressurePct,
              totalReserved,
              walletCount
            )
            .toArray();
          const newId = result[0]?.id;
          if (newId !== undefined) {
            this.setStateValue("active_surge_id", newId);
            this.log("warn", "surge_started", {
              surgeId: newId,
              pressurePct,
              totalReserved,
              walletCount,
            });
          }
        } else {
          // Update existing surge if new peak is higher
          const existing = this.sql
            .exec<{ peak_pressure_pct: number; peak_reserved: number }>(
              "SELECT peak_pressure_pct, peak_reserved FROM surge_events WHERE id = ? LIMIT 1",
              activeSurgeId
            )
            .toArray()[0];
          if (existing && (pressurePct > existing.peak_pressure_pct || totalReserved > existing.peak_reserved)) {
            this.sql.exec(
              `UPDATE surge_events
               SET peak_pressure_pct = MAX(peak_pressure_pct, ?),
                   peak_reserved = MAX(peak_reserved, ?),
                   wallet_count_at_peak = ?
               WHERE id = ?`,
              pressurePct,
              totalReserved,
              walletCount,
              activeSurgeId
            );
          }
        }
      } else if (activeSurgeId !== null && activeSurgeId > 0) {
        // Pressure dropped below threshold — resolve the surge
        const startedRows = this.sql
          .exec<{ started_at: string; peak_pressure_pct: number; peak_reserved: number; wallet_count_at_peak: number }>(
            "SELECT started_at, peak_pressure_pct, peak_reserved, wallet_count_at_peak FROM surge_events WHERE id = ? LIMIT 1",
            activeSurgeId
          )
          .toArray();
        const surgeRow = startedRows[0];
        if (surgeRow) {
          const startMs = new Date(surgeRow.started_at).getTime();
          const durationMs = Date.now() - startMs;
          this.sql.exec(
            "UPDATE surge_events SET resolved_at = ?, duration_ms = ? WHERE id = ?",
            now,
            durationMs,
            activeSurgeId
          );
          this.setStateValue("active_surge_id", 0);

          // Emit structured surge_pattern for operator capacity planning
          const startedAt = new Date(surgeRow.started_at);
          const rampRate = durationMs > 0
            ? Math.round((surgeRow.peak_pressure_pct / (durationMs / 1000)) * 100) / 100
            : 0;
          this.log("info", "surge_pattern", {
            surgeId: activeSurgeId,
            time_of_day: startedAt.getUTCHours(),
            day_of_week: startedAt.getUTCDay(),
            peak_pressure_pct: surgeRow.peak_pressure_pct,
            peak_reserved: surgeRow.peak_reserved,
            wallet_count_at_peak: surgeRow.wallet_count_at_peak,
            duration_ms: durationMs,
            ramp_rate_pct_per_sec: rampRate,
          });
        }
      }
    } catch (e) {
      this.log("debug", "surge_check_error", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Check if dynamic wallet scaling is needed and perform it if so.
   * Called from alarm() after reconciliation. Scales up by one wallet when:
   *   - All initialized wallets are above SCALE_UP_THRESHOLD pressure
   *   - Current wallet count is below SPONSOR_WALLET_MAX
   *   - SPONSOR_MNEMONIC is available for key derivation
   *
   * Never throws — fail-open.
   */
  private async checkAndScaleUp(initializedCount: number): Promise<void> {
    try {
      if (initializedCount === 0) return;

      const walletMax = this.getSponsorWalletMax();
      if (initializedCount >= walletMax) {
        return; // Already at ceiling
      }

      // Check if ALL wallets are above the scale-up threshold
      for (let wi = 0; wi < initializedCount; wi++) {
        const headroom = this.walletHeadroom(wi);
        const pressure = 1 - (headroom / CHAINING_LIMIT);
        if (pressure < SCALE_UP_THRESHOLD) {
          return; // At least one wallet has capacity — no scale-up needed
        }
      }

      // All wallets are under pressure — derive and initialize the next wallet
      const newWalletIndex = initializedCount;
      const privateKey = await this.derivePrivateKeyForWallet(newWalletIndex);
      if (!privateKey) {
        this.log("warn", "scale_up_skipped_no_key", {
          newWalletIndex,
          reason: "SPONSOR_MNEMONIC not available or derivation failed",
        });
        return;
      }

      // Derive Stacks address for the new wallet
      const network = this.env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
      const newAddress = getAddressFromPrivateKey(privateKey, network);

      // Seed nonce head from Hiro
      await this.initWalletHeadFromHiro(newWalletIndex, newAddress);

      // Register the new wallet address
      await this.setStoredSponsorAddressForWallet(newWalletIndex, newAddress);

      // Update dynamic wallet count in nonce_state
      const newCount = newWalletIndex + 1;
      this.setStateValue("dynamic_wallet_count", newCount);

      this.log("info", "wallet_scaled_up", {
        newWalletIndex,
        newAddress,
        newWalletCount: newCount,
        reason: `All ${initializedCount} wallets exceeded ${Math.round(SCALE_UP_THRESHOLD * 100)}% pressure threshold`,
        walletMax,
      });
    } catch (e) {
      this.log("warn", "scale_up_error", {
        error: e instanceof Error ? e.message : String(e),
        initializedCount,
      });
    }
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

  /**
   * Compute the escalated gap-fill fee for a nonce based on prior attempts.
   * Returns baseFee + priorAttempts (capped at MAX_BROADCAST_FEE), or baseFee if no prior attempts.
   * Fail-open: returns baseFee on SQL errors.
   */
  private computeEscalatedFee(walletIndex: number, nonce: number, baseFee: bigint = GAP_FILL_FEE): bigint {
    try {
      const rows = this.sql
        .exec<{ gap_fill_attempts: number | null }>(
          "SELECT gap_fill_attempts FROM nonce_intents WHERE wallet_index = ? AND nonce = ? LIMIT 1",
          walletIndex,
          nonce
        )
        .toArray();
      const priorAttempts = rows[0]?.gap_fill_attempts ?? 0;
      if (priorAttempts > 0) {
        const escalated = baseFee + BigInt(priorAttempts);
        return escalated > MAX_BROADCAST_FEE ? MAX_BROADCAST_FEE : escalated;
      }
    } catch { /* fail-open — use base fee */ }
    return baseFee;
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
    for (let wi = 0; wi < ABSOLUTE_MAX_WALLET_COUNT; wi++) {
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
      this.advanceChainFrontier(walletIndex, info.possible_next_nonce);
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
   * Count nonces in 'assigned' state only (handed out, not yet broadcast).
   * Used for diagnostics/logging — NOT for chaining-limit decisions.
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
   * Count all in-flight nonces for a wallet: 'assigned' (handed out, awaiting broadcast),
   * 'broadcasted' (accepted by node, in mempool), and 'confirmed' (broadcast succeeded,
   * nonce consumed — still pending on-chain despite the ledger state name).
   * The Stacks node's TooMuchChaining limit (25) counts ALL pending txs from a sender,
   * so chaining-limit decisions must count all three states.
   * Used as the fallback when chain frontier is not yet available (cold start).
   */
  private ledgerInFlightCount(walletIndex: number): number {
    const rows = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM nonce_intents WHERE wallet_index = ? AND state IN ('assigned', 'broadcasted', 'confirmed')",
        walletIndex
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

      // Check current state — if ledgerBroadcastOutcome already set a terminal state
      // (conflict/failed/broadcasted), don't clobber it. This prevents the race where
      // releaseNonceDO and recordBroadcastOutcomeDO run concurrently.
      const currentRows = this.sql
        .exec<{ state: string }>(
          "SELECT state FROM nonce_intents WHERE wallet_index = ? AND nonce = ? LIMIT 1",
          walletIndex,
          nonce
        )
        .toArray();
      const currentState = currentRows[0]?.state;

      if (txid) {
        // Nonce was broadcast successfully — mark as confirmed in the intent ledger.
        // 'confirmed' here means "broadcast accepted by the network".
        // Reconciliation will further validate on-chain confirmation.
        // Only upgrade from assigned or broadcasted — not from conflict/failed.
        if (currentState !== "assigned" && currentState !== "broadcasted") {
          return; // Already in terminal state
        }
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = 'confirmed', txid = ?, broadcasted_at = ?, confirmed_at = ?
           WHERE wallet_index = ? AND nonce = ? AND state IN ('assigned', 'broadcasted')`,
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
        // Broadcast was attempted but release has no txid — quarantine.
        // Only transition from assigned — if already conflict/failed/broadcasted, don't clobber.
        if (currentState !== "assigned") {
          return;
        }
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = 'failed', error_reason = ?
           WHERE wallet_index = ? AND nonce = ? AND state = 'assigned'`,
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
        // Nonce was never broadcast — mark expired.
        // Only from assigned — if broadcast outcome already recorded, don't clobber.
        if (currentState !== "assigned") {
          return;
        }
        // Dual-write: status='broadcast_failed' (Phase 1 SponsorLedgerSchema alignment).
        // Expired = nonce slot was reserved but never dispatched to the network.
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = 'expired', status = 'broadcast_failed'
           WHERE wallet_index = ? AND nonce = ? AND state = 'assigned'`,
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

      // Monotonic state transitions: only update if current state allows it.
      // State ordering: assigned → broadcasted → confirmed (via reconciliation)
      //                 assigned → conflict | failed (broadcast rejection)
      // Once in confirmed/conflict/failed/expired, no further transitions from broadcast outcome.
      const currentRows = this.sql
        .exec<{ state: string }>(
          "SELECT state FROM nonce_intents WHERE wallet_index = ? AND nonce = ? LIMIT 1",
          walletIndex,
          nonce
        )
        .toArray();
      const currentState = currentRows[0]?.state;
      if (!currentState || (currentState !== "assigned" && currentState !== "broadcasted")) {
        // Already in a terminal state (confirmed/conflict/failed/expired) — don't clobber
        this.log("debug", "ledger_broadcast_outcome_skipped", {
          walletIndex, nonce, currentState, txid: txid ?? null,
        });
        return;
      }

      if (txid) {
        // Broadcast accepted — record txid, status, node URL.
        // Dual-write: status='broadcast_sent', broadcast_at=now (Phase 1 SponsorLedgerSchema alignment).
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = 'broadcasted', txid = ?, http_status = ?,
               broadcast_node = ?, broadcasted_at = ?,
               status = 'broadcast_sent', broadcast_at = ?
           WHERE wallet_index = ? AND nonce = ? AND state IN ('assigned', 'broadcasted')`,
          txid,
          httpStatus ?? 200,
          nodeUrl ?? null,
          now,
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
        // Advance matching dispatch queue entry from 'queued' to 'dispatched'
        this.transitionQueueEntry(walletIndex, nonce, "dispatched");
      } else {
        // Determine if this is a nonce conflict (quarantine) or generic failure
        const isConflict =
          errorReason !== undefined &&
          errorReason.includes("ConflictingNonceInMempool");
        const newState = isConflict ? "conflict" : "failed";
        // Dual-write: status='broadcast_failed' (Phase 1 SponsorLedgerSchema alignment).
        this.sql.exec(
          `UPDATE nonce_intents
           SET state = ?, http_status = ?, broadcast_node = ?,
               error_reason = ?, broadcasted_at = ?,
               status = 'broadcast_failed'
           WHERE wallet_index = ? AND nonce = ? AND state IN ('assigned', 'broadcasted')`,
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
    await this.refreshSponsorStatusSnapshot();
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
      const updateCursor = this.sql.exec(
        `UPDATE nonce_intents
         SET state = 'confirmed', txid = ?, broadcasted_at = COALESCE(broadcasted_at, ?), confirmed_at = ?
         WHERE wallet_index = ? AND nonce = ? AND state != 'confirmed'`,
        txid,
        now,
        now,
        walletIndex,
        nonce
      );
      // Only emit event if the UPDATE actually transitioned the intent (prevents
      // duplicate reconcile_confirmed events when the nonce is already confirmed)
      if (updateCursor.rowsWritten > 0) {
        this.sql.exec(
          `INSERT INTO nonce_events (wallet_index, nonce, event, detail, created_at)
           VALUES (?, ?, 'reconcile_confirmed', ?, ?)`,
          walletIndex,
          nonce,
          JSON.stringify({ txid, reason: "chain_advanced_past_nonce" }),
          now
        );
      }
      // Also advance any matching dispatch queue entry to 'confirmed'
      this.transitionQueueEntry(walletIndex, nonce, "confirmed");
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
      return this.getStateValue(STATE_KEYS.current);
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
      this.setStateValue(STATE_KEYS.current, nextNonce);
    } else {
      this.setStateValue(`wallet_next_nonce:${walletIndex}`, nextNonce);
    }
  }

  // ---------------------------------------------------------------------------
  // Chain frontier — monotonic high-water mark of Hiro's possible_next_nonce.
  // Used for O(1) headroom calculation without SQL or API calls.
  // ---------------------------------------------------------------------------

  private chainFrontierKey(walletIndex: number): string {
    return `chain_frontier:${walletIndex}`;
  }

  /**
   * Read the chain frontier for a wallet. Checks in-memory cache first,
   * falls back to persistent nonce_state. Returns null if never observed.
   */
  private getChainFrontier(walletIndex: number): number | null {
    const cached = this.chainFrontierCache.get(walletIndex);
    if (cached !== undefined) return cached;
    const stored = this.getStateValue(this.chainFrontierKey(walletIndex));
    if (stored !== null) this.chainFrontierCache.set(walletIndex, stored);
    return stored;
  }

  /**
   * Advance the chain frontier for a wallet. Only moves forward (monotonic).
   * Called on every Hiro observation to absorb the highest confirmed nonce,
   * filtering out load-balanced inconsistency where a stale node returns a
   * lower value.
   */
  private advanceChainFrontier(walletIndex: number, hiroNextNonce: number): void {
    const current = this.getChainFrontier(walletIndex);
    const next = current !== null ? Math.max(current, hiroNextNonce) : hiroNextNonce;
    if (current === next) return; // no change
    this.chainFrontierCache.set(walletIndex, next);
    this.setStateValue(this.chainFrontierKey(walletIndex), next);
  }

  /**
   * Compute headroom for a wallet using the chain frontier (O(1), no SQL).
   * headroom = CHAINING_LIMIT - (assignmentHead - chainFrontier)
   *
   * The gap (head - frontier) represents all nonces that are outstanding:
   * assigned, broadcasted, confirmed-but-pending, and silently-failed.
   * This naturally errs conservative — failed broadcasts inflate the gap
   * until reconciliation cleans them up.
   *
   * Returns null if no chain frontier exists (cold start) — caller should
   * fall back to ledgerInFlightCount().
   */
  private headroomFromChainGap(walletIndex: number): number | null {
    const frontier = this.getChainFrontier(walletIndex);
    if (frontier === null) return null;
    const head = this.ledgerGetWalletHead(walletIndex);
    if (head === null) return null;
    // Clamp gap to [0, ∞) — frontier can exceed head if Hiro advances
    // before the ledger head is forward-bumped, making gap negative.
    const gap = Math.max(0, head - frontier);
    return Math.max(0, Math.min(CHAINING_LIMIT, CHAINING_LIMIT - gap));
  }

  /**
   * Effective headroom for a wallet — how many more nonces it can accept.
   * Prefers the O(1) chain-gap calculation; falls back to SQL-based
   * ledgerInFlightCount on cold start (no frontier yet).
   */
  private walletHeadroom(walletIndex: number): number {
    return this.headroomFromChainGap(walletIndex) ?? (CHAINING_LIMIT - this.ledgerInFlightCount(walletIndex));
  }

  /**
   * Effective headroom for gin rummy dispatch.
   * Returns walletHeadroom - WALLET_RESERVE_SLOTS, clamped to 0 minimum.
   * The reserve slots guarantee room for new senders even when existing runs are in flight.
   * Used by assignRunToWallet() to pick the best wallet for a sender's run.
   */
  private effectiveHeadroom(walletIndex: number): number {
    return Math.max(0, this.walletHeadroom(walletIndex) - WALLET_RESERVE_SLOTS);
  }

  /**
   * Assign a gapless sender run to a single wallet with fairness-first selection.
   *
   * Invariant: ALL assigned txs land on the SAME walletIndex.
   * Never splits a run across wallets — cross-wallet ordering dependencies can't be resolved.
   *
   * Steps:
   * 1. Truncate run to MAX_RUN_PER_DISPATCH (excess stays in sender_hand for next cycle)
   * 2. Find the wallet with the most effectiveHeadroom (total headroom - WALLET_RESERVE_SLOTS)
   *    that can fit the ENTIRE truncated run
   * 3. If found: allocate contiguous sponsor nonces on that wallet, insert all into
   *    dispatch_queue as 'queued', record in wallet_hand — all atomically
   * 4. If no single wallet fits the full truncated run: find wallet with most effectiveHeadroom,
   *    truncate run further to fit, hold the rest in sender_hand
   * 5. If no headroom at all: hold all txs
   *
   * Returns RunDispatchResult: { assigned, held }
   */
  private assignRunToWallet(
    senderAddress: string,
    run: Array<{ senderNonce: number; txHex: string; paymentId: string | null }>
  ): RunDispatchResult {
    const now = new Date().toISOString();

    // Step 1: Truncate run to MAX_RUN_PER_DISPATCH
    const truncatedRun = run.slice(0, MAX_RUN_PER_DISPATCH);
    const excessRun = run.slice(MAX_RUN_PER_DISPATCH);
    // Excess stays in sender_hand — we just don't dispatch it this cycle

    if (truncatedRun.length === 0) {
      return { assigned: [], held: [] };
    }

    // Step 2: Find wallet with most effectiveHeadroom that can fit the entire truncated run
    let bestWalletIndex = -1;
    let bestEffectiveHeadroom = 0;
    for (let wi = 0; wi < MAX_WALLET_COUNT; wi++) {
      const head = this.ledgerGetWalletHead(wi);
      if (head === null) break; // wallet not initialized — stop scanning
      const eff = this.effectiveHeadroom(wi);
      if (eff > bestEffectiveHeadroom) {
        bestEffectiveHeadroom = eff;
        bestWalletIndex = wi;
      }
    }

    // Determine how many txs we can actually dispatch
    let dispatchCount: number;
    if (bestWalletIndex === -1 || bestEffectiveHeadroom === 0) {
      // No wallet has effective headroom — hold everything
      dispatchCount = 0;
    } else if (bestEffectiveHeadroom >= truncatedRun.length) {
      // Best wallet can fit the entire truncated run
      dispatchCount = truncatedRun.length;
    } else {
      // Best wallet can only fit part of the truncated run
      dispatchCount = bestEffectiveHeadroom;
    }

    if (dispatchCount === 0) {
      // Hold all txs (truncated + excess)
      const held = [...truncatedRun, ...excessRun].map((e) => ({ senderNonce: e.senderNonce }));
      return { assigned: [], held };
    }

    const dispatchBatch = truncatedRun.slice(0, dispatchCount);
    const remainingTruncated = truncatedRun.slice(dispatchCount);
    const held = [...remainingTruncated, ...excessRun].map((e) => ({ senderNonce: e.senderNonce }));

    // Step 3: Atomic hand→queue transition for dispatchBatch
    const walletIndex = bestWalletIndex;
    const walletHead = this.ledgerGetWalletHead(walletIndex)!;
    const firstSponsorNonce = walletHead;

    const assigned: RunDispatchResult["assigned"] = [];

    for (let i = 0; i < dispatchBatch.length; i++) {
      const entry = dispatchBatch[i];
      const sponsorNonce = firstSponsorNonce + i;
      const position = sponsorNonce;

      // Remove from sender_hand
      this.sql.exec(
        "DELETE FROM sender_hand WHERE sender_address = ? AND sender_nonce = ?",
        senderAddress,
        entry.senderNonce
      );

      // Insert into dispatch_queue
      this.sql.exec(
        `INSERT OR REPLACE INTO dispatch_queue
           (wallet_index, position, payment_id, sender_tx_hex, sender_address, sender_nonce,
            sponsor_nonce, state, queued_at, dispatched_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL)`,
        walletIndex,
        position,
        entry.paymentId,
        entry.txHex,
        senderAddress,
        entry.senderNonce,
        sponsorNonce,
        now
      );

      // Record the assignment in the nonce_intents ledger (authoritative nonce state)
      this.ledgerAssign(walletIndex, sponsorNonce);

      // Update assignment counters so /nonce/stats and dashboards stay accurate
      this.updateAssignedStats(sponsorNonce);

      // Record in wallet_hand (allocated state)
      this.sql.exec(
        `INSERT OR REPLACE INTO wallet_hand
           (wallet_index, sponsor_nonce, state, sender_address, sender_nonce,
            original_fee, dispatched_at, confirmed_at)
         VALUES (?, ?, 'allocated', ?, ?, NULL, NULL, NULL)`,
        walletIndex,
        sponsorNonce,
        senderAddress,
        entry.senderNonce
      );

      assigned.push({ senderNonce: entry.senderNonce, walletIndex, sponsorNonce });
    }

    // Advance wallet nonce head past the dispatched run
    this.ledgerAdvanceWalletHead(walletIndex, walletHead + dispatchBatch.length);

    this.log("info", "assign_run_to_wallet", {
      senderAddress,
      walletIndex,
      firstSponsorNonce,
      dispatchCount,
      heldCount: held.length,
    });

    return { assigned, held };
  }

  private async syncPaymentsAfterQueueAssignment(
    run: Array<{ senderNonce: number; paymentId: string | null }>,
    assigned: RunDispatchResult["assigned"]
  ): Promise<void> {
    if (!this.env.RELAY_KV || assigned.length === 0) {
      return;
    }

    const paymentIdsBySenderNonce = new Map(
      run
        .filter((entry) => entry.paymentId)
        .map((entry) => [entry.senderNonce, entry.paymentId as string])
    );

    await Promise.all(
      assigned.map(async (entry) => {
        const paymentId = paymentIdsBySenderNonce.get(entry.senderNonce);
        if (!paymentId) {
          return;
        }

        const record = await getPaymentRecord(this.env.RELAY_KV!, paymentId);
        if (!record || new Set(["confirmed", "failed", "replaced"]).has(record.status)) {
          return;
        }

        record.sponsorWalletIndex = entry.walletIndex;
        record.sponsorNonce = entry.sponsorNonce;
        record.relayState = "queued";
        record.holdReason = undefined;
        record.nextExpectedNonce = undefined;
        record.missingNonces = undefined;
        record.holdExpiresAt = undefined;
        record.error = undefined;
        record.errorCode = undefined;
        record.retryable = undefined;

        await putPaymentRecord(this.env.RELAY_KV!, record);
      })
    );
  }

  /**
   * Sum effective headroom across `walletCount` wallets and derive the
   * aggregate reserved count (poolCapacity - totalHeadroom).
   * Used for pool-pressure signaling in both assignNonce and checkAndRecordSurge.
   */
  private poolTotalReserved(walletCount: number): number {
    let totalHeadroom = 0;
    for (let wi = 0; wi < walletCount; wi++) {
      totalHeadroom += this.walletHeadroom(wi);
    }
    return (walletCount * CHAINING_LIMIT) - totalHeadroom;
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
    this.advanceChainFrontier(walletIndex, seedNonce);
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

      // Use the larger of the caller-supplied count and the dynamically-scaled count
      // stored in nonce_state. This ensures scale-ups are reflected immediately
      // without waiting for SponsorService to send the new count.
      const storedDynamic = this.getStateValue("dynamic_wallet_count");
      const effectiveWalletCount = Math.max(
        1,
        Math.min(
          Math.max(walletCount, storedDynamic ?? 0),
          this.getSponsorWalletMax()
        )
      );

      // Resolve the correct sponsor address for a given wallet index.
      // In multi-wallet mode, each wallet has its own Stacks address for nonce seeding.
      const resolveAddress = (wi: number): string =>
        addresses?.[String(wi)] ?? sponsorAddress;

      // Scan all wallets and select the one with the most available headroom.
      // No degradation flags — per-nonce occupied tracking handles conflicts.
      let totalMempoolDepth = 0;
      const eligibleWallets: Array<{ walletIndex: number; headroom: number }> = [];

      for (let i = 0; i < effectiveWalletCount; i++) {
        await this.initWalletHeadFromHiro(i, resolveAddress(i));
        const headroom = this.walletHeadroom(i);
        if (headroom > 0) {
          eligibleWallets.push({ walletIndex: i, headroom });
        } else {
          totalMempoolDepth += CHAINING_LIMIT - headroom;
        }
      }

      // Select wallet with most available headroom (fewest in-flight nonces).
      let selectedWalletIndex: number | null = null;
      if (eligibleWallets.length > 0) {
        eligibleWallets.sort((a, b) => b.headroom - a.headroom);
        const best = eligibleWallets[0];
        // Soft-reject: if even the best wallet is nearly full, tell the caller to back off
        // rather than assigning into a pool that could hit TooMuchChaining in the next burst.
        if (best.headroom <= SOFT_REJECT_HEADROOM_THRESHOLD) {
          this.log("warn", "low_headroom_soft_reject", {
            maxHeadroom: best.headroom,
            threshold: SOFT_REJECT_HEADROOM_THRESHOLD,
            eligibleCount: eligibleWallets.length,
          });
          throw new LowHeadroomError(best.headroom);
        }
        selectedWalletIndex = best.walletIndex;
      }

      if (selectedWalletIndex === null) {
        throw new ChainingLimitError(totalMempoolDepth);
      }

      const walletIndex = selectedWalletIndex;

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
        const inFlightCount = this.ledgerInFlightCount(walletIndex);
        this.log("warn", "nonce_lookahead_capped", {
          walletIndex,
          assignedNonce,
          hiroNextNonce,
          limit: hiroNextNonce + LOOKAHEAD_GUARD_BUFFER,
          inFlightCount,
        });
        // Treat this the same as chaining limit — caller returns 429 so agent can retry
        throw new ChainingLimitError(inFlightCount);
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
        chainGapHeadroom: this.headroomFromChainGap(walletIndex),
        nextHead: assignedNonce + 1,
      });

      // Advance round-robin to next wallet
      await this.setNextWalletIndex((walletIndex + 1) % effectiveWalletCount);

      // Compute totalReserved across all wallets for pool pressure signaling.
      const totalReserved = this.poolTotalReserved(effectiveWalletCount);

      this.log("debug", "nonce_pool_pressure", {
        walletIndex,
        totalReserved,
        poolCapacity: effectiveWalletCount * CHAINING_LIMIT,
      });

      await this.refreshSponsorStatusSnapshot();

      return { nonce: assignedNonce, walletIndex, totalReserved };
    });
  }

  /**
   * Release a nonce for the specified wallet — updates only the intent ledger.
   *
   * txid present   → nonce was broadcast successfully; mark as 'confirmed' in ledger.
   * txid absent    → nonce was NOT broadcast (e.g. broadcast failure). Priority order:
   *   1. errorReason provided → mark as 'failed' with reason recorded.
   *   2. Prior txid in nonce_txids → mark as 'failed' (broadcast happened but release has no txid).
   *   3. Neither → mark as 'expired' (truly unused nonce, available for gap-fill).
   * walletIndex    → which wallet the nonce belongs to (default: 0)
   * fee            → when provided with txid (broadcast succeeded), recorded in cumulative wallet stats
   * errorReason    → recorded in ledger for diagnostics
   */
  async releaseNonce(nonce: number, txid?: string, walletIndex: number = 0, fee?: string, errorReason?: string): Promise<void> {
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

      if (!txid) {
        if (errorReason) {
          this.log("warn", "nonce_quarantined", {
            walletIndex,
            nonce,
            reason: errorReason,
          });
          this.ledgerRelease(walletIndex, nonce, undefined, errorReason);
        } else {
          // No explicit error reason: check if a txid was previously recorded in nonce_txids.
          const txidRows = this.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) as count FROM nonce_txids WHERE nonce = ?",
              nonce
            )
            .toArray();
          const hasPriorTxid = (txidRows[0]?.count ?? 0) > 0;

          if (hasPriorTxid) {
            this.log("warn", "nonce_quarantined", {
              walletIndex,
              nonce,
              reason: "txid_recorded_on_failed_release",
            });
            this.ledgerRelease(walletIndex, nonce, undefined, "txid_recorded_on_failed_release");
          } else {
            // Truly unused nonce (never broadcast) — mark expired
            this.ledgerRelease(walletIndex, nonce, undefined);
          }
        }
      } else {
        // txid provided: nonce was broadcast successfully — consumed
        if (fee && fee !== "0") {
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

      await this.refreshSponsorStatusSnapshot();
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

  /**
   * Lightweight pool health check — returns per-wallet availability and
   * aggregate capacity so callers can perform pre-flight gating before
   * attempting nonce assignment. Exposed via GET /pool-health and /health.
   *
   * Much cheaper than getStats() — only reads reserved counts from the
   * ledger, no heavy SQL joins or utilization queries.
   */
  async getPoolHealth(): Promise<PoolHealthResponse> {
    const initializedWallets = await this.getInitializedWallets();

    const wallets: WalletHealthSnapshot[] = initializedWallets.map(({ walletIndex }) => {
      const reserved = this.ledgerReservedCount(walletIndex);
      const available = Math.max(0, CHAINING_LIMIT - reserved);
      const queueState = this.getDispatchQueueDepth(walletIndex);
      const replayDepth = this.getReplayBufferDepth(walletIndex);
      return {
        walletIndex,
        // circuit breaker removed; always false for API compatibility
        circuitBreakerOpen: false,
        reserved,
        available,
        quarantineCount: 0,
        queueDepth: queueState.total,
        replayBufferDepth: replayDepth,
        dispatchedCount: queueState.dispatched,
      };
    });

    const totalReserved = wallets.reduce((s, w) => s + w.reserved, 0);
    const totalCapacity = initializedWallets.length * CHAINING_LIMIT;
    const allWalletsDegraded = initializedWallets.length > 0 &&
      wallets.every((w) => w.available === 0);

    return { allWalletsDegraded, totalReserved, totalCapacity, wallets };
  }

  private async buildSponsorStatusSnapshot(): Promise<StoredSponsorStatusSnapshot> {
    const initializedWallets = await this.getInitializedWallets();
    const walletSnapshots = initializedWallets.map(({ walletIndex }) => {
      const available = Math.max(0, Math.min(CHAINING_LIMIT, this.walletHeadroom(walletIndex)));
      const reserved = CHAINING_LIMIT - available;
      return { available, reserved };
    });
    const walletCount = walletSnapshots.length;
    const totalAvailable = walletSnapshots.reduce((sum, wallet) => sum + wallet.available, 0);
    const totalReserved = walletSnapshots.reduce((sum, wallet) => sum + wallet.reserved, 0);
    const totalCapacity = walletCount * CHAINING_LIMIT;
    const allWalletsDegraded = walletCount > 0 && totalAvailable === 0;
    const lastGapDetectedMs = this.getStateValue(STATE_KEYS.lastGapDetected);
    const lastHiroSyncMs = this.getStateValue(STATE_KEYS.lastHiroSync);
    const healInProgress =
      lastGapDetectedMs !== null &&
      Date.now() - lastGapDetectedMs < ALARM_INTERVAL_ACTIVE_MS * 2;
    const recentConflict =
      lastGapDetectedMs !== null &&
      Date.now() - lastGapDetectedMs <= SPONSOR_STATUS_RECENT_CONFLICT_WINDOW_MS;
    const poolAvailabilityRatio =
      totalCapacity === 0
        ? 0
        : Math.round((totalAvailable / totalCapacity) * 100) / 100;

    return {
      asOf: new Date().toISOString(),
      walletCount,
      allWalletsDegraded,
      recommendation:
        totalAvailable === 0 ||
        allWalletsDegraded ||
        recentConflict ||
        healInProgress
          ? "fallback_to_direct"
          : null,
      noncePool: {
        totalAvailable,
        totalReserved,
        totalCapacity,
        poolAvailabilityRatio,
        conflictsDetected: this.getStoredCount(STATE_KEYS.conflictsDetected),
        lastConflictAt: lastGapDetectedMs ? new Date(lastGapDetectedMs).toISOString() : null,
        healInProgress,
      },
      reconciliation: {
        lastSuccessfulAt: lastHiroSyncMs ? new Date(lastHiroSyncMs).toISOString() : null,
      },
    };
  }

  private async refreshSponsorStatusSnapshot(): Promise<StoredSponsorStatusSnapshot> {
    const snapshot = await this.buildSponsorStatusSnapshot();
    await this.state.storage.put(SPONSOR_STATUS_SNAPSHOT_STORAGE_KEY, snapshot);
    return snapshot;
  }

  async getSponsorStatus(): Promise<SponsorStatusResult> {
    let snapshot =
      await this.state.storage.get<StoredSponsorStatusSnapshot>(
        SPONSOR_STATUS_SNAPSHOT_STORAGE_KEY
      );

    if (!snapshot) {
      snapshot = await this.refreshSponsorStatusSnapshot();
    }

    return toSponsorStatusResult(snapshot);
  }

  async getStats(): Promise<NonceStatsResponse> {
    const totalAssigned = this.getStoredCount(STATE_KEYS.totalAssigned);
    const conflictsDetected = this.getStoredCount(STATE_KEYS.conflictsDetected);
    const lastAssignedNonce = this.getStateValue(STATE_KEYS.lastAssignedNonce);
    const lastAssignedAtMs = this.getStateValue(STATE_KEYS.lastAssignedAt);
    const nextNonce = this.getStateValue(STATE_KEYS.current);
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
      const ledgerCounts = this.ledgerCountsByWallet(walletIndex);
      const available = Math.max(0, CHAINING_LIMIT - ledgerCounts.assigned);
      const spentRows = this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM nonce_intents WHERE wallet_index = ? AND state IN ('confirmed','failed','expired')",
          walletIndex
        )
        .toArray();
      const spent = spentRows[0]?.count ?? 0;
      const maxNonceRows = this.sql
        .exec<{ maxNonce: number | null }>(
          "SELECT MAX(nonce) as maxNonce FROM nonce_intents WHERE wallet_index = ?",
          walletIndex
        )
        .toArray();
      const maxNonce = maxNonceRows[0]?.maxNonce ?? (this.ledgerGetWalletHead(walletIndex) ?? 0);
      wallets.push({
        walletIndex,
        available,
        reserved: ledgerCounts.assigned,
        spent,
        maxNonce,
        sponsorAddress: address,
      });
    }

    // Wallet 0 backward-compat fields
    const wallet0 = wallets[0];

    const stuckTxRbfBroadcast = this.getStoredCount(STATE_KEYS.stuckTxRbfBroadcast);
    const stuckTxRbfConfirmed = this.getStoredCount(STATE_KEYS.stuckTxRbfConfirmed);

    // Per-wallet utilization over the last hour (nonce_intents with assigned_at >= 1h ago)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const walletUtilization: WalletUtilization[] = [];
    for (const { walletIndex } of initializedWallets) {
      const rows = this.sql
        .exec<{ state: string; count: number }>(
          `SELECT state, COUNT(*) as count FROM nonce_intents
           WHERE wallet_index = ? AND assigned_at >= ?
           GROUP BY state`,
          walletIndex,
          oneHourAgo
        )
        .toArray();
      const counts = { assigned: 0, broadcasted: 0, confirmed: 0, failed: 0, conflict: 0 };
      for (const row of rows) {
        if (row.state in counts) {
          counts[row.state as keyof typeof counts] = row.count;
        }
      }
      walletUtilization.push({
        walletIndex,
        assigned_count: counts.assigned,
        broadcasted_count: counts.broadcasted,
        confirmed_count: counts.confirmed,
        failed_count: counts.failed + counts.conflict,
        window_hours: 1,
        chain_gap_headroom: this.headroomFromChainGap(walletIndex),
        chain_frontier: this.getChainFrontier(walletIndex),
      });
    }

    const dynamicWalletCount = this.getStateValue("dynamic_wallet_count");

    // Queue state aggregated across all wallets
    let totalQueueDepth = 0;
    let totalReplayBufferDepth = 0;
    for (const { walletIndex } of initializedWallets) {
      const qd = this.getDispatchQueueDepth(walletIndex);
      totalQueueDepth += qd.total;
      totalReplayBufferDepth += this.getReplayBufferDepth(walletIndex);
    }

    // Settlement time percentiles from confirmed dispatch_queue entries (last 24h)
    const settlementTimes = this.computeSettlementPercentiles();
    const walletSettlementTimes: Record<number, SettlementTimeStats> = {};
    for (const { walletIndex } of initializedWallets) {
      walletSettlementTimes[walletIndex] = this.computeSettlementPercentiles(walletIndex);
    }

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
      walletUtilization,
      dynamicWalletCount: dynamicWalletCount !== null && dynamicWalletCount > 0
        ? dynamicWalletCount
        : null,
      totalQueueDepth,
      totalReplayBufferDepth,
      settlementTimes,
      walletSettlementTimes,
    };
  }

  /**
   * Build the client-observable nonce state for MCP diagnostics (issue #229).
   * Returns per-wallet pending txs, detected gaps, and health metadata.
   */
  async getObservableNonceState(): Promise<ObservableNonceState> {
    const initializedWallets = await this.getInitializedWallets();
    const lastGapDetectedMs = this.getStateValue(STATE_KEYS.lastGapDetected);
    const gapsFilled = this.getStoredCount(STATE_KEYS.gapsFilled);

    const wallets: ObservableWalletState[] = await Promise.all(
      initializedWallets.map(async ({ walletIndex, address }) => {
        // Pending txs: assigned or broadcasted nonce_intents, joined with dispatch_queue
        // to surface sender_address (issue #251).
        const pendingRows = this.sql
          .exec<{
            nonce: number;
            state: string;
            txid: string | null;
            assigned_at: string;
            broadcasted_at: string | null;
            sender_address: string | null;
          }>(
            `SELECT ni.nonce, ni.state, ni.txid, ni.assigned_at, ni.broadcasted_at,
                    dq.sender_address
             FROM nonce_intents ni
             LEFT JOIN dispatch_queue dq
               ON dq.wallet_index = ni.wallet_index AND dq.sponsor_nonce = ni.nonce
             WHERE ni.wallet_index = ? AND ni.state IN ('assigned', 'broadcasted')
             ORDER BY ni.nonce ASC`,
            walletIndex
          )
          .toArray();

        const pendingTxs: ObservablePendingTx[] = pendingRows.map((row) => ({
          sponsorNonce: row.nonce,
          state: row.state as "assigned" | "broadcasted",
          txid: row.txid ?? undefined,
          assignedAt: row.assigned_at,
          broadcastedAt: row.broadcasted_at ?? undefined,
          senderAddress: row.sender_address ?? undefined,
        }));

        // Replaced txs: failed intents where error_reason starts with 'contention:'
        // These are sponsor txs that were dropped because a direct submission claimed
        // the same nonce slot (contention detection in reconcileNonceForWallet).
        const replacedRows = this.sql
          .exec<{
            nonce: number;
            state: string;
            txid: string | null;
            error_reason: string | null;
            assigned_at: string;
            broadcasted_at: string | null;
          }>(
            `SELECT nonce, state, txid, error_reason, assigned_at, broadcasted_at
             FROM nonce_intents
             WHERE wallet_index = ? AND state = 'failed' AND error_reason LIKE 'contention:%'
             ORDER BY nonce ASC`,
            walletIndex
          )
          .toArray();

        const replacedTxs: ObservablePendingTx[] = replacedRows.map((row) => ({
          sponsorNonce: row.nonce,
          state: "replaced" as const,
          // For contention, txid holds the original sponsored txid (the relay didn't
          // do the replacement — an external party did). Surface it as originalTxid.
          originalTxid: row.txid ?? undefined,
          replacedReason: row.error_reason ?? undefined,
          assignedAt: row.assigned_at,
          broadcastedAt: row.broadcasted_at ?? undefined,
        }));

        // Merge and sort by sponsorNonce ascending
        const allTxs = [...pendingTxs, ...replacedTxs].sort(
          (a, b) => a.sponsorNonce - b.sponsorNonce
        );

        // Chain frontier and head for gap detection
        const chainFrontier = this.getChainFrontier(walletIndex);
        const head = this.ledgerGetWalletHead(walletIndex);

        // Detect gaps: nonces between chain frontier and head with no ledger entry.
        // occupiedNonces covers ALL states (assigned, broadcasted, confirmed, failed)
        // so inFlightNonces (a subset) is redundant.
        const gaps: number[] = [];
        if (chainFrontier !== null && head !== null && head > chainFrontier) {
          const occupiedRows = this.sql
            .exec<{ nonce: number }>(
              `SELECT nonce FROM nonce_intents
               WHERE wallet_index = ? AND nonce >= ? AND nonce < ?`,
              walletIndex,
              chainFrontier,
              head
            )
            .toArray();
          const occupiedNonces = new Set(occupiedRows.map((r) => r.nonce));
          for (let n = chainFrontier; n < head; n++) {
            if (!occupiedNonces.has(n)) {
              gaps.push(n);
            }
          }
        }

        // Use walletHeadroom() — same calculation as the assignment path.
        const available = this.walletHeadroom(walletIndex);
        const reserved = CHAINING_LIMIT - available;

        // Queue state for observability
        const queueState = this.getDispatchQueueDepth(walletIndex);
        const replayDepth = this.getReplayBufferDepth(walletIndex);

        // Settlement time percentiles for this wallet (last 24h)
        const settlementTimes = this.computeSettlementPercentiles(walletIndex);

        return {
          walletIndex,
          sponsorAddress: address,
          chainFrontier: chainFrontier ?? undefined,
          assignmentHead: head ?? undefined,
          pendingTxs: allTxs,
          gaps,
          available,
          reserved,
          circuitBreakerOpen: false,
          healthy: gaps.length === 0 && available > 0,
          queueDepth: queueState.total,
          replayBufferDepth: replayDepth,
          settlementTimes,
        };
      })
    );

    const anyGaps = wallets.some((w) => w.gaps.length > 0);
    const totalAvailable = wallets.reduce((s, w) => s + w.available, 0);
    const totalReserved = wallets.reduce((s, w) => s + w.reserved, 0);
    const totalCapacity = initializedWallets.length * CHAINING_LIMIT;

    // healInProgress: gap was detected recently (within last alarm cycle + buffer)
    const healInProgress = lastGapDetectedMs !== null &&
      Date.now() - lastGapDetectedMs < ALARM_INTERVAL_ACTIVE_MS * 2;

    const healthy = !anyGaps && totalAvailable > 0;
    const recommendation: "fallback_to_direct" | null =
      !healthy && anyGaps ? "fallback_to_direct" : null;

    // Sender hands: active senders with held transactions waiting for nonce gap fill.
    // Capped at 50 senders to bound the response size.
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const handRows = this.sql
      .exec<{
        sender_address: string;
        next_expected_nonce: number;
        count: number;
        oldest_received_at: string;
      }>(
        `SELECT sh.sender_address,
                MIN(COALESCE(ss.next_expected_nonce, sh.sender_nonce)) AS next_expected_nonce,
                COUNT(*) AS count,
                MIN(sh.received_at) AS oldest_received_at
         FROM sender_hand sh
         LEFT JOIN sender_state ss ON ss.sender_address = sh.sender_address
         WHERE sh.expires_at > ?
         GROUP BY sh.sender_address
         ORDER BY sh.sender_address ASC
         LIMIT 50`,
        nowIso
      )
      .toArray();

    const senderHands: SenderHandSummary[] = handRows.map((row) => ({
      address: row.sender_address,
      nextExpected: row.next_expected_nonce,
      handSize: row.count,
      oldestEntryAge: nowMs - new Date(row.oldest_received_at).getTime(),
    }));

    // Global settlement percentiles (last 24h confirmed txs across all wallets)
    const settlementTimes = this.computeSettlementPercentiles();

    // Probe queue status (backward ghost eviction)
    const probeStats = this.sql
      .exec<{ state: string; cnt: number }>(
        "SELECT state, COUNT(*) as cnt FROM probe_queue GROUP BY state"
      )
      .toArray();
    const probeTotal = probeStats.reduce((s, r) => s + r.cnt, 0);
    let probeQueue: ProbeQueueStatus | null = null;
    if (probeTotal > 0) {
      const probePendingByWallet = this.sql
        .exec<{ wallet_index: number; cnt: number }>(
          "SELECT wallet_index, COUNT(*) as cnt FROM probe_queue WHERE state = 'pending' GROUP BY wallet_index"
        )
        .toArray();
      probeQueue = {
        pending: probeStats.find((r) => r.state === "pending")?.cnt ?? 0,
        replaced: probeStats.find((r) => r.state === "replaced")?.cnt ?? 0,
        conflict: probeStats.find((r) => r.state === "conflict")?.cnt ?? 0,
        rejected: probeStats.find((r) => r.state === "rejected")?.cnt ?? 0,
        wallets: probePendingByWallet.map((r) => ({
          walletIndex: r.wallet_index,
          pending: r.cnt,
        })),
      };
    }

    return {
      wallets,
      senderHands,
      healthy,
      healInProgress,
      gapsFilled,
      totalAvailable,
      totalReserved,
      totalCapacity,
      lastGapDetected: lastGapDetectedMs
        ? new Date(lastGapDetectedMs).toISOString()
        : null,
      recommendation,
      settlementTimes,
      probeQueue,
      timestamp: new Date().toISOString(),
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
   * Proactive flush and replay cycle for a specific wallet.
   *
   * Detects dispatch_queue entries with state='dispatched' that have been pending
   * longer than stuckAgeMs. For each stuck entry:
   *   1. Mark the queue entry as 'replaying'
   *   2. Broadcast a 1 uSTX self-transfer at the stuck sponsor nonce (flush the slot)
   *   3. Move the original sender tx to the replay_buffer for re-sponsoring
   *
   * Sender txs in the replay_buffer are logged as 'replay_buffer_pending' so operators
   * can observe their count. Actual re-sponsoring (calling SponsorService with a fresh
   * nonce) is outside the DO's scope — a future enhancement will wire that path.
   *
   * Batch flush threshold: when >= 5 slots are stuck simultaneously, logs a
   * 'wallet_flush_and_replay' event to signal that a batch recovery is occurring.
   *
   * Returns {flushed, replayBufferDepth} counts for inclusion in reconciliation_summary.
   * `replayBufferDepth` is the total replay buffer depth after flushing (not entries added this cycle).
   * Never throws — all errors are logged and the cycle continues.
   */
  private async runFlushAndReplayCycle(
    walletIndex: number,
    stuckAgeMs: number
  ): Promise<{ flushed: number; replayBufferDepth: number }> {
    let flushed = 0;
    let replayBufferDepth = 0;

    try {
      // Fetch dispatched entries older than stuckAgeMs (candidates for flushing).
      // Uses COALESCE to fall back to queued_at when dispatched_at is NULL.
      const stuckCutoff = new Date(Date.now() - stuckAgeMs).toISOString();
      const stuckEntries = this.sql
        .exec<{
          payment_id: string | null;
          sender_tx_hex: string;
          sender_address: string;
          sender_nonce: number;
          sponsor_nonce: number;
        }>(
          `SELECT payment_id, sender_tx_hex, sender_address, sender_nonce, sponsor_nonce
           FROM dispatch_queue
           WHERE wallet_index = ? AND state = 'dispatched'
             AND COALESCE(dispatched_at, queued_at) <= ?
           ORDER BY sponsor_nonce ASC`,
          walletIndex,
          stuckCutoff
        )
        .toArray();

      if (stuckEntries.length === 0) {
        const currentDepth = this.getReplayBufferDepth(walletIndex);
        return { flushed: 0, replayBufferDepth: currentDepth };
      }

      // Batch flush detection: log a high-visibility event when many slots are stuck
      const BATCH_FLUSH_THRESHOLD = 5;
      if (stuckEntries.length >= BATCH_FLUSH_THRESHOLD) {
        this.log("warn", "wallet_flush_and_replay", {
          walletIndex,
          stuckCount: stuckEntries.length,
          stuckNonces: stuckEntries.map((e) => e.sponsor_nonce),
          stuckAgeMs,
        });
      }

      // Derive private key for gap-fill broadcasts
      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      if (!privateKey) {
        this.log("warn", "dispatch_flush_no_key", {
          walletIndex,
          stuckCount: stuckEntries.length,
          reason: "Cannot derive private key for wallet",
        });
        return { flushed: 0, replayBufferDepth: 0 };
      }

      for (const entry of stuckEntries) {
        try {
          // Step 1: Flush the stuck sponsor nonce slot with a self-transfer.
          // Uses RBF_FEE to guarantee eviction of the stuck tx from the mempool.
          const flushTxid = await this.broadcastRbfForNonce(
            walletIndex,
            entry.sponsor_nonce,
            privateKey,
            null  // no original txid available from dispatch queue
          );

          this.log("info", "dispatch_flush_start", {
            walletIndex,
            sponsorNonce: entry.sponsor_nonce,
            senderAddress: entry.sender_address,
            senderNonce: entry.sender_nonce,
            flushTxid: flushTxid ?? null,
            reason: "dispatched_entry_stuck",
          });

          if (!flushTxid) {
            // Flush broadcast failed (e.g., ConflictingNonceInMempool or network error).
            // Keep the entry in 'dispatched' state — will be retried next alarm cycle.
            this.log("info", "dispatch_flush_skipped", {
              walletIndex,
              sponsorNonce: entry.sponsor_nonce,
              reason: "flush broadcast did not return txid",
            });
            continue;
          }

          // Step 2: Mark the queue entry as 'replaying' (only after successful flush)
          this.transitionQueueEntry(walletIndex, entry.sponsor_nonce, "replaying");

          // Step 3: Move the original sender tx to the replay buffer
          this.addToReplayBuffer(
            walletIndex,
            entry.sender_tx_hex,
            entry.sender_address,
            entry.sender_nonce,
            entry.sponsor_nonce,
            (entry as { payment_id?: string | null }).payment_id ?? null
          );

          flushed++;
        } catch (e) {
          this.log("warn", "dispatch_flush_entry_error", {
            walletIndex,
            sponsorNonce: entry.sponsor_nonce,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Track total replay buffer depth for the return value.
      // This is NOT the count of entries added this cycle (that equals `flushed`),
      // but the total depth including entries from prior cycles.
      replayBufferDepth = this.getReplayBufferDepth(walletIndex);
    } catch (e) {
      this.log("warn", "flush_replay_cycle_error", {
        walletIndex,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return { flushed, replayBufferDepth };
  }


  /**
   * Process replay buffer entries: re-sponsor sender txs with fresh nonces and broadcast.
   *
   * For each entry in the replay buffer (across all wallets):
   * 1. Find a wallet with headroom
   * 2. Assign a fresh sponsor nonce from that wallet
   * 3. Deserialize the original sender tx and re-sponsor it
   * 4. Broadcast the re-sponsored tx
   * 5. Record in dispatch queue and intent ledger
   * 6. Remove from replay buffer
   *
   * Processes up to `maxPerCycle` entries per alarm cycle to avoid blocking.
   * Never throws — all errors are logged and the cycle continues.
   */
  /**
   * Alarm-driven backward probe: process pending probe_queue entries in batches.
   * Broadcasts self-transfers at confirmed nonces using RBF_FEE to evict ghost
   * mempool entries from the Stacks node. Results stored in probe_queue for
   * operator inspection via GET /nonce/state.
   */
  private async processProbeQueue(): Promise<{ processed: number; replaced: number; conflict: number; rejected: number }> {
    const pending = this.sql
      .exec<{ wallet_index: number; nonce: number }>(
        `SELECT wallet_index, nonce FROM probe_queue
         WHERE state = 'pending'
         ORDER BY wallet_index ASC, nonce ASC
         LIMIT ?`,
        MAX_PROBES_PER_TICK
      )
      .toArray();

    if (pending.length === 0) {
      return { processed: 0, replaced: 0, conflict: 0, rejected: 0 };
    }

    let processed = 0;
    let replaced = 0;
    let conflict = 0;
    let rejected = 0;

    // Group by wallet to avoid re-deriving keys for each nonce
    const byWallet = new Map<number, number[]>();
    for (const { wallet_index, nonce } of pending) {
      const nonces = byWallet.get(wallet_index) ?? [];
      nonces.push(nonce);
      byWallet.set(wallet_index, nonces);
    }

    for (const [walletIndex, nonces] of byWallet) {
      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      if (!privateKey) {
        // Can't derive key — mark all as rejected
        const now = new Date().toISOString();
        for (const nonce of nonces) {
          this.sql.exec(
            `UPDATE probe_queue SET state = 'rejected', reason = 'key_derivation_failed', completed_at = ?
             WHERE wallet_index = ? AND nonce = ?`,
            now, walletIndex, nonce
          );
          rejected++;
          processed++;
        }
        continue;
      }

      const { network, recipient } = await this.getFlushRecipientAsync(walletIndex);

      for (const nonce of nonces) {
        const now = new Date().toISOString();
        try {
          const tx = await makeSTXTokenTransfer({
            recipient,
            amount: GAP_FILL_AMOUNT,
            senderKey: privateKey,
            network,
            nonce: BigInt(nonce),
            fee: RBF_FEE,
            memo: `probe-${nonce}`,
          });
          const result = await this.broadcastRawTx(tx, "backward_probe");

          if (result.ok) {
            this.sql.exec(
              `UPDATE probe_queue SET state = 'replaced', txid = ?, completed_at = ?
               WHERE wallet_index = ? AND nonce = ?`,
              result.txid, now, walletIndex, nonce
            );
            replaced++;
          } else if (result.reason === "ConflictingNonceInMempool") {
            this.sql.exec(
              `UPDATE probe_queue SET state = 'conflict', reason = ?, completed_at = ?
               WHERE wallet_index = ? AND nonce = ?`,
              result.reason, now, walletIndex, nonce
            );
            conflict++;
          } else {
            this.sql.exec(
              `UPDATE probe_queue SET state = 'rejected', reason = ?, completed_at = ?
               WHERE wallet_index = ? AND nonce = ?`,
              result.reason, now, walletIndex, nonce
            );
            rejected++;
          }
        } catch (e) {
          this.sql.exec(
            `UPDATE probe_queue SET state = 'rejected', reason = ?, completed_at = ?
             WHERE wallet_index = ? AND nonce = ?`,
            e instanceof Error ? e.message : String(e), now, walletIndex, nonce
          );
          rejected++;
        }
        processed++;
      }
    }

    if (processed > 0) {
      this.log("info", "probe_queue_tick", { processed, replaced, conflict, rejected });
    }

    return { processed, replaced, conflict, rejected };
  }

  private async processReplayBuffer(
    initializedWallets: Array<{ walletIndex: number; address: string }>,
    maxPerCycle: number = 5
  ): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;

    try {
      // Collect all replay buffer entries across all wallets, oldest first
      const entries: Array<{
        id: number;
        wallet_index: number;
        payment_id: string | null;
        sender_tx_hex: string;
        sender_address: string;
        sender_nonce: number;
        original_sponsor_nonce: number;
        queued_at: string;
      }> = [];

      for (const { walletIndex } of initializedWallets) {
        const walletEntries = this.getReplayBuffer(walletIndex);
        for (const e of walletEntries) {
          entries.push({ ...e, wallet_index: walletIndex });
        }
      }

      if (entries.length === 0) {
        return { processed: 0, failed: 0 };
      }

      // Sort by queued_at ASC (oldest first) and limit
      entries.sort((a, b) => a.queued_at.localeCompare(b.queued_at));
      const batch = entries.slice(0, maxPerCycle);

      this.log("info", "replay_buffer_processing", {
        totalEntries: entries.length,
        batchSize: batch.length,
      });

      const network = this.env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;

      for (const entry of batch) {
        try {
          // Find a wallet with headroom (prefer a different wallet than the original)
          let targetWallet: { walletIndex: number; headroom: number } | null = null;

          // First pass: try any wallet with headroom >= 3 (avoid the one that was stuck)
          for (const { walletIndex } of initializedWallets) {
            if (walletIndex === entry.wallet_index) continue;
            const headroom = this.walletHeadroom(walletIndex);
            if (headroom >= 3) {
              targetWallet = { walletIndex, headroom };
              break;
            }
          }

          // Second pass: try the original wallet or any with headroom >= 1
          if (!targetWallet) {
            for (const { walletIndex } of initializedWallets) {
              const headroom = this.walletHeadroom(walletIndex);
              if (headroom >= 1) {
                targetWallet = { walletIndex, headroom };
                break;
              }
            }
          }

          if (!targetWallet) {
            this.log("warn", "replay_skip_no_headroom", {
              replayId: entry.id,
              senderAddress: entry.sender_address,
              originalWallet: entry.wallet_index,
              originalNonce: entry.original_sponsor_nonce,
            });
            failed++;
            continue;
          }

          // Derive the sponsor key for the target wallet
          const privateKey = await this.derivePrivateKeyForWallet(targetWallet.walletIndex);
          if (!privateKey) {
            this.log("warn", "replay_skip_no_key", {
              replayId: entry.id,
              targetWallet: targetWallet.walletIndex,
            });
            failed++;
            continue;
          }

          // Assign a fresh nonce from the target wallet
          const freshNonce = this.ledgerGetWalletHead(targetWallet.walletIndex);
          if (freshNonce === null) {
            this.log("warn", "replay_skip_no_head", {
              replayId: entry.id,
              targetWallet: targetWallet.walletIndex,
            });
            failed++;
            continue;
          }

          // Reserve the nonce in the ledger
          this.ledgerAssign(targetWallet.walletIndex, freshNonce);

          // Deserialize and re-sponsor the sender tx
          const cleanHex = entry.sender_tx_hex.replace(/^0x/i, "");
          const senderTx = deserializeTransaction(cleanHex);
          const reSponsoredTx = await sponsorTransaction({
            transaction: senderTx,
            sponsorPrivateKey: privateKey,
            network,
            fee: GAP_FILL_FEE, // conservative fee for replayed tx
            sponsorNonce: BigInt(freshNonce),
          });

          // Broadcast the re-sponsored tx
          const result = await this.broadcastRawTx(reSponsoredTx, "replay_respon");
          if (result.ok) {
            // Record in dispatch queue (fee=GAP_FILL_FEE used for replayed txs).
            // Replay re-dispatches are tagged as is_gap_fill=1 so they are excluded from
            // settlement time percentiles — the original submitted_at is in the retired entry
            // and cannot be accurately carried forward here.
            this.queueDispatch(
              targetWallet.walletIndex,
              entry.sender_tx_hex,
              entry.sender_address,
              entry.sender_nonce,
              freshNonce,
              entry.payment_id ?? null,
              GAP_FILL_FEE.toString(),
              null,  // submitted_at: not available after replay
              true   // is_gap_fill: exclude from settlement percentiles
            );
            // Transition to dispatched
            this.transitionQueueEntry(targetWallet.walletIndex, freshNonce, "dispatched");
            // Record broadcast outcome in ledger
            this.ledgerBroadcastOutcome(
              targetWallet.walletIndex, freshNonce, result.txid, 200, undefined, undefined
            );
            await this.syncPaymentAfterBroadcast({
              paymentId: entry.payment_id ?? null,
              txid: result.txid,
              walletIndex: targetWallet.walletIndex,
              sponsorNonce: freshNonce,
              fee: GAP_FILL_FEE.toString(),
            });
            // Remove from replay buffer
            this.removeFromReplayBuffer(entry.id);

            this.log("info", "replay_respon_success", {
              replayId: entry.id,
              senderAddress: entry.sender_address,
              originalWallet: entry.wallet_index,
              originalNonce: entry.original_sponsor_nonce,
              targetWallet: targetWallet.walletIndex,
              freshNonce,
              txid: result.txid,
            });
            processed++;
          } else {
            // Broadcast failed — release the nonce, keep entry in replay buffer for next cycle
            this.ledgerRelease(targetWallet.walletIndex, freshNonce, undefined, result.reason);

            this.log("warn", "replay_respon_broadcast_failed", {
              replayId: entry.id,
              senderAddress: entry.sender_address,
              targetWallet: targetWallet.walletIndex,
              freshNonce,
              httpStatus: result.status,
              reason: result.reason,
            });
            failed++;
          }
        } catch (e) {
          this.log("warn", "replay_entry_error", {
            replayId: entry.id,
            senderAddress: entry.sender_address,
            error: e instanceof Error ? e.message : String(e),
          });
          failed++;
        }
      }
    } catch (e) {
      this.log("warn", "replay_buffer_cycle_error", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return { processed, failed };
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
    sponsorAddress: string,
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
    this.advanceChainFrontier(walletIndex, nonceInfo.possible_next_nonce);

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

    /** Classify a nonce's Hiro signal for debug logging. */
    const classifyHiroSignal = (n: number): string => {
      if (mempoolNonceSet.has(n)) return "mempool";
      if (missingNonceSet.has(n)) return "missing";
      if (last_executed_tx_nonce !== null && n <= last_executed_tx_nonce) return "confirmed";
      return "unknown";
    };

    // Query ledger for this wallet's known nonces
    const broadcastedIntents = this.ledgerGetBroadcastedNonces(walletIndex);
    const broadcastedByNonce = new Map(broadcastedIntents.map((r) => [r.nonce, r]));
    const assignedIntents = this.ledgerGetAssignedNonces(walletIndex);
    const assignedByNonce = new Map(assignedIntents.map((r) => [r.nonce, r]));

    // Verdict counters for reconciliation_summary
    let verdictConfirmed = 0;
    let verdictPendingAgree = 0;
    let verdictPendingWait = 0;
    let verdictPendingAssign = 0;
    let verdictPendingDiverge = 0;
    let verdictExpired = 0;
    let verdictIgnoreStaleHiro = 0;
    let verdictRbfCandidate = 0;
    const rbfCandidates: Array<{ nonce: number; txid: string }> = [];
    const gapFillNonces: number[] = [];

    // Routine verdicts that don't need per-nonce DEBUG logs — the
    // reconciliation_summary INFO log reports their distinct counts.
    const ROUTINE_BROADCASTED_VERDICTS = new Set(["confirmed", "pending_agree", "pending_wait"]);
    const ROUTINE_ASSIGNED_VERDICTS = new Set(["pending_assign"]);
    // conflict_resolved_* and conflict_stale_gap_fill have their own info-level
    // log via conflict_nonce_resolved — skip the redundant reconcile_verdict debug log.
    const ROUTINE_MISSING_VERDICTS = new Set([
      "ignore_stale_hiro",
      "conflict_resolved_consumed",
      "conflict_stale_gap_fill",
      "conflict_recent_skip",
    ]);


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
        verdictPendingWait++;
      }

      // Only log individually for actionable verdicts; routine verdicts
      // are reported with distinct counts in the reconciliation_summary.
      if (!ROUTINE_BROADCASTED_VERDICTS.has(verdict)) {
        this.log("debug", "reconcile_verdict", {
          walletIndex,
          nonce,
          txid,
          ledger_state: "broadcasted",
          hiro_signal: classifyHiroSignal(nonce),
          verdict,
          reason,
          ageMs,
        });
      }
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
        verdict = "expired";
        reason = "stale_assigned_never_broadcast";
        verdictExpired++;
        this.ledgerMarkExpiredByReconcile(walletIndex, nonce, reason);
      } else {
        verdict = "pending_assign";
        reason = "within_grace_period";
        verdictPendingAssign++;
      }

      // Only log individually for actionable verdicts (expired);
      // routine verdicts are reported with distinct counts in the summary.
      if (!ROUTINE_ASSIGNED_VERDICTS.has(verdict)) {
        this.log("debug", "reconcile_verdict", {
          walletIndex,
          nonce,
          ledger_state: "assigned",
          hiro_signal: classifyHiroSignal(nonce),
          verdict,
          reason,
          ageMs,
        });
      }
    }

    // -------------------------------------------------------------------------
    // Cross-reference: Hiro-detected missing nonces not in our ledger
    // -------------------------------------------------------------------------
    if (detected_missing_nonces.length > 0) {
      // NOTE: lastGapDetected is set AFTER the loop, only when true gap-fills are
      // needed (gapFillNonces.length > 0).  Setting it here unconditionally caused
      // the circuit breaker to latch open: the alarm runs every 60s, Hiro routinely
      // reports transient "missing" nonces that are already tracked in the ledger
      // (assigned/broadcasted/confirmed), and the 10-minute RECENT_CONFLICT_WINDOW
      // never expired because the timestamp was refreshed every cycle.

      for (const nonce of detected_missing_nonces) {
        // Already handled above in broadcastedByNonce or assignedByNonce loops
        if (broadcastedByNonce.has(nonce) || assignedByNonce.has(nonce)) continue;

        // Query ledger directly for this nonce's state and metadata
        const intentRows = this.sql
          .exec<{ state: string; txid: string | null; assigned_at: string }>(
            "SELECT state, txid, assigned_at FROM nonce_intents WHERE wallet_index = ? AND nonce = ? LIMIT 1",
            walletIndex,
            nonce
          )
          .toArray();
        const intentState = intentRows[0]?.state ?? null;
        const intentTxid = intentRows[0]?.txid ?? null;
        const intentAssignedAt = intentRows[0]?.assigned_at ?? null;
        const intentAgeMs = intentAssignedAt ? Date.now() - new Date(intentAssignedAt).getTime() : Infinity;
        // Use 5 minutes as the threshold for "old enough to abandon" conflict nonces
        const CONFLICT_ABANDON_AGE_MS = 5 * 60 * 1000;

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
        } else if (intentState === "conflict") {
          // Two txs were broadcast for this nonce slot (ConflictingNonceInMempool).
          // Hiro reports the nonce as missing, meaning neither tx is currently in the mempool.
          // Recovery strategy:
          //   1. If chain advanced past this nonce (last_executed_tx_nonce >= nonce):
          //      one of the txs confirmed — mark as confirmed and clean up.
          //   2. If the conflict is old enough (>5 min) and nonce not yet consumed:
          //      both txs are gone and neither confirmed — gap-fill to unblock the wallet.
          //   3. If the conflict is recent: skip conservatively, let it age out.
          if (last_executed_tx_nonce !== null && nonce <= last_executed_tx_nonce) {
            // Chain consumed this nonce — mark confirmed (txid may be null if we never got one)
            verdict = "conflict_resolved_consumed";
            reason = "chain_advanced_past_conflict_nonce";
            if (intentTxid) {
              this.ledgerMarkConfirmedByReconcile(walletIndex, nonce, intentTxid);
              const stuckKey = this.walletStuckTxKey(walletIndex, nonce);
              await this.state.storage.delete(stuckKey);
            }
            verdictConfirmed++;
            this.log("info", "conflict_nonce_resolved", {
              walletIndex,
              nonce,
              txid: intentTxid,
              last_executed_tx_nonce,
              reason: "chain_advanced_past_conflict_nonce",
            });
          } else if (intentAgeMs >= CONFLICT_ABANDON_AGE_MS) {
            // Conflict is stale and nonce not consumed — gap-fill to restore capacity
            verdict = "conflict_stale_gap_fill";
            reason = "conflict_nonce_old_hiro_missing_gap_fill";
            gapFillNonces.push(nonce);
            this.log("info", "conflict_nonce_resolved", {
              walletIndex,
              nonce,
              txid: intentTxid,
              ageMs: intentAgeMs,
              reason: "conflict_stale_gap_fill",
            });
          } else {
            // Conflict is recent — skip conservatively
            verdict = "conflict_recent_skip";
            reason = "conflict_nonce_recent_skip";
            verdictPendingAgree++;
          }
        } else {
          // Unexpected state — log and skip conservatively
          verdict = "unknown_state";
          reason = `unexpected_ledger_state_${intentState}`;
          verdictPendingAgree++;
        }

        // Only log individually for actionable verdicts;
        // routine verdicts are reported with distinct counts in the summary.
        if (!ROUTINE_MISSING_VERDICTS.has(verdict)) {
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
    }

    // -------------------------------------------------------------------------
    // Pre-mempool corridor: scan [last_executed_tx_nonce+1 .. possible_next_nonce)
    // for nonces that Hiro never reports as "missing" because no mempool tx sits
    // above them to create a detectable gap — the "first blocker" blind spot.
    // -------------------------------------------------------------------------
    if (last_executed_tx_nonce !== null && possible_next_nonce > last_executed_tx_nonce + 1) {
      const corridorStart = last_executed_tx_nonce + 1;
      // Clamp corridor scan to CHAINING_LIMIT nonces — if the range is huge
      // (e.g., a very high-nonce mempool tx), the downstream gap-fill cap will
      // truncate anyway, and this avoids O(N) iteration blocking the DO.
      const corridorEnd = Math.min(possible_next_nonce, corridorStart + CHAINING_LIMIT);
      const gapFillNonceSet = new Set(gapFillNonces);
      let corridorDetected = 0;
      for (let n = corridorStart; n < corridorEnd; n++) {
        if (broadcastedByNonce.has(n) || assignedByNonce.has(n) || gapFillNonceSet.has(n)) continue;
        gapFillNonces.push(n);
        gapFillNonceSet.add(n);
        corridorDetected++;
      }
      if (corridorDetected > 0) {
        this.log("info", "corridor_gap_detected", {
          walletIndex,
          corridorStart,
          corridorEnd: possible_next_nonce - 1,
          detected: corridorDetected,
          last_executed_tx_nonce,
          possible_next_nonce,
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
          // Check if this nonce is already consumed on-chain via last_executed_tx_nonce.
          // This catches cases where the txid lookup returns null/dropped but the nonce
          // has actually been executed (e.g. by a replacement tx that Hiro hasn't indexed).
          if (last_executed_tx_nonce !== null && nonce <= last_executed_tx_nonce) {
            this.log("info", "reconcile_nonce_already_executed", {
              walletIndex,
              nonce,
              txid,
              last_executed_tx_nonce,
              reason: "nonce_below_last_executed_skip_rbf",
            });
            this.ledgerMarkConfirmedByReconcile(walletIndex, nonce, txid);
            // Clean up any stuck-tx state for this nonce
            const stuckKey = this.walletStuckTxKey(walletIndex, nonce);
            await this.state.storage.delete(stuckKey);
            verdictConfirmed++;
            verdictRbfCandidate--;
            continue;
          }
          // Check if tx is abort_* (terminal) before RBF — skip RBF if so
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
            // Clean up stuck-tx state for aborted nonce
            const abortStuckKey = this.walletStuckTxKey(walletIndex, nonce);
            await this.state.storage.delete(abortStuckKey);
            verdictRbfCandidate--;
            continue;
          }
          if (txStatus === "success") {
            // Tx actually confirmed (Hiro eventually returned it) — mark confirmed
            this.ledgerMarkConfirmedByReconcile(walletIndex, nonce, txid);
            // Clean up stuck-tx state for confirmed nonce
            const confirmStuckKey = this.walletStuckTxKey(walletIndex, nonce);
            await this.state.storage.delete(confirmStuckKey);
            verdictConfirmed++;
            verdictRbfCandidate--;
            continue;
          }
          // P2 contention awareness (issue #229): if the tx was replaced by a
          // direct submission (dropped_replace_by_fee or dropped_replace_across_fork),
          // someone else (likely the sender via self-pay) settled this nonce slot.
          // Gap-fill immediately instead of wasting an RBF attempt.
          if (txStatus !== null && (
            txStatus === "dropped_replace_by_fee" ||
            txStatus === "dropped_replace_across_fork"
          )) {
            this.log("info", "contention_detected", {
              walletIndex,
              nonce,
              txid,
              txStatus,
              reason: "sponsor_tx_replaced_by_direct_submission",
            });
            // Mark as failed with contention reason and queue for gap-fill
            try {
              const now = new Date().toISOString();
              this.sql.exec(
                `UPDATE nonce_intents SET state = 'failed', error_reason = ?
                 WHERE wallet_index = ? AND nonce = ?`,
                `contention:${txStatus}`,
                walletIndex,
                nonce
              );
              this.sql.exec(
                `INSERT INTO nonce_events (wallet_index, nonce, event, detail, created_at)
                 VALUES (?, ?, 'contention_detected', ?, ?)`,
                walletIndex,
                nonce,
                JSON.stringify({ txid, txStatus, reason: "replaced_by_direct" }),
                now
              );
            } catch { /* fail-open */ }
            // Clean up stuck-tx state
            const contentionStuckKey = this.walletStuckTxKey(walletIndex, nonce);
            await this.state.storage.delete(contentionStuckKey);
            // Gap-fill this nonce in the current cycle if budget allows.
            // Note: contention nonces share the gap-fill budget with structural gaps.
            // The gap-fill broadcast will return ConflictingNonceInMempool if the
            // replacement tx still occupies the slot — harmless, handled gracefully.
            gapFillNonces.push(nonce);
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

    // Only stamp lastGapDetected when there are genuine gaps that require
    // gap-fill broadcasts — not for every Hiro-reported missing nonce (many are
    // already tracked as assigned/broadcasted/confirmed in the ledger).
    // Without this gate the 10-minute window in health.ts (RECENT_CONFLICT_WINDOW_MS)
    // never expires because the alarm refreshes the timestamp every 60s cycle.
    if (gapFillNonces.length > 0) {
      this.setStateValue(STATE_KEYS.lastGapDetected, Date.now());
    }

    // -------------------------------------------------------------------------
    // Execute gap-fills for nonces not in our ledger or in failed state.
    // Throttle against mempool depth: each gap-fill adds a pending tx, so stop
    // before hitting the relay's CHAINING_LIMIT (20), which is set below the node's
    // TooMuchChaining limit of 25 pending transactions.
    // -------------------------------------------------------------------------
    const gapFillFilled: number[] = [];
    if (gapFillNonces.length > 0) {
      // Use walletHeadroom (chain-gap preferred, SQL fallback) — same as assignment path.
      const headroom = this.walletHeadroom(walletIndex);
      const gapFillBudget = Math.max(0, headroom);
      if (gapFillBudget === 0) {
        this.log("info", "gap_fill_throttled", {
          walletIndex,
          headroom,
          chainingLimit: CHAINING_LIMIT,
          gapCount: gapFillNonces.length,
        });
      }
      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      const gapsToFill = gapFillNonces
        .slice()
        .sort((a, b) => a - b)
        .slice(0, Math.min(MAX_GAP_FILLS_PER_ALARM, gapFillBudget));
      if (privateKey) {
        for (const gapNonce of gapsToFill) {
          // Fee escalation: conflict retries use GAP_FILL_FEE + prior attempts (+1 uSTX each)
          const escalatedFee = this.computeEscalatedFee(walletIndex, gapNonce);
          const feeOverride = escalatedFee > GAP_FILL_FEE ? escalatedFee : undefined;
          const txid = await this.fillGapNonce(walletIndex, gapNonce, privateKey, feeOverride);
          if (txid) {
            const actualFee = escalatedFee;
            this.log("info", "gap_filled", {
              walletIndex,
              nonce: gapNonce,
              txid,
              fee: actualFee.toString(),
            });
            this.incrementCounter(STATE_KEYS.gapsFilled);
            gapFillFilled.push(gapNonce);
            this.ledgerInsertGapFill(walletIndex, gapNonce, txid);
            await this.recordGapFillFee(walletIndex, actualFee.toString());
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Head bump: after gap-fills, RBF the first real pending (non-gap-fill)
    // broadcasted tx with a higher fee to signal miners to re-evaluate the
    // pending nonce sequence. We target the real sponsored tx (not a gap-fill)
    // so agents can detect the replacement via the replaced_tx KV entry and
    // resubmit their original transaction. (Issue #229 P0)
    // -------------------------------------------------------------------------
    let headBumpNonce: number | null = null;
    let headBumpTxid: string | null = null;
    if (gapFillFilled.length > 0) {
      // Find the lowest broadcasted nonce that is NOT a gap-fill
      const gapFillSet = new Set(gapFillFilled);
      const bumpCandidate = this.sql
        .exec<{ nonce: number; txid: string | null }>(
          `SELECT nonce, txid FROM nonce_intents
           WHERE wallet_index = ? AND state = 'broadcasted' AND txid IS NOT NULL
           ORDER BY nonce ASC`,
          walletIndex
        )
        .toArray()
        .find((row) => !gapFillSet.has(row.nonce));

      if (bumpCandidate) {
        const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
        if (privateKey) {
          const { network, recipient } = await this.getFlushRecipientAsync(walletIndex);
          // Use original_fee + 1 when known, otherwise MIN_FLUSH_FEE
          const bumpDispatchRow = this.sql
            .exec<{ original_fee: string | null }>(
              "SELECT original_fee FROM dispatch_queue WHERE wallet_index = ? AND sponsor_nonce = ? LIMIT 1",
              walletIndex,
              bumpCandidate.nonce
            )
            .toArray()[0];
          const bumpFee = computeRbfFee(bumpDispatchRow?.original_fee ?? null);
          try {
            const tx = await makeSTXTokenTransfer({
              recipient,
              amount: GAP_FILL_AMOUNT,
              senderKey: privateKey,
              network,
              nonce: BigInt(bumpCandidate.nonce),
              fee: bumpFee,
              memo: `head-bump-${bumpCandidate.nonce}`,
            });
            const result = await this.broadcastRawTx(tx, "head_bump");
            if (result.ok) {
              headBumpNonce = bumpCandidate.nonce;
              headBumpTxid = result.txid;
              // Update the ledger: new txid + mark as head-bump so reconciliation
              // knows this is now a self-transfer (prevents phantom contention detection)
              try {
                this.sql.exec(
                  `UPDATE nonce_intents SET txid = ?, error_reason = 'head_bump_replaced'
                   WHERE wallet_index = ? AND nonce = ?`,
                  result.txid,
                  walletIndex,
                  bumpCandidate.nonce
                );
              } catch { /* fail-open */ }
              // Notify agents that their sponsored tx was replaced
              if (bumpCandidate.txid) {
                await this.writeReplacedTxEntry(bumpCandidate.txid, result.txid, "head_bump", walletIndex, bumpCandidate.nonce);
              }
              this.log("info", "head_bump_after_gap_fill", {
                walletIndex,
                nonce: bumpCandidate.nonce,
                originalTxid: bumpCandidate.txid,
                bumpTxid: result.txid,
                gapsFilled: gapFillFilled,
              });
            }
          } catch (e) {
            this.log("warn", "head_bump_error", {
              walletIndex,
              nonce: bumpCandidate.nonce,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Proactive flush and replay: detect stuck dispatched entries in the
    // dispatch_queue, flush their sponsor nonce slots with self-transfers,
    // and move sender txs to the replay buffer for re-sponsoring.
    // -------------------------------------------------------------------------
    const flushResult = await this.runFlushAndReplayCycle(walletIndex, STUCK_TX_AGE_MS);

    // Log reconciliation_summary for this wallet
    // -------------------------------------------------------------------------
    this.log("info", "reconciliation_summary", {
      walletIndex,
      total_nonces: broadcastedByNonce.size + assignedByNonce.size + gapFillNonces.length,
      confirmed: verdictConfirmed,
      pending_agree: verdictPendingAgree,
      pending_wait: verdictPendingWait,
      pending_assign: verdictPendingAssign,
      pending_diverge: verdictPendingDiverge,
      expired: verdictExpired,
      gap_filled: gapFillFilled.length,
      rbf_candidates: verdictRbfCandidate,
      rbf_broadcast: rbfAttempted.length,
      ignore_stale_hiro: verdictIgnoreStaleHiro,
      hiro_missing_count: detected_missing_nonces.length,
      hiro_mempool_count: detected_mempool_nonces.length,
      head_bump_nonce: headBumpNonce,
      possible_next_nonce,
      last_executed_tx_nonce,
      flush_flushed: flushResult.flushed,
      flush_replay_buffer_depth: flushResult.replayBufferDepth,
    });

    // -------------------------------------------------------------------------
    // Head maintenance: forward bump and stale reset based on Hiro signals.
    // RBF deferral: if we just broadcast RBF replacements, skip the stale reset
    // for one cycle to let the replacement confirm.
    // -------------------------------------------------------------------------

    if (previousNonce !== null && possible_next_nonce > previousNonce) {
      // Chain has advanced past our stored head — forward bump the head.
      this.ledgerAdvanceWalletHead(walletIndex, possible_next_nonce);
      this.incrementCounter(STATE_KEYS.conflictsDetected);

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

      // Guard: don't reset past nonces that were actually broadcast and may still
      // be pending in the mempool. Hiro's possible_next_nonce can lag behind the
      // mempool, so resetting to it would re-assign nonces that are still in-flight,
      // causing ConflictingNonceInMempool on the next broadcast.
      const highestInFlight = this.sql
        .exec<{ max_nonce: number | null }>(
          `SELECT MAX(nonce) as max_nonce FROM nonce_intents
           WHERE wallet_index = ? AND nonce >= ? AND nonce < ?
             AND state IN ('broadcasted', 'assigned')`,
          walletIndex,
          possible_next_nonce,
          previousNonce
        )
        .toArray()[0]?.max_nonce ?? null;

      // If there are in-flight nonces above Hiro's value, reset to just past
      // the highest one instead of blindly trusting Hiro.
      const guarded = highestInFlight !== null;
      const safeResetTarget = guarded
        ? Math.max(possible_next_nonce, highestInFlight + 1)
        : possible_next_nonce;

      this.ledgerAdvanceWalletHead(walletIndex, safeResetTarget);
      this.incrementCounter(STATE_KEYS.conflictsDetected);

      const idleSeconds = Math.round(idleMs / 1000);
      this.log("warn", "nonce_reconcile_stale", {
        walletIndex,
        previousNonce,
        newNonce: safeResetTarget,
        idleSeconds,
        hiroNextNonce: possible_next_nonce,
        ledgerReserved: this.ledgerReservedCount(walletIndex),
        ...(guarded && { highestInFlight }),
      });

      return {
        previousNonce,
        newNonce: safeResetTarget,
        changed: true,
        reason: `STALE DETECTION: idle ${idleSeconds}s, reset to ${guarded ? "guarded" : "chain"} nonce ${safeResetTarget}`,
      };
    }

    const gapFilledSummary = gapFillFilled.length > 0
      ? ` gap_filled [${gapFillFilled.join(",")}]`
      : "";
    const rbfSummary = rbfAttempted.length > 0
      ? ` rbf [${rbfAttempted.join(",")}]`
      : "";
    const headBumpSummary = headBumpNonce !== null
      ? ` head_bump [${headBumpNonce}]`
      : "";
    return {
      previousNonce,
      newNonce: previousNonce,
      changed: gapFillFilled.length > 0 || rbfAttempted.length > 0 || headBumpNonce !== null,
      reason: `nonce is consistent with chain state${gapFilledSummary}${rbfSummary}${headBumpSummary}`,
    };
  }

  /**
   * Gap-aware nonce reconciliation for all initialized wallets, returning a structured response.
   */
  private async performResync(): Promise<{
    success: true;
    action: "resync";
    wallets: Array<ReconcileResult & { walletIndex: number }>;
  }> {
    const initializedWallets = await this.getInitializedWallets();
    const wallets: Array<ReconcileResult & { walletIndex: number }> = [];
    for (const { walletIndex, address } of initializedWallets) {
      const result = await this.reconcileNonceForWallet(walletIndex, address);
      if (result === null) {
        throw new Error("Hiro API unavailable");
      }
      wallets.push({ walletIndex, ...result });
    }

    // When all wallets are consistent with chain state, reset cumulative conflict counters.
    // This prevents stale conflict state from permanently poisoning health checks.
    const allClean = wallets.every(w => !w.changed);
    if (allClean && this.getStoredCount(STATE_KEYS.conflictsDetected) > 0) {
      this.clearConflictCounters("all_wallets_consistent_with_chain");
    }

    return { success: true, action: "resync", wallets };
  }

  /**
   * Perform a hard nonce reset for all initialized wallets to safe floor: last_executed_tx_nonce + 1.
   */
  private async performReset(): Promise<{
    success: true;
    action: "reset";
    wallets: Array<{ walletIndex: number; previousNonce: number | null; newNonce: number; changed: boolean }>;
  }> {
    const initializedWallets = await this.getInitializedWallets();
    const wallets: Array<{ walletIndex: number; previousNonce: number | null; newNonce: number; changed: boolean }> = [];
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
        this.incrementCounter(STATE_KEYS.conflictsDetected);
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

  /**
   * Scan for replaced_tx:* KV entries written by RBF/head-bump handlers and
   * transition matching payment records to "replaced" status.
   *
   * Called from alarm() after reconciliation so agents can detect replacements
   * via GET /payment/:id without polling the NonceDO directly.
   *
   * Fail-open: errors are logged but never rethrown so the alarm cycle continues.
   */
  private async processReplacementNotifications(): Promise<void> {
    if (!this.env.RELAY_KV) {
      this.log("warn", "replacement_notifications_skipped", {
        reason: "RELAY_KV binding not available",
      });
      return;
    }
    try {
      // Paginate through all replaced_tx:* entries (KV list returns max 1000 per call)
      const allKeys: KVNamespaceListKey<unknown>[] = [];
      let cursor: string | undefined;
      do {
        const listResult = await this.env.RELAY_KV.list({
          prefix: "replaced_tx:",
          ...(cursor && { cursor }),
        });
        allKeys.push(...listResult.keys);
        cursor = listResult.list_complete ? undefined : listResult.cursor;
      } while (cursor);

      const total = allKeys.length;
      let matchedCount = 0;

      for (const kvKey of allKeys) {
        const keyName = kvKey.name; // e.g. "replaced_tx:0xabc123..."
        const originalTxid = keyName.slice("replaced_tx:".length);

        // Read the replacement metadata
        const raw = await this.env.RELAY_KV.get(keyName, "text");
        let metadata: {
          replacementTxid: string;
          reason: string;
          walletIndex: number;
          nonce: number;
          replacedAt: string;
        } | null = null;
        if (raw) {
          try {
            metadata = JSON.parse(raw);
          } catch {
            // Unparseable metadata — still delete the entry
          }
        }

        if (metadata) {
          // Look up paymentId from the txid→paymentId mapping
          const paymentId = await this.env.RELAY_KV.get(
            `txid_map:${originalTxid}`,
            "text"
          );

          if (paymentId) {
            const record = await getPaymentRecord(this.env.RELAY_KV, paymentId);
            // Skip terminal states — don't regress confirmed/failed records
            if (record && !TERMINAL_PAYMENT_STATUSES.has(record.status)) {
              const updated = transitionPayment(record, "replaced", {
                terminalReason: inferReplacementTerminalReason(metadata.reason),
              });
              updated.replacementTxid = metadata.replacementTxid;
              updated.replacedReason = metadata.reason;
              updated.resubmittable = true;
              await putPaymentRecord(this.env.RELAY_KV, updated);
              matchedCount++;
            }
          }
        }

        // Delete the replaced_tx entry regardless — it has served its purpose
        await this.env.RELAY_KV.delete(keyName).catch(() => {
          /* fail-open */
        });
      }

      if (total > 0) {
        this.log("info", "replacement_notifications_processed", {
          total,
          matched: matchedCount,
          unmatched: total - matchedCount,
        });
      }
    } catch (e) {
      this.log("warn", "replacement_notifications_error", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Scan nonce_events for reconcile_confirmed and reconcile_aborted events since
   * the last cursor position, then proactively transition matching payment records
   * in RELAY_KV to confirmed or failed status.
   *
   * Called from alarm() after processReplacementNotifications() so all reconciliation
   * results are visible before we push updates to RELAY_KV.
   *
   * Cursor: stored in nonce_state as ALARM_CONFIRMATION_CURSOR_KEY (last processed
   * nonce_events.id). Advances after each tick.
   *
   * Fail-open: errors are logged but never rethrown so the alarm cycle continues.
   */
  private async processConfirmationNotifications(): Promise<void> {
    if (!this.env.RELAY_KV) {
      this.log("warn", "confirmation_notifications_skipped", {
        reason: "RELAY_KV binding not available",
      });
      return;
    }
    try {
      const cursor = this.getStateValue(ALARM_CONFIRMATION_CURSOR_KEY) ?? 0;

      // Fetch events joined with nonce_intents to get txid + block_height in one query
      // (eliminates N per-event intent lookups)
      type JoinedEventRow = {
        id: number;
        event: string;
        detail: string | null;
        txid: string | null;
        block_height: number | null;
      };
      const events = this.sql
        .exec<JoinedEventRow>(
          `SELECT ne.id, ne.event, ne.detail, ni.txid, ni.block_height
           FROM nonce_events ne
           LEFT JOIN nonce_intents ni
             ON ni.wallet_index = ne.wallet_index AND ni.nonce = ne.nonce
           WHERE ne.id > ?
             AND ne.event IN ('reconcile_confirmed', 'reconcile_aborted')
           ORDER BY ne.id ASC
           LIMIT ?`,
          cursor,
          MAX_CONFIRMATION_EVENTS_PER_TICK
        )
        .toArray();

      if (events.length === 0) return;

      let confirmedCount = 0;
      let abortedCount = 0;
      let skippedNoPayment = 0;
      let skippedMissingRecord = 0;
      let skippedTerminal = 0;

      for (const ev of events) {
        if (!ev.txid) {
          // No txid — gap-fill or intent not found; skip silently
          skippedNoPayment++;
          continue;
        }

        // Resolve txid → paymentId via KV map
        const paymentId = await this.env.RELAY_KV.get(`txid_map:${ev.txid}`, "text");
        if (!paymentId) {
          // Gap-fill transactions or untracked txids have no mapping
          skippedNoPayment++;
          continue;
        }

        const record = await getPaymentRecord(this.env.RELAY_KV, paymentId);
        if (!record) {
          skippedMissingRecord++;
          continue;
        }
        if (TERMINAL_PAYMENT_STATUSES.has(record.status)) {
          skippedTerminal++;
          continue;
        }

        if (ev.event === "reconcile_confirmed") {
          const updated = transitionPayment(record, "confirmed", {
            ...(ev.block_height != null && { blockHeight: ev.block_height }),
          });
          await putPaymentRecord(this.env.RELAY_KV, updated);
          confirmedCount++;
        } else if (ev.event === "reconcile_aborted") {
          // Extract txStatus from event detail JSON for context
          let txStatus: string | undefined;
          if (ev.detail) {
            try {
              const parsed = JSON.parse(ev.detail) as { txid?: string; txStatus?: string };
              txStatus = parsed.txStatus;
            } catch { /* detail is optional */ }
          }
          const error = txStatus
            ? `Transaction aborted on-chain: ${txStatus}`
            : "Transaction aborted on-chain";
          const updated = transitionPayment(record, "failed", {
            terminalReason: "chain_abort",
            error,
            errorCode: "SETTLEMENT_FAILED",
            retryable: false,
          });
          await putPaymentRecord(this.env.RELAY_KV, updated);
          abortedCount++;
        }
      }

      // Advance cursor past all events we processed (events ordered by id ASC)
      const maxId = events[events.length - 1].id;
      this.setStateValue(ALARM_CONFIRMATION_CURSOR_KEY, maxId);

      // Always log when we scanned events (early return above handles zero-event case)
      this.log("info", "confirmation_notifications_processed", {
        cursor,
        newCursor: maxId,
        eventsScanned: events.length,
        confirmed: confirmedCount,
        aborted: abortedCount,
        skippedNoPayment,
        skippedMissingRecord,
        skippedTerminal,
      });
    } catch (e) {
      this.log("warn", "confirmation_notifications_error", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * One-shot cleanup: delete orphaned KV keys from removed degradation state machines
   * (circuit breaker, ghost degraded, cascade detection). These keys are no longer
   * read but accumulate in DO storage. Runs once; sets a flag to skip on subsequent cycles.
   */
  private async cleanupLegacyDegradationKeys(): Promise<void> {
    const flagKey = "legacy_degradation_keys_cleaned";
    if (await this.state.storage.get<boolean>(flagKey)) return;

    const keysToDelete: string[] = ["cascade_quarantine_window"];
    for (let i = 0; i < MAX_WALLET_COUNT; i++) {
      keysToDelete.push(
        `wallet_quarantine_recent:${i}`,
      );
    }
    // nonce_state SQL keys for ghost counters
    for (let i = 0; i < MAX_WALLET_COUNT; i++) {
      this.setStateValue(`wallet_ghost_failures:${i}`, 0);
      this.setStateValue(`wallet_ghost_degraded:${i}`, 0);
    }
    await this.state.storage.delete(keysToDelete);
    await this.state.storage.put(flagKey, true);
    this.log("info", "legacy_degradation_keys_cleaned", {
      deletedKvKeys: keysToDelete.length,
      clearedNonceStateKeys: MAX_WALLET_COUNT * 2,
    });
  }

  /**
   * One-time migration: backfill wallet_hand and sender_state from existing tables.
   *
   * Detection: wallet_hand has zero rows AND dispatch_queue has active rows.
   * Runs at start of each alarm cycle; is a no-op after the first successful run.
   */
  private runGinRummyMigration(): void {
    const walletHandCount = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM wallet_hand")
      .toArray()[0]?.cnt ?? 0;

    const totalDqCount = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM dispatch_queue")
      .toArray()[0]?.cnt ?? 0;

    const activeDqCount = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE state NOT IN ('confirmed', 'retired')"
      )
      .toArray()[0]?.cnt ?? 0;

    // Migration only needed when wallet_hand is empty and dispatch_queue has active rows
    if (walletHandCount > 0 || activeDqCount === 0) {
      // Log skip reason on first few alarms for observability
      if (walletHandCount === 0 && totalDqCount > 0) {
        this.log("info", "gin_rummy_migration_skipped", {
          reason: "dispatch_queue has only terminal rows — no active work to migrate",
          walletHandCount,
          totalDqCount,
          activeDqCount,
        });
      }
      return;
    }

    this.log("info", "gin_rummy_migration_starting", {
      walletHandCount,
      totalDqCount,
      activeDqCount,
    });

    const now = new Date().toISOString();

    // 1. Backfill wallet_hand from ALL dispatch_queue rows
    //    Active rows → 'dispatched', confirmed → 'confirmed', retired → 'retired'
    //    INSERT OR IGNORE: safe to re-run if interrupted
    this.sql.exec(
      `INSERT OR IGNORE INTO wallet_hand
         (wallet_index, sponsor_nonce, state, sender_address, sender_nonce,
          original_fee, dispatched_at, confirmed_at)
       SELECT
         wallet_index,
         sponsor_nonce,
         CASE
           WHEN state = 'confirmed' THEN 'confirmed'
           WHEN state = 'retired' THEN 'retired'
           ELSE 'dispatched'
         END,
         sender_address,
         sender_nonce,
         original_fee,
         dispatched_at,
         confirmed_at
       FROM dispatch_queue`
    );

    const walletHandInserted = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM wallet_hand")
      .toArray()[0]?.cnt ?? 0;

    // Per-state breakdown for diagnostics
    const walletHandStates = this.sql
      .exec<{ state: string; cnt: number }>(
        "SELECT state, COUNT(*) as cnt FROM wallet_hand GROUP BY state"
      )
      .toArray();

    this.log("info", "gin_rummy_migration_wallet_hand_done", {
      totalInserted: walletHandInserted,
      byState: Object.fromEntries(walletHandStates.map((r) => [r.state, r.cnt])),
    });

    // 2. Seed sender_state from highest confirmed sender_nonce in dispatch_queue
    //    INSERT OR IGNORE: won't overwrite if already seeded from Hiro
    this.sql.exec(
      `INSERT OR IGNORE INTO sender_state
         (sender_address, next_expected_nonce, seeded_from, seeded_at)
       SELECT
         sender_address,
         MAX(sender_nonce) + 1,
         'relay_cache',
         ?
       FROM dispatch_queue
       WHERE state = 'confirmed'
       GROUP BY sender_address`,
      now
    );

    const senderStateInserted = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sender_state")
      .toArray()[0]?.cnt ?? 0;

    // List seeded senders for verification
    const seededSenders = this.sql
      .exec<{ sender_address: string; next_expected_nonce: number }>(
        "SELECT sender_address, next_expected_nonce FROM sender_state ORDER BY sender_address"
      )
      .toArray();

    this.log("info", "gin_rummy_migration_completed", {
      wallet_hand_rows: walletHandInserted,
      wallet_hand_states: Object.fromEntries(walletHandStates.map((r) => [r.state, r.cnt])),
      sender_state_rows: senderStateInserted,
      seeded_senders: seededSenders.map((s) => ({
        address: s.sender_address,
        nextNonce: s.next_expected_nonce,
      })),
    });
  }

  /**
   * Re-seed sender_state rows that were seeded from 'first_tx' (Hiro was unreachable at first contact).
   * Runs in the alarm cycle; up to 5 re-seeds per cycle to avoid alarm timeout.
   */
  private async retrySeedFirstTxSenders(): Promise<void> {
    const staleSenders = this.sql
      .exec<{ sender_address: string; next_expected_nonce: number }>(
        `SELECT sender_address, next_expected_nonce
         FROM sender_state
         WHERE seeded_from = 'first_tx'
         LIMIT 5`
      )
      .toArray();

    for (const row of staleSenders) {
      try {
        const info = await this.fetchNonceInfo(row.sender_address);
        const now = new Date().toISOString();
        this.sql.exec(
          `UPDATE sender_state
           SET next_expected_nonce = MAX(next_expected_nonce, ?),
               seeded_from = 'hiro',
               seeded_at = ?
           WHERE sender_address = ?`,
          info.possible_next_nonce,
          now,
          row.sender_address
        );
        this.log("debug", "gin_rummy_reseed_success", {
          senderAddress: row.sender_address,
          oldNonce: row.next_expected_nonce,
          hiroNonce: info.possible_next_nonce,
        });
      } catch {
        // Hiro still unreachable — will retry on next alarm cycle
      }
    }
  }

  /**
   * Recycle up to 5 replay_buffer entries back into sender_hand for re-dispatch.
   * Uses INSERT OR IGNORE so a fresher agent resubmission for the same sender nonce
   * takes precedence — the replay version is silently dropped but still consumed.
   * Runs once per alarm cycle, after gin rummy migration and before wallet reconciliation.
   */
  private recycleReplayBuffer(): void {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + HAND_HOLD_TIMEOUT_MS).toISOString();

    const entries = this.sql
      .exec<{
        id: number;
        payment_id: string | null;
        sender_address: string;
        sender_nonce: number;
        sender_tx_hex: string;
        queued_at: string;
      }>(
        `SELECT id, payment_id, sender_address, sender_nonce, sender_tx_hex, queued_at
         FROM replay_buffer
         ORDER BY queued_at ASC
         LIMIT 5`
      )
      .toArray();

    let recycled = 0;
    for (const entry of entries) {
      // INSERT OR IGNORE — never overwrite a fresher agent submission for the same nonce
      this.sql.exec(
        `INSERT OR IGNORE INTO sender_hand
           (sender_address, sender_nonce, tx_hex, payment_id, source, received_at, expires_at)
         VALUES (?, ?, ?, ?, 'replay', ?, ?)`,
        entry.sender_address,
        entry.sender_nonce,
        entry.sender_tx_hex,
        (entry as { payment_id?: string | null }).payment_id ?? null,
        now,
        expiresAt
      );
      // Always delete from replay_buffer — the entry is consumed regardless of IGNORE
      this.sql.exec("DELETE FROM replay_buffer WHERE id = ?", entry.id);
      recycled++;
    }

    if (recycled > 0) {
      this.log("info", "replay_recycled", {
        total: recycled,
      });
    }
  }

  /**
   * Sweep up to MAX_SWEEP_SENDERS sender hands per alarm tick.
   * Uses a round-robin cursor (alarm_sender_cursor) so no single sender is always skipped.
   * For each sender with a non-empty hand, calls checkAndAssignRun() to try to assign runs.
   */
  private async sweepHeldHands(): Promise<void> {
    const now = new Date().toISOString();

    // Count total senders with non-empty hands
    const totalSenders = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(DISTINCT sender_address) as cnt
         FROM sender_hand WHERE expires_at > ?`,
        now
      )
      .toArray()[0]?.cnt ?? 0;

    if (totalSenders === 0) return;

    // Read current sender cursor (offset into the sorted sender list)
    const cursor = this.getStateValue(ALARM_SENDER_CURSOR_KEY) ?? 0;

    // Query senders with non-empty hands, ordered deterministically, offset by cursor
    const senders = this.sql
      .exec<{ sender_address: string }>(
        `SELECT DISTINCT sender_address
         FROM sender_hand
         WHERE expires_at > ?
         ORDER BY sender_address ASC
         LIMIT ? OFFSET ?`,
        now,
        MAX_SWEEP_SENDERS,
        cursor % Math.max(1, totalSenders)
      )
      .toArray();

    let swept = 0;
    for (const { sender_address } of senders) {
      try {
        await this.maybeRepairStaleSenderFrontier(sender_address);
        await this.checkAndAssignRun(sender_address);
        swept++;
      } catch (e) {
        this.log("warn", "sweep_hand_error", {
          senderAddress: sender_address,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Advance sender cursor by MAX_SWEEP_SENDERS (wraps in next call via % totalSenders)
    const newCursor = (cursor + MAX_SWEEP_SENDERS) % Math.max(1, totalSenders);
    this.setStateValue(ALARM_SENDER_CURSOR_KEY, newCursor);

    if (swept > 0) {
      this.log("info", "sweep_held_hands", { swept, cursor, totalSenders });
    }
  }

  /**
   * Delete sender_hand entries whose expires_at timestamp has passed.
   * Capped at 100 deletions per alarm tick to stay within CPU budget.
   * Records expired nonces in sender_expiry_log so agents can receive feedback on their next submission.
   * Returns the count of expired entries and the affected sender addresses.
   */
  private sweepExpiredHands(): { expiredCount: number; affectedSenders: string[] } {
    const now = new Date().toISOString();
    const EXPIRY_SWEEP_CAP = 100;

    const expired = this.sql
      .exec<{ sender_address: string; sender_nonce: number }>(
        `SELECT sender_address, sender_nonce FROM sender_hand
         WHERE expires_at < ?
         ORDER BY expires_at ASC
         LIMIT ?`,
        now,
        EXPIRY_SWEEP_CAP
      )
      .toArray();

    if (expired.length === 0) return { expiredCount: 0, affectedSenders: [] };

    // Group expired nonces by sender
    const bySender = new Map<string, number[]>();
    for (const row of expired) {
      const list = bySender.get(row.sender_address) ?? [];
      list.push(row.sender_nonce);
      bySender.set(row.sender_address, list);
    }

    // Delete the expired entries from sender_hand
    for (const row of expired) {
      this.sql.exec(
        "DELETE FROM sender_hand WHERE sender_address = ? AND sender_nonce = ?",
        row.sender_address,
        row.sender_nonce
      );
    }

    // Record expirations in the log so agents see them on next submission
    const expiredAtTs = now;
    for (const [addr, nonces] of bySender.entries()) {
      this.sql.exec(
        `INSERT OR REPLACE INTO sender_expiry_log (sender_address, expired_nonces, expired_at)
         VALUES (?, ?, ?)`,
        addr,
        JSON.stringify(nonces),
        expiredAtTs
      );
    }

    const affectedSenders = Array.from(bySender.keys());
    this.log("info", "hand_entries_expired", {
      expiredCount: expired.length,
      affectedSenders,
      noncesPerSender: Object.fromEntries(bySender),
    });

    return { expiredCount: expired.length, affectedSenders };
  }

  /**
   * Delete sender_expiry_log entries older than 30 minutes.
   * Runs once per alarm cycle to prevent unbounded log growth.
   */
  private pruneExpiryLog(): void {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    this.sql.exec("DELETE FROM sender_expiry_log WHERE expired_at < ?", cutoff);
  }

  /**
   * Return the most recent expiry log entry for the given sender address, if any.
   * Used by /hand-submit to attach recentlyExpired info to the response so agents
   * understand why previously-submitted nonces disappeared from the queue.
   */
  private getRecentExpirationsForSender(
    senderAddress: string
  ): { nonces: number[]; expiredAt: string } | null {
    const row = this.sql
      .exec<{ expired_nonces: string; expired_at: string }>(
        `SELECT expired_nonces, expired_at FROM sender_expiry_log
         WHERE sender_address = ?
         ORDER BY expired_at DESC LIMIT 1`,
        senderAddress
      )
      .toArray()[0];

    if (!row) return null;
    return {
      nonces: JSON.parse(row.expired_nonces) as number[],
      expiredAt: row.expired_at,
    };
  }

  private async syncPaymentAfterBroadcast(params: {
    paymentId: string | null;
    txid: string;
    walletIndex: number;
    sponsorNonce: number;
    fee: string;
  }): Promise<void> {
    if (!params.paymentId || !this.env.RELAY_KV) {
      return;
    }

    const record = await getPaymentRecord(this.env.RELAY_KV, params.paymentId);
    if (record && !new Set(["confirmed", "failed", "replaced"]).has(record.status)) {
      const updated = transitionPayment(record, "mempool", {
        txid: params.txid,
        sponsorWalletIndex: params.walletIndex,
        sponsorNonce: params.sponsorNonce,
        sponsorFee: params.fee,
        holdReason: undefined,
        nextExpectedNonce: undefined,
        missingNonces: undefined,
        holdExpiresAt: undefined,
      });
      await putPaymentRecord(this.env.RELAY_KV, updated);
    }

    await this.env.RELAY_KV.put(`txid_map:${params.txid}`, params.paymentId, {
      expirationTtl: 86_400,
    });
  }

  /**
   * Broadcast up to MAX_BROADCASTS_PER_TICK queued dispatch_queue entries across all wallets.
   * Processes entries ordered by wallet_index ASC, sponsor_nonce ASC to maintain ordering.
   * For each queued entry: deserializes the sender tx, re-sponsors with the queued sponsor nonce,
   * broadcasts, and transitions the entry to 'dispatched'.
   *
   * Pre-flight: skips wallets with zero headroom to avoid wasting API calls on broadcasts
   * that will fail with TooMuchChaining.
   *
   * On failure: parses the raw Hiro response into a NodeBroadcastOutcome, maps it to a
   * BroadcastResponsibility, and acts accordingly — retiring terminal entries instead of
   * retrying them forever.
   *
   * This is the bounded broadcast step in the gin rummy alarm tick.
   */
  private async broadcastBoundedQueueEntries(
    initializedWallets: Array<{ walletIndex: number; address: string }>
  ): Promise<void> {
    const queued = this.sql
      .exec<{
        wallet_index: number;
        payment_id: string | null;
        sender_tx_hex: string;
        sender_address: string;
        sender_nonce: number;
        sponsor_nonce: number;
      }>(
        `SELECT wallet_index, payment_id, sender_tx_hex, sender_address, sender_nonce, sponsor_nonce
         FROM dispatch_queue
         WHERE state = 'queued'
         ORDER BY wallet_index ASC, sponsor_nonce ASC
         LIMIT ?`,
        MAX_BROADCASTS_PER_TICK
      )
      .toArray();

    if (queued.length === 0) return;

    const network = this.env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
    let broadcasts = 0;
    let errors = 0;
    let skippedThrottled = 0;

    // Pre-flight: check headroom per wallet. Wallets at capacity will fail with
    // TooMuchChaining — skip them to avoid burning API calls and generating log spam.
    // Also tracks wallets that hit chaining_limit during this tick so we stop trying.
    const throttledWallets = new Set<number>();

    for (const entry of queued) {
      // Skip wallets throttled during this tick (hit chaining_limit on a prior entry)
      if (throttledWallets.has(entry.wallet_index)) {
        skippedThrottled++;
        continue;
      }

      // Note: no pre-flight headroom gate here. Queued entries already have assigned nonces
      // within the wallet's head-frontier gap — broadcasting them fills the gap rather than
      // expanding it. Headroom measures local gap, not mempool depth, so gating on it would
      // prevent the queue from draining when the gap consists entirely of queued entries.
      // Dynamic throttling via TooMuchChaining outcomes (throttledWallets) is sufficient.

      try {
        const wallet = initializedWallets.find((w) => w.walletIndex === entry.wallet_index);
        if (!wallet) {
          this.log("warn", "bounded_broadcast_no_wallet", {
            walletIndex: entry.wallet_index,
            sponsorNonce: entry.sponsor_nonce,
          });
          errors++;
          continue;
        }

        const privateKey = await this.derivePrivateKeyForWallet(entry.wallet_index);
        if (!privateKey) {
          this.log("warn", "bounded_broadcast_no_key", {
            walletIndex: entry.wallet_index,
            sponsorNonce: entry.sponsor_nonce,
          });
          errors++;
          continue;
        }

        const cleanHex = entry.sender_tx_hex.replace(/^0x/i, "");
        const senderTx = deserializeTransaction(cleanHex);
        const sponsoredTx = await sponsorTransaction({
          transaction: senderTx,
          sponsorPrivateKey: privateKey,
          network,
          fee: GAP_FILL_FEE, // Conservative low fee — mempool clears fast with correct nonce sequences
          sponsorNonce: BigInt(entry.sponsor_nonce),
        });

        const result = await this.broadcastRawTx(sponsoredTx, "bounded_broadcast");
        if (result.ok) {
          // Update original_fee on the existing dispatch_queue row (inserted by checkAndAssignRun with fee=NULL)
          this.sql.exec(
            `UPDATE dispatch_queue SET original_fee = ? WHERE wallet_index = ? AND sponsor_nonce = ? AND original_fee IS NULL`,
            GAP_FILL_FEE.toString(),
            entry.wallet_index,
            entry.sponsor_nonce
          );
          this.transitionQueueEntry(entry.wallet_index, entry.sponsor_nonce, "dispatched");
          this.ledgerBroadcastOutcome(
            entry.wallet_index, entry.sponsor_nonce, result.txid, 200, undefined, undefined
          );
          await this.syncPaymentAfterBroadcast({
            paymentId: entry.payment_id,
            txid: result.txid,
            walletIndex: entry.wallet_index,
            sponsorNonce: entry.sponsor_nonce,
            fee: GAP_FILL_FEE.toString(),
          });
          broadcasts++;
          this.log("debug", "bounded_broadcast_ok", {
            walletIndex: entry.wallet_index,
            sponsorNonce: entry.sponsor_nonce,
            txid: result.txid,
          });
        } else {
          const outcome = parseBroadcastOutcome(result);
          const action = decideBroadcastAction(outcome);
          const logCtx = {
            walletIndex: entry.wallet_index,
            sponsorNonce: entry.sponsor_nonce,
            outcome: outcome.outcome,
            httpStatus: result.status,
            reason: result.reason,
            body: result.body?.slice(0, 512),
          };

          if (action.responsible === "sender") {
            this.retireQueuedEntry(entry.wallet_index, entry.sponsor_nonce, outcome.outcome);
            this.log("info", "bounded_broadcast_retired_sender", {
              ...logCtx,
              isOrigin: "isOrigin" in outcome ? outcome.isOrigin : undefined,
              agentErrorCode: action.agentErrorCode,
            });
          } else if (action.responsible === "sponsor") {
            if (action.action === "wait_for_confirmations") {
              throttledWallets.add(entry.wallet_index);
              this.log("info", "bounded_broadcast_wallet_throttled", logCtx);
            } else if (action.action === "skip_nonce") {
              this.retireQueuedEntry(entry.wallet_index, entry.sponsor_nonce, outcome.outcome);
              this.log("info", "bounded_broadcast_retired_skip", logCtx);
            } else {
              this.log("warn", "bounded_broadcast_needs_fee_bump", logCtx);
            }
          } else {
            this.log("info", "bounded_broadcast_network_retry", {
              ...logCtx,
              retryOnNextAlarmTick: true,
              requestedRetryAfterMs: action.retryAfterMs,
            });
          }
          errors++;
        }
      } catch (e) {
        this.log("warn", "bounded_broadcast_error", {
          walletIndex: entry.wallet_index,
          sponsorNonce: entry.sponsor_nonce,
          error: e instanceof Error ? e.message : String(e),
        });
        errors++;
      }
    }

    if (broadcasts > 0 || errors > 0 || skippedThrottled > 0) {
      this.log("info", "bounded_broadcast_tick", {
        broadcasts,
        errors,
        queued: queued.length,
        skippedThrottled,
        throttledWallets: throttledWallets.size,
      });
    }
  }

  /**
   * Recover from an invalid run on a specific wallet.
   * Called when reconciliation detects a terminal failure for a dispatched sender tx.
   *
   * Failure types:
   * - 'stale_seed': sender nonce was confirmed elsewhere (bad nonce on our sponsored tx)
   * - 'contention': sender submitted same nonce directly; our tx dropped (contention_detected)
   * - 'sender_abort': sender's contract rejected on-chain (abort_by_response / abort_by_post_condition)
   *
   * Recovery pattern: detect → advance sender state → flush dead sponsor slots → return abandoned txs to hand.
   * All cleanup is isolated to the one wallet that owned the run.
   */
  private async recoverInvalidRun(
    walletIndex: number,
    failedSponsorNonce: number,
    failureType: "stale_seed" | "contention" | "sender_abort"
  ): Promise<void> {
    const now = new Date().toISOString();

    // Get the failed dispatch_queue entry to identify the sender
    const failedEntry = this.sql
      .exec<{
        payment_id: string | null;
        sender_address: string;
        sender_nonce: number;
        sender_tx_hex: string;
        original_fee: string | null;
      }>(
        `SELECT payment_id, sender_address, sender_nonce, sender_tx_hex, original_fee
         FROM dispatch_queue
         WHERE wallet_index = ? AND sponsor_nonce = ? LIMIT 1`,
        walletIndex,
        failedSponsorNonce
      )
      .toArray()[0];

    if (!failedEntry) {
      this.log("warn", "recover_invalid_run_entry_not_found", {
        walletIndex,
        failedSponsorNonce,
        failureType,
      });
      return;
    }

    const { sender_address, sender_nonce: failedSenderNonce } = failedEntry;

    if (failureType === "stale_seed" || failureType === "contention") {
      // Case A/B: The sender nonce was confirmed elsewhere. Our sponsored tx is dead.
      // 1. Mark the dead slot as 'replaying' in dispatch_queue
      this.transitionQueueEntry(walletIndex, failedSponsorNonce, "replaying");
      this.sql.exec(
        `UPDATE wallet_hand SET state = 'flushed' WHERE wallet_index = ? AND sponsor_nonce = ?`,
        walletIndex,
        failedSponsorNonce
      );

      // 2. Gap-fill the dead sponsor nonce so the wallet nonce sequence stays gapless
      //    Use original_fee + 1 to replace any ghost mempool entry cheaply
      const flushFee = computeRbfFee(failedEntry.original_fee);
      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      if (privateKey) {
        await this.fillGapNonce(walletIndex, failedSponsorNonce, privateKey, flushFee);
      }

      // 3. Advance sender_state past the failed sender nonce (it was confirmed elsewhere)
      this.advanceSenderNonce(sender_address, failedSenderNonce);

      this.log("info", "invalid_run_recovery", {
        walletIndex,
        failedSponsorNonce,
        failedSenderNonce,
        senderAddress: sender_address,
        failureType,
        slotsFlushed: 1,
        txsReturnedToHand: 0,
        flushFee: flushFee.toString(),
        originalFee: failedEntry.original_fee,
      });
    } else {
      // Case C: sender_abort — the tx aborted on-chain. The sender nonce was NOT confirmed.
      // The sender may want to resubmit with different params.
      // Get ALL higher entries from the same sender's run on this wallet
      const higherEntries = this.sql
        .exec<{
          payment_id: string | null;
          sponsor_nonce: number;
          sender_nonce: number;
          sender_tx_hex: string;
          original_fee: string | null;
        }>(
          `SELECT payment_id, sponsor_nonce, sender_nonce, sender_tx_hex, original_fee
           FROM dispatch_queue
           WHERE wallet_index = ? AND sender_address = ? AND sponsor_nonce >= ?
           ORDER BY sponsor_nonce ASC`,
          walletIndex,
          sender_address,
          failedSponsorNonce
        )
        .toArray();

      const expiresAt = new Date(Date.now() + HAND_HOLD_TIMEOUT_MS).toISOString();
      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      let slotsFlushed = 0;
      let txsReturnedToHand = 0;

      for (const higher of higherEntries) {
        // Mark as replaying / flushed in the tables
        this.transitionQueueEntry(walletIndex, higher.sponsor_nonce, "replaying");
        this.sql.exec(
          `UPDATE wallet_hand SET state = 'flushed' WHERE wallet_index = ? AND sponsor_nonce = ?`,
          walletIndex,
          higher.sponsor_nonce
        );
        slotsFlushed++;

        // Gap-fill the sponsor nonce slot using original_fee + 1 to replace any ghost mempool entry
        const slotFlushFee = computeRbfFee(higher.original_fee);
        if (privateKey) {
          await this.fillGapNonce(walletIndex, higher.sponsor_nonce, privateKey, slotFlushFee);
        }

        // For higher sender nonces (not the failed one): return to sender_hand for resubmit
        if (higher.sender_nonce > failedSenderNonce) {
          this.sql.exec(
            `INSERT OR IGNORE INTO sender_hand
               (sender_address, sender_nonce, tx_hex, payment_id, source, received_at, expires_at)
             VALUES (?, ?, ?, ?, 'replay', ?, ?)`,
            sender_address,
            higher.sender_nonce,
            higher.sender_tx_hex,
            (higher as { payment_id?: string | null }).payment_id ?? null,
            now,
            expiresAt
          );
          txsReturnedToHand++;
        }
        // The failed sender nonce itself is NOT advanced — sender may resubmit with new params
      }

      this.log("info", "invalid_run_recovery", {
        walletIndex,
        failedSponsorNonce,
        failedSenderNonce,
        senderAddress: sender_address,
        failureType,
        slotsFlushed,
        txsReturnedToHand,
      });
    }
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      try {
        // --- Preamble: migration, cleanup, replay recycling, seed upgrades ---
        this.runGinRummyMigration();
        await this.cleanupLegacyDegradationKeys();
        this.recycleReplayBuffer();
        await this.retrySeedFirstTxSenders();

        // Snapshot gin rummy state for alarm diagnostics
        const senderHandTotal = this.sql
          .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sender_hand")
          .toArray()[0]?.cnt ?? 0;
        const senderStateTotal = this.sql
          .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sender_state")
          .toArray()[0]?.cnt ?? 0;
        const walletHandActive = this.sql
          .exec<{ cnt: number }>(
            "SELECT COUNT(*) as cnt FROM wallet_hand WHERE state IN ('allocated','dispatched','stuck')"
          )
          .toArray()[0]?.cnt ?? 0;
        if (senderHandTotal > 0 || walletHandActive > 0) {
          this.log("info", "gin_rummy_alarm_state", {
            senderHandEntries: senderHandTotal,
            senderStateTracked: senderStateTotal,
            walletHandActive,
          });
        }

        const initializedWallets = await this.getInitializedWallets();

        // ---------------------------------------------------------------------------
        // Bounded reconciliation: process MAX_RECONCILE_WALLETS wallets per tick.
        // Round-robin cursor advances each tick so all wallets reconcile over time.
        // Full 10-wallet reconciliation: ceil(10/3) = 4 ticks (~4 min at 60s cadence).
        // ---------------------------------------------------------------------------
        const walletCursor = this.getStateValue(ALARM_WALLET_CURSOR_KEY) ?? 0;
        const walletCount = initializedWallets.length;

        // Determine which wallets to reconcile this tick
        const reconcileWallets: Array<{ walletIndex: number; address: string }> = [];
        for (let i = 0; i < MAX_RECONCILE_WALLETS && i < walletCount; i++) {
          const idx = (walletCursor + i) % walletCount;
          const wallet = initializedWallets[idx];
          if (wallet) reconcileWallets.push(wallet);
        }

        for (const { walletIndex, address } of reconcileWallets) {
          // reconcileNonceForWallet returns null when Hiro is unreachable — skip silently
          await this.reconcileNonceForWallet(walletIndex, address);

          // Clean up StuckTxState entries for nonces that have been confirmed on-chain.
          const cached = this.hiroNonceCache.get(walletIndex);
          if (cached) {
            const confirmedThreshold = cached.value - 1;
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
                this.incrementCounter(STATE_KEYS.stuckTxRbfConfirmed);
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

        // Advance wallet cursor for next tick (round-robin)
        const nextWalletCursor = walletCount > 0
          ? (walletCursor + MAX_RECONCILE_WALLETS) % walletCount
          : 0;
        this.setStateValue(ALARM_WALLET_CURSOR_KEY, nextWalletCursor);

        // ---------------------------------------------------------------------------
        // Sweep held sender hands: try to dispatch pending runs (bounded per tick)
        // ---------------------------------------------------------------------------
        await this.sweepHeldHands();

        // ---------------------------------------------------------------------------
        // Expiry sweep: delete sender_hand entries past their 15-minute hold timeout.
        // Capped at 100 deletions per tick; records to sender_expiry_log for feedback.
        // ---------------------------------------------------------------------------
        this.sweepExpiredHands();
        // Prune expiry log entries older than 30 minutes to bound table growth.
        this.pruneExpiryLog();

        // ---------------------------------------------------------------------------
        // Bounded broadcast: broadcast up to MAX_BROADCASTS_PER_TICK queued entries
        // ---------------------------------------------------------------------------
        await this.broadcastBoundedQueueEntries(initializedWallets);

        // Surge tracking: record/update/resolve surge events based on pool pressure.
        // Must run after reconciliation so ledger counts are current.
        this.checkAndRecordSurge(initializedWallets.length);

        // Dynamic scaling: add a wallet if ALL initialized wallets are above 75% pressure
        // and we haven't hit SPONSOR_WALLET_MAX.
        await this.checkAndScaleUp(initializedWallets.length);

        // Replacement notifications: scan replaced_tx:* KV entries and transition payment
        // records to "replaced" status so agents can detect via GET /payment/:id.
        await this.processReplacementNotifications();

        // Confirmation notifications: scan nonce_events for reconcile_confirmed/
        // reconcile_aborted and proactively transition payment records in RELAY_KV.
        await this.processConfirmationNotifications();

        // Process old-path replay buffer: re-sponsor sender txs with fresh nonces and broadcast.
        // Runs after all wallet reconciliation is complete so flush results are visible.
        const replayResult = await this.processReplayBuffer(initializedWallets);
        if (replayResult.processed > 0 || replayResult.failed > 0) {
          this.log("info", "replay_buffer_cycle_complete", {
            processed: replayResult.processed,
            failed: replayResult.failed,
          });
        }

        // Queue observability: log remaining replay buffer entries after processing.
        for (const { walletIndex } of initializedWallets) {
          const replayDepth = this.getReplayBufferDepth(walletIndex);
          if (replayDepth > 0) {
            const queueDepth = this.getDispatchQueueDepth(walletIndex);
            this.log("info", "replay_buffer_non_empty", {
              walletIndex,
              replayBufferDepth: replayDepth,
              queueDepth: queueDepth.total,
              dispatchedCount: queueDepth.dispatched,
            });
          }
        }

        // ---------------------------------------------------------------------------
        // Backward probe: process pending probe_queue entries (ghost eviction).
        // Runs after reconciliation so wallet state is current.
        // ---------------------------------------------------------------------------
        const probeResult = await this.processProbeQueue();
        if (probeResult.processed > 0) {
          this.log("info", "probe_queue_cycle_complete", probeResult);
        }

        await this.refreshSponsorStatusSnapshot();

        // Dynamic alarm interval: active (60s) when in-flight nonces present,
        // idle (5min) when all wallets are drained.
        const totalReservedAfterCycle = this.ledgerTotalAssigned();
        const probeQueuePending = this.sql
          .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM probe_queue WHERE state = 'pending'")
          .toArray()[0]?.cnt ?? 0;
        const isActive = totalReservedAfterCycle > 0 || probeQueuePending > 0;
        const intervalMs = isActive ? ALARM_INTERVAL_ACTIVE_MS : ALARM_INTERVAL_IDLE_MS;
        this.log("info", "nonce_alarm_scheduled", {
          intervalMs,
          activeWallets: initializedWallets.length,
          totalReserved: totalReservedAfterCycle,
          isActive,
          walletCursor,
          nextWalletCursor,
          reconcileCount: reconcileWallets.length,
        });
        await this.state.storage.setAlarm(Date.now() + intervalMs);
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
      await this.refreshSponsorStatusSnapshot();
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
   * Zero out conflictsDetected and clear lastGapDetected.
   * Shared by auto-clear (after clean resync) and manual clear-conflicts action.
   * Returns the previous conflict count (0 if already clean).
   */
  private clearConflictCounters(reason: string): number {
    const previousConflicts = this.getStoredCount(STATE_KEYS.conflictsDetected);

    // Always clear lastGapDetected so the health circuit breaker can recover,
    // even if conflictsDetected is already zero.
    this.sql.exec("DELETE FROM nonce_state WHERE key = ?", STATE_KEYS.lastGapDetected);

    if (previousConflicts === 0) {
      this.log("info", "conflict_counters_already_clear", { reason });
      return 0;
    }

    this.setStateValue(STATE_KEYS.conflictsDetected, 0);
    this.log("info", "conflict_counters_cleared", { previousConflicts, reason });
    return previousConflicts;
  }

  /**
   * Manual escape hatch: zero out conflictsDetected and clear lastGapDetected
   * without touching any nonce pool state. Used when auto-clear hasn't fired yet
   * and operators need to unblock the health circuit breaker immediately.
   */
  private async handleClearConflicts(): Promise<Response> {
    const previousConflicts = this.clearConflictCounters("manual_operator_clear");
    await this.refreshSponsorStatusSnapshot();
    return this.jsonResponse({ cleared: true, previousConflicts });
  }

  /**
   * Clear per-wallet nonce state and re-derive sponsor addresses from mnemonic.
   * Resets nonce heads, clears nonce_intents ledger, and resets round-robin index.
   * Always re-derives and stores sponsor addresses — this both preserves them
   * during normal clears and recovers from a previous bug that deleted them.
   */
  private async handleClearPools(): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const initializedWallets = await this.getInitializedWallets();
      for (const { walletIndex } of initializedWallets) {
        // NOTE: sponsor address is intentionally preserved — it is wallet
        // identity, not nonce state. Deleting it breaks all admin actions
        // until a redeploy re-runs /assign.
        // Reset the ledger head for this wallet
        if (walletIndex === 0) {
          this.sql.exec("DELETE FROM nonce_state WHERE key = ?", STATE_KEYS.current);
        } else {
          this.sql.exec("DELETE FROM nonce_state WHERE key = ?", `wallet_next_nonce:${walletIndex}`);
        }
        // Clear nonce_intents and chain frontier for this wallet
        this.sql.exec("DELETE FROM nonce_intents WHERE wallet_index = ?", walletIndex);
        this.sql.exec("DELETE FROM nonce_state WHERE key = ?", this.chainFrontierKey(walletIndex));
        this.chainFrontierCache.delete(walletIndex);
      }
      // Reset round-robin index
      await this.state.storage.put(NEXT_WALLET_INDEX_KEY, 0);

      // Re-derive and store sponsor addresses from the mnemonic.
      // This both preserves addresses after a normal clear AND recovers from
      // a previous clear-pools that erroneously deleted them.
      const walletCountRaw = this.env.SPONSOR_WALLET_COUNT ?? "1";
      const walletCount = Math.max(1, parseInt(walletCountRaw, 10) || 1);
      const stacksNetwork = this.env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
      let rederived = 0;
      for (let wi = 0; wi < walletCount; wi++) {
        const pk = await this.derivePrivateKeyForWallet(wi);
        if (!pk) break;
        const addr = getAddressFromPrivateKey(pk, stacksNetwork);
        await this.setStoredSponsorAddressForWallet(wi, addr);
        rederived++;
      }

      const cleared = initializedWallets.length;
      const reason = cleared > 0
        ? `Cleared ${cleared} wallet${cleared === 1 ? "" : "s"}, re-derived ${rederived} address${rederived === 1 ? "" : "es"}`
        : `No wallets to clear, re-derived ${rederived} address${rederived === 1 ? "" : "es"}`;
      const result = {
        success: true,
        action: "clear_pools",
        previousNonce: null,
        newNonce: null,
        changed: cleared > 0,
        reason,
      };
      this.log("info", "clear_pools", { action: result.action, changed: result.changed, reason: result.reason });
      await this.refreshSponsorStatusSnapshot();
      return this.jsonResponse(result);
    });
  }

  /**
   * Admin: fill all nonce gaps for a specific wallet by querying Hiro for the
   * gap range and broadcasting 1 uSTX transfers. Bypasses MAX_GAP_FILLS_PER_ALARM
   * and gap-fill throttle — intended for manual intervention on stuck wallets.
   */
  private async handleFillGaps(walletIndex: number): Promise<Response> {
    try {
      const address = await this.getStoredSponsorAddressForWallet(walletIndex);
      if (!address) {
        return this.badRequest(`Wallet ${walletIndex} not initialized`);
      }

      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      if (!privateKey) {
        return this.badRequest(`Cannot derive key for wallet ${walletIndex}`);
      }

      // Fetch current chain state
      let nonceInfo: HiroNonceInfo;
      try {
        nonceInfo = await this.fetchNonceInfo(address);
      } catch (_e) {
        return this.jsonResponse({ error: "Hiro API unavailable" }, 503);
      }

      const { possible_next_nonce, detected_missing_nonces, last_executed_tx_nonce } = nonceInfo;
      this.advanceChainFrontier(walletIndex, possible_next_nonce);
      const head = this.ledgerGetWalletHead(walletIndex);

      // Compute gaps: Hiro-reported missing nonces + any range between
      // last_executed and head that Hiro doesn't see (ledger-only gaps)
      const gapSet = new Set(detected_missing_nonces);

      // Pre-mempool corridor: [last_executed_tx_nonce+1 .. possible_next_nonce)
      // Hiro never reports these as "missing" because no mempool tx sits above them
      // to create a detectable gap — the "first blocker" blind spot.
      if (last_executed_tx_nonce !== null) {
        const corridorEnd = Math.min(
          possible_next_nonce,
          last_executed_tx_nonce + 1 + MAX_ADMIN_GAP_FILLS
        );
        for (let n = last_executed_tx_nonce + 1; n < corridorEnd; n++) {
          gapSet.add(n);
        }
      }

      // Also check contiguous range from possible_next_nonce to head for
      // nonces not in the mempool (Hiro won't report these as "missing"
      // if it doesn't know about them)
      if (head !== null && head > possible_next_nonce) {
        for (let n = possible_next_nonce; n < head; n++) {
          gapSet.add(n);
        }
      }

      // Remove nonces that are already managed by our ledger (assigned/broadcasted/confirmed).
      // Lower bound covers the full gap range added above (last_executed + 1 or 0)
      // so corridor nonces with existing ledger entries are correctly excluded.
      // 'confirmed' = broadcast accepted, still pending on-chain — same as ledgerInFlightCount.
      const inFlightLowerBound =
        last_executed_tx_nonce !== null ? last_executed_tx_nonce + 1 : 0;
      const inFlightRows = this.sql
        .exec<{ nonce: number }>(
          `SELECT nonce FROM nonce_intents
           WHERE wallet_index = ? AND state IN ('assigned', 'broadcasted', 'confirmed')
             AND nonce >= ?`,
          walletIndex,
          inFlightLowerBound
        )
        .toArray();
      for (const row of inFlightRows) {
        gapSet.delete(row.nonce);
      }

      const allGaps = [...gapSet].sort((a, b) => a - b);
      const truncated = allGaps.length > MAX_ADMIN_GAP_FILLS;
      const gaps = allGaps.slice(0, MAX_ADMIN_GAP_FILLS);

      if (gaps.length === 0) {
        return this.jsonResponse({
          success: true,
          walletIndex,
          address,
          message: "No gaps found",
          possible_next_nonce,
          head,
          filled: [],
          failed: [],
        });
      }

      this.log("info", "admin_fill_gaps_start", {
        walletIndex,
        gapCount: gaps.length,
        gaps,
        possible_next_nonce,
        head,
      });

      const filled: Array<{ nonce: number; txid: string }> = [];
      const failed: Array<{ nonce: number; reason: string }> = [];

      for (const gapNonce of gaps) {
        const escalatedFee = this.computeEscalatedFee(walletIndex, gapNonce);
        const feeOverride = escalatedFee > GAP_FILL_FEE ? escalatedFee : undefined;
        const txid = await this.fillGapNonce(walletIndex, gapNonce, privateKey, feeOverride);
        if (txid) {
          filled.push({ nonce: gapNonce, txid });
          this.ledgerInsertGapFill(walletIndex, gapNonce, txid);
          this.incrementCounter(STATE_KEYS.gapsFilled);
          await this.recordGapFillFee(walletIndex, escalatedFee.toString());
        } else {
          failed.push({ nonce: gapNonce, reason: "broadcast rejected or already occupied" });
        }
      }

      this.log("info", "admin_fill_gaps_complete", {
        walletIndex,
        filledCount: filled.length,
        failedCount: failed.length,
      });

      return this.jsonResponse({
        success: true,
        walletIndex,
        address,
        possible_next_nonce,
        head,
        filled,
        failed,
        ...(truncated && { truncated: true, totalGaps: allGaps.length }),
      });
    } catch (error) {
      return this.internalError(error);
    }
  }

  /**
   * Admin: full wallet flush — retract all active dispatch_queue entries to replay_buffer,
   * replace every nonce in [last_executed+1 .. max(possible_next, head)] with a self-transfer,
   * and reset the wallet head. Use when surgical gap-filling fails (18+ scattered gaps /
   * TooMuchChaining prevents individual gap-fills from landing).
   *
   * Safety cap: MAX_ADMIN_GAP_FILLS (50) nonces per flush to prevent unbounded iteration.
   * Nonces are processed ascending (lowest first) so the chain starts confirming immediately.
   */
  private async handleFlushWallet(walletIndex: number, probeDepth?: number): Promise<Response> {
    try {
      const address = await this.getStoredSponsorAddressForWallet(walletIndex);
      if (!address) {
        return this.badRequest(`Wallet ${walletIndex} not initialized`);
      }

      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      if (!privateKey) {
        return this.badRequest(`Cannot derive key for wallet ${walletIndex}`);
      }

      // Fetch current chain state from Hiro
      let nonceInfo: HiroNonceInfo;
      try {
        nonceInfo = await this.fetchNonceInfo(address);
      } catch (_e) {
        return this.jsonResponse({ error: "Hiro API unavailable" }, 503);
      }

      const { possible_next_nonce, last_executed_tx_nonce } = nonceInfo;
      this.advanceChainFrontier(walletIndex, possible_next_nonce);
      const head = this.ledgerGetWalletHead(walletIndex);

      // Determine flush range: [flushStart .. flushEnd)
      // flushStart = last_executed_tx_nonce + 1 (safe floor confirmed on-chain)
      // flushEnd   = max(possible_next_nonce, head) so we cover all in-flight nonces
      const flushStart = last_executed_tx_nonce !== null
        ? last_executed_tx_nonce + 1
        : possible_next_nonce;
      const rawFlushEnd = Math.max(
        possible_next_nonce,
        head ?? possible_next_nonce
      );
      // Clamp to safety cap — process lowest nonces first so chain starts confirming
      const flushEnd = Math.min(rawFlushEnd, flushStart + MAX_ADMIN_GAP_FILLS);

      this.log("info", "flush_wallet_start", {
        walletIndex,
        address,
        flushStart,
        flushEnd,
        possibleNextNonce: possible_next_nonce,
        lastExecutedTxNonce: last_executed_tx_nonce,
        head,
        probeDepth: probeDepth ?? null,
        capped: rawFlushEnd > flushStart + MAX_ADMIN_GAP_FILLS,
      });

      // -------------------------------------------------------------------------
      // Backward probe: forward range is empty but ghost entries may exist.
      // Enqueue nonces into probe_queue for alarm-driven batch processing.
      // The alarm processes 5/tick with RBF_FEE to evict ghost mempool entries
      // without blocking payment requests (CF best practice: no long I/O in fetch).
      // -------------------------------------------------------------------------
      if (flushStart >= flushEnd && probeDepth && probeDepth > 0 && last_executed_tx_nonce !== null) {
        const probeStart = Math.max(0, last_executed_tx_nonce - probeDepth + 1);
        const probeEnd = last_executed_tx_nonce + 1; // exclusive
        const now = new Date().toISOString();

        // Clear any stale probe entries for this wallet before inserting
        this.sql.exec(
          "DELETE FROM probe_queue WHERE wallet_index = ?",
          walletIndex
        );

        let enqueued = 0;
        for (let nonce = probeStart; nonce < probeEnd; nonce++) {
          this.sql.exec(
            `INSERT INTO probe_queue (wallet_index, nonce, state, created_at)
             VALUES (?, ?, 'pending', ?)`,
            walletIndex,
            nonce,
            now
          );
          enqueued++;
        }

        this.log("info", "flush_wallet_probe_enqueued", {
          walletIndex,
          probeStart,
          probeEnd,
          enqueued,
          probeDepth,
          lastExecutedTxNonce: last_executed_tx_nonce,
        });

        return this.jsonResponse({
          success: true,
          walletIndex,
          address,
          mode: "backward_probe_enqueued",
          probeRange: { start: probeStart, end: probeEnd },
          enqueued,
          forwardRangeEmpty: true,
          chainState: {
            lastExecutedTxNonce: last_executed_tx_nonce,
            possibleNextNonce: possible_next_nonce,
            head,
          },
          note: "Probe nonces enqueued for alarm-driven processing (5/tick, RBF_FEE). Check GET /nonce/state for progress.",
        });
      }

      // -------------------------------------------------------------------------
      // Step 1: Index active dispatch_queue entries by sponsor nonce.
      // We defer retraction to replay_buffer until after each nonce is
      // successfully flushed — avoids re-sponsoring while old slot is occupied.
      // -------------------------------------------------------------------------
      const activeEntries = this.sql
        .exec<{
          payment_id: string | null;
          sender_tx_hex: string;
          sender_address: string;
          sender_nonce: number;
          sponsor_nonce: number;
        }>(
          `SELECT payment_id, sender_tx_hex, sender_address, sender_nonce, sponsor_nonce
           FROM dispatch_queue
           WHERE wallet_index = ? AND state IN ('queued', 'dispatched')
           ORDER BY sponsor_nonce ASC`,
          walletIndex
        )
        .toArray();

      // Map sponsor_nonce → entry for per-nonce retraction after successful flush
      const activeByNonce = new Map(activeEntries.map((e) => [e.sponsor_nonce, e]));

      // -------------------------------------------------------------------------
      // Step 2: Fill every nonce in [flushStart .. flushEnd) with a self-transfer.
      // For nonces occupied by real sponsored txs, use broadcastRbfForNonce to evict.
      // For gaps or gap-fill slots, use fillGapNonce with MIN_FLUSH_FEE.
      // On successful flush of a sponsored nonce, retract to replay_buffer.
      // -------------------------------------------------------------------------
      const filled: Array<{ nonce: number; txid: string; method: "rbf" | "gap_fill" }> = [];
      const failedNonces: Array<{ nonce: number; reason: string }> = [];
      let retracted = 0;

      // Build set of nonces that hold real sponsored txs (non-gap-fill dispatch_queue entries)
      const sponsoredNonceSet = new Set(
        this.sql
          .exec<{ sponsor_nonce: number }>(
            `SELECT sponsor_nonce FROM dispatch_queue WHERE wallet_index = ? AND state NOT IN ('confirmed', 'retired')`,
            walletIndex
          )
          .toArray()
          .map((r) => r.sponsor_nonce)
      );

      for (let nonce = flushStart; nonce < flushEnd; nonce++) {
        try {
          if (sponsoredNonceSet.has(nonce)) {
            // Nonce held by a real sponsored tx — prefer RBF, fall back to gap-fill
            let txid = await this.broadcastRbfForNonce(walletIndex, nonce, privateKey, null);
            if (txid) {
              filled.push({ nonce, txid, method: "rbf" });
            } else {
              // RBF failed (max attempts or network error) — fall back to gap-fill
              const flushFee = this.computeEscalatedFee(walletIndex, nonce, MIN_FLUSH_FEE);
              const gapTxid = await this.fillGapNonce(walletIndex, nonce, privateKey, flushFee);
              if (gapTxid) {
                txid = gapTxid;
                this.ledgerInsertGapFill(walletIndex, nonce, gapTxid);
                this.incrementCounter(STATE_KEYS.gapsFilled);
                await this.recordGapFillFee(walletIndex, flushFee.toString());
                filled.push({ nonce, txid: gapTxid, method: "gap_fill" });
              } else {
                failedNonces.push({ nonce, reason: "rbf and gap-fill both failed or already occupied" });
              }
            }
            // Only retract to replay_buffer after successful flush for this nonce
            if (txid) {
              const entry = activeByNonce.get(nonce);
              if (entry) {
                try {
                  this.transitionQueueEntry(walletIndex, nonce, "replaying");
                  this.addToReplayBuffer(
                    walletIndex,
                    entry.sender_tx_hex,
                    entry.sender_address,
                    entry.sender_nonce,
                    entry.sponsor_nonce,
                    (entry as { payment_id?: string | null }).payment_id ?? null
                  );
                  retracted++;
                } catch (e) {
                  this.log("warn", "flush_wallet_retract_error", {
                    walletIndex,
                    sponsorNonce: nonce,
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              }
            }
          } else {
            // Gap or unknown slot — use gap-fill self-transfer
            const gapFlushFee = this.computeEscalatedFee(walletIndex, nonce, MIN_FLUSH_FEE);
            const txid = await this.fillGapNonce(walletIndex, nonce, privateKey, gapFlushFee);
            if (txid) {
              this.ledgerInsertGapFill(walletIndex, nonce, txid);
              this.incrementCounter(STATE_KEYS.gapsFilled);
              await this.recordGapFillFee(walletIndex, gapFlushFee.toString());
              filled.push({ nonce, txid, method: "gap_fill" });
            } else {
              // ConflictingNonceInMempool means already occupied — not a hard failure
              failedNonces.push({ nonce, reason: "broadcast rejected or already occupied" });
            }
          }
        } catch (e) {
          this.log("warn", "flush_wallet_fill_error", {
            walletIndex,
            nonce,
            error: e instanceof Error ? e.message : String(e),
          });
          failedNonces.push({ nonce, reason: e instanceof Error ? e.message : String(e) });
        }
      }

      // -------------------------------------------------------------------------
      // Step 3: Advance wallet head to flushEnd so /assign starts past the
      // flushed range. Setting it to flushStart would cause immediate conflicts
      // with the self-transfers we just broadcast.
      // -------------------------------------------------------------------------
      this.ledgerAdvanceWalletHead(walletIndex, flushEnd);
      const replayBufferDepth = this.getReplayBufferDepth(walletIndex);

      this.log("info", "flush_wallet_complete", {
        walletIndex,
        flushStart,
        flushEnd,
        retracted,
        filledCount: filled.length,
        failedCount: failedNonces.length,
        newHead: flushEnd,
        replayBufferDepth,
      });

      return this.jsonResponse({
        success: true,
        walletIndex,
        address,
        flushRange: { start: flushStart, end: flushEnd },
        retracted,
        filled,
        failed: failedNonces,
        newHead: flushEnd,
        replayBufferDepth,
        ...(rawFlushEnd > flushStart + MAX_ADMIN_GAP_FILLS && {
          capped: true,
          totalNonceRange: rawFlushEnd - flushStart,
        }),
      });
    } catch (error) {
      return this.internalError(error);
    }
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
        ? Math.max(1, Math.min(body.walletCount, ABSOLUTE_MAX_WALLET_COUNT))
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
        if (error instanceof LowHeadroomError) {
          return new Response(
            JSON.stringify({
              error: "Nonce pool headroom is low; back off and retry",
              code: "LOW_HEADROOM",
              retryAfterSeconds: error.retryAfterSeconds,
            }),
            {
              status: 503,
              headers: {
                "content-type": "application/json",
                "Retry-After": String(error.retryAfterSeconds),
              },
            }
          );
        }
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
        ? Math.max(0, Math.min(body.walletIndex, ABSOLUTE_MAX_WALLET_COUNT - 1))
        : 0;

      // fee is optional; only recorded when present and txid is also present
      const fee = typeof body.fee === "string" && body.fee.length > 0 ? body.fee : undefined;

      const errorReason = typeof body.errorReason === "string" && body.errorReason.length > 0
        ? body.errorReason
        : undefined;

      try {
        await this.releaseNonce(body.nonce, body.txid, walletIndex, fee, errorReason);
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

    if (request.method === "GET" && url.pathname === "/pool-health") {
      try {
        const health = await this.getPoolHealth();
        return this.jsonResponse(health);
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

    if (request.method === "GET" && url.pathname === "/sponsor-status") {
      try {
        const sponsorStatus = await this.getSponsorStatus();
        return this.jsonResponse(
          sponsorStatus,
          sponsorStatus.status === "unavailable" ? 503 : 200
        );
      } catch (error) {
        return this.internalError(error);
      }
    }

    // GET /wallet-fees/:walletIndex — returns fee stats for a specific wallet
    const walletFeesMatch = url.pathname.match(/^\/wallet-fees\/(\d+)$/);
    if (request.method === "GET" && walletFeesMatch) {
      const wi = parseInt(walletFeesMatch[1], 10);
      if (!Number.isInteger(wi) || wi < 0 || wi >= ABSOLUTE_MAX_WALLET_COUNT) {
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

    if (request.method === "POST" && url.pathname === "/clear-conflicts") {
      return this.handleClearConflicts();
    }

    if (request.method === "POST" && url.pathname === "/queue-dispatch") {
      const { value: body, errorResponse } =
        await this.parseJson<{
          walletIndex: number;
          senderTxHex: string;
          senderAddress: string;
          senderNonce: number;
          sponsorNonce: number;
          paymentId?: string | null;
          fee?: string | null;
          submittedAt?: string | null;
        }>(request);
      if (errorResponse) return errorResponse;
      if (
        typeof body?.walletIndex !== "number" ||
        typeof body?.sponsorNonce !== "number" ||
        !body?.senderTxHex ||
        !body?.senderAddress
      ) {
        return this.badRequest("Missing required fields");
      }
      try {
        this.queueDispatch(
          body.walletIndex,
          body.senderTxHex,
          body.senderAddress,
          body.senderNonce ?? 0,
          body.sponsorNonce,
          typeof body.paymentId === "string" ? body.paymentId : null,
          typeof body.fee === "string" ? body.fee : null,
          typeof body.submittedAt === "string" ? body.submittedAt : null
        );
        return this.jsonResponse({ success: true });
      } catch (error) {
        return this.internalError(error);
      }
    }

    if (request.method === "POST" && url.pathname === "/broadcast-outcome") {
      const { value: body, errorResponse } =
        await this.parseJson<BroadcastOutcomeRequest>(request);
      if (errorResponse) return errorResponse;
      if (typeof body?.nonce !== "number") return this.badRequest("Missing nonce");
      const walletIndex = typeof body.walletIndex === "number"
        ? Math.max(0, Math.min(body.walletIndex, ABSOLUTE_MAX_WALLET_COUNT - 1))
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

    // POST /fill-gaps/:wallet — admin: immediately fill all gaps for a specific wallet.
    // Bypasses MAX_GAP_FILLS_PER_ALARM and RBF logic — just broadcasts gap-fill txs.
    const fillGapsMatch = url.pathname.match(/^\/fill-gaps\/(\d+)$/);
    if (request.method === "POST" && fillGapsMatch) {
      const walletIdx = parseInt(fillGapsMatch[1], 10);
      const response = await this.state.blockConcurrencyWhile(() => this.handleFillGaps(walletIdx));
      if (response.ok) {
        await this.refreshSponsorStatusSnapshot();
      }
      return response;
    }

    // POST /flush-wallet/:walletIndex — admin: full wallet flush when surgical gap-filling fails.
    // Retracts all active dispatch_queue entries to replay_buffer, fills the entire nonce range
    // with self-transfers, and resets the wallet head to last_executed+1.
    const flushWalletMatch = url.pathname.match(/^\/flush-wallet\/(\d+)$/);
    if (request.method === "POST" && flushWalletMatch) {
      const walletIdx = parseInt(flushWalletMatch[1], 10);
      if (!Number.isInteger(walletIdx) || walletIdx < 0 || walletIdx >= ABSOLUTE_MAX_WALLET_COUNT) {
        return this.badRequest("Invalid wallet index");
      }
      const probeDepthParam = url.searchParams.get("probeDepth");
      let probeDepth: number | undefined;
      if (probeDepthParam !== null) {
        const parsed = Number(probeDepthParam);
        probeDepth = Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : undefined;
      }

      // Forward flush + probe enqueue both run inside blockConcurrencyWhile
      // (both mutate SQLite). When probeDepth is set and the forward range is
      // empty, handleFlushWallet enqueues nonces into probe_queue and returns
      // immediately — the alarm processes them in batches (5/tick, RBF_FEE).
      const response = await this.state.blockConcurrencyWhile(
        () => this.handleFlushWallet(walletIdx, probeDepth)
      );
      if (response.ok) {
        await this.refreshSponsorStatusSnapshot();
      }
      return response;
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

    // GET /nonce-state — client-observable nonce state for diagnostics.
    // Returns per-wallet pending txs, gaps, and health status so MCP clients
    // can correlate sender nonces with sponsor nonces (issue #229).
    if (request.method === "GET" && url.pathname === "/nonce-state") {
      try {
        const state = await this.getObservableNonceState();
        return this.jsonResponse(state);
      } catch (error) {
        return this.internalError(error);
      }
    }

    // GET /surge-history — returns the last 20 surge events for operator diagnostics.
    if (request.method === "GET" && url.pathname === "/surge-history") {
      try {
        const surgeEvents = this.sql
          .exec("SELECT * FROM surge_events ORDER BY id DESC LIMIT 20")
          .toArray();
        return this.jsonResponse({
          surgeEvents,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        return this.internalError(error);
      }
    }

    // GET /queue-sender/:address — agent queue visibility.
    // Returns dispatch_queue and replay_buffer rows for a specific sender address
    // across all wallets. sender_tx_hex is excluded (large + unnecessary for clients).
    const queueSenderMatch = url.pathname.match(/^\/queue-sender\/([^/]+)$/);
    if (request.method === "GET" && queueSenderMatch) {
      const senderAddress = decodeURIComponent(queueSenderMatch[1]);
      try {
        const senderWedge = this.buildSenderWedgeStatus(senderAddress);
        const queueRows = this.sql
          .exec<{
            wallet_index: number;
            payment_id: string | null;
            sponsor_nonce: number;
            sender_nonce: number;
            state: string;
            queued_at: string;
            dispatched_at: string | null;
          }>(
            `SELECT wallet_index, payment_id, sponsor_nonce, sender_nonce, state,
                    queued_at, dispatched_at
             FROM dispatch_queue
             WHERE sender_address = ? AND state NOT IN ('confirmed', 'retired')
             ORDER BY sponsor_nonce ASC
             LIMIT 100`,
            senderAddress
          )
          .toArray();

        const heldRows = this.sql
          .exec<{
            payment_id: string | null;
            sender_nonce: number;
            source: string;
            received_at: string;
            expires_at: string;
          }>(
            `SELECT payment_id, sender_nonce, source, received_at, expires_at
             FROM sender_hand
             WHERE sender_address = ? AND expires_at > ?
             ORDER BY sender_nonce ASC
             LIMIT 100`,
            senderAddress,
            new Date().toISOString()
          )
          .toArray();

        const replayRows = this.sql
          .exec<{
            id: number;
            wallet_index: number;
            payment_id: string | null;
            sender_nonce: number;
            original_sponsor_nonce: number;
            queued_at: string;
          }>(
            `SELECT id, wallet_index, payment_id, sender_nonce, original_sponsor_nonce, queued_at
             FROM replay_buffer
             WHERE sender_address = ?
             ORDER BY queued_at ASC
             LIMIT 100`,
            senderAddress
          )
          .toArray();

        const queued = queueRows
          .filter((r) => r.state === "queued")
          .map((r) => ({
            walletIndex: r.wallet_index,
            ...(r.payment_id && { paymentId: r.payment_id }),
            sponsorNonce: r.sponsor_nonce,
            senderNonce: r.sender_nonce,
            queuedAt: r.queued_at,
          }));

        const dispatched = queueRows
          .filter((r) => r.state === "dispatched")
          .map((r) => ({
            walletIndex: r.wallet_index,
            ...(r.payment_id && { paymentId: r.payment_id }),
            sponsorNonce: r.sponsor_nonce,
            senderNonce: r.sender_nonce,
            queuedAt: r.queued_at,
            dispatchedAt: r.dispatched_at,
          }));

        const replaying = queueRows
          .filter((r) => r.state === "replaying")
          .map((r) => ({
            walletIndex: r.wallet_index,
            ...(r.payment_id && { paymentId: r.payment_id }),
            sponsorNonce: r.sponsor_nonce,
            senderNonce: r.sender_nonce,
            queuedAt: r.queued_at,
          }));

        const held = heldRows.map((r) => ({
          ...(r.payment_id && { paymentId: r.payment_id }),
          senderNonce: r.sender_nonce,
          source: r.source,
          receivedAt: r.received_at,
          expiresAt: r.expires_at,
        }));

        const replayBuffer = replayRows.map((r) => ({
          id: r.id,
          walletIndex: r.wallet_index,
          ...(r.payment_id && { paymentId: r.payment_id }),
          originalSponsorNonce: r.original_sponsor_nonce,
          senderNonce: r.sender_nonce,
          queuedAt: r.queued_at,
        }));

        return this.jsonResponse({
          senderWedge,
          queued,
          dispatched,
          replaying,
          held,
          replayBuffer,
          total: queued.length + dispatched.length + replaying.length + held.length + replayBuffer.length,
        });
      } catch (error) {
        return this.internalError(error);
      }
    }

    const senderRepairMatch = url.pathname.match(/^\/sender-repair\/([^/]+)$/);
    if (request.method === "POST" && senderRepairMatch) {
      const senderAddress = decodeURIComponent(senderRepairMatch[1]);
      return this.state.blockConcurrencyWhile(async () => {
        try {
          const senderWedge = await this.repairSenderWedge(senderAddress);
          return this.jsonResponse(senderWedge);
        } catch (error) {
          return this.internalError(error);
        }
      });
    }

    // DELETE /queue-sender/:address/:walletIndex/:sponsorNonce — agent self-service cancellation.
    // Cancels a queued/dispatched/replaying tx or replay_buffer entry.
    // Address ownership is verified by the calling endpoint (SIP-018 auth).
    const cancelQueueMatch = url.pathname.match(/^\/queue-sender\/([^/]+)\/(\d+)\/(\d+)$/);
    if (request.method === "DELETE" && cancelQueueMatch) {
      const senderAddress = decodeURIComponent(cancelQueueMatch[1]);
      const walletIndex = parseInt(cancelQueueMatch[2], 10);
      const sponsorNonce = parseInt(cancelQueueMatch[3], 10);

      if (!Number.isInteger(walletIndex) || !Number.isInteger(sponsorNonce)) {
        return this.badRequest("Invalid walletIndex or sponsorNonce");
      }

      try {
        // Check dispatch_queue first
        const rows = this.sql
          .exec<{ state: string; sender_address: string }>(
            `SELECT state, sender_address FROM dispatch_queue
             WHERE wallet_index = ? AND sponsor_nonce = ?
             LIMIT 1`,
            walletIndex,
            sponsorNonce
          )
          .toArray();

        if (rows.length > 0) {
          const row = rows[0];

          // Verify address ownership
          if (row.sender_address !== senderAddress) {
            return this.jsonResponse({
              error: "Address mismatch: you do not own this queue entry",
              code: "QUEUE_ACCESS_DENIED",
            }, 403);
          }

          const previousState = row.state;

          if (previousState === "queued") {
            // Remove immediately from queue
            this.sql.exec(
              "DELETE FROM dispatch_queue WHERE wallet_index = ? AND sponsor_nonce = ?",
              walletIndex,
              sponsorNonce
            );
          } else if (previousState === "dispatched") {
            // Dispatched tx is in the mempool — flush the sponsor nonce slot with a
            // self-transfer so the slot clears, then delete the queue entry.
            // The flush cycle handles actual re-broadcasting; we just mark for cleanup.
            const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
            if (privateKey) {
              await this.broadcastRbfForNonce(walletIndex, sponsorNonce, privateKey, null);
            }
            this.sql.exec(
              "DELETE FROM dispatch_queue WHERE wallet_index = ? AND sponsor_nonce = ?",
              walletIndex,
              sponsorNonce
            );
          } else if (previousState === "replaying") {
            // Flush cycle already moved this to replay_buffer; remove from both
            // tables to prevent re-sponsoring a cancelled tx
            this.sql.exec(
              "DELETE FROM dispatch_queue WHERE wallet_index = ? AND sponsor_nonce = ?",
              walletIndex,
              sponsorNonce
            );
            this.sql.exec(
              "DELETE FROM replay_buffer WHERE wallet_index = ? AND original_sponsor_nonce = ?",
              walletIndex,
              sponsorNonce
            );
          }

          return this.jsonResponse({
            cancelled: true,
            previousState,
            walletIndex,
            sponsorNonce,
          });
        }

        // Not in dispatch_queue — check replay_buffer by original_sponsor_nonce
        const replayRows = this.sql
          .exec<{ id: number; sender_address: string }>(
            `SELECT id, sender_address FROM replay_buffer
             WHERE wallet_index = ? AND original_sponsor_nonce = ?
             LIMIT 1`,
            walletIndex,
            sponsorNonce
          )
          .toArray();

        if (replayRows.length > 0) {
          const replayRow = replayRows[0];
          if (replayRow.sender_address !== senderAddress) {
            return this.jsonResponse({
              error: "Address mismatch: you do not own this replay buffer entry",
              code: "QUEUE_ACCESS_DENIED",
            }, 403);
          }
          this.sql.exec("DELETE FROM replay_buffer WHERE id = ?", replayRow.id);
          return this.jsonResponse({
            cancelled: true,
            previousState: "replay_buffer",
            walletIndex,
            sponsorNonce,
          });
        }

        return this.jsonResponse({
          error: "Queue entry not found",
          code: "QUEUE_NOT_FOUND",
        }, 404);
      } catch (error) {
        return this.internalError(error);
      }
    }

    // POST /hand-submit — add a sender tx to the hand and check for a dispatchable run.
    // Returns HandSubmitResult: either dispatched (nonce assigned) or held (gap exists).
    //
    // Optional mode field:
    //   "hold" (default) — insert into hand even if held; agent can submit gaps later
    //   "immediate" — reject (return held) without inserting if a gap exists; used by /sponsor
    //     so that synchronous callers (MCP server, skills) get a 400 instead of a 202.
    if (request.method === "POST" && url.pathname === "/hand-submit") {
      const { value: body, errorResponse } = await this.parseJson<{
        senderAddress: string;
        senderNonce: number;
        txHex: string;
        mode?: "hold" | "immediate";
        paymentId?: string;
      }>(request);
      if (errorResponse) return errorResponse;
      if (!body?.senderAddress || typeof body.senderNonce !== "number" || !body.txHex) {
        return this.badRequest("Missing senderAddress, senderNonce, or txHex");
      }

      const mode = body.mode ?? "hold";

      return this.state.blockConcurrencyWhile(async () => {
        try {
          // 1. Seed sender state on first contact
          await this.seedSenderState(body.senderAddress, body.senderNonce);

          // 2. Reject stale sender nonces (already confirmed)
          const stateRow = this.getSenderState(body.senderAddress);
          if (stateRow && body.senderNonce < stateRow.next_expected_nonce) {
            return this.jsonResponse({
              error: "Stale sender nonce — already confirmed or superseded",
              code: "STALE_SENDER_NONCE",
              nextExpected: stateRow.next_expected_nonce,
            }, 400);
          }

          // 3. For immediate mode, check if the tx would be held BEFORE inserting.
          //    If it would be held, return the held result without touching sender_hand.
          //    This prevents rejected /sponsor txs from lingering in the hand queue.
          if (mode === "immediate") {
            const wouldDispatch = this.checkWouldDispatch(body.senderAddress, body.senderNonce);
            if (!wouldDispatch.dispatches) {
              return this.jsonResponse(wouldDispatch.heldResult);
            }
          }

          // 4. Add to hand (agent submission — INSERT OR REPLACE)
          this.addToHand(
            body.senderAddress,
            body.senderNonce,
            body.txHex,
            "agent",
            body.paymentId ?? null
          );

          // 5. Check for a gapless run and dispatch if found
          const result = await this.checkAndAssignRun(body.senderAddress);

          // 6. Attach recentlyExpired info when entries expired before this submission.
          //    Helps agents understand why previously-submitted nonces disappeared.
          const recentExpiry = this.getRecentExpirationsForSender(body.senderAddress);
          if (recentExpiry) {
            return this.jsonResponse({ ...result, recentlyExpired: recentExpiry });
          }
          return this.jsonResponse(result);
        } catch (error) {
          return this.internalError(error);
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
