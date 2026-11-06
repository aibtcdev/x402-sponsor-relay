import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";
import { getPaymentSponsorStatus } from "../services/payment-sponsor-status";

/**
 * Public sponsor status endpoint — readiness of the x402 payment sponsor (SponsorWalletDO).
 * Returns the same SponsorStatusResult contract used by RelayRPC.getSponsorStatus().
 *
 * GET /status/sponsor
 */
export class SponsorStatus extends BaseEndpoint {
  schema = {
    tags: ["Health"],
    summary: "x402 payment sponsor readiness",
    description:
      "Returns whether the x402 payment sponsor can take a payment now: configured, funded above 0.1 STX, and under today's fee budget. The balance read is cached for 60s.",
    responses: {
      "200": {
        description: "Fresh or stale sponsor status snapshot",
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
                status: {
                  type: "string" as const,
                  enum: ["healthy", "degraded"],
                },
                canSponsor: { type: "boolean" as const },
                walletCount: { type: "number" as const },
                recommendation: {
                  type: "string" as const,
                  nullable: true,
                  enum: ["fallback_to_direct"],
                },
                reasons: {
                  type: "array" as const,
                  items: {
                    type: "string" as const,
                    enum: [
                      "NO_AVAILABLE_NONCES",
                      "ALL_WALLETS_DEGRADED",
                      "RECENT_CONFLICT",
                      "HEAL_IN_PROGRESS",
                      "RECONCILIATION_STALE",
                      "SNAPSHOT_STALE",
                      "SPONSOR_NOT_CONFIGURED",
                      "SPONSOR_BALANCE_LOW",
                      "DAILY_BUDGET_REACHED",
                    ],
                  },
                },
                noncePool: {
                  type: "object" as const,
                  properties: {
                    totalAvailable: { type: "number" as const },
                    totalReserved: { type: "number" as const },
                    totalCapacity: { type: "number" as const },
                    poolAvailabilityRatio: { type: "number" as const },
                    conflictsDetected: { type: "number" as const },
                    lastConflictAt: { type: "string" as const, nullable: true },
                    healInProgress: { type: "boolean" as const },
                  },
                },
                reconciliation: {
                  type: "object" as const,
                  properties: {
                    source: { type: "string" as const, enum: ["hiro"] },
                    lastSuccessfulAt: { type: "string" as const, nullable: true },
                    freshness: {
                      type: "string" as const,
                      enum: ["fresh", "stale", "unavailable"],
                    },
                  },
                },
                snapshot: {
                  type: "object" as const,
                  properties: {
                    asOf: { type: "string" as const },
                    ageMs: { type: "number" as const },
                    freshness: {
                      type: "string" as const,
                      enum: ["fresh", "stale", "expired"],
                    },
                  },
                },
              },
            },
          },
        },
      },
      "503": {
        description: "Expired sponsor status snapshot",
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
                status: { type: "string" as const, enum: ["unavailable"] },
                canSponsor: { type: "boolean" as const },
                walletCount: { type: "number" as const },
                recommendation: {
                  type: "string" as const,
                  nullable: true,
                  enum: ["fallback_to_direct"],
                },
                reasons: {
                  type: "array" as const,
                  items: {
                    type: "string" as const,
                    enum: [
                      "NO_AVAILABLE_NONCES",
                      "ALL_WALLETS_DEGRADED",
                      "RECENT_CONFLICT",
                      "HEAL_IN_PROGRESS",
                      "RECONCILIATION_STALE",
                      "SNAPSHOT_STALE",
                      "SPONSOR_NOT_CONFIGURED",
                      "SPONSOR_BALANCE_LOW",
                      "DAILY_BUDGET_REACHED",
                    ],
                  },
                },
                noncePool: {
                  type: "object" as const,
                  properties: {
                    totalAvailable: { type: "number" as const },
                    totalReserved: { type: "number" as const },
                    totalCapacity: { type: "number" as const },
                    poolAvailabilityRatio: { type: "number" as const },
                    conflictsDetected: { type: "number" as const },
                    lastConflictAt: { type: "string" as const, nullable: true },
                    healInProgress: { type: "boolean" as const },
                  },
                },
                reconciliation: {
                  type: "object" as const,
                  properties: {
                    source: { type: "string" as const, enum: ["hiro"] },
                    lastSuccessfulAt: { type: "string" as const, nullable: true },
                    freshness: {
                      type: "string" as const,
                      enum: ["fresh", "stale", "unavailable"],
                    },
                  },
                },
                snapshot: {
                  type: "object" as const,
                  properties: {
                    asOf: { type: "string" as const },
                    ageMs: { type: "number" as const },
                    freshness: {
                      type: "string" as const,
                      enum: ["expired"],
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
      const status = await getPaymentSponsorStatus(c.env, logger);
      return this.ok(
        c,
        status as unknown as Record<string, unknown>,
        undefined,
        status.status === "unavailable" ? 503 : 200
      );
    } catch (e) {
      logger.error("Sponsor status request failed", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to fetch sponsor status",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
