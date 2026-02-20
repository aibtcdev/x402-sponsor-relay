import type {
  Env,
  TokenType,
  ErrorCategory,
  DailyStats,
  DashboardOverview,
  TransactionLogEntry,
} from "../types";
import { calculateTrend } from "../services/stats";

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
    const token = entry.tokenType as string;
    const amount = entry.amount || "0";
    const fee = entry.fee || null;

    // Insert into tx_log
    const id = crypto.randomUUID();
    const timestamp = new Date(entry.timestamp).getTime() || now;
    this.sql.exec(
      `INSERT OR IGNORE INTO tx_log
         (id, endpoint, timestamp, success, token, amount, fee, txid, sender, recipient, status, block_height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      entry.blockHeight || null
    );

    // Prune tx_log older than 7 days
    const cutoff = now - 7 * DAY_MS;
    this.sql.exec("DELETE FROM tx_log WHERE timestamp < ?", cutoff);

    // Determine token column increments
    const stxInt = token === "STX" ? 1 : 0;
    const sbtcInt = token === "sBTC" ? 1 : 0;
    const usdcxInt = token === "USDCx" ? 1 : 0;

    // Atomic daily upsert — counts
    this.sql.exec(
      `INSERT INTO daily_stats (date, total, success, failed, stx_count, sbtc_count, usdcx_count)
       VALUES (?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         total = total + 1,
         success = success + excluded.success,
         failed = failed + excluded.failed,
         stx_count = stx_count + excluded.stx_count,
         sbtc_count = sbtc_count + excluded.sbtc_count,
         usdcx_count = usdcx_count + excluded.usdcx_count`,
      today,
      successInt,
      failedInt,
      stxInt,
      sbtcInt,
      usdcxInt
    );

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

    // Atomic hourly upsert
    this.sql.exec(
      `INSERT INTO hourly_stats (hour, total, success, failed, stx_count, sbtc_count, usdcx_count)
       VALUES (?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(hour) DO UPDATE SET
         total = total + 1,
         success = success + excluded.success,
         failed = failed + excluded.failed,
         stx_count = stx_count + excluded.stx_count,
         sbtc_count = sbtc_count + excluded.sbtc_count,
         usdcx_count = usdcx_count + excluded.usdcx_count`,
      hourKey,
      successInt,
      failedInt,
      stxInt,
      sbtcInt,
      usdcxInt
    );

    // Hourly fee total
    if (entry.success && fee) {
      this.sql.exec(
        `UPDATE hourly_stats SET fee_total = CAST(CAST(fee_total AS INTEGER) + ? AS TEXT) WHERE hour = ?`,
        fee,
        hourKey
      );
    }

    // Prune hourly_stats older than 48h
    const hourCutoff = new Date(now - 48 * HOUR_MS);
    const hourCutoffStr = `${hourCutoff.toISOString().split("T")[0]}:${hourCutoff.getUTCHours().toString().padStart(2, "0")}`;
    this.sql.exec("DELETE FROM hourly_stats WHERE hour < ?", hourCutoffStr);
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
    const result: DailyStats[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = getDateKey(now - i * DAY_MS);
      const rows = this.sql
        .exec<{
          total: number;
          success: number;
          failed: number;
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
        }>(
          `SELECT total, success, failed,
                  stx_count, stx_volume,
                  sbtc_count, sbtc_volume,
                  usdcx_count, usdcx_volume,
                  fee_total, fee_count, fee_min, fee_max,
                  err_validation, err_rate_limit, err_sponsoring, err_settlement, err_internal
           FROM daily_stats WHERE date = ? LIMIT 1`,
          date
        )
        .toArray();

      if (rows.length === 0) {
        result.push({
          date,
          transactions: { total: 0, success: 0, failed: 0 },
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
        });
      } else {
        const r = rows[0];
        const ds: DailyStats = {
          date,
          transactions: {
            total: r.total,
            success: r.success,
            failed: r.failed,
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
    }

    return result;
  }

  private readHourlyData(): Array<{ hour: string; transactions: number; success: number; fees?: string }> {
    const now = Date.now();
    const result: Array<{ hour: string; transactions: number; success: number; fees?: string }> = [];

    for (let i = 23; i >= 0; i--) {
      const ts = now - i * HOUR_MS;
      const d = new Date(ts);
      const hourLabel = d.getUTCHours().toString().padStart(2, "0") + ":00";
      const key = getHourKey(ts);

      const rows = this.sql
        .exec<{ total: number; success: number; fee_total: string }>(
          `SELECT total, success, fee_total FROM hourly_stats WHERE hour = ? LIMIT 1`,
          key
        )
        .toArray();

      if (rows.length === 0) {
        result.push({ hour: hourLabel, transactions: 0, success: 0 });
      } else {
        const r = rows[0];
        const entry: { hour: string; transactions: number; success: number; fees?: string } = {
          hour: hourLabel,
          transactions: r.total,
          success: r.success,
        };
        if (r.fee_total && r.fee_total !== "0") {
          entry.fees = r.fee_total;
        }
        result.push(entry);
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

  private buildOverview(): DashboardOverview {
    // readDailyStats(2) returns [yesterday, today] — reuse instead of
    // duplicating the raw SQL query for yesterday's row.
    const twoDays = this.readDailyStats(2);
    const previous = twoDays[0] ?? null;
    const current = twoDays[1];

    // Token percentages
    const totalTokenTx =
      current.tokens.STX.count +
      current.tokens.sBTC.count +
      current.tokens.USDCx.count;
    const pct = (count: number) =>
      totalTokenTx > 0 ? Math.round((count / totalTokenTx) * 100) : 0;

    // Fee aggregates
    const currentFees = current.fees ?? { total: "0", count: 0, min: "0", max: "0" };
    const previousFees = previous?.fees ?? { total: "0", count: 0, min: "0", max: "0" };

    const avgFee =
      currentFees.count > 0
        ? (BigInt(currentFees.total) / BigInt(currentFees.count)).toString()
        : "0";

    const currentFeeTotal = BigInt(currentFees.total);
    const previousFeeTotal = BigInt(previousFees.total);
    let feeTrend: "up" | "down" | "stable" = "stable";
    if (previousFeeTotal === 0n) {
      feeTrend = currentFeeTotal > 0n ? "up" : "stable";
    } else {
      const diff = currentFeeTotal - previousFeeTotal;
      const pctChange = (diff * 100n) / previousFeeTotal;
      if (pctChange > 5n) feeTrend = "up";
      else if (pctChange < -5n) feeTrend = "down";
    }

    const hourlyData = this.readHourlyData();

    return {
      period: "24h",
      transactions: {
        total: current.transactions.total,
        success: current.transactions.success,
        failed: current.transactions.failed,
        trend: calculateTrend(
          current.transactions.total,
          previous?.transactions.total ?? 0
        ),
        previousTotal: previous?.transactions.total ?? 0,
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
        total: currentFees.total,
        average: avgFee,
        min: currentFees.min || "0",
        max: currentFees.max || "0",
        trend: feeTrend,
        previousTotal: previousFees.total,
      },
      hourlyData,
    };
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

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return this.internalError(e);
    }
  }
}
