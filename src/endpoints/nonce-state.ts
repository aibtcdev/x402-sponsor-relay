import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";

/**
 * Client-observable nonce state endpoint (issue #229).
 * Returns per-wallet pending txs, gaps, and health status so MCP clients
 * can correlate sender nonces with sponsor nonces.
 *
 * Intentionally unauthenticated — matches the pattern of public /health and
 * /nonce/stats. Exposed data (sponsor addresses, txids, gap positions) is
 * already on-chain or mempool-visible. MCP clients need access without
 * API keys for pre-flight diagnostics.
 *
 * GET /nonce/state
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
                          chainFrontier: { type: "number" as const, description: "Next expected nonce on-chain (Hiro possible_next_nonce, monotonic high-water mark)" },
                          assignmentHead: { type: "number" as const, description: "Next nonce the relay will assign (one past the highest assigned/broadcasted)" },
                          pendingTxs: {
                            type: "array" as const,
                            items: {
                              type: "object" as const,
                              properties: {
                                sponsorNonce: { type: "number" as const },
                                state: { type: "string" as const, enum: ["assigned", "broadcasted", "replaced"] },
                                txid: { type: "string" as const },
                                assignedAt: { type: "string" as const },
                                broadcastedAt: { type: "string" as const },
                                senderAddress: { type: "string" as const, description: "Stacks address of the transaction sender (from dispatch_queue, absent if not yet dispatched)" },
                                originalTxid: { type: "string" as const, description: "Original sponsored txid that was replaced (present when state is 'replaced')" },
                                replacementTxid: { type: "string" as const, description: "Txid of the relay's replacement transaction, if the relay performed the RBF (present when state is 'replaced' via head-bump/RBF)" },
                                replacedReason: { type: "string" as const, description: "Contention reason string, e.g. 'contention:dropped_replace_by_fee' (present when state is 'replaced')" },
                              },
                            },
                          },
                          gaps: {
                            type: "array" as const,
                            items: { type: "number" as const },
                            description: "Missing nonce values between chain frontier and assignment head",
                          },
                          available: { type: "number" as const, description: "Effective headroom — how many more nonces this wallet can accept (same calc as assignment)" },
                          reserved: { type: "number" as const, description: "In-flight nonces across all states (assigned + broadcasted + confirmed-pending)" },
                          circuitBreakerOpen: { type: "boolean" as const },
                          ghostDegraded: { type: "boolean" as const, description: "True when the wallet has accumulated consecutive ghost broadcast failures (invisible mempool entries)" },
                          ghostFailures: { type: "number" as const, description: "Number of consecutive ghost broadcast failures (ConflictingNonceInMempool with no Hiro-visible occupant)" },
                          chainingDegraded: { type: "boolean" as const, description: "True when the wallet has hit the Stacks node TooMuchChaining limit" },
                          chainingFailures: { type: "number" as const, description: "Number of consecutive TooMuchChaining broadcast failures" },
                          mempoolTxCount: {
                            type: "number" as const,
                            nullable: true,
                            description: "Last known Hiro mempool tx count for this sponsor address (populated only for stuck wallets during reconciliation)",
                          },
                          healthy: { type: "boolean" as const },
                          settlementTimes: {
                            type: "object" as const,
                            description: "Per-wallet broadcast-to-confirmation latency percentiles (last 24h)",
                            properties: {
                              p50: { type: "number" as const, description: "Median settlement time in milliseconds" },
                              p95: { type: "number" as const, description: "95th percentile settlement time in milliseconds" },
                              avg: { type: "number" as const, description: "Average settlement time in milliseconds" },
                              count: { type: "number" as const, description: "Number of confirmed transactions in the sample" },
                            },
                          },
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
                    senderHands: {
                      type: "array" as const,
                      description: "Active sender hands — senders with held transactions waiting for nonce gap fill (capped at 50)",
                      items: {
                        type: "object" as const,
                        properties: {
                          address: { type: "string" as const, description: "Sender Stacks address" },
                          nextExpected: { type: "number" as const, description: "Next sender nonce needed to unblock dispatch" },
                          handSize: { type: "number" as const, description: "Number of transactions held in the sender's hand" },
                          oldestEntryAge: { type: "number" as const, description: "Milliseconds since oldest entry was received" },
                        },
                      },
                    },
                    recommendation: {
                      type: "string" as const,
                      nullable: true,
                      enum: ["fallback_to_direct"],
                      description: "When non-null, clients should bypass sponsored submission",
                    },
                    settlementTimes: {
                      type: "object" as const,
                      description: "Global broadcast-to-confirmation latency percentiles across all wallets (last 24h)",
                      properties: {
                        p50: { type: "number" as const, description: "Median settlement time in milliseconds" },
                        p95: { type: "number" as const, description: "95th percentile settlement time in milliseconds" },
                        avg: { type: "number" as const, description: "Average settlement time in milliseconds" },
                        count: { type: "number" as const, description: "Number of confirmed transactions in the sample" },
                      },
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

      // recommendation is derived inside the DO (single source of truth)
      const state = await response.json();

      return this.ok(c, { state });
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
