import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";

interface NonceStats {
  totalAssigned: number;
  conflictsDetected: number;
  lastAssignedNonce: number | null;
  lastAssignedAt: string | null;
  nextNonce: number | null;
  txidCount: number;
}

/**
 * Nonce stats endpoint - returns Durable Object stats
 * GET /nonce/stats
 */
export class NonceStatsEndpoint extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Get nonce coordinator stats",
    description:
      "Returns nonce assignment and txid tracking statistics from the Nonce Durable Object.",
    responses: {
      "200": {
        description: "Nonce stats retrieved successfully",
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
                stats: {
                  type: "object" as const,
                  properties: {
                    totalAssigned: { type: "number" as const },
                    conflictsDetected: { type: "number" as const },
                    lastAssignedNonce: { type: "number" as const, nullable: true },
                    lastAssignedAt: { type: "string" as const, nullable: true },
                    nextNonce: { type: "number" as const, nullable: true },
                    txidCount: { type: "number" as const },
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
      const response = await stub.fetch("https://nonce-do/stats");

      if (!response.ok) {
        const body = await response.text();
        logger.warn("Nonce DO stats request failed", {
          status: response.status,
          body,
        });
        return this.err(c, {
          error: "Failed to fetch nonce stats",
          code: "INTERNAL_ERROR",
          status: 500,
          details: body || "Nonce DO responded with error",
          retryable: true,
          retryAfter: 5,
        });
      }

      const stats = (await response.json()) as NonceStats;
      return this.ok(c, { stats });
    } catch (e) {
      logger.error("Nonce stats request failed", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to fetch nonce stats",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
