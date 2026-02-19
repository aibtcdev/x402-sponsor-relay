import type { Env } from "../types";
import { getHiroBaseUrl, getHiroHeaders } from "../utils";

interface AssignNonceRequest {
  sponsorAddress: string;
}

interface AssignNonceResponse {
  nonce: number;
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

  private getStoredNonce(): number | null {
    const rows = this.sql
      .exec<{ value: number }>(
        "SELECT value FROM nonce_state WHERE key = ? LIMIT 1",
        "current"
      )
      .toArray();

    if (rows.length === 0) {
      return null;
    }

    return rows[0].value;
  }

  private setStoredNonce(value: number): void {
    this.sql.exec(
      "INSERT INTO nonce_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      "current",
      value
    );
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
      let currentNonce = this.getStoredNonce();
      if (currentNonce === null) {
        currentNonce = await this.fetchPossibleNextNonce(sponsorAddress);
      }

      const assignedNonce = currentNonce;
      this.setStoredNonce(assignedNonce + 1);

      this.state.waitUntil(this.writeNonceCache(sponsorAddress, assignedNonce));

      return assignedNonce;
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

    return new Response("Not found", { status: 404 });
  }

  // Future phases will add public RPC methods for txid tracking, stats reporting,
  // and reconciliation alarms.
}
