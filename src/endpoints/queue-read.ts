import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import {
  Error401Response,
  Error500Response,
} from "../schemas";

/**
 * Agent queue visibility endpoint — returns the sender's queue state.
 *
 * Requires SIP-018 auth with action "queue-read". The recovered signer
 * address must match the :senderAddress URL parameter so agents can only
 * read their own entries.
 *
 * GET /queue/:senderAddress
 */
export class QueueRead extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Agent queue state",
    description:
      "Returns the agent's pending transaction queue state across all sponsor wallets. " +
      "Requires a SIP-018 signature with action \"queue-read\" from the sender's Stacks key. " +
      "Auth is passed via X-SIP018-Auth header (JSON-encoded {signature, message}). " +
      "Returns queued, dispatched, replaying, and replay_buffer entries.",
    request: {},
    responses: {
      "200": {
        description: "Queue state retrieved successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const },
                requestId: { type: "string" as const, format: "uuid" },
                queue: {
                  type: "object" as const,
                  properties: {
                    queued: {
                      type: "array" as const,
                      items: {
                        type: "object" as const,
                        properties: {
                          walletIndex: { type: "number" as const },
                          sponsorNonce: { type: "number" as const },
                          senderNonce: { type: "number" as const },
                          queuedAt: { type: "string" as const },
                        },
                      },
                    },
                    dispatched: {
                      type: "array" as const,
                      items: {
                        type: "object" as const,
                        properties: {
                          walletIndex: { type: "number" as const },
                          sponsorNonce: { type: "number" as const },
                          senderNonce: { type: "number" as const },
                          queuedAt: { type: "string" as const },
                          dispatchedAt: { type: "string" as const, nullable: true },
                        },
                      },
                    },
                    replaying: {
                      type: "array" as const,
                      items: {
                        type: "object" as const,
                        properties: {
                          walletIndex: { type: "number" as const },
                          sponsorNonce: { type: "number" as const },
                          senderNonce: { type: "number" as const },
                          queuedAt: { type: "string" as const },
                        },
                      },
                    },
                    replayBuffer: {
                      type: "array" as const,
                      items: {
                        type: "object" as const,
                        properties: {
                          id: { type: "number" as const },
                          walletIndex: { type: "number" as const },
                          originalSponsorNonce: { type: "number" as const },
                          senderNonce: { type: "number" as const },
                          queuedAt: { type: "string" as const },
                        },
                      },
                    },
                    total: { type: "number" as const },
                  },
                },
              },
            },
          },
        },
      },
      "401": { ...Error401Response, description: "Invalid or expired SIP-018 signature" },
      "403": {
        description: "Address mismatch — signature does not prove ownership of senderAddress",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: false },
                requestId: { type: "string" as const, format: "uuid" },
                error: { type: "string" as const },
                code: { type: "string" as const, example: "QUEUE_ACCESS_DENIED" },
                retryable: { type: "boolean" as const, example: false },
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
    const senderAddress = c.req.param("senderAddress");

    if (!senderAddress) {
      return this.err(c, {
        error: "Missing senderAddress parameter",
        code: "INVALID_PAYLOAD",
        status: 400,
        retryable: false,
      });
    }

    // Parse and verify SIP-018 auth with address ownership check
    const authError = await this.parseAndVerifyQueueAuth(c, "queue-read", senderAddress);
    if (authError) return authError;

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
      const response = await stub.fetch(
        `https://nonce-do/queue-sender/${encodeURIComponent(senderAddress)}`
      );

      if (!response.ok) {
        const body = await response.text();
        logger.warn("NonceDO queue-sender request failed", { status: response.status, body });
        return this.err(c, {
          error: "Failed to fetch queue state",
          code: "INTERNAL_ERROR",
          status: 500,
          details: body || "Nonce DO responded with error",
          retryable: true,
          retryAfter: 5,
        });
      }

      const queue = await response.json();
      return this.ok(c, { queue });
    } catch (e) {
      logger.error("Queue read request failed", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to fetch queue state",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
