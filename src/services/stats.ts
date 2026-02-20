import type {
  Env,
  Logger,
  TokenType,
  DailyStats,
  DashboardOverview,
  ErrorCategory,
  TransactionLogEntry,
} from "../types";

/**
 * Calculate trend based on current vs previous values
 */
export function calculateTrend(
  current: number,
  previous: number
): "up" | "down" | "stable" {
  if (previous === 0) return current > 0 ? "up" : "stable";
  const change = ((current - previous) / previous) * 100;
  if (change > 5) return "up";
  if (change < -5) return "down";
  return "stable";
}

/**
 * StatsService — thin proxy to StatsDO for atomic stats recording.
 *
 * All write methods (recordTransaction, recordError, logTransaction) are
 * fire-and-forget-friendly: callers should wrap them in waitUntil() so
 * they never block the HTTP response.
 *
 * All read methods (getOverview, getDailyStats, etc.) call StatsDO and
 * return the same shapes as the previous KV implementation.
 *
 * If STATS_DO is unavailable, all methods degrade silently (same
 * behaviour as the previous KV fallback).
 */
export class StatsService {
  private readonly env: Env;
  private readonly logger: Logger;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger;
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  private getStub(): DurableObjectStub | null {
    if (!this.env.STATS_DO) {
      this.logger.debug("STATS_DO not available, skipping stats");
      return null;
    }
    try {
      const id = this.env.STATS_DO.idFromName("global");
      return this.env.STATS_DO.get(id);
    } catch (e) {
      this.logger.debug("Failed to get STATS_DO stub", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }

  private async doPost(path: string, body: unknown): Promise<void> {
    const stub = this.getStub();
    if (!stub) return;
    try {
      await stub.fetch(
        new Request(`http://do${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    } catch (e) {
      this.logger.debug(`StatsDO POST ${path} failed`, {
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  private async doGet<T>(path: string): Promise<T | null> {
    const stub = this.getStub();
    if (!stub) return null;
    try {
      const resp = await stub.fetch(new Request(`http://do${path}`));
      if (!resp.ok) return null;
      return (await resp.json()) as T;
    } catch (e) {
      this.logger.debug(`StatsDO GET ${path} failed`, {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }

  // ===========================================================================
  // Write methods (fire-and-forget — wrap callers in waitUntil)
  // ===========================================================================

  /**
   * Record a successful or failed transaction.
   * Callers should use c.executionCtx.waitUntil(statsService.recordTransaction(...).catch(() => {}))
   */
  async recordTransaction(data: {
    success: boolean;
    tokenType: TokenType;
    amount: string;
    /** Fee paid by sponsor in microSTX */
    fee?: string;
  }): Promise<void> {
    await this.doPost("/record", {
      timestamp: new Date().toISOString(),
      endpoint: "relay" as const,
      success: data.success,
      tokenType: data.tokenType,
      amount: data.amount,
      fee: data.fee,
    });
  }

  /**
   * Record an error by category.
   * Callers should use c.executionCtx.waitUntil(statsService.recordError(...).catch(() => {}))
   */
  async recordError(category: ErrorCategory): Promise<void> {
    await this.doPost("/error", { category });
  }

  /**
   * Append an individual transaction log entry.
   * Callers should use c.executionCtx.waitUntil(statsService.logTransaction(...).catch(() => {}))
   */
  async logTransaction(entry: TransactionLogEntry): Promise<void> {
    await this.doPost("/record", entry);
  }

  // ===========================================================================
  // Read methods (for dashboard and stats endpoints)
  // ===========================================================================

  /**
   * Get dashboard overview data (today + trend vs yesterday).
   */
  async getOverview(): Promise<DashboardOverview> {
    const emptyFees = {
      total: "0",
      average: "0",
      min: "0",
      max: "0",
      trend: "stable" as const,
      previousTotal: "0",
    };

    const emptyOverview: DashboardOverview = {
      period: "24h",
      transactions: {
        total: 0,
        success: 0,
        failed: 0,
        trend: "stable",
        previousTotal: 0,
      },
      tokens: {
        STX: { count: 0, volume: "0", percentage: 0 },
        sBTC: { count: 0, volume: "0", percentage: 0 },
        USDCx: { count: 0, volume: "0", percentage: 0 },
      },
      fees: emptyFees,
      settlement: {
        status: "unknown",
        avgLatencyMs: 0,
        uptime24h: 0,
        lastCheck: null,
      },
      hourlyData: [],
    };

    try {
      const data = await this.doGet<DashboardOverview>("/overview");
      return data ?? emptyOverview;
    } catch (e) {
      this.logger.error("Failed to get overview stats", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return emptyOverview;
    }
  }

  /**
   * Get daily stats for a date range (oldest-first, N days back from today).
   */
  async getDailyStats(days: number): Promise<DailyStats[]> {
    try {
      const data = await this.doGet<DailyStats[]>(`/daily?days=${days}`);
      return data ?? [];
    } catch (e) {
      this.logger.error("Failed to get daily stats", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return [];
    }
  }

  /**
   * Get daily stats aggregated as chart-compatible entries.
   * Returns one entry per day with a short date label (e.g. "Feb 12").
   */
  async getDailyChartData(
    days: number
  ): Promise<Array<{ hour: string; transactions: number; success: number }>> {
    const daily = await this.getDailyStats(days);
    return daily.map((d) => {
      const [year, month, day] = d.date.split("-").map(Number);
      const label = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(
        "en-US",
        { month: "short", day: "numeric", timeZone: "UTC" }
      );
      return {
        hour: label,
        transactions: d.transactions.total,
        success: d.transactions.success,
      };
    });
  }

  /**
   * Get hourly stats for last 24 hours.
   */
  async getHourlyStats(): Promise<
    Array<{ hour: string; transactions: number; success: number; fees?: string }>
  > {
    try {
      const data = await this.doGet<
        Array<{ hour: string; transactions: number; success: number; fees?: string }>
      >("/hourly");
      return data ?? [];
    } catch (e) {
      this.logger.error("Failed to get hourly stats", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return [];
    }
  }

  /**
   * Get recent transaction log entries.
   */
  async getTransactionLog(opts?: {
    days?: number;
    limit?: number;
    endpoint?: string;
  }): Promise<TransactionLogEntry[]> {
    try {
      const params = new URLSearchParams();
      if (opts?.days != null) params.set("days", String(opts.days));
      if (opts?.limit != null) params.set("limit", String(opts.limit));
      if (opts?.endpoint) params.set("endpoint", opts.endpoint);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const data = await this.doGet<TransactionLogEntry[]>(`/recent${qs}`);
      return data ?? [];
    } catch (e) {
      this.logger.error("Failed to get transaction log", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return [];
    }
  }
}

