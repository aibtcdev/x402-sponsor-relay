import {
  makeSTXTokenTransfer,
  broadcastTransaction,
} from "@stacks/transactions";
import { generateNewAccount, generateWallet } from "@stacks/wallet-sdk";
import type { Env } from "../types";
import { getHiroBaseUrl, getHiroHeaders } from "../utils";

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
 * Reservation pool state — persisted as a single JSON object per wallet.
 * available: nonces ready to be assigned (pre-seeded, sorted ascending)
 * reserved: nonces currently in-flight (assigned but not yet confirmed or released)
 * maxNonce: highest nonce ever placed in the pool (used to extend when available runs low)
 * reservedAt: unix ms timestamp of when each nonce was reserved (keyed by nonce as string)
 */
interface PoolState {
  available: number[];
  reserved: number[];
  maxNonce: number;
  reservedAt: Record<number, number>;
}

interface WalletPoolStats {
  walletIndex: number;
  available: number;
  reserved: number;
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
}

/**
 * Maximum number of in-flight nonces allowed concurrently per sponsor wallet.
 * The Stacks node hard-rejects at 25 (TooMuchChaining). We cap at 20 to leave
 * a buffer of 5 for concurrent in-flight requests and gap-fill transactions.
 */
const CHAINING_LIMIT = 20;
/** Initial pool pre-seeds this many nonces ahead of the current head */
const POOL_SEED_SIZE = CHAINING_LIMIT;

const ALARM_INTERVAL_MS = 5 * 60 * 1000;
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

