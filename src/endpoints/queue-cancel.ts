import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import {
  Error401Response,
  Error404Response,
  Error500Response,
} from "../schemas";

/**
 * Agent self-service cancellation endpoint — cancel a queued/dispatched/replaying tx.
 *
 * Requires SIP-018 auth with action "queue-cancel". The recovered signer
 * address must match the :senderAddress URL parameter so agents can only
 * cancel their own entries.
 *
 * State transitions:
 *   queued → deleted immediately
 *   dispatched → set to 'replaying' (signals the alarm to flush the sponsor nonce slot)
 *   replaying → deleted immediately
 *   replay_buffer → deleted (matched by original_sponsor_nonce)
 *
 * DELETE /queue/:senderAddress/:walletIndex/:sponsorNonce
 */
export class QueueCancel extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Cancel a queued transaction",
    description:
      "Cancels a queued, dispatched, or replaying sponsored transaction. " +
      "Requires a SIP-018 signature with action \"queue-cancel\" from the sender's Stacks key. " +
      "The recovered signer address must match the :senderAddress URL parameter.\n\n" +
      "State transitions:\n" +
      "- queued → deleted immediately\n" +
      "- dispatched → transitioned to 'replaying' (sponsor nonce slot will be flushed in next alarm cycle)\n" +
      "- replaying → deleted immediately\n" +
      "- replay_buffer entry (matched by original_sponsor_nonce) → deleted",
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["auth"],
              properties: {
                auth: {
                  type: "object" as const,
                  required: ["signature", "message"],
                  description: "SIP-018 structured data signature proving ownership of senderAddress",
                  properties: {
                    signature: { type: "string" as const, description: "RSV hex signature" },
                    message: {
                      type: "object" as const,
                      required: ["action", "nonce", "expiry"],
                      properties: {
                        action: { type: "string" as const, enum: ["queue-cancel"] },
                        nonce: { type: "string" as const, description: "Unix timestamp ms" },
                        expiry: { type: "string" as const, description: "Expiry unix timestamp ms" },
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
    responses: {
      "200": {
        description: "Transaction cancelled successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const },
                requestId: { type: "string" as const, format: "uuid" },
                cancelled: {
                  type: "object" as const,
                  properties: {
                    cancelled: { type: "boolean" as const },
                    previousState: {
                      type: "string" as const,
                      enum: ["queued", "dispatched", "replaying", "replay_buffer"],
                    },
                    walletIndex: { type: "number" as const },
                    sponsorNonce: { type: "number" as const },
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
                error: { type: "string" as const },
                code: { type: "string" as const, example: "QUEUE_ACCESS_DENIED" },
              },
            },
          },
        },
      },
      "404": { ...Error404Response, description: "Queue entry not found" },
      "500": Error500Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    const senderAddress = c.req.param("senderAddress");
    const walletIndexStr = c.req.param("walletIndex");
    const sponsorNonceStr = c.req.param("sponsorNonce");

    if (!senderAddress || !walletIndexStr || !sponsorNonceStr) {
      return this.err(c, {
        error: "Missing required URL parameters: senderAddress, walletIndex, sponsorNonce",
        code: "INVALID_PAYLOAD",
        status: 400,
        retryable: false,
      });
    }

    const walletIndex = parseInt(walletIndexStr, 10);
    const sponsorNonce = parseInt(sponsorNonceStr, 10);
    if (!Number.isInteger(walletIndex) || !Number.isInteger(sponsorNonce)) {
      return this.err(c, {
        error: "walletIndex and sponsorNonce must be integers",
        code: "INVALID_PAYLOAD",
        status: 400,
        retryable: false,
      });
    }

    // Parse and verify SIP-018 auth with address ownership check
    const authError = await this.parseAndVerifyQueueAuth(c, "queue-cancel", senderAddress);
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
        `https://nonce-do/queue-sender/${encodeURIComponent(senderAddress)}/${walletIndex}/${sponsorNonce}`,
        { method: "DELETE" }
      );

      if (response.status === 404) {
        return this.err(c, {
          error: "Queue entry not found",
          code: "QUEUE_NOT_FOUND",
          status: 404,
          retryable: false,
        });
      }

      if (response.status === 403) {
        return this.err(c, {
          error: "Access denied to queue entry",
          code: "QUEUE_ACCESS_DENIED",
          status: 403,
          retryable: false,
        });
      }

      if (!response.ok) {
        const body = await response.text();
        logger.warn("NonceDO queue-cancel request failed", { status: response.status, body });
        return this.err(c, {
          error: "Failed to cancel queue entry",
          code: "INTERNAL_ERROR",
          status: 500,
          details: body || "Nonce DO responded with error",
          retryable: true,
          retryAfter: 5,
        });
      }

      const cancelled = await response.json();
      return this.ok(c, { cancelled });
    } catch (e) {
      logger.error("Queue cancel request failed", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to cancel queue entry",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
