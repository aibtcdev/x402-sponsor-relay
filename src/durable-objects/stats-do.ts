import type {
  Env,
  TokenType,
  ErrorCategory,
  DailyStats,
  DashboardOverview,
  EndpointBreakdown,
  TransactionLogEntry,
  WalletThroughputEntry,
} from "../types";
import { calculateTrend } from "../services/stats";
import { TERMINAL_REASON_TO_CATEGORY } from "@aibtc/tx-schemas/core/terminal-reasons";

// ===========================================================================
// Time helpers
// ===========================================================================

function getDateKey(now: number = Date.now()): string {
  return new Date(now).toISOString().split("T")[0];
}

function getHourKey(now: number = Date.now()): string {
  const d = new Date(now);
  const date = d.toISOString().split("T")[0];
  const hour = d.getUTCHours().toString().padStart(2, "0");
  return `${date}:${hour}`;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ===========================================================================
// StatsDO — SQLite-backed atomic stats for the x402 sponsor relay
//
// Eliminates the 1 write/sec/key KV limit by using Durable Object SQLite
// with atomic upserts (INSERT ... ON CONFLICT DO UPDATE SET total = total + 1).
// No read-modify-write — every counter increment is a single SQL statement.
//
// Routes:
//   POST /record  — record a transaction (TransactionLogEntry shape)
//   POST /error   — record an error category
//   GET  /daily   — return daily stats array (?days=N)
//   GET  /hourly  — return 24h hourly data array
//   GET  /recent  — return recent tx_log entries (?days=N&limit=N&endpoint=X)
//   GET  /overview — return full DashboardOverview
//
// Singleton: env.STATS_DO.idFromName("global")
// ===========================================================================

export class StatsDO {
  private readonly sql: DurableObjectStorage["sql"];

  constructor(ctx: DurableObjectState, _env: Env) {
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    // Per-transaction detail log (rolling 7-day)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tx_log (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        success INTEGER NOT NULL,
        token TEXT NOT NULL,
        amount TEXT NOT NULL,
        fee TEXT,
        txid TEXT,
        sender TEXT,
        recipient TEXT,
        status TEXT,
        block_height INTEGER,
        error_code TEXT
      );
    `);

    // Index for time-range queries
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_tx_log_timestamp
        ON tx_log(timestamp DESC);
    `);

    // Index for endpoint filtering
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_tx_log_endpoint
        ON tx_log(endpoint, timestamp DESC);
    `);

    // Daily aggregate (atomic increment — no read-modify-write)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        total INTEGER DEFAULT 0,
        success INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        stx_count INTEGER DEFAULT 0,
        stx_volume TEXT DEFAULT '0',
        sbtc_count INTEGER DEFAULT 0,
        sbtc_volume TEXT DEFAULT '0',
        usdcx_count INTEGER DEFAULT 0,
        usdcx_volume TEXT DEFAULT '0',
        fee_total TEXT DEFAULT '0',
        fee_count INTEGER DEFAULT 0,
        fee_min TEXT,
        fee_max TEXT,
        err_validation INTEGER DEFAULT 0,
        err_rate_limit INTEGER DEFAULT 0,
        err_sponsoring INTEGER DEFAULT 0,
        err_settlement INTEGER DEFAULT 0,
        err_internal INTEGER DEFAULT 0
      );
    `);

    // Hourly aggregate (rolling 48h)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hourly_stats (
        hour TEXT PRIMARY KEY,
        total INTEGER DEFAULT 0,
        success INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        stx_count INTEGER DEFAULT 0,
        sbtc_count INTEGER DEFAULT 0,
        usdcx_count INTEGER DEFAULT 0,
        fee_total TEXT DEFAULT '0'
      );
    `);

    // Per-wallet hourly aggregate (rolling 48h) — tracks throughput per sponsor wallet
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS wallet_hourly (
        wallet_index INTEGER NOT NULL,
        hour TEXT NOT NULL,
        total INTEGER DEFAULT 0,
        success INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        fee_total TEXT DEFAULT '0',
        PRIMARY KEY(wallet_index, hour)
      );
    `);

    // Schema migrations — ALTER TABLE ADD COLUMN is idempotent (catch ignores
    // "duplicate column name" errors on repeated DO restarts).
    const migrations: Array<[table: string, column: string]> = [
      ["tx_log", "client_error INTEGER DEFAULT 0"],
      ["daily_stats", "client_errors INTEGER DEFAULT 0"],
      ["daily_stats", "relay_total INTEGER DEFAULT 0"],
      ["daily_stats", "relay_success INTEGER DEFAULT 0"],
      ["daily_stats", "relay_failed INTEGER DEFAULT 0"],
      ["daily_stats", "sponsor_total INTEGER DEFAULT 0"],
      ["daily_stats", "sponsor_success INTEGER DEFAULT 0"],
      ["daily_stats", "sponsor_failed INTEGER DEFAULT 0"],
      ["daily_stats", "settle_total INTEGER DEFAULT 0"],
      ["daily_stats", "settle_success INTEGER DEFAULT 0"],
      ["daily_stats", "settle_failed INTEGER DEFAULT 0"],
      ["daily_stats", "settle_client_errors INTEGER DEFAULT 0"],
      ["daily_stats", "verify_total INTEGER DEFAULT 0"],
      ["hourly_stats", "client_errors INTEGER DEFAULT 0"],
      ["hourly_stats", "fee_min TEXT"],
      ["hourly_stats", "fee_max TEXT"],
      // Terminal reason category columns (tx-schemas v0.4.0 alignment)
      // Named with _schema suffix to avoid collision with legacy err_validation / err_settlement columns.
      ["tx_log", "terminal_reason TEXT"],
      ["daily_stats", "err_schema_validation INTEGER DEFAULT 0"],
      ["daily_stats", "err_sender INTEGER DEFAULT 0"],
      ["daily_stats", "err_relay INTEGER DEFAULT 0"],
      ["daily_stats", "err_settlement_schema INTEGER DEFAULT 0"],
      ["daily_stats", "err_replacement INTEGER DEFAULT 0"],
      ["daily_stats", "err_identity INTEGER DEFAULT 0"],
    ];
    for (const [table, columnDef] of migrations) {
      try {
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes("duplicate column")) {
          throw e;
        }
      }
    }
  }

  // ===========================================================================
  // JSON helpers
  // ===========================================================================

  private jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private badRequest(message: string): Response {
    return this.jsonResponse({ error: message }, 400);
  }

  private internalError(error: unknown): Response {
    const message = error instanceof Error ? error.message : "Unknown error";
    return this.jsonResponse({ error: message }, 500);
  }

  // ===========================================================================
  // Write operations — atomic upserts only, no read-modify-write
  // ===========================================================================

  private recordTx(entry: TransactionLogEntry): void {
    const now = Date.now();
    const today = getDateKey(now);
    const hourKey = getHourKey(now);

    const successInt = entry.success ? 1 : 0;
    const failedInt = entry.success ? 0 : 1;
    const clientErrorInt = entry.clientError ? 1 : 0;
    const token = entry.tokenType as string;
    const amount = entry.amount || "0";
    const fee = entry.fee || null;

    // Insert into tx_log (includes client_error and terminal_reason columns)
    const id = crypto.randomUUID();
    const timestamp = new Date(entry.timestamp).getTime() || now;
    const terminalReason = entry.terminalReason || null;
    this.sql.exec(
      `INSERT OR IGNORE INTO tx_log
         (id, endpoint, timestamp, success, token, amount, fee, txid, sender, recipient, status, block_height, client_error, terminal_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.endpoint,
      timestamp,
      successInt,
      token,
      amount,
      fee,
      entry.txid || null,
      entry.sender || null,
      entry.recipient || null,
      entry.status || null,
      entry.blockHeight || null,
      clientErrorInt,
      terminalReason
    );

    // Prune tx_log older than 7 days
    const cutoff = now - 7 * DAY_MS;
    this.sql.exec("DELETE FROM tx_log WHERE timestamp < ?", cutoff);

    // Determine token column increments
    const stxInt = token === "STX" ? 1 : 0;
    const sbtcInt = token === "sBTC" ? 1 : 0;
    const usdcxInt = token === "USDCx" ? 1 : 0;

    // Atomic daily upsert — core counts + client errors
    this.sql.exec(
      `INSERT INTO daily_stats (date, total, success, failed, stx_count, sbtc_count, usdcx_count, client_errors)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         total = total + 1,
         success = success + excluded.success,
         failed = failed + excluded.failed,
         stx_count = stx_count + excluded.stx_count,
         sbtc_count = sbtc_count + excluded.sbtc_count,
         usdcx_count = usdcx_count + excluded.usdcx_count,
         client_errors = client_errors + excluded.client_errors`,
      today,
      successInt,
      failedInt,
      stxInt,
      sbtcInt,
      usdcxInt,
      clientErrorInt
    );

    // Atomic daily upsert — per-endpoint counters
    // Each endpoint has its own total/success/failed columns (verify only has total)
    const ep = entry.endpoint;
    if (ep === "relay") {
      this.sql.exec(
        `UPDATE daily_stats SET
           relay_total = relay_total + 1,
           relay_success = relay_success + ?,
           relay_failed = relay_failed + ?
         WHERE date = ?`,
        successInt, failedInt, today
      );
    } else if (ep === "sponsor") {
      this.sql.exec(
        `UPDATE daily_stats SET
           sponsor_total = sponsor_total + 1,
           sponsor_success = sponsor_success + ?,
           sponsor_failed = sponsor_failed + ?
         WHERE date = ?`,
        successInt, failedInt, today
      );
    } else if (ep === "settle") {
      this.sql.exec(
        `UPDATE daily_stats SET
           settle_total = settle_total + 1,
           settle_success = settle_success + ?,
           settle_failed = settle_failed + ?,
           settle_client_errors = settle_client_errors + ?
         WHERE date = ?`,
        successInt, failedInt, clientErrorInt, today
      );
    } else if (ep === "verify") {
      this.sql.exec(
        `UPDATE daily_stats SET verify_total = verify_total + 1 WHERE date = ?`,
        today
      );
    }

    // Atomic daily upsert — terminal reason category increment (tx-schemas alignment)
    // Only applies to failed transactions with a known terminal reason.
    if (!entry.success && terminalReason) {
      const category = TERMINAL_REASON_TO_CATEGORY[terminalReason as keyof typeof TERMINAL_REASON_TO_CATEGORY];
      const categoryColMap: Record<string, string> = {
        validation: "err_schema_validation",
        sender: "err_sender",
        relay: "err_relay",
        settlement: "err_settlement_schema",
        replacement: "err_replacement",
        identity: "err_identity",
      };
      const categoryCol = category ? categoryColMap[category] : null;
      if (categoryCol) {
        this.sql.exec(
          `INSERT INTO daily_stats (date, ${categoryCol})
           VALUES (?, 1)
           ON CONFLICT(date) DO UPDATE SET
             ${categoryCol} = ${categoryCol} + 1`,
          today
        );
      }
    }

    // Atomic daily upsert — volumes (must be separate to use BigInt arithmetic safely)
    if (stxInt) {
      this.sql.exec(
        `UPDATE daily_stats SET stx_volume = CAST(CAST(stx_volume AS INTEGER) + ? AS TEXT) WHERE date = ?`,
        amount,
        today
      );
    } else if (sbtcInt) {
      this.sql.exec(
        `UPDATE daily_stats SET sbtc_volume = CAST(CAST(sbtc_volume AS INTEGER) + ? AS TEXT) WHERE date = ?`,
        amount,
        today
      );
    } else if (usdcxInt) {
      this.sql.exec(
        `UPDATE daily_stats SET usdcx_volume = CAST(CAST(usdcx_volume AS INTEGER) + ? AS TEXT) WHERE date = ?`,
        amount,
        today
      );
    }

    // Atomic daily upsert — fee stats (only for successful transactions with fee data)
    if (entry.success && fee) {
      this.sql.exec(
        `UPDATE daily_stats SET
           fee_total = CAST(CAST(fee_total AS INTEGER) + ? AS TEXT),
           fee_count = fee_count + 1,
           fee_min = CASE
             WHEN fee_min IS NULL THEN ?
             WHEN CAST(? AS INTEGER) < CAST(fee_min AS INTEGER) THEN ?
             ELSE fee_min
           END,
           fee_max = CASE
             WHEN fee_max IS NULL THEN ?
             WHEN CAST(? AS INTEGER) > CAST(fee_max AS INTEGER) THEN ?
             ELSE fee_max
           END
         WHERE date = ?`,
        fee,
        fee, fee, fee,
        fee, fee, fee,
        today
      );
    }

    // Atomic hourly upsert — core counts + client errors
    this.sql.exec(
      `INSERT INTO hourly_stats (hour, total, success, failed, stx_count, sbtc_count, usdcx_count, client_errors)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hour) DO UPDATE SET
         total = total + 1,
         success = success + excluded.success,
         failed = failed + excluded.failed,
         stx_count = stx_count + excluded.stx_count,
         sbtc_count = sbtc_count + excluded.sbtc_count,
         usdcx_count = usdcx_count + excluded.usdcx_count,
         client_errors = client_errors + excluded.client_errors`,
      hourKey,
      successInt,
      failedInt,
      stxInt,
      sbtcInt,
      usdcxInt,
      clientErrorInt
    );

    // Hourly fee total + min/max (only for successful transactions with fee data)
    if (entry.success && fee) {
      this.sql.exec(
        `UPDATE hourly_stats SET fee_total = CAST(CAST(fee_total AS INTEGER) + ? AS TEXT) WHERE hour = ?`,
        fee,
        hourKey
      );
      this.sql.exec(
        `UPDATE hourly_stats SET
           fee_min = CASE
             WHEN fee_min IS NULL THEN ?
             WHEN CAST(? AS INTEGER) < CAST(fee_min AS INTEGER) THEN ?
             ELSE fee_min
           END,
           fee_max = CASE
             WHEN fee_max IS NULL THEN ?
             WHEN CAST(? AS INTEGER) > CAST(fee_max AS INTEGER) THEN ?
             ELSE fee_max
           END
         WHERE hour = ?`,
        fee, fee, fee,
        fee, fee, fee,
        hourKey
      );
    }

    // Prune hourly_stats older than 48h
    const hourCutoff = new Date(now - 48 * HOUR_MS);
    const hourCutoffStr = `${hourCutoff.toISOString().split("T")[0]}:${hourCutoff.getUTCHours().toString().padStart(2, "0")}`;
    this.sql.exec("DELETE FROM hourly_stats WHERE hour < ?", hourCutoffStr);

    // Atomic per-wallet hourly upsert (only when walletIndex is provided)
    if (entry.walletIndex !== undefined) {
      const walletFee = fee || "0";
      this.sql.exec(
        `INSERT INTO wallet_hourly (wallet_index, hour, total, success, failed, fee_total)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(wallet_index, hour) DO UPDATE SET
           total = total + 1,
           success = success + excluded.success,
           failed = failed + excluded.failed,
           fee_total = CAST(CAST(fee_total AS INTEGER) + CAST(excluded.fee_total AS INTEGER) AS TEXT)`,
        entry.walletIndex,
        hourKey,
        successInt,
        failedInt,
        walletFee
      );
      // Prune wallet_hourly older than 48h (same cutoff as hourly_stats)
      this.sql.exec("DELETE FROM wallet_hourly WHERE hour < ?", hourCutoffStr);
    }
  }

  private recordErrorCategory(category: ErrorCategory): void {
    const today = getDateKey();
    const colMap: Record<ErrorCategory, string> = {
      validation: "err_validation",
      rateLimit: "err_rate_limit",
      sponsoring: "err_sponsoring",
      settlement: "err_settlement",
      internal: "err_internal",
    };
    const col = colMap[category];
    if (!col) return;

    // Only update the specific error column here.
    // Transaction totals (total/failed) are maintained via /record
    // to avoid double-counting when both /record and /error are used.
    this.sql.exec(
      `INSERT INTO daily_stats (date, ${col})
       VALUES (?, 1)
       ON CONFLICT(date) DO UPDATE SET
         ${col} = ${col} + 1`,
      today
    );
  }

  // ===========================================================================
  // Read operations
  // ===========================================================================

  private readDailyStats(days: number): DailyStats[] {
    const now = Date.now();

    // Generate the ordered list of date keys we need
    const dateKeys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      dateKeys.push(getDateKey(now - i * DAY_MS));
    }

    const startDate = dateKeys[0];

    // Single range query instead of N individual queries
    type DailyRow = {
      date: string;
      total: number;
      success: number;
      failed: number;
      client_errors: number;
      stx_count: number;
      stx_volume: string;
      sbtc_count: number;
      sbtc_volume: string;
      usdcx_count: number;
      usdcx_volume: string;
      fee_total: string;
      fee_count: number;
      fee_min: string | null;
      fee_max: string | null;
      err_validation: number;
      err_rate_limit: number;
      err_sponsoring: number;
      err_settlement: number;
      err_internal: number;
      err_schema_validation: number;
      err_sender: number;
      err_relay: number;
      err_settlement_schema: number;
      err_replacement: number;
      err_identity: number;
    };

    const rows = this.sql
      .exec<DailyRow>(
        `SELECT date, total, success, failed, client_errors,
                stx_count, stx_volume,
                sbtc_count, sbtc_volume,
                usdcx_count, usdcx_volume,
                fee_total, fee_count, fee_min, fee_max,
                err_validation, err_rate_limit, err_sponsoring, err_settlement, err_internal,
                err_schema_validation, err_sender, err_relay, err_settlement_schema, err_replacement, err_identity
         FROM daily_stats WHERE date >= ? ORDER BY date ASC`,
        startDate
      )
      .toArray();

    // Index results by date for O(1) lookup
    const rowMap = new Map<string, DailyRow>();
    for (const r of rows) {
      rowMap.set(r.date, r);
    }

    const zeroDailyStats = (date: string): DailyStats => ({
      date,
      transactions: { total: 0, success: 0, failed: 0, clientErrors: 0 },
      tokens: {
        STX: { count: 0, volume: "0" },
        sBTC: { count: 0, volume: "0" },
        USDCx: { count: 0, volume: "0" },
      },
      errors: {
        validation: 0,
        rateLimit: 0,
        sponsoring: 0,
        settlement: 0,
        internal: 0,
      },
      terminalReasons: {
        validation: 0,
        sender: 0,
        relay: 0,
        settlement: 0,
        replacement: 0,
        identity: 0,
      },
    });

    // Build result array, filling missing dates with zeros
    const result: DailyStats[] = [];
    for (const date of dateKeys) {
      const r = rowMap.get(date);
      if (!r) {
        result.push(zeroDailyStats(date));
        continue;
      }

      const ds: DailyStats = {
        date,
        transactions: {
          total: r.total,
          success: r.success,
          failed: r.failed,
          clientErrors: r.client_errors ?? 0,
        },
        tokens: {
          STX: { count: r.stx_count, volume: r.stx_volume || "0" },
          sBTC: { count: r.sbtc_count, volume: r.sbtc_volume || "0" },
          USDCx: { count: r.usdcx_count, volume: r.usdcx_volume || "0" },
        },
        errors: {
          validation: r.err_validation,
          rateLimit: r.err_rate_limit,
          sponsoring: r.err_sponsoring,
          settlement: r.err_settlement,
          internal: r.err_internal,
        },
        terminalReasons: {
          validation: r.err_schema_validation ?? 0,
          sender: r.err_sender ?? 0,
          relay: r.err_relay ?? 0,
          settlement: r.err_settlement_schema ?? 0,
          replacement: r.err_replacement ?? 0,
          identity: r.err_identity ?? 0,
        },
      };
      if (r.fee_count > 0) {
        ds.fees = {
          total: r.fee_total || "0",
          count: r.fee_count,
          min: r.fee_min || "0",
          max: r.fee_max || "0",
        };
      }
      result.push(ds);
    }

    return result;
  }

  private readHourlyData(): Array<{ hour: string; transactions: number; success: number; fees?: string; feeMin?: string; feeMax?: string; clientErrors?: number }> {
    const now = Date.now();

    // Generate the 24 hour keys and their display labels
    const hourEntries: Array<{ key: string; label: string }> = [];
    for (let i = 23; i >= 0; i--) {
      const ts = now - i * HOUR_MS;
      const d = new Date(ts);
      hourEntries.push({
        key: getHourKey(ts),
        label: d.getUTCHours().toString().padStart(2, "0") + ":00",
      });
    }

    const startKey = hourEntries[0].key;
    const endKey = hourEntries[hourEntries.length - 1].key;

    // Single range query instead of 24 individual queries
    type HourlyRow = { hour: string; total: number; success: number; fee_total: string; fee_min: string | null; fee_max: string | null; client_errors: number };
    const rows = this.sql
      .exec<HourlyRow>(
        `SELECT hour, total, success, fee_total, fee_min, fee_max, client_errors
         FROM hourly_stats
         WHERE hour >= ? AND hour <= ?
         ORDER BY hour ASC`,
        startKey,
        endKey
      )
      .toArray();

    // Index results by hour key for O(1) lookup
    const rowMap = new Map<string, HourlyRow>();
    for (const r of rows) {
      rowMap.set(r.hour, r);
    }

    // Build result array, filling missing hours with zeros
    const result: Array<{ hour: string; transactions: number; success: number; fees?: string; feeMin?: string; feeMax?: string; clientErrors?: number }> = [];
    for (const { key, label } of hourEntries) {
      const r = rowMap.get(key);
      if (!r) {
        result.push({ hour: label, transactions: 0, success: 0 });
        continue;
      }

      const entry: { hour: string; transactions: number; success: number; fees?: string; feeMin?: string; feeMax?: string; clientErrors?: number } = {
        hour: label,
        transactions: r.total,
        success: r.success,
      };
      if (r.fee_total && r.fee_total !== "0") {
        entry.fees = r.fee_total;
      }
      if (r.fee_min) {
        entry.feeMin = r.fee_min;
      }
      if (r.fee_max) {
        entry.feeMax = r.fee_max;
      }
      if (r.client_errors > 0) {
        entry.clientErrors = r.client_errors;
      }
      result.push(entry);
    }

    return result;
  }

  private readWalletHourlyStats(
    walletIndex: number,
    hours: number
  ): Array<{ hour: string; total: number; success: number; failed: number; feeTotal: string }> {
    const now = Date.now();

    // Generate the hour keys and their display labels
    const hourEntries: Array<{ key: string; label: string }> = [];
    for (let i = hours - 1; i >= 0; i--) {
      const ts = now - i * HOUR_MS;
      const d = new Date(ts);
      hourEntries.push({
        key: getHourKey(ts),
        label: d.getUTCHours().toString().padStart(2, "0") + ":00",
      });
    }

    const startKey = hourEntries[0].key;
    const endKey = hourEntries[hourEntries.length - 1].key;

    // Single range query instead of N individual queries per wallet
    type WalletHourlyRow = { hour: string; total: number; success: number; failed: number; fee_total: string };
    const rows = this.sql
      .exec<WalletHourlyRow>(
        `SELECT hour, total, success, failed, fee_total
         FROM wallet_hourly
         WHERE wallet_index = ? AND hour >= ? AND hour <= ?
         ORDER BY hour ASC`,
        walletIndex,
        startKey,
        endKey
      )
      .toArray();

    // Index results by hour key for O(1) lookup
    const rowMap = new Map<string, WalletHourlyRow>();
    for (const r of rows) {
      rowMap.set(r.hour, r);
    }

    // Build result array, filling missing hours with zeros
    const result: Array<{ hour: string; total: number; success: number; failed: number; feeTotal: string }> = [];
    for (const { key, label } of hourEntries) {
      const r = rowMap.get(key);
      if (!r) {
        result.push({ hour: label, total: 0, success: 0, failed: 0, feeTotal: "0" });
      } else {
        result.push({
          hour: label,
          total: r.total,
          success: r.success,
          failed: r.failed,
          feeTotal: r.fee_total || "0",
        });
      }
    }

    return result;
  }

  private readRecentTxLog(opts: {
    days?: number;
    limit?: number;
    endpoint?: string;
  }): TransactionLogEntry[] {
    const days = Math.min(Math.max(opts.days ?? 1, 1), 7);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const cutoff = Date.now() - days * DAY_MS;

    const rows = this.sql
      .exec<{
        endpoint: string;
        timestamp: number;
        success: number;
        token: string;
        amount: string;
        fee: string | null;
        txid: string | null;
        sender: string | null;
        recipient: string | null;
        status: string | null;
        block_height: number | null;
      }>(
        opts.endpoint
          ? `SELECT endpoint, timestamp, success, token, amount, fee, txid, sender, recipient, status, block_height
             FROM tx_log
             WHERE timestamp >= ? AND endpoint = ?
             ORDER BY timestamp DESC LIMIT ?`
          : `SELECT endpoint, timestamp, success, token, amount, fee, txid, sender, recipient, status, block_height
             FROM tx_log
             WHERE timestamp >= ?
             ORDER BY timestamp DESC LIMIT ?`,
        ...(opts.endpoint ? [cutoff, opts.endpoint, limit] : [cutoff, limit])
      )
      .toArray();

    return rows.map((r) => {
      const entry: TransactionLogEntry = {
        timestamp: new Date(r.timestamp).toISOString(),
        endpoint: r.endpoint as TransactionLogEntry["endpoint"],
        success: r.success === 1,
        tokenType: r.token as TokenType,
        amount: r.amount,
      };
      if (r.fee != null) entry.fee = r.fee;
      if (r.txid != null) entry.txid = r.txid;
      if (r.sender != null) entry.sender = r.sender;
      if (r.recipient != null) entry.recipient = r.recipient;
      if (r.status != null) entry.status = r.status as TransactionLogEntry["status"];
      if (r.block_height != null) entry.blockHeight = r.block_height;
      return entry;
    });
  }

  /**
   * Compute rolling totals for the previous 24h window (24-48h ago).
   * Used for rolling-vs-rolling trend comparison instead of calendar day.
   *
   * Single aggregate query instead of 24 individual queries.
   */
  private readPrevious24hTotals(): { total: number; success: number; clientErrors: number } {
    const now = Date.now();
    const startKey = getHourKey(now - 47 * HOUR_MS);
    const endKey = getHourKey(now - 24 * HOUR_MS);

    const rows = this.sql
      .exec<{ total: number; success: number; client_errors: number }>(
        `SELECT COALESCE(SUM(total), 0) as total,
                COALESCE(SUM(success), 0) as success,
                COALESCE(SUM(client_errors), 0) as client_errors
         FROM hourly_stats
         WHERE hour >= ? AND hour <= ?`,
        startKey,
        endKey
      )
      .toArray();

    if (rows.length === 0) {
      return { total: 0, success: 0, clientErrors: 0 };
    }

    const r = rows[0];
    return {
      total: r.total,
      success: r.success,
      clientErrors: r.client_errors ?? 0,
    };
  }

  /**
   * Build per-wallet 24h throughput entries from wallet_hourly data.
   * Only includes wallets with at least one transaction in the last 24h.
   *
   * Uses a single query to fetch all wallet+hour rows in the 24h window,
   * then groups by wallet and fills missing hours in code.
   */
  private readWalletThroughput(): WalletThroughputEntry[] {
    const now = Date.now();

    // Generate the 24 hour keys and labels (same logic as readWalletHourlyStats)
    const hourEntries: Array<{ key: string; label: string }> = [];
    for (let i = 23; i >= 0; i--) {
      const ts = now - i * HOUR_MS;
      const d = new Date(ts);
      hourEntries.push({
        key: getHourKey(ts),
        label: d.getUTCHours().toString().padStart(2, "0") + ":00",
      });
    }

    const startKey = hourEntries[0].key;
    const endKey = hourEntries[hourEntries.length - 1].key;

    // Single query for ALL wallets across the 24h window
    type BulkRow = { wallet_index: number; hour: string; total: number; success: number; failed: number; fee_total: string };
    const rows = this.sql
      .exec<BulkRow>(
        `SELECT wallet_index, hour, total, success, failed, fee_total
         FROM wallet_hourly
         WHERE hour >= ? AND hour <= ?
         ORDER BY wallet_index ASC, hour ASC`,
        startKey,
        endKey
      )
      .toArray();

    // Group rows by wallet_index
    const walletMap = new Map<number, Map<string, BulkRow>>();
    for (const r of rows) {
      let hourMap = walletMap.get(r.wallet_index);
      if (!hourMap) {
        hourMap = new Map();
        walletMap.set(r.wallet_index, hourMap);
      }
      hourMap.set(r.hour, r);
    }

    // Build result for each wallet, filling missing hours with zeros
    const result: WalletThroughputEntry[] = [];
    for (const [walletIndex, hourMap] of walletMap) {
      const hourly: Array<{ hour: string; total: number; success: number; failed: number; feeTotal: string }> = [];
      let total24h = 0;
      let success24h = 0;
      let failed24h = 0;
      let feeTotal24h = 0n;

      for (const { key, label } of hourEntries) {
        const r = hourMap.get(key);
        if (!r) {
          hourly.push({ hour: label, total: 0, success: 0, failed: 0, feeTotal: "0" });
        } else {
          const feeStr = r.fee_total || "0";
          hourly.push({
            hour: label,
            total: r.total,
            success: r.success,
            failed: r.failed,
            feeTotal: feeStr,
          });
          total24h += r.total;
          success24h += r.success;
          failed24h += r.failed;
          feeTotal24h += BigInt(feeStr);
        }
      }

      result.push({ walletIndex, total24h, success24h, failed24h, feeTotal24h: feeTotal24h.toString(), hourly });
    }

    return result;
  }

  private buildOverview(): DashboardOverview {
    // readDailyStats(1) returns [today] — used for calendar-day token and fee breakdown.
    const todayArr = this.readDailyStats(1);
    const current = todayArr[0];

    // Token percentages (from today's daily_stats — calendar-day token breakdown)
    const totalTokenTx =
      current.tokens.STX.count +
      current.tokens.sBTC.count +
      current.tokens.USDCx.count;
    const pct = (count: number) =>
      totalTokenTx > 0 ? Math.round((count / totalTokenTx) * 100) : 0;

    // Fee aggregates (from today's daily_stats)
    const currentFees = current.fees ?? { total: "0", count: 0, min: "0", max: "0" };

    const avgFee =
      currentFees.count > 0
        ? (BigInt(currentFees.total) / BigInt(currentFees.count)).toString()
        : "0";

    // Hourly data covers the rolling 24h window (crossing midnight).
    // Sum it to produce headline totals that match the hourly chart exactly.
    // Also sum fees from hourly data so the fee total is accurate at UTC day boundaries
    // (when daily_stats has reset but the rolling window still has fee data from yesterday).
    const hourlyData = this.readHourlyData();
    const rolling = hourlyData.reduce(
      (acc, h) => {
        const hasHourFee = h.fees && h.fees !== "0";
        // Rolling fee min: track the lowest fee_min across all hours in the window
        let newFeeMin = acc.feeMin;
        if (h.feeMin) {
          if (newFeeMin === null) {
            newFeeMin = h.feeMin;
          } else if (BigInt(h.feeMin) < BigInt(newFeeMin)) {
            newFeeMin = h.feeMin;
          }
        }
        // Rolling fee max: track the highest fee_max across all hours in the window
        let newFeeMax = acc.feeMax;
        if (h.feeMax) {
          if (newFeeMax === null) {
            newFeeMax = h.feeMax;
          } else if (BigInt(h.feeMax) > BigInt(newFeeMax)) {
            newFeeMax = h.feeMax;
          }
        }
        return {
          total: acc.total + h.transactions,
          success: acc.success + h.success,
          clientErrors: acc.clientErrors + (h.clientErrors ?? 0),
          fees: acc.fees + BigInt(h.fees || "0"),
          feeCount: hasHourFee ? acc.feeCount + 1 : acc.feeCount,
          feeMin: newFeeMin,
          feeMax: newFeeMax,
        };
      },
      { total: 0, success: 0, clientErrors: 0, fees: 0n, feeCount: 0, feeMin: null as string | null, feeMax: null as string | null }
    );
    const rollingFailed = rolling.total - rolling.success;

    // Use the rolling hourly fee sum as the headline total when available.
    // Fall back to today's calendar-day fee total for backward compatibility
    // (e.g., when hourly data is absent on a fresh deployment).
    const rollingFeeTotal = rolling.fees > 0n ? rolling.fees.toString() : currentFees.total;
    const rollingFeeAvg =
      rolling.feeCount > 0
        ? (rolling.fees / BigInt(rolling.feeCount)).toString()
        : avgFee;

    // Rolling previous 24h (24-48h ago) for rolling-vs-rolling comparison (Bug #7 fix).
    const prev24h = this.readPrevious24hTotals();

    // TODO: implement previous-window fee comparison
    const feeTrend: "up" | "down" | "stable" = rolling.fees > 0n ? "up" : "stable";

    // Per-endpoint breakdown from today's daily_stats
    const endpointBreakdown = this.readEndpointBreakdown(current.date);

    // Dual success rates (Bug #4)
    // rawSuccessRate: success / total (includes all failures in denominator)
    const rawSuccessRate = rolling.total > 0
      ? Math.round((rolling.success / rolling.total) * 10000) / 10000
      : 0;
    // effectiveSuccessRate: success / (success + relayErrors) — excludes client errors
    const relayErrors = rollingFailed - rolling.clientErrors;
    const effectiveDenominator = rolling.success + Math.max(0, relayErrors);
    const effectiveSuccessRate = effectiveDenominator > 0
      ? Math.round((rolling.success / effectiveDenominator) * 10000) / 10000
      : 0;

    // Per-wallet throughput (Bug #6)
    const walletThroughput = this.readWalletThroughput();

    return {
      period: "24h",
      transactions: {
        total: rolling.total,
        success: rolling.success,
        failed: rollingFailed,
        clientErrors: rolling.clientErrors,
        // Rolling-vs-rolling trend comparison (Bug #7 fix)
        trend: calculateTrend(rolling.total, prev24h.total),
        previousTotal: prev24h.total,
        rawSuccessRate,
        effectiveSuccessRate,
      },
      tokens: {
        STX: {
          count: current.tokens.STX.count,
          volume: current.tokens.STX.volume,
          percentage: pct(current.tokens.STX.count),
        },
        sBTC: {
          count: current.tokens.sBTC.count,
          volume: current.tokens.sBTC.volume,
          percentage: pct(current.tokens.sBTC.count),
        },
        USDCx: {
          count: current.tokens.USDCx.count,
          volume: current.tokens.USDCx.volume,
          percentage: pct(current.tokens.USDCx.count),
        },
      },
      fees: {
        total: rollingFeeTotal,
        average: rollingFeeAvg,
        min: rolling.feeMin ?? currentFees.min ?? "0",
        max: rolling.feeMax ?? currentFees.max ?? "0",
        trend: feeTrend,
        previousTotal: currentFees.total,
      },
      hourlyData,
      endpointBreakdown,
      // Terminal reason category counts from today's daily_stats row
      terminalReasons: {
        validation: current.terminalReasons?.validation ?? 0,
        sender: current.terminalReasons?.sender ?? 0,
        relay: current.terminalReasons?.relay ?? 0,
        settlement: current.terminalReasons?.settlement ?? 0,
        replacement: current.terminalReasons?.replacement ?? 0,
        identity: current.terminalReasons?.identity ?? 0,
      },
      walletThroughput,
      previous24h: {
        total: prev24h.total,
        success: prev24h.success,
        failed: prev24h.total - prev24h.success,
      },
    };
  }

  private readEndpointBreakdown(date: string): EndpointBreakdown {
    const rows = this.sql
      .exec<{
        relay_total: number;
        relay_success: number;
        relay_failed: number;
        sponsor_total: number;
        sponsor_success: number;
        sponsor_failed: number;
        settle_total: number;
        settle_success: number;
        settle_failed: number;
        settle_client_errors: number;
        verify_total: number;
      }>(
        `SELECT relay_total, relay_success, relay_failed,
                sponsor_total, sponsor_success, sponsor_failed,
                settle_total, settle_success, settle_failed, settle_client_errors,
                verify_total
         FROM daily_stats WHERE date = ? LIMIT 1`,
        date
      )
      .toArray();

    if (rows.length === 0) {
      return {
        relay: { total: 0, success: 0, failed: 0 },
        sponsor: { total: 0, success: 0, failed: 0 },
        settle: { total: 0, success: 0, failed: 0, clientErrors: 0 },
        verify: { total: 0 },
      };
    }

    const r = rows[0];
    return {
      relay: {
        total: r.relay_total ?? 0,
        success: r.relay_success ?? 0,
        failed: r.relay_failed ?? 0,
      },
      sponsor: {
        total: r.sponsor_total ?? 0,
        success: r.sponsor_success ?? 0,
        failed: r.sponsor_failed ?? 0,
      },
      settle: {
        total: r.settle_total ?? 0,
        success: r.settle_success ?? 0,
        failed: r.settle_failed ?? 0,
        clientErrors: r.settle_client_errors ?? 0,
      },
      verify: {
        total: r.verify_total ?? 0,
      },
    };
  }

  // ===========================================================================
  // Backfill — one-time bulk import from old KV data
  // ===========================================================================

  /**
   * Bulk import historical data from KV migration.
   * Uses INSERT OR REPLACE so it's safe to run multiple times.
   */
  private async handleBackfill(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      daily?: Array<{
        date: string;
        total: number; success: number; failed: number;
        stx_count: number; stx_volume: string;
        sbtc_count: number; sbtc_volume: string;
        usdcx_count: number; usdcx_volume: string;
        fee_total: string; fee_count: number;
        fee_min: string | null; fee_max: string | null;
        err_validation: number; err_rate_limit: number;
        err_sponsoring: number; err_settlement: number; err_internal: number;
        // New optional columns (default to 0 when absent in historical data)
        client_errors?: number;
        relay_total?: number; relay_success?: number; relay_failed?: number;
        sponsor_total?: number; sponsor_success?: number; sponsor_failed?: number;
        settle_total?: number; settle_success?: number; settle_failed?: number;
        settle_client_errors?: number;
        verify_total?: number;
      }>;
      hourly?: Array<{
        hour: string;
        total: number; success: number; failed: number;
        stx_count: number; sbtc_count: number; usdcx_count: number;
        fee_total: string;
        client_errors?: number;
      }>;
      txLog?: Array<{
        endpoint: string;
        timestamp: number;
        success: number;
        token: string;
        amount: string;
        fee?: string | null;
        txid?: string | null;
        sender?: string | null;
        recipient?: string | null;
        status?: string | null;
        block_height?: number | null;
        client_error?: number;
      }>;
    };

    let dailyCount = 0;
    let hourlyCount = 0;
    let txLogCount = 0;

    if (body.daily) {
      for (const d of body.daily) {
        this.sql.exec(
          `INSERT OR REPLACE INTO daily_stats
             (date, total, success, failed,
              stx_count, stx_volume, sbtc_count, sbtc_volume, usdcx_count, usdcx_volume,
              fee_total, fee_count, fee_min, fee_max,
              err_validation, err_rate_limit, err_sponsoring, err_settlement, err_internal,
              client_errors,
              relay_total, relay_success, relay_failed,
              sponsor_total, sponsor_success, sponsor_failed,
              settle_total, settle_success, settle_failed, settle_client_errors,
              verify_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          d.date, d.total, d.success, d.failed,
          d.stx_count, d.stx_volume, d.sbtc_count, d.sbtc_volume, d.usdcx_count, d.usdcx_volume,
          d.fee_total, d.fee_count, d.fee_min, d.fee_max,
          d.err_validation, d.err_rate_limit, d.err_sponsoring, d.err_settlement, d.err_internal,
          d.client_errors ?? 0,
          d.relay_total ?? 0, d.relay_success ?? 0, d.relay_failed ?? 0,
          d.sponsor_total ?? 0, d.sponsor_success ?? 0, d.sponsor_failed ?? 0,
          d.settle_total ?? 0, d.settle_success ?? 0, d.settle_failed ?? 0, d.settle_client_errors ?? 0,
          d.verify_total ?? 0
        );
        dailyCount++;
      }
    }

    if (body.hourly) {
      for (const h of body.hourly) {
        this.sql.exec(
          `INSERT OR REPLACE INTO hourly_stats
             (hour, total, success, failed, stx_count, sbtc_count, usdcx_count, fee_total, client_errors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          h.hour, h.total, h.success, h.failed,
          h.stx_count, h.sbtc_count, h.usdcx_count, h.fee_total,
          h.client_errors ?? 0
        );
        hourlyCount++;
      }
    }

    if (body.txLog) {
      for (const t of body.txLog) {
        const id = crypto.randomUUID();
        this.sql.exec(
          `INSERT OR IGNORE INTO tx_log
             (id, endpoint, timestamp, success, token, amount, fee, txid, sender, recipient, status, block_height, client_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, t.endpoint, t.timestamp, t.success, t.token, t.amount,
          t.fee ?? null, t.txid ?? null, t.sender ?? null, t.recipient ?? null,
          t.status ?? null, t.block_height ?? null, t.client_error ?? 0
        );
        txLogCount++;
      }
    }

    return this.jsonResponse({
      success: true,
      imported: { daily: dailyCount, hourly: hourlyCount, txLog: txLogCount },
    });
  }

  // ===========================================================================
  // Fetch handler (routes for Worker-to-DO calls)
  // ===========================================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    try {
      // POST /record — record a transaction
      if (method === "POST" && url.pathname === "/record") {
        const body = (await request.json()) as Partial<TransactionLogEntry>;
        if (!body.endpoint || !body.tokenType || body.success === undefined) {
          return this.badRequest("Missing required fields: endpoint, tokenType, success");
        }
        const entry: TransactionLogEntry = {
          timestamp: body.timestamp || new Date().toISOString(),
          endpoint: body.endpoint,
          success: body.success,
          tokenType: body.tokenType,
          amount: body.amount || "0",
          fee: body.fee,
          txid: body.txid,
          sender: body.sender,
          recipient: body.recipient,
          status: body.status,
          blockHeight: body.blockHeight,
          clientError: body.clientError,
        };
        this.recordTx(entry);
        return this.jsonResponse({ success: true });
      }

      // POST /error — record an error category
      if (method === "POST" && url.pathname === "/error") {
        const body = (await request.json()) as { category?: string };
        if (!body.category) {
          return this.badRequest("Missing category");
        }
        this.recordErrorCategory(body.category as ErrorCategory);
        return this.jsonResponse({ success: true });
      }

      // GET /daily?days=N — return daily stats array
      if (method === "GET" && url.pathname === "/daily") {
        const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "7", 10), 1), 90);
        const stats = this.readDailyStats(days);
        return this.jsonResponse(stats);
      }

      // GET /hourly — return 24h hourly data
      if (method === "GET" && url.pathname === "/hourly") {
        const data = this.readHourlyData();
        return this.jsonResponse(data);
      }

      // GET /wallet-hourly?walletIndex=N&hours=N — per-wallet hourly data
      if (method === "GET" && url.pathname === "/wallet-hourly") {
        const walletIndexParam = url.searchParams.get("walletIndex");
        if (!walletIndexParam) {
          return this.badRequest("Missing walletIndex");
        }
        const walletIndex = parseInt(walletIndexParam, 10);
        if (isNaN(walletIndex)) {
          return this.badRequest("Invalid walletIndex");
        }
        const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") || "24", 10), 1), 48);
        const data = this.readWalletHourlyStats(walletIndex, hours);
        return this.jsonResponse(data);
      }

      // GET /recent?days=N&limit=N&endpoint=X — recent tx log entries
      if (method === "GET" && url.pathname === "/recent") {
        const days = parseInt(url.searchParams.get("days") || "1", 10);
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const endpoint = url.searchParams.get("endpoint") || undefined;
        const entries = this.readRecentTxLog({ days, limit, endpoint });
        return this.jsonResponse(entries);
      }

      // GET /overview — full DashboardOverview (without health, which caller adds)
      if (method === "GET" && url.pathname === "/overview") {
        const overview = this.buildOverview();
        return this.jsonResponse(overview);
      }

      // POST /backfill — one-time bulk import of historical KV data
      if (method === "POST" && url.pathname === "/backfill") {
        return this.handleBackfill(request);
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return this.internalError(e);
    }
  }
}
