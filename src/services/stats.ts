import type {
  Logger,
  TokenType,
  DailyStats,
  HourlyStats,
  DashboardOverview,
  ErrorCategory,
  FeeStats,
} from "../types";

/**
 * Get current date in YYYY-MM-DD format (UTC)
 */
function getDateKey(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Get current hour key in YYYY-MM-DD:HH format (UTC)
 */
function getHourKey(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hour = now.getUTCHours().toString().padStart(2, "0");
  return `${date}:${hour}`;
}

/**
 * Create empty daily stats for a given date
 */
function createEmptyDailyStats(date: string): DailyStats {
  return {
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
      facilitator: 0,
      internal: 0,
    },
  };
}

/**
 * Create empty hourly stats for a given hour
 */
function createEmptyHourlyStats(hour: string): HourlyStats {
  return {
    hour,
    transactions: 0,
    success: 0,
    failed: 0,
    tokens: { STX: 0, sBTC: 0, USDCx: 0 },
  };
}

/**
 * Calculate trend based on current vs previous values
 */
function calculateTrend(
  current: number,
  previous: number
): "up" | "down" | "stable" {
  if (previous === 0) return current > 0 ? "up" : "stable";
  const change = ((current - previous) / previous) * 100;
  if (change > 5) return "up";
  if (change < -5) return "down";
  return "stable";
}

// Time constants
const HOUR_MS = 60 * 60 * 1000; // 1 hour in milliseconds
const DAY_MS = 24 * HOUR_MS; // 24 hours in milliseconds

// TTL values in seconds
const HOURLY_TTL = 48 * 60 * 60; // 48 hours
const DAILY_TTL = 90 * 24 * 60 * 60; // 90 days

/**
 * Service for tracking and retrieving relay statistics
 */
export class StatsService {
  constructor(
    private kv: KVNamespace | undefined,
    private logger: Logger
  ) {}

