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

interface NonceStatsResponse {
  totalAssigned: number;
  conflictsDetected: number;
  lastAssignedNonce: number | null;
  lastAssignedAt: string | null;
  nextNonce: number | null;
  txidCount: number;
}

const ALARM_INTERVAL_MS = 5 * 60 * 1000;
const SPONSOR_ADDRESS_KEY = "sponsor_address";

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
    return this.getStateValue("current");
  }

  private setStoredNonce(value: number): void {
    this.setStateValue("current", value);
  }

  private getStoredCount(key: string): number {
    return this.getStateValue(key) ?? 0;
  }

  private updateAssignedStats(assignedNonce: number): void {
    const totalAssigned = this.getStoredCount("total_assigned") + 1;
    this.setStateValue("total_assigned", totalAssigned);
    this.setStateValue("last_assigned_nonce", assignedNonce);
    this.setStateValue("last_assigned_at", Date.now());
  }

  private incrementConflictsDetected(): void {
    const conflictsDetected = this.getStoredCount("conflicts_detected") + 1;
    this.setStateValue("conflicts_detected", conflictsDetected);
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

  private async fetchPossibleNextNonce(sponsorAddress: string): Promise<number> {
    const url = `${getHiroBaseUrl(this.env.STACKS_NETWORK)}/extended/v1/address/${sponsorAddress}/nonces`;
    const headers = getHiroHeaders(this.env.HIRO_API_KEY);
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Hiro nonce endpoint responded with ${response.status}`);
    }

    const data = (await response.json()) as { possible_next_nonce?: number };
    if (typeof data?.possible_next_nonce !== "number") {
      throw new Error("Hiro nonce response missing possible_next_nonce");
    }

    return data.possible_next_nonce;
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
        currentNonce = await this.fetchPossibleNextNonce(sponsorAddress);
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
    const totalAssigned = this.getStoredCount("total_assigned");
    const conflictsDetected = this.getStoredCount("conflicts_detected");
    const lastAssignedNonce = this.getStateValue("last_assigned_nonce");
    const lastAssignedAtMs = this.getStateValue("last_assigned_at");
    const nextNonce = this.getStoredNonce();

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
    };
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      try {
        const sponsorAddress = await this.getStoredSponsorAddress();
        if (!sponsorAddress) {
          return;
        }

        const possibleNextNonce = await this.fetchPossibleNextNonce(sponsorAddress);
        const currentNonce = this.getStoredNonce();

        if (currentNonce === null) {
          this.setStoredNonce(possibleNextNonce);
          return;
        }

        if (possibleNextNonce > currentNonce) {
          this.setStoredNonce(possibleNextNonce);
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
      let body: AssignNonceRequest | null = null;
      try {
        body = (await request.json()) as AssignNonceRequest;
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      if (!body?.sponsorAddress) {
        return new Response(JSON.stringify({ error: "Missing sponsorAddress" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      try {
        const nonce = await this.assignNonce(body.sponsorAddress);
        const response: AssignNonceResponse = { nonce };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    if (request.method === "POST" && url.pathname === "/record") {
      let body: RecordTxidRequest | null = null;
      try {
        body = (await request.json()) as RecordTxidRequest;
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      if (!body?.txid || typeof body.nonce !== "number") {
        return new Response(JSON.stringify({ error: "Missing txid or nonce" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      try {
        await this.recordTxid(body.txid, body.nonce);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    if (request.method === "POST" && url.pathname === "/lookup") {
      let body: LookupTxidRequest | null = null;
      try {
        body = (await request.json()) as LookupTxidRequest;
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      if (!body?.txid) {
        return new Response(JSON.stringify({ error: "Missing txid" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      try {
        const nonce = await this.getNonceForTxid(body.txid);
        const response: LookupTxidResponse =
          nonce === null ? { found: false } : { found: true, nonce };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      try {
        const stats = await this.getStats();
        return new Response(JSON.stringify(stats), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  // Future phases will add public RPC methods for txid tracking, stats reporting,
  // and reconciliation alarms.
}
