import type { Env, Logger } from "../types";
import { HealthMonitor } from "./health-monitor";
import type { HealthStatus } from "./health-monitor";

const HIRO_CHECK_TIMEOUT_MS = 5000;

/**
 * Service for monitoring native settlement health.
 *
 * Performs a self-check:
 *   1. Sponsor wallet is configured (SPONSOR_MNEMONIC or SPONSOR_PRIVATE_KEY set)
 *   2. Hiro API is reachable (GET /extended/v1/info returns HTTP 200)
 *
 * Health results are stored in KV under the "settlement" key prefix.
 */
export class SettlementHealthService {
  private healthMonitor: HealthMonitor;

  constructor(
    private env: Env,
    private logger: Logger
  ) {
    this.healthMonitor = new HealthMonitor(env.RELAY_KV, logger, "settlement");
  }

  /**
   * Get the Hiro API base URL based on environment configuration
   */
  private getHiroBaseUrl(): string {
    return this.env.STACKS_NETWORK === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";
  }

  /**
   * Build headers for Hiro API requests, including optional API key
   */
  private getHiroHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.env.HIRO_API_KEY) {
      headers["x-hiro-api-key"] = this.env.HIRO_API_KEY;
    }
    return headers;
  }

  /**
   * Check whether the sponsor wallet is configured.
   * Returns true if either SPONSOR_MNEMONIC or SPONSOR_PRIVATE_KEY is set.
   */
  private isSponsorConfigured(): boolean {
    return !!(this.env.SPONSOR_MNEMONIC || this.env.SPONSOR_PRIVATE_KEY);
  }

  /**
   * Perform a settlement health self-check:
   *   1. Verify sponsor wallet is configured
   *   2. Verify Hiro API is reachable
   *
   * Records the result in KV via HealthMonitor for dashboard display.
   * Returns true if both checks pass, false otherwise.
   */
  async checkHealth(): Promise<boolean> {
    const startTime = performance.now();

    // Check 1: sponsor wallet configured
    if (!this.isSponsorConfigured()) {
      this.logger.warn("Settlement health check failed: sponsor wallet not configured");

      await this.healthMonitor.recordCheck({
        status: "down",
        latencyMs: 0,
        httpStatus: 0,
        error: "Sponsor wallet not configured (set SPONSOR_MNEMONIC or SPONSOR_PRIVATE_KEY)",
      });

      return false;
    }

    // Check 2: Hiro API reachable
    const hiroUrl = `${this.getHiroBaseUrl()}/extended/v1/info`;

    try {
      const response = await fetch(hiroUrl, {
        method: "GET",
        headers: this.getHiroHeaders(),
        signal: AbortSignal.timeout(HIRO_CHECK_TIMEOUT_MS),
      });

      const latencyMs = Math.round(performance.now() - startTime);

      if (!response.ok) {
        this.logger.warn("Settlement health check: Hiro API returned non-2xx", {
          status: response.status,
          latencyMs,
        });

        await this.healthMonitor.recordCheck({
          status: HealthMonitor.determineCheckStatus(response.status, latencyMs),
          latencyMs,
          httpStatus: response.status,
          error: `Hiro API returned HTTP ${response.status}`,
        });

        return false;
      }

      await this.healthMonitor.recordCheck({
        status: HealthMonitor.determineCheckStatus(response.status, latencyMs),
        latencyMs,
        httpStatus: response.status,
      });

      this.logger.debug("Settlement health check passed", { latencyMs });
      return true;
    } catch (e) {
      const latencyMs = Math.round(performance.now() - startTime);
      const isTimeout = e instanceof Error && e.name === "TimeoutError";

      this.logger.error(
        isTimeout
          ? "Settlement health check: Hiro API timed out"
          : "Settlement health check: Hiro API request failed",
        { error: e instanceof Error ? e.message : "Unknown error" }
      );

      await this.healthMonitor.recordCheck({
        status: "down",
        latencyMs,
        httpStatus: isTimeout ? 504 : 500,
        error: e instanceof Error ? e.message : "Unknown error",
      });

      return false;
    }
  }

  /**
   * Get the current settlement health status from KV history.
   * Delegates to the internal HealthMonitor.
   */
  async getStatus(): Promise<HealthStatus> {
    return this.healthMonitor.getStatus();
  }
}