  /**
   * Record a successful or failed transaction
   */
  async recordTransaction(data: {
    success: boolean;
    tokenType: TokenType;
    amount: string;
    /** Fee paid by sponsor in microSTX */
    fee?: string;
  }): Promise<void> {
    if (!this.kv) {
      this.logger.debug("KV not available, skipping stats recording");
      return;
    }

    try {
      const dateKey = getDateKey();
      const hourKey = getHourKey();

      // Update daily stats
      await this.updateDailyStats(dateKey, data);

      // Update hourly stats
      await this.updateHourlyStats(hourKey, data);
    } catch (e) {
      this.logger.error("Failed to record transaction stats", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  /**
   * Record an error by category
   */
  async recordError(category: ErrorCategory): Promise<void> {
    if (!this.kv) {
      this.logger.debug("KV not available, skipping error recording");
      return;
    }

    try {
      const dateKey = getDateKey();
      const key = `stats:daily:${dateKey}`;

      const existing = await this.kv.get<DailyStats>(key, "json");
      const stats = existing || createEmptyDailyStats(dateKey);

      stats.errors[category]++;

      // Only count errors from actual transaction attempts as failed transactions
      // Validation and rate limit errors never become actual transactions
      if (category === "sponsoring" || category === "facilitator" || category === "internal") {
        stats.transactions.total++;
        stats.transactions.failed++;
      }

      await this.kv.put(key, JSON.stringify(stats), {
        expirationTtl: DAILY_TTL,
      });
    } catch (e) {
      this.logger.error("Failed to record error stats", {
        error: e instanceof Error ? e.message : "Unknown error",
        category,
      });
    }
  }

  /**
   * Get dashboard overview data
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
      facilitator: {
        status: "unknown",
        avgLatencyMs: 0,
        uptime24h: 0,
        lastCheck: null,
      },
      hourlyData: [],
    };

    if (!this.kv) {
      return emptyOverview;
    }

    try {
      // Get today and yesterday stats for trend calculation
      const today = getDateKey();
      const yesterday = new Date(Date.now() - DAY_MS)
        .toISOString()
        .split("T")[0];

      const [todayStats, yesterdayStats] = await Promise.all([
        this.kv.get<DailyStats>(`stats:daily:${today}`, "json"),
        this.kv.get<DailyStats>(`stats:daily:${yesterday}`, "json"),
      ]);

      const current = todayStats || createEmptyDailyStats(today);
      const previous = yesterdayStats || createEmptyDailyStats(yesterday);

      // Calculate token percentages
      const totalTokenTx =
        current.tokens.STX.count +
        current.tokens.sBTC.count +
        current.tokens.USDCx.count;

      const tokenPercentage = (count: number) =>
        totalTokenTx > 0 ? Math.round((count / totalTokenTx) * 100) : 0;

      // Get hourly data for chart
      const hourlyData = await this.getHourlyStats();

      // Calculate fee metrics
      const currentFees = current.fees || { total: "0", count: 0, min: "0", max: "0" };
      const previousFees = previous.fees || { total: "0", count: 0, min: "0", max: "0" };

      const avgFee = currentFees.count > 0
        ? (BigInt(currentFees.total) / BigInt(currentFees.count)).toString()
        : "0";

      // Calculate fee trend using BigInt comparison
      const currentFeeTotal = BigInt(currentFees.total);
      const previousFeeTotal = BigInt(previousFees.total);
      let feeTrend: "up" | "down" | "stable" = "stable";
      if (previousFeeTotal === 0n) {
        feeTrend = currentFeeTotal > 0n ? "up" : "stable";
      } else {
        // Calculate percentage change: (current - previous) / previous * 100
        const diff = currentFeeTotal - previousFeeTotal;
        const percentChange = (diff * 100n) / previousFeeTotal;
        if (percentChange > 5n) feeTrend = "up";
        else if (percentChange < -5n) feeTrend = "down";
      }

      return {
        period: "24h",
        transactions: {
          total: current.transactions.total,
          success: current.transactions.success,
          failed: current.transactions.failed,
          trend: calculateTrend(
            current.transactions.total,
            previous.transactions.total
          ),
          previousTotal: previous.transactions.total,
        },
        tokens: {
          STX: {
            count: current.tokens.STX.count,
            volume: current.tokens.STX.volume,
            percentage: tokenPercentage(current.tokens.STX.count),
          },
          sBTC: {
            count: current.tokens.sBTC.count,
            volume: current.tokens.sBTC.volume,
            percentage: tokenPercentage(current.tokens.sBTC.count),
          },
          USDCx: {
            count: current.tokens.USDCx.count,
            volume: current.tokens.USDCx.volume,
            percentage: tokenPercentage(current.tokens.USDCx.count),
          },
        },
        fees: {
          total: currentFees.total,
          average: avgFee,
          min: currentFees.min,
          max: currentFees.max,
          trend: feeTrend,
          previousTotal: previousFees.total,
        },
        facilitator: {
          status: "unknown", // Will be populated by health monitor
          avgLatencyMs: 0,
          uptime24h: 0,
          lastCheck: null,
        },
        hourlyData,
      };
    } catch (e) {
      this.logger.error("Failed to get overview stats", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return emptyOverview;
    }
  }

  /**
   * Get daily stats for a date range
   */
  async getDailyStats(days: number): Promise<DailyStats[]> {
    if (!this.kv) {
      return [];
    }

    try {
      const stats: DailyStats[] = [];
      const now = Date.now();

      for (let i = 0; i < days; i++) {
        const date = new Date(now - i * DAY_MS)
          .toISOString()
          .split("T")[0];
        const data = await this.kv.get<DailyStats>(
          `stats:daily:${date}`,
          "json"
        );
        stats.push(data || createEmptyDailyStats(date));
      }

      return stats.reverse(); // Oldest first
    } catch (e) {
      this.logger.error("Failed to get daily stats", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return [];
    }
  }

  /**
   * Get hourly stats for last 24 hours
   */
  async getHourlyStats(): Promise<
    Array<{ hour: string; transactions: number; success: number; fees?: string }>
  > {
    if (!this.kv) {
      return [];
    }

    try {
      const stats: Array<{ hour: string; transactions: number; success: number; fees?: string }> = [];
      const now = Date.now();

      for (let i = 23; i >= 0; i--) {
        const hourDate = new Date(now - i * HOUR_MS);
        const date = hourDate.toISOString().split("T")[0];
        const hour = hourDate.getUTCHours().toString().padStart(2, "0");
        const key = `stats:hourly:${date}:${hour}`;

        const data = await this.kv.get<HourlyStats>(key, "json");
        stats.push({
          hour: `${hour}:00`,
          transactions: data?.transactions || 0,
          success: data?.success || 0,
          fees: data?.fees,
        });
      }

      return stats;
    } catch (e) {
      this.logger.error("Failed to get hourly stats", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return [];
    }
  }

  /**
   * Update daily stats with transaction data
   */
  private async updateDailyStats(
    dateKey: string,
    data: { success: boolean; tokenType: TokenType; amount: string; fee?: string }
  ): Promise<void> {
    if (!this.kv) return;

    const key = `stats:daily:${dateKey}`;
    const existing = await this.kv.get<DailyStats>(key, "json");
    const stats = existing || createEmptyDailyStats(dateKey);

    stats.transactions.total++;
    if (data.success) {
      stats.transactions.success++;
    } else {
      stats.transactions.failed++;
    }

    // Update token stats
    const tokenStats = stats.tokens[data.tokenType];
    tokenStats.count++;
    tokenStats.volume = (
      BigInt(tokenStats.volume) + BigInt(data.amount)
    ).toString();

    // Update fee stats if fee is provided
    if (data.fee && data.success) {
      const feeValue = BigInt(data.fee);
      if (!stats.fees) {
        stats.fees = {
          total: "0",
          count: 0,
          min: data.fee,
          max: data.fee,
        };
      }
      stats.fees.total = (BigInt(stats.fees.total) + feeValue).toString();
      stats.fees.count++;
      // Update min/max
      if (feeValue < BigInt(stats.fees.min)) {
        stats.fees.min = data.fee;
      }
      if (feeValue > BigInt(stats.fees.max)) {
        stats.fees.max = data.fee;
      }
    }

    await this.kv.put(key, JSON.stringify(stats), {
      expirationTtl: DAILY_TTL,
    });
  }

  /**
   * Update hourly stats with transaction data
   */
  private async updateHourlyStats(
    hourKey: string,
    data: { success: boolean; tokenType: TokenType; amount: string; fee?: string }
  ): Promise<void> {
    if (!this.kv) return;

    const key = `stats:hourly:${hourKey}`;
    const existing = await this.kv.get<HourlyStats>(key, "json");
    const stats = existing || createEmptyHourlyStats(hourKey);

    stats.transactions++;
    if (data.success) {
      stats.success++;
    } else {
      stats.failed++;
    }
    stats.tokens[data.tokenType]++;

    // Track fees for the hour
    if (data.fee && data.success) {
      const currentFees = BigInt(stats.fees || "0");
      stats.fees = (currentFees + BigInt(data.fee)).toString();
    }

    await this.kv.put(key, JSON.stringify(stats), {
      expirationTtl: HOURLY_TTL,
    });
  }
}
