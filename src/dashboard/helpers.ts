import type { DashboardOverview, AggregateKeyStats } from "../types";
import type { HealthStatus } from "../services/health-monitor";

/**
 * Merge stats overview with health status and optional API key stats
 * into a single DashboardOverview object.
 *
 * Used by both the dashboard router and the /stats endpoint
 * to avoid duplicating the assembly logic.
 */
export function buildDashboardData(
  overview: DashboardOverview,
  health: HealthStatus,
  apiKeyStats?: AggregateKeyStats
): DashboardOverview {
  return {
    ...overview,
    settlement: {
      status: health.status,
      avgLatencyMs: health.avgLatencyMs,
      uptime24h: health.uptime24h,
      lastCheck: health.lastCheck?.timestamp || null,
    },
    apiKeys:
      apiKeyStats &&
      (apiKeyStats.totalActiveKeys > 0 || apiKeyStats.topKeys.length > 0)
        ? apiKeyStats
        : undefined,
  };
}