export class NonceDO {
  private readonly sql: DurableObjectStorage["sql"];
  private readonly state: DurableObjectState;
  private readonly env: Env;

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
   * Release stale reservations for a wallet pool back to available.
   * A reservation is "stale" when:
   *   - It has been reserved longer than STALE_THRESHOLD_MS (10 minutes), AND
   *   - No txid has been recorded for it in nonce_txids (never broadcast).
   *
   * This recovers pool capacity lost to fire-and-forget releaseNonceDO failures.
   * Returns the number of nonces returned to available.
   */
  private cleanStaleReservations(pool: PoolState): number {
    const now = Date.now();
    const staleNonces = new Set<number>();

    for (const nonce of pool.reserved) {
      const reservedAt = pool.reservedAt[nonce];
      // No timestamp means we can't determine age -- conservatively skip
      if (reservedAt === undefined) continue;
      // Still within the grace window
      if (now - reservedAt < STALE_THRESHOLD_MS) continue;
      // Was broadcast -- consumed legitimately, do not reclaim
      if (this.hasTxidForNonce(nonce)) continue;

      staleNonces.add(nonce);
    }

    if (staleNonces.size === 0) {
      return 0;
    }

    // Filter out stale nonces from reserved and return them to available
    pool.reserved = pool.reserved.filter((n) => !staleNonces.has(n));
    for (const nonce of staleNonces) {
      delete pool.reservedAt[nonce];
      insertSorted(pool.available, nonce);
    }

    return staleNonces.size;
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
      console.warn(
        JSON.stringify({
          action: "gap_fill_rejected",
          walletIndex,
          nonce: gapNonce,
          reason: rejection.reason ?? "unknown",
          error: rejection.error ?? "",
        })
      );
      return null;
    } catch (e) {
      console.warn(
        JSON.stringify({
          action: "gap_fill_error",
          walletIndex,
          nonce: gapNonce,
          error: e instanceof Error ? e.message : String(e),
        })
      );
      return null;
    }
  }

  private async scheduleAlarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
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
   * Returns cumulative totals and today's stats.
   */
  async getWalletFeeStats(walletIndex: number): Promise<WalletFeeStats> {
    const totalFeesSpent = (await this.state.storage.get<string>(this.walletFeesKey(walletIndex))) ?? "0";
    const txCount = (await this.state.storage.get<number>(this.walletTxCountKey(walletIndex))) ?? 0;
    const todayKey = this.walletTxTodayKey(walletIndex);
    const today = (await this.state.storage.get<{ txCount: number; fees: string }>(todayKey)) ?? { txCount: 0, fees: "0" };

    return {
      totalFeesSpent,
      txCount,
      txCountToday: today.txCount,
      feesToday: today.fees,
    };
  }

  private async fetchNonceInfo(sponsorAddress: string): Promise<HiroNonceInfo> {
    const url = `${getHiroBaseUrl(this.env.STACKS_NETWORK)}/extended/v1/address/${sponsorAddress}/nonces`;
    const headers = getHiroHeaders(this.env.HIRO_API_KEY);
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
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
        console.log(
          JSON.stringify({
            action: "pool_address_changed",
            walletIndex,
            oldAddress: storedAddr,
            newAddress: sponsorAddress,
          })
        );
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
      maxNonce: seedNonce + POOL_SEED_SIZE - 1,
      reservedAt: {},
    };
    await this.savePoolForWallet(walletIndex, pool);
    return pool;
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
  ): Promise<{ nonce: number; walletIndex: number }> {
    if (!sponsorAddress) {
      throw new Error("Missing sponsor address");
    }

    return this.state.blockConcurrencyWhile(async () => {
      const currentAlarm = await this.state.storage.getAlarm();
      if (currentAlarm === null) {
        await this.scheduleAlarm();
      }

      const effectiveWalletCount = Math.max(1, Math.min(walletCount, MAX_WALLET_COUNT));

      // Round-robin: start from stored nextWalletIndex, find a wallet under chaining limit
      let walletIndex = (await this.getNextWalletIndex()) % effectiveWalletCount;
      let pool: PoolState | null = null;

      // Resolve the correct sponsor address for a given wallet index.
      // In multi-wallet mode, each wallet has its own Stacks address for nonce seeding.
      const resolveAddress = (wi: number): string =>
        addresses?.[String(wi)] ?? sponsorAddress;

      // Try each wallet in round-robin order; skip any at chaining limit
      let attempts = 0;
      let totalMempoolDepth = 0;
      while (attempts < effectiveWalletCount) {
        pool = await this.loadPoolOrInit(walletIndex, resolveAddress(walletIndex));
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
        throw new ChainingLimitError(totalMempoolDepth);
      }

      // Store the per-wallet sponsor address (used by alarm reconciliation)
      await this.setStoredSponsorAddressForWallet(walletIndex, resolveAddress(walletIndex));

      // Extend pool if available is exhausted
      if (pool.available.length === 0) {
        const nextNonce = pool.maxNonce + 1;
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

      // Advance round-robin to next wallet
      await this.setNextWalletIndex((walletIndex + 1) % effectiveWalletCount);

      return { nonce: assignedNonce, walletIndex };
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

      if (!txid) {
        // Unused nonce: return to available in sorted order
        insertSorted(pool.available, nonce);
      } else if (fee && fee !== "0") {
        // Broadcast succeeded and fee provided — record in wallet stats
        // (done outside blockConcurrencyWhile to avoid nested blocking, but we call it here
        //  as part of the same serialized operation)
        await this.recordWalletFee(walletIndex, fee);
      }
      // If txid is provided but no fee, the nonce is consumed — do not return to available

      await this.savePoolForWallet(walletIndex, pool);
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
    const wallets: WalletPoolStats[] = [];
    for (let wi = 0; wi < MAX_WALLET_COUNT; wi++) {
      const addr = await this.getStoredSponsorAddressForWallet(wi);
      if (!addr) break; // no more initialized wallets
      const pool = await this.loadPoolForWallet(wi);
      wallets.push({
        walletIndex: wi,
        available: pool?.available.length ?? 0,
        reserved: pool?.reserved.length ?? 0,
        maxNonce: pool?.maxNonce ?? 0,
        sponsorAddress: addr,
      });
    }

    // Wallet 0 backward-compat fields
    const wallet0 = wallets[0];

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
    };
  }

  /**
   * Core gap-aware nonce reconciliation against Hiro for a specific wallet.
   * Shared by alarm() (all wallets), performResync() (wallet 0), and performReset() (wallet 0).
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

        return {
          previousNonce,
          newNonce: lowestGap,
          changed: true,
          reason: `GAP RECOVERY: reset to lowest gap nonce ${lowestGap} (gaps: ${sortedGaps.join(",")})`,
        };
      }

      this.setStateValue(STATE_KEYS.lastGapDetected, Date.now());

      // Actively fill gaps: derive key and broadcast 1 uSTX transfers for each gap nonce.
      // Cap per-alarm fills to avoid exceeding Cloudflare alarm execution time limits.
      const privateKey = await this.derivePrivateKeyForWallet(walletIndex);
      const filled: number[] = [];
      const gapsToFill = sortedGaps.slice(0, MAX_GAP_FILLS_PER_ALARM);
      if (privateKey) {
        for (const gapNonce of gapsToFill) {
          const txid = await this.fillGapNonce(walletIndex, gapNonce, privateKey);
          if (txid) {
            console.log(
              JSON.stringify({
                action: "gap_filled",
                walletIndex,
                nonce: gapNonce,
                txid,
              })
            );
            this.incrementGapsFilled();
            filled.push(gapNonce);
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
      if (walletIndex === 0) {
        this.setStoredNonce(possible_next_nonce);
      }
      this.incrementConflictsDetected();

      if (poolHead !== null) {
        await this.resetPoolAvailableForWallet(walletIndex, poolHead, possible_next_nonce);
      }

      return {
        previousNonce: effectivePreviousNonce,
        newNonce: possible_next_nonce,
        changed: true,
        reason: `STALE DETECTION: idle ${Math.round(idleMs / 1000)}s, reset to chain nonce ${possible_next_nonce}`,
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
   * NEVER touches pool.reserved.
   */
  private async resetPoolAvailableForWallet(
    walletIndex: number,
    pool: PoolState,
    newHead: number
  ): Promise<void> {
    const availableSlots = Math.max(1, POOL_SEED_SIZE - pool.reserved.length);
    const newAvailable: number[] = [];
    for (let i = 0; i < availableSlots; i++) {
      newAvailable.push(newHead + i);
    }
    pool.available = newAvailable;
    pool.maxNonce = newHead + availableSlots - 1;
    await this.savePoolForWallet(walletIndex, pool);
  }

  /**
   * Gap-aware nonce reconciliation for wallet 0, returning a structured response.
   */
  private async performResync(sponsorAddress: string): Promise<{
    success: true;
    action: "resync";
    previousNonce: number | null;
    newNonce: number | null;
    changed: boolean;
    reason: string;
  }> {
    const result = await this.reconcileNonceForWallet(0, sponsorAddress);
    if (result === null) {
      throw new Error("Hiro API unavailable");
    }
    return { success: true, action: "resync", ...result };
  }

  /**
   * Perform a hard nonce reset for wallet 0 to the safe floor: last_executed_tx_nonce + 1.
   */
  private async performReset(sponsorAddress: string): Promise<{
    success: true;
    action: "reset";
    previousNonce: number | null;
    newNonce: number;
    changed: boolean;
  }> {
    let nonceInfo: HiroNonceInfo;
    try {
      nonceInfo = await this.fetchNonceInfo(sponsorAddress);
    } catch (_e) {
      throw new Error("Hiro API unavailable");
    }

    this.setStateValue(STATE_KEYS.lastHiroSync, Date.now());

    const currentNonce = this.getStoredNonce();
    const safeFloor = nonceInfo.last_executed_tx_nonce === null
      ? 0
      : nonceInfo.last_executed_tx_nonce + 1;

    const changed = currentNonce !== safeFloor;
    this.setStoredNonce(safeFloor);
    if (changed) {
      this.incrementConflictsDetected();
    }

    // Reset pool for wallet 0
    const pool = await this.loadPoolForWallet(0);
    if (pool !== null) {
      await this.resetPoolAvailableForWallet(0, pool, safeFloor);
    }

    return {
      success: true,
      action: "reset",
      previousNonce: currentNonce,
      newNonce: safeFloor,
      changed,
    };
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      try {
        // Reconcile all wallets that have been initialized (up to MAX_WALLET_COUNT)
        for (let wi = 0; wi < MAX_WALLET_COUNT; wi++) {
          const addr = await this.getStoredSponsorAddressForWallet(wi);
          if (!addr) break; // no more initialized wallets
          // reconcileNonceForWallet returns null when Hiro is unreachable — skip silently
          await this.reconcileNonceForWallet(wi, addr);

          // Clean stale reservations: release nonces reserved > 10 min ago with no broadcast
          const pool = await this.loadPoolForWallet(wi);
          if (pool !== null) {
            const released = this.cleanStaleReservations(pool);
            if (released > 0) {
              await this.savePoolForWallet(wi, pool);
              console.log(
                JSON.stringify({
                  action: "stale_reservations_cleaned",
                  walletIndex: wi,
                  released,
                })
              );
            }
          }
        }
      } finally {
        await this.scheduleAlarm();
      }
    });
  }

  /**
   * Shared handler for /resync and /reset RPC routes (operates on wallet 0).
   */
  private async handleRecoveryAction(action: "resync" | "reset"): Promise<Response> {
    try {
      const sponsorAddress = await this.getStoredSponsorAddressForWallet(0);
      if (!sponsorAddress) {
        return this.badRequest("No sponsor address stored; call /assign first");
      }
      const result = action === "reset"
        ? await this.state.blockConcurrencyWhile(() => this.performReset(sponsorAddress))
        : await this.state.blockConcurrencyWhile(() => this.performResync(sponsorAddress));
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
      let cleared = 0;
      for (let wi = 0; wi < MAX_WALLET_COUNT; wi++) {
        const addr = await this.getStoredSponsorAddressForWallet(wi);
        if (!addr) break;
        await this.state.storage.delete(this.poolKey(wi));
        await this.state.storage.delete(this.sponsorAddressKey(wi));
        cleared++;
      }
      // Reset round-robin index
      await this.state.storage.put("next_wallet_index", 0);
      console.log(
        JSON.stringify({
          action: "clear_pools",
          previousNonce: null,
          newNonce: null,
          changed: cleared > 0,
          reason:
            cleared > 0
              ? `Cleared ${cleared} wallet${cleared === 1 ? "" : "s"}`
              : "No wallets to clear",
        })
      );
      return this.jsonResponse({
        success: true,
        action: "clear_pools",
        previousNonce: null,
        newNonce: null,
        changed: cleared > 0,
        reason:
          cleared > 0
            ? `Cleared ${cleared} wallet${cleared === 1 ? "" : "s"}`
            : "No wallets to clear",
      });
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

    return new Response("Not found", { status: 404 });
  }
}
