import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";

/**
 * Public cached sponsor status endpoint.
 * Returns the same SponsorStatusResult contract used by RelayRPC.getSponsorStatus().
 *
 * GET /status/sponsor
 */
export class SponsorStatus extends BaseEndpoint {
  schema = {
    tags: ["Health"],
    summary: "Cached sponsor readiness snapshot",
    description:
      "Returns the relay-owned cached sponsor readiness snapshot. Reads never fan out to Hiro on the request path.",
    responses: {
      "200": {
        description: "Fresh or stale sponsor status snapshot",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                status: {
                  type: "string" as const,
                  enum: ["healthy", "degraded", "unavailable"],
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
                status: { type: "string" as const, enum: ["unavailable"] },
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

    if (!c.env.NONCE_DO) {
      return this.err(c, {
        error: "Nonce coordinator unavailable",
        code: "INTERNAL_ERROR",
        status: 500,
        details: "NONCE_DO binding not configured",
        retryable: true,
        retryAfter: 5,
      });
    }

    try {
      const stub = c.env.NONCE_DO.get(c.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch("https://nonce-do/sponsor-status");

      const body = await response.text();
      if (!response.ok && response.status !== 503) {
        logger.warn("Nonce DO sponsor-status request failed", {
          status: response.status,
          body,
        });
        return this.err(c, {
          error: "Failed to fetch sponsor status",
          code: "INTERNAL_ERROR",
          status: 500,
          details: body || "Nonce DO responded with error",
          retryable: true,
          retryAfter: 5,
        });
      }

      return c.json(JSON.parse(body), response.status as 200 | 503);
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
