import { BaseEndpoint } from "./BaseEndpoint";
import {
  StatsService,
  SettlementHealthService,
  AuthService,
} from "../services";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";
import { buildDashboardData } from "../dashboard/helpers";

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
                    clientErrors: {
                      type: "number" as const,
                      description:
                        "Number of failures caused by client errors (bad params, nonce conflicts, rate limits). Excluded from effective success rate calculation.",
                    },
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
                endpointBreakdown: {
                  type: "object" as const,
                  nullable: true,
                  description:
                    "Per-endpoint transaction breakdown (today's calendar-day counters from StatsDO). Only present when StatsDO is configured.",
                  properties: {
                    relay: {
                      type: "object" as const,
                      description: "Stats for POST /relay (sponsored transactions with settlement)",
                      properties: {
                        total: { type: "number" as const },
                        success: { type: "number" as const },
                        failed: { type: "number" as const },
                      },
                    },
                    sponsor: {
                      type: "object" as const,
                      description: "Stats for POST /sponsor (direct sponsoring, API key required)",
                      properties: {
                        total: { type: "number" as const },
                        success: { type: "number" as const },
                        failed: { type: "number" as const },
                      },
                    },
                    settle: {
                      type: "object" as const,
                      description: "Stats for POST /settle (x402 V2 facilitator — no sponsoring)",
                      properties: {
                        total: { type: "number" as const },
                        success: { type: "number" as const },
                        failed: { type: "number" as const },
                        clientErrors: {
                          type: "number" as const,
                          description:
                            "Settle failures caused by client errors (invalid payload, wrong recipient, etc.)",
                        },
                      },
                    },
                    verify: {
                      type: "object" as const,
                      description: "Stats for POST /verify (x402 V2 local validation only)",
                      properties: {
                        total: { type: "number" as const },
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
      const statsService = new StatsService(c.env, logger);
      const healthService = new SettlementHealthService(c.env, logger);
      const authService = new AuthService(c.env.API_KEYS_KV, logger);

      // Read cached health status from KV (no live Hiro call)
      const [overview, health, apiKeyStats] = await Promise.all([
        statsService.getOverview(),
        healthService.getStatus(),
        authService.getAggregateKeyStats(),
      ]);

      // Populate health KV in the background when no cached data exists
      if (health.status === "unknown") {
        c.executionCtx.waitUntil(
          healthService.checkHealth().catch((e) => {
            logger.warn("Background health check failed", {
              error: e instanceof Error ? e.message : String(e),
            });
          })
        );
      }

      const dashboardData = buildDashboardData(overview, health, apiKeyStats);

      return this.ok(c, dashboardData, {
        "Cache-Control": "public, max-age=15",
      });
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
