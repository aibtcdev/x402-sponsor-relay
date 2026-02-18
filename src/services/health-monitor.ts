import type { Logger, HealthCheck } from "../types";

const HEALTH_HISTORY_LIMIT = 100;

/**
 * Health status with metrics
 */
export interface HealthStatus {
  status: "healthy" | "degraded" | "down" | "unknown";
  avgLatencyMs: number;
  uptime24h: number;
  lastCheck: HealthCheck | null;
  recentChecks: HealthCheck[];
}

/**
 * Service for monitoring health checks.
 * Requires a key prefix to namespace KV entries.
 */
export class HealthMonitor {
  constructor(
    private kv: KVNamespace | undefined,
    private logger: Logger,
    private keyPrefix: string
  ) {}

  /**
   * Record a health check result
   */
  async recordCheck(
    check: Omit<HealthCheck, "timestamp">
  ): Promise<void> {
    if (!this.kv) {
      this.logger.debug("KV not available, skipping health recording");
      return;
    }

    try {
      const healthCheck: HealthCheck = {
        ...check,
        timestamp: new Date().toISOString(),
      };

      // Update latest check
      await this.kv.put(
        `${this.keyPrefix}:health:latest`,
        JSON.stringify(healthCheck)
      );

      // Update history (ring buffer)
      const history = await this.kv.get<HealthCheck[]>(
        `${this.keyPrefix}:health:history`,
        "json"
      );
      const checks = history || [];

      checks.unshift(healthCheck);
      if (checks.length > HEALTH_HISTORY_LIMIT) {
        checks.pop();
      }

      await this.kv.put(
        `${this.keyPrefix}:health:history`,
        JSON.stringify(checks)
      );
    } catch (e) {
      this.logger.error("Failed to record health check", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  /**
   * Get current health status
   */
  async getStatus(): Promise<HealthStatus> {
    const emptyStatus: HealthStatus = {
      status: "unknown",
      avgLatencyMs: 0,
      uptime24h: 0,
      lastCheck: null,
      recentChecks: [],
    };

    if (!this.kv) {
      return emptyStatus;
    }

    try {
      const [latest, history] = await Promise.all([
        this.kv.get<HealthCheck>(
          `${this.keyPrefix}:health:latest`,
          "json"
        ),
        this.kv.get<HealthCheck[]>(
          `${this.keyPrefix}:health:history`,
          "json"
        ),
      ]);

      const checks = history || [];

      if (checks.length === 0) {
        return emptyStatus;
      }

      // Filter to last 24 hours for uptime calculation
      const now = Date.now();
      const last24h = checks.filter((c) => {
        const checkTime = new Date(c.timestamp).getTime();
        return now - checkTime < 24 * 60 * 60 * 1000;
      });

      // Calculate metrics
      const avgLatencyMs =
        last24h.length > 0
          ? Math.round(
              last24h.reduce((sum, c) => sum + c.latencyMs, 0) / last24h.length
            )
          : 0;

      const healthyChecks = last24h.filter((c) => c.status === "healthy").length;
      const uptime24h =
        last24h.length > 0
          ? Math.round((healthyChecks / last24h.length) * 100)
          : 0;

      // Determine overall status from recent checks
      const recentChecks = checks.slice(0, 5);
      const status = this.determineStatus(recentChecks);

      return {
        status,
        avgLatencyMs,
        uptime24h,
        lastCheck: latest,
        recentChecks,
      };
    } catch (e) {
      this.logger.error("Failed to get health status", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return emptyStatus;
    }
  }

  /**
   * Determine overall status from recent checks
   * - healthy: all last 5 checks succeeded
   * - degraded: some failures in last 5
   * - down: all last 5 failed
   * - unknown: no recent checks
   */
  private determineStatus(
    checks: HealthCheck[]
  ): "healthy" | "degraded" | "down" | "unknown" {
    if (checks.length === 0) {
      return "unknown";
    }

    const healthyCount = checks.filter((c) => c.status === "healthy").length;

    if (healthyCount === checks.length) {
      return "healthy";
    }
    if (healthyCount === 0) {
      return "down";
    }
    return "degraded";
  }

  /**
   * Determine check status from HTTP response
   */
  static determineCheckStatus(
    httpStatus: number,
    latencyMs: number
  ): "healthy" | "degraded" | "down" {
    if (httpStatus >= 500) {
      return "down";
    }
    if (httpStatus >= 400) {
      return "degraded";
    }
    // Slow responses (>5s) are degraded
    if (latencyMs > 5000) {
      return "degraded";
    }
    return "healthy";
  }
}
