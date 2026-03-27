import { BaseEndpoint } from "./BaseEndpoint";
import { StxVerifyService } from "../services/stx-verify";
import type { AppContext, Sip018Auth } from "../types";
import { SIP018_DOMAIN } from "../types";
import {
  tupleCV,
  stringAsciiCV,
  uintCV,
} from "@stacks/transactions";
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
      "Returns queued, dispatched, replaying, and replay_buffer entries.",
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
                        action: { type: "string" as const, enum: ["queue-read"] },
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
                error: { type: "string" as const },
                code: { type: "string" as const, example: "QUEUE_ACCESS_DENIED" },
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

    // Parse auth from request body
    let auth: Sip018Auth;
    try {
      const body = await c.req.json() as { auth?: Sip018Auth };
      if (!body?.auth) {
        return this.err(c, {
          error: "Missing auth field — SIP-018 signature required",
          code: "INVALID_AUTH_SIGNATURE",
          status: 401,
          retryable: false,
        });
      }
      auth = body.auth;
    } catch {
      return this.err(c, {
        error: "Invalid JSON body",
        code: "INVALID_PAYLOAD",
        status: 400,
        retryable: false,
      });
    }

    // Verify SIP-018 auth and recover signer address
    const stxVerify = new StxVerifyService(logger, c.env.STACKS_NETWORK);
    const authError = stxVerify.verifySip018Auth(auth, "queue-read");
    if (authError) {
      return this.err(c, {
        error: authError.error,
        code: authError.code,
        status: 401,
        retryable: false,
      });
    }

    // Recover signer address and verify it matches the URL param
    const nonce = parseInt(auth.message.nonce, 10);
    const expiry = parseInt(auth.message.expiry, 10);
    const domain = c.env.STACKS_NETWORK === "mainnet"
      ? SIP018_DOMAIN.mainnet
      : SIP018_DOMAIN.testnet;
    const domainTuple = tupleCV({
      name: stringAsciiCV(domain.name),
      version: stringAsciiCV(domain.version),
      "chain-id": uintCV(domain.chainId),
    });
    const messageTuple = tupleCV({
      action: stringAsciiCV(auth.message.action),
      nonce: uintCV(nonce),
      expiry: uintCV(expiry),
    });
    const verifyResult = stxVerify.verifySip018({
      signature: auth.signature,
      domain: domainTuple,
      message: messageTuple,
      expectedAddress: senderAddress,
    });

    if (!verifyResult.valid) {
      return this.err(c, {
        error: "Signature does not match senderAddress — you may only read your own queue",
        code: "QUEUE_ACCESS_DENIED",
        status: 403,
        retryable: false,
      });
    }

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
