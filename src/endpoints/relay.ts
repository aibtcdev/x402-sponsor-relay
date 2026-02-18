import { BaseEndpoint } from "./BaseEndpoint";
import { SponsorService, SettlementService, StatsService, ReceiptService, StxVerifyService } from "../services";
import { checkRateLimit, RATE_LIMIT } from "../middleware";
import type { AppContext, RelayRequest, SettlementResult } from "../types";
import {
  Error400Response,
  Error401Response,
  Error429Response,
  Error500Response,
  Error502Response,
} from "../schemas";

/**
 * Relay endpoint - sponsors and settles transactions
 * POST /relay
 */
export class Relay extends BaseEndpoint {
  schema = {
    tags: ["Relay"],
    summary: "Submit sponsored transaction for settlement",
    description:
      "Accepts a pre-signed sponsored transaction, sponsors it with the relay's key, verifies payment locally, and broadcasts directly to the Stacks network.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["transaction", "settle"],
              properties: {
                transaction: {
                  type: "string" as const,
                  description: "Hex-encoded signed sponsored transaction",
                  example: "0x00000001...",
                },
                settle: {
                  type: "object" as const,
                  required: ["expectedRecipient", "minAmount"],
                  properties: {
                    expectedRecipient: {
                      type: "string" as const,
                      description: "Expected recipient address",
                      example: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
                    },
                    minAmount: {
                      type: "string" as const,
                      description:
                        "Minimum amount required (in smallest unit - microSTX, sats, etc.)",
                      example: "1000000",
                    },
                    tokenType: {
                      type: "string" as const,
                      enum: ["STX", "sBTC", "USDCx"],
                      default: "STX",
                      description: "Token type for payment",
                    },
                    expectedSender: {
                      type: "string" as const,
                      description: "Expected sender address (optional)",
                    },
                    resource: {
                      type: "string" as const,
                      description: "API resource being accessed (optional)",
                    },
                    method: {
                      type: "string" as const,
                      description: "HTTP method being used (optional)",
                    },
                  },
                },
                auth: {
                  type: "object" as const,
                  description: "Optional SIP-018 structured data signature for authentication",
                  properties: {
                    signature: {
                      type: "string" as const,
                      description: "RSV signature of the structured data",
                      example: "0x1234...",
                    },
                    message: {
                      type: "object" as const,
                      required: ["action", "nonce", "expiry"],
                      properties: {
                        action: {
                          type: "string" as const,
                          description: "Action being performed (should be 'relay')",
                          example: "relay",
                        },
                        nonce: {
                          type: "string" as const,
                          description: "Unix timestamp ms for replay protection",
                          example: "1708099200000",
                        },
                        expiry: {
                          type: "string" as const,
                          description: "Expiry timestamp (unix ms) for time-bound authorization",
                          example: "1708185600000",
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
    responses: {
      "200": {
        description: "Transaction sponsored and settled successfully",
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
                  example: "550e8400-e29b-41d4-a716-446655440000",
                },
                txid: {
                  type: "string" as const,
                  description: "Transaction ID",
                  example: "0x1234...",
                },
                explorerUrl: {
                  type: "string" as const,
                  description: "Link to view transaction on Hiro Explorer",
                  example: "https://explorer.hiro.so/txid/0x1234...?chain=testnet",
                },
                settlement: {
                  type: "object" as const,
                  properties: {
                    success: { type: "boolean" as const },
                    status: {
                      type: "string" as const,
                      enum: ["pending", "confirmed", "failed"],
                    },
                    sender: { type: "string" as const, description: "Sender Stacks address (c32check-encoded, human-readable)" },
                    recipient: { type: "string" as const },
                    amount: { type: "string" as const },
                    blockHeight: { type: "number" as const },
                  },
                },
                sponsoredTx: {
                  type: "string" as const,
                  description: "Hex-encoded fully-sponsored transaction (can be used as X-PAYMENT header value)",
                  example: "0x00000001...",
                },
                receiptId: {
                  type: "string" as const,
                  format: "uuid",
                  description: "Receipt token for verifying payment via GET /verify/:receiptId",
                  example: "550e8400-e29b-41d4-a716-446655440000",
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "401": { ...Error401Response, description: "Authentication failed (invalid or expired SIP-018 signature)" },
      "429": { ...Error429Response, description: "Rate limit exceeded" },
      "500": Error500Response,
      "502": { ...Error502Response, description: "Broadcast or network error" },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Relay request received");

    // Initialize stats service for metrics recording
    const statsService = new StatsService(c.env.RELAY_KV, logger);

    try {
      // Parse request body
      const body = (await c.req.json()) as RelayRequest;

      // Validate required fields
      if (!body.transaction) {
        await statsService.recordError("validation");
        return this.err(c, {
          error: "Missing transaction field",
          code: "MISSING_TRANSACTION",
          status: 400,
          retryable: false,
        });
      }

      if (!body.settle) {
        await statsService.recordError("validation");
        return this.err(c, {
          error: "Missing settle options",
          code: "MISSING_SETTLE_OPTIONS",
          status: 400,
          retryable: false,
        });
      }

      // Optional: Verify SIP-018 auth if provided
      if (body.auth) {
        const stxVerifyService = new StxVerifyService(logger, c.env.STACKS_NETWORK);
        const authError = stxVerifyService.verifySip018Auth(body.auth, "relay");
        if (authError) {
          await statsService.recordError("validation");
          return this.err(c, {
            error: authError.error,
            code: authError.code,
            status: 401,
            retryable: false,
          });
        }
      }

      // Initialize services
      const sponsorService = new SponsorService(c.env, logger);
      const settlementService = new SettlementService(c.env, logger);

      // Validate settle options
      const settleValidation = settlementService.validateSettleOptions(
        body.settle
      );
      if (settleValidation.valid === false) {
        await statsService.recordError("validation");
        return this.err(c, {
          error: settleValidation.error,
          code: "INVALID_SETTLE_OPTIONS",
          status: 400,
          details: settleValidation.details,
          retryable: false,
        });
      }

      // Validate and deserialize transaction
      const validation = sponsorService.validateTransaction(body.transaction);
      if (validation.valid === false) {
        await statsService.recordError("validation");
        // Determine error code based on validation failure
        const code = validation.error === "Transaction must be sponsored"
          ? "NOT_SPONSORED"
          : "INVALID_TRANSACTION";
        return this.err(c, {
          error: validation.error,
          code,
          status: 400,
          details: validation.details,
          retryable: false,
        });
      }

      // Check rate limit using sender address from transaction
      if (!checkRateLimit(validation.senderAddress)) {
        logger.warn("Rate limit exceeded", { sender: validation.senderAddress });
        await statsService.recordError("rateLimit");
        return this.err(c, {
          error: "Rate limit exceeded",
          code: "RATE_LIMIT_EXCEEDED",
          status: 429,
          details: `Maximum ${RATE_LIMIT} requests per minute`,
          retryable: true,
          retryAfter: 60,
        });
      }

      // Step A — Dedup check on original tx (stable across retries with different sponsor nonces)
      const dedupResult = await settlementService.checkDedup(body.transaction);
      if (dedupResult) {
        logger.info("Dedup hit, returning cached result", {
          txid: dedupResult.txid,
          status: dedupResult.status,
        });
        return this.okWithTx(c, {
          txid: dedupResult.txid,
          settlement: {
            success: true,
            status: dedupResult.status,
            sender: dedupResult.sender,
            recipient: dedupResult.recipient,
            amount: dedupResult.amount,
            ...(dedupResult.blockHeight ? { blockHeight: dedupResult.blockHeight } : {}),
          },
          ...(dedupResult.sponsoredTx ? { sponsoredTx: dedupResult.sponsoredTx } : {}),
          ...(dedupResult.receiptId ? { receiptId: dedupResult.receiptId } : {}),
        });
      }

      // Step B — Sponsor the transaction
      const sponsorResult = await sponsorService.sponsorTransaction(
        validation.transaction
      );
      if (sponsorResult.success === false) {
        await statsService.recordError("sponsoring");
        const code = sponsorResult.error === "Service not configured"
          ? "SPONSOR_CONFIG_ERROR"
          : "SPONSOR_FAILED";
        return this.err(c, {
          error: sponsorResult.error,
          code,
          status: 500,
          details: sponsorResult.details,
          retryable: code === "SPONSOR_FAILED",
        });
      }

      // Step C — Verify payment parameters locally
      const verifyResult = settlementService.verifyPaymentParams(
        sponsorResult.sponsoredTxHex,
        body.settle
      );
      if (!verifyResult.valid) {
        await statsService.recordError("validation");
        return this.err(c, {
          error: verifyResult.error,
          code: "SETTLEMENT_VERIFICATION_FAILED",
          status: 400,
          details: verifyResult.details,
          retryable: false,
        });
      }

      // Step D — Broadcast and poll for confirmation (up to 60s)
      const broadcastResult = await settlementService.broadcastAndConfirm(
        verifyResult.data.transaction
      );
      if ("error" in broadcastResult) {
        await statsService.recordError("internal");
        // Record fee even for failed broadcasts — sponsor already paid
        const tokenTypeFailed = body.settle.tokenType || "STX";
        await statsService.recordTransaction({
          success: false,
          tokenType: tokenTypeFailed,
          amount: body.settle.minAmount,
          fee: sponsorResult.fee,
        });
        // Distinguish retryable broadcast failures from non-retryable on-chain failures
        const code = broadcastResult.retryable ? "SETTLEMENT_BROADCAST_FAILED" : "SETTLEMENT_FAILED";
        return this.err(c, {
          error: broadcastResult.error,
          code,
          status: broadcastResult.retryable ? 502 : 422,
          details: broadcastResult.details,
          retryable: broadcastResult.retryable,
          ...(broadcastResult.retryable ? { retryAfter: 5 } : {}),
        });
      }

      // Step E — Record successful transaction stats
      const tokenType = body.settle.tokenType || "STX";
      await statsService.recordTransaction({
        success: true,
        tokenType,
        amount: body.settle.minAmount,
        fee: sponsorResult.fee,
      });

      // Step F — Build settlement result and store payment receipt
      // Convert signer hash160 to human-readable Stacks address
      const senderAddress = settlementService.senderToAddress(
        verifyResult.data.transaction,
        c.env.STACKS_NETWORK
      );
      const settlement: SettlementResult = {
        success: true,
        status: broadcastResult.status,
        sender: senderAddress,
        recipient: verifyResult.data.recipient,
        amount: verifyResult.data.amount,
        ...(broadcastResult.status === "confirmed"
          ? { blockHeight: broadcastResult.blockHeight }
          : {}),
      };

      const receiptService = new ReceiptService(c.env.RELAY_KV, logger);
      const receiptId = crypto.randomUUID();
      const storedReceipt = await receiptService.storeReceipt({
        receiptId,
        senderAddress: validation.senderAddress,
        sponsoredTx: sponsorResult.sponsoredTxHex,
        fee: sponsorResult.fee,
        txid: broadcastResult.txid,
        settlement,
        settleOptions: body.settle,
      });

      // Step G — Record dedup entry keyed on original tx for idempotent retries
      await settlementService.recordDedup(body.transaction, {
        txid: broadcastResult.txid,
        receiptId: storedReceipt ? receiptId : undefined,
        status: broadcastResult.status,
        sender: senderAddress,
        recipient: verifyResult.data.recipient,
        amount: verifyResult.data.amount,
        sponsoredTx: sponsorResult.sponsoredTxHex,
        ...(broadcastResult.status === "confirmed"
          ? { blockHeight: broadcastResult.blockHeight }
          : {}),
      });

      // Step H — Log and return
      logger.info("Transaction sponsored and settled", {
        txid: broadcastResult.txid,
        sender: senderAddress,
        settlement_status: broadcastResult.status,
        receiptId: storedReceipt ? receiptId : undefined,
      });

      return this.okWithTx(c, {
        txid: broadcastResult.txid,
        settlement,
        sponsoredTx: sponsorResult.sponsoredTxHex,
        // Only return receiptId if storage succeeded
        ...(storedReceipt ? { receiptId } : {}),
      });
    } catch (e) {
      logger.error("Unexpected error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      await statsService.recordError("internal");
      return this.err(c, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true, // Unexpected errors might be transient
        retryAfter: 5,
      });
    }
  }
}
