import { BaseEndpoint } from "./BaseEndpoint";
import {
  StatsService,
  SettlementHealthService,
  AuthService,
} from "../services";
import type { AppContext, DashboardOverview } from "../types";
import { Error500Response } from "../schemas";

/**
 * Dashboard stats endpoint - returns stats as JSON
 * GET /stats
 */
export class DashboardStats extends BaseEndpoint {
  schema = {
    tags: ["Dashboard"],
    summary: "Get relay statistics",
    description:
      "Returns aggregated statistics about relay transactions, token breakdown, and settlement health. This is a public endpoint.",
    responses: {
      "200": {
        description: "Statistics retrieved successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: {
                  type: "string" as const,
                  format: "uuid",
                  description: "Unique request identifier for tracking",
                },
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
                settlement: {
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
                apiKeys: {
                  type: "object" as const,
                  nullable: true,
                  description:
                    "API key aggregate statistics (only present if API_KEYS_KV is configured)",
                  properties: {
                    totalActiveKeys: {
                      type: "number" as const,
                      description: "Total number of active API keys",
                    },
                    totalFeesToday: {
                      type: "string" as const,
                      description: "Total fees sponsored today in microSTX",
                    },
                    topKeys: {
                      type: "array" as const,
                      description: "Top keys by request count (max 5)",
                      items: {
                        type: "object" as const,
                        properties: {
                          keyPrefix: {
                            type: "string" as const,
                            description:
                              "First 12 characters of keyId for anonymization",
                          },
                          requestsToday: {
                            type: "number" as const,
                            description: "Number of requests made today",
                          },
                          feesToday: {
                            type: "string" as const,
                            description: "Total fees sponsored today in microSTX",
                          },
                          status: {
                            type: "string" as const,
                            enum: ["active", "rate_limited", "capped"],
                            description: "Current status of the key",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "500": Error500Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);

    try {
      const statsService = new StatsService(c.env.RELAY_KV, logger);
      const settlementHealthService = new SettlementHealthService(c.env, logger);
      const authService = new AuthService(c.env.API_KEYS_KV, logger);

      // Run settlement health check and API key stats in parallel with data fetching
      // Health check pings Hiro API and verifies sponsor wallet is configured
      const [overview, health, apiKeyStats] = await Promise.all([
        statsService.getOverview(),
        // Fresh self-check (wallet configured + Hiro reachable), then read updated KV status
        settlementHealthService.checkHealth().then(() => settlementHealthService.getStatus()),
        // Get API key aggregate stats (returns empty stats if KV not configured)
        authService.getAggregateKeyStats(),
      ]);

      const dashboardData: DashboardOverview = {
        ...overview,
        settlement: {
          status: health.status,
          avgLatencyMs: health.avgLatencyMs,
          uptime24h: health.uptime24h,
          lastCheck: health.lastCheck?.timestamp || null,
        },
        // Only include apiKeys if there are active keys or usage data
        apiKeys:
          apiKeyStats.totalActiveKeys > 0 || apiKeyStats.topKeys.length > 0
            ? apiKeyStats
            : undefined,
      };

      return this.ok(c, dashboardData);
    } catch (e) {
      logger.error("Failed to get stats", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to retrieve statistics",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
