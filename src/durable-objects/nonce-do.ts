import type { Env } from "../types";
import { getHiroBaseUrl, getHiroHeaders } from "../utils";

interface AssignNonceRequest {
  sponsorAddress: string;
}

interface AssignNonceResponse {
  nonce: number;
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
}

const ALARM_INTERVAL_MS = 5 * 60 * 1000;
/** Reset to possible_next_nonce if no assignment in this window and we are ahead */
const STALE_THRESHOLD_MS = 10 * 60 * 1000;
const SPONSOR_ADDRESS_KEY = "sponsor_address";
const STATE_KEYS = {
  current: "current",
  totalAssigned: "total_assigned",
  conflictsDetected: "conflicts_detected",
  lastAssignedNonce: "last_assigned_nonce",
  lastAssignedAt: "last_assigned_at",
  gapsRecovered: "gaps_recovered",
  lastHiroSync: "last_hiro_sync",
  lastGapDetected: "last_gap_detected",
} as const;

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

  private async scheduleAlarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private async getStoredSponsorAddress(): Promise<string | null> {
    const stored = await this.state.storage.get<string>(SPONSOR_ADDRESS_KEY);
    return typeof stored === "string" && stored.length > 0 ? stored : null;
  }

  private async setStoredSponsorAddress(address: string): Promise<void> {
    await this.state.storage.put(SPONSOR_ADDRESS_KEY, address);
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

  private async writeNonceCache(
    sponsorAddress: string,
    nonce: number
  ): Promise<void> {
    if (!this.env.RELAY_KV) {
      return;
    }

    await this.env.RELAY_KV.put(`nonce:${sponsorAddress}`, nonce.toString());
  }

  async assignNonce(sponsorAddress: string): Promise<number> {
    if (!sponsorAddress) {
      throw new Error("Missing sponsor address");
    }

    return this.state.blockConcurrencyWhile(async () => {
      await this.setStoredSponsorAddress(sponsorAddress);

      const currentAlarm = await this.state.storage.getAlarm();
      if (currentAlarm === null) {
        await this.scheduleAlarm();
      }

      let currentNonce = this.getStoredNonce();
      if (currentNonce === null) {
        const nonceInfo = await this.fetchNonceInfo(sponsorAddress);
        currentNonce = nonceInfo.possible_next_nonce;
      }

      const assignedNonce = currentNonce;
      this.setStoredNonce(assignedNonce + 1);
      this.updateAssignedStats(assignedNonce);

      this.state.waitUntil(this.writeNonceCache(sponsorAddress, assignedNonce));

      return assignedNonce;
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
    const lastHiroSyncMs = this.getStateValue(STATE_KEYS.lastHiroSync);
    const lastGapDetectedMs = this.getStateValue(STATE_KEYS.lastGapDetected);

    const txidRows = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM nonce_txids")
      .toArray();
    const txidCount = txidRows.length > 0 ? txidRows[0].count : 0;

    return {
      totalAssigned,
      conflictsDetected,
      lastAssignedNonce,
      lastAssignedAt: lastAssignedAtMs ? new Date(lastAssignedAtMs).toISOString() : null,
      nextNonce,
      txidCount,
      gapsRecovered,
      lastHiroSync: lastHiroSyncMs ? new Date(lastHiroSyncMs).toISOString() : null,
      lastGapDetected: lastGapDetectedMs ? new Date(lastGapDetectedMs).toISOString() : null,
    };
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      try {
        const sponsorAddress = await this.getStoredSponsorAddress();
        if (!sponsorAddress) {
          return;
        }

        let nonceInfo: HiroNonceInfo;
        try {
          nonceInfo = await this.fetchNonceInfo(sponsorAddress);
        } catch (_e) {
          // Hiro API unavailable; reschedule and try again next alarm cycle
          return;
        }

        // Record successful Hiro sync timestamp
        this.setStateValue(STATE_KEYS.lastHiroSync, Date.now());

        const currentNonce = this.getStoredNonce();
        if (currentNonce === null) {
          // No nonce seeded yet — initialize from Hiro
          this.setStoredNonce(nonceInfo.possible_next_nonce);
          return;
        }

        const { possible_next_nonce, detected_missing_nonces } = nonceInfo;

        if (detected_missing_nonces.length > 0) {
          // GAP RECOVERY: the network sees missing nonces in the mempool
          const sortedGaps = [...detected_missing_nonces].sort((a, b) => a - b);
          const lowestGap = sortedGaps[0];

          if (currentNonce > lowestGap) {
            // We have assigned nonces past a gap — reset to the lowest gap so the
            // next transaction fills it and the chain can make progress.
            const gapsRecovered = this.getStoredCount(STATE_KEYS.gapsRecovered) + 1;
            this.setStoredNonce(lowestGap);
            this.setStateValue(STATE_KEYS.gapsRecovered, gapsRecovered);
            this.setStateValue(STATE_KEYS.lastGapDetected, Date.now());
            // Count this as a conflict for visibility in existing metrics
            this.incrementConflictsDetected();
            return;
          }

          // Our nextNonce is at or below the lowest gap — but we may still be
          // behind the chain's possible_next_nonce.
          if (currentNonce < possible_next_nonce) {
            // FORWARD BUMP with gaps present: advance to possible_next_nonce so we
            // stop re-using nonces the chain has already processed.
            this.setStateValue(STATE_KEYS.lastGapDetected, Date.now());
            this.setStoredNonce(possible_next_nonce);
            this.incrementConflictsDetected();
          }
          return;
        }

        // NO GAPS: mempool is clean
        if (possible_next_nonce > currentNonce) {
          // FORWARD BUMP: chain has advanced past our counter (e.g., external tx submitted)
          this.setStoredNonce(possible_next_nonce);
          this.incrementConflictsDetected();
          return;
        }

        // STALE DETECTION: no assignment recently and we are ahead of the chain
        const lastAssignedAtMs = this.getStateValue(STATE_KEYS.lastAssignedAt);
        const idleMs = lastAssignedAtMs !== null
          ? Date.now() - lastAssignedAtMs
          : Infinity;

        if (idleMs > STALE_THRESHOLD_MS && currentNonce > possible_next_nonce) {
          // We advanced our counter but the chain never confirmed those nonces.
          // Reset to what the chain expects so we don't drift further.
          this.setStoredNonce(possible_next_nonce);
          this.incrementConflictsDetected();
        }
      } finally {
        await this.scheduleAlarm();
      }
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

      try {
        const nonce = await this.assignNonce(body.sponsorAddress);
        const response: AssignNonceResponse = { nonce };
        return this.jsonResponse(response);
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

    return new Response("Not found", { status: 404 });
  }
}
