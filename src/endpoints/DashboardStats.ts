import { BaseEndpoint } from "./BaseEndpoint";
import { StatsService, HealthMonitor, FacilitatorService } from "../services";
import type { AppContext, DashboardOverview } from "../types";

/**
 * Dashboard stats endpoint - returns stats as JSON
 * GET /stats
 */
export class DashboardStats extends BaseEndpoint {
  schema = {
    tags: ["Dashboard"],
    summary: "Get relay statistics",
    description:
      "Returns aggregated statistics about relay transactions, token breakdown, and facilitator health. This is a public endpoint.",
    responses: {
      "200": {
        description: "Statistics retrieved successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                period: {
                  type: "string" as const,
                  enum: ["24h", "7d"],
                  description: "Time period for the stats",
                },
                transactions: {
                  type: "object" as const,
                  properties: {
                    total: { type: "number" as const },
                    success: { type: "number" as const },
                    failed: { type: "number" as const },
                    trend: {
                      type: "string" as const,
                      enum: ["up", "down", "stable"],
                    },
                    previousTotal: { type: "number" as const },
                  },
                },
                tokens: {
                  type: "object" as const,
                  properties: {
                    STX: {
                      type: "object" as const,
                      properties: {
                        count: { type: "number" as const },
                        volume: { type: "string" as const },
                        percentage: { type: "number" as const },
                      },
                    },
                    sBTC: {
                      type: "object" as const,
                      properties: {
                        count: { type: "number" as const },
                        volume: { type: "string" as const },
                        percentage: { type: "number" as const },
                      },
                    },
                    USDCx: {
                      type: "object" as const,
                      properties: {
                        count: { type: "number" as const },
                        volume: { type: "string" as const },
                        percentage: { type: "number" as const },
                      },
                    },
                  },
                },
                facilitator: {
                  type: "object" as const,
                  properties: {
                    status: {
                      type: "string" as const,
                      enum: ["healthy", "degraded", "down", "unknown"],
                    },
                    avgLatencyMs: { type: "number" as const },
                    uptime24h: { type: "number" as const },
                    lastCheck: {
                      type: "string" as const,
                      nullable: true,
                      format: "date-time",
                    },
                  },
                },
                hourlyData: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      hour: { type: "string" as const },
                      transactions: { type: "number" as const },
                      success: { type: "number" as const },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "500": {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                error: { type: "string" as const },
                details: { type: "string" as const },
              },
            },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);

    try {
      const statsService = new StatsService(c.env.RELAY_KV, logger);
      const healthMonitor = new HealthMonitor(c.env.RELAY_KV, logger);
      const facilitatorService = new FacilitatorService(c.env, logger);

      // Trigger a fresh health check (non-blocking - we'll still return cached data if this fails)
      // Run health check in parallel with data fetching
      const [overview, health] = await Promise.all([
        statsService.getOverview(),
        // First do a fresh health check, then get the updated status
        facilitatorService.checkHealth().then(() => healthMonitor.getStatus()),
      ]);

      const dashboardData: DashboardOverview = {
        ...overview,
        facilitator: {
          status: health.status,
          avgLatencyMs: health.avgLatencyMs,
          uptime24h: health.uptime24h,
          lastCheck: health.lastCheck?.timestamp || null,
        },
      };

      return c.json(dashboardData);
    } catch (e) {
      logger.error("Failed to get stats", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.errorResponse(
        c,
        "Failed to retrieve statistics",
        500,
        e instanceof Error ? e.message : "Unknown error"
      );
    }
  }
}
