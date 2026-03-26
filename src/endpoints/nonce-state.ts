import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";

/**
 * Client-observable nonce state endpoint (issue #229).
 * Returns per-wallet pending txs, gaps, and health status so MCP clients
 * can correlate sender nonces with sponsor nonces.
 *
 * GET /nonce-state
 */
export class NonceState extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Observable nonce state for client diagnostics",
    description:
      "Returns the relay's internal nonce state per wallet — pending transactions, detected gaps, " +
      "circuit breaker status, and heal progress. Designed for MCP tools like `tx_status_deep` to " +
      "cross-reference sender nonces with sponsor nonces without scraping the Hiro mempool API.",
    responses: {
      "200": {
        description: "Nonce state retrieved successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: { type: "string" as const, format: "uuid" },
                state: {
                  type: "object" as const,
                  properties: {
                    wallets: {
                      type: "array" as const,
                      items: {
                        type: "object" as const,
                        properties: {
                          walletIndex: { type: "number" as const },
                          sponsorAddress: { type: "string" as const },
                          chainFrontier: { type: "number" as const, description: "Highest confirmed nonce (monotonic)" },
                          assignmentHead: { type: "number" as const, description: "Next nonce to assign" },
                          pendingTxs: {
                            type: "array" as const,
                            items: {
                              type: "object" as const,
                              properties: {
                                sponsorNonce: { type: "number" as const },
                                state: { type: "string" as const, enum: ["assigned", "broadcasted"] },
                                txid: { type: "string" as const },
                                assignedAt: { type: "string" as const },
                                broadcastedAt: { type: "string" as const },
                              },
                            },
                          },
                          gaps: {
                            type: "array" as const,
                            items: { type: "number" as const },
                            description: "Missing nonce values between chain frontier and assignment head",
                          },
                          available: { type: "number" as const },
                          reserved: { type: "number" as const },
                          circuitBreakerOpen: { type: "boolean" as const },
                          healthy: { type: "boolean" as const },
                        },
                      },
                    },
                    healthy: { type: "boolean" as const, description: "True when no gaps and no circuit breakers active" },
                    healInProgress: { type: "boolean" as const, description: "True when gap-fill was triggered recently" },
                    gapsFilled: { type: "number" as const, description: "Cumulative gap-fill count" },
                    totalAvailable: { type: "number" as const },
                    totalReserved: { type: "number" as const },
                    totalCapacity: { type: "number" as const },
                    lastGapDetected: { type: "string" as const, nullable: true },
                    recommendation: {
                      type: "string" as const,
                      nullable: true,
                      enum: ["fallback_to_direct"],
                      description: "When non-null, clients should bypass sponsored submission",
                    },
                    timestamp: { type: "string" as const },
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
      const response = await stub.fetch("https://nonce-do/nonce-state");

      if (!response.ok) {
        const body = await response.text();
        logger.warn("Nonce DO nonce-state request failed", {
          status: response.status,
          body,
        });
        return this.err(c, {
          error: "Failed to fetch nonce state",
          code: "INTERNAL_ERROR",
          status: 500,
          details: body || "Nonce DO responded with error",
          retryable: true,
          retryAfter: 5,
        });
      }

      const state = await response.json() as {
        wallets: Array<{
          gaps: number[];
          circuitBreakerOpen: boolean;
          available: number;
        }>;
        healthy: boolean;
        healInProgress: boolean;
        [key: string]: unknown;
      };

      // Add recommendation field for clients
      const anyGaps = state.wallets.some((w) => w.gaps.length > 0);
      const allDegraded =
        state.wallets.length > 0 &&
        state.wallets.every((w) => w.circuitBreakerOpen || w.available === 0);
      const recommendation =
        !state.healthy && (anyGaps || allDegraded)
          ? "fallback_to_direct"
          : null;

      return this.ok(c, { state: { ...state, recommendation } });
    } catch (e) {
      logger.error("Nonce state request failed", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to fetch nonce state",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
