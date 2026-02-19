import type { Env } from "../types";

export class NonceDO {
  private readonly sql: DurableObjectStorage["sql"];

  constructor(ctx: DurableObjectState, _env: Env) {
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

  // Future phases will add public RPC methods for nonce assignment, txid tracking,
  // stats reporting, and reconciliation alarms.
}
