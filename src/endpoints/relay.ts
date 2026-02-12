import { BaseEndpoint } from "./BaseEndpoint";
import { SponsorService, FacilitatorService, StatsService, ReceiptService } from "../services";
import { checkRateLimit, RATE_LIMIT } from "../middleware";
import type { AppContext, RelayRequest } from "../types";
import {
  Error400Response,
  Error429Response,
  Error500Response,
  Error502Response,
  Error504Response,
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
      "Accepts a pre-signed sponsored transaction, sponsors it with the relay's key, and calls the x402 facilitator for settlement verification.",
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
                    sender: { type: "string" as const },
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
      "429": { ...Error429Response, description: "Rate limit exceeded" },
      "500": Error500Response,
      "502": { ...Error502Response, description: "Facilitator error" },
      "504": Error504Response,
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

      // Initialize services
      const sponsorService = new SponsorService(c.env, logger);
      const facilitatorService = new FacilitatorService(c.env, logger);

      // Validate settle options
      const settleValidation = facilitatorService.validateSettleOptions(
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

      // Sponsor the transaction
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
          retryable: code === "SPONSOR_FAILED", // Config errors are not retryable
        });
      }

      // Call facilitator to settle
      const settleResult = await facilitatorService.settle(
        sponsorResult.sponsoredTxHex,
        body.settle
      );

      if (settleResult.success === false) {
        await statsService.recordError("facilitator");

        // Record fee even for failed settlements - sponsor already paid
        const tokenType = body.settle.tokenType || "STX";
        await statsService.recordTransaction({
          success: false,
          tokenType,
          amount: body.settle.minAmount,
          fee: sponsorResult.fee,
        });

        // Determine error code and retry guidance based on HTTP status
        let code: "FACILITATOR_TIMEOUT" | "FACILITATOR_ERROR" | "FACILITATOR_INVALID_RESPONSE" | "SETTLEMENT_FAILED";
        let retryable = false;
        let retryAfter: number | undefined;

        if (settleResult.httpStatus === 504) {
          code = "FACILITATOR_TIMEOUT";
          retryable = true;
          retryAfter = 5; // Wait 5 seconds before retrying timeout
        } else if (settleResult.httpStatus === 502) {
          code = "FACILITATOR_ERROR";
          retryable = true;
          retryAfter = 5; // Wait 5 seconds before retrying gateway error
        } else if (settleResult.error === "Settlement response invalid") {
          code = "FACILITATOR_INVALID_RESPONSE";
          retryable = true;
          retryAfter = 10;
        } else {
          code = "SETTLEMENT_FAILED";
          retryable = false; // Settlement validation failures are not retryable
        }

        // SETTLEMENT_FAILED is a 400 (bad request), others use httpStatus
        const status = code === "SETTLEMENT_FAILED" ? 400 : (settleResult.httpStatus || 500);

        return this.err(c, {
          error: settleResult.error,
          code,
          status,
          details: settleResult.details,
          retryable,
          retryAfter,
        });
      }

      // Record successful transaction with fee
      const tokenType = body.settle.tokenType || "STX";
      await statsService.recordTransaction({
        success: true,
        tokenType,
        amount: body.settle.minAmount,
        fee: sponsorResult.fee,
      });

      // Generate receipt ID for payment verification
      const receiptId = crypto.randomUUID();

      // Store payment receipt for future verification (best-effort)
      const receiptService = new ReceiptService(c.env.RELAY_KV, logger);
      await receiptService.storeReceipt({
        receiptId,
        senderAddress: validation.senderAddress,
        sponsoredTx: sponsorResult.sponsoredTxHex,
        fee: sponsorResult.fee,
        txid: settleResult.txid!,
        settlement: settleResult.settlement!,
        settleOptions: body.settle,
      });

      logger.info("Transaction sponsored and settled", {
        txid: settleResult.txid,
        sender: validation.senderAddress,
        settlement_status: settleResult.settlement?.status,
        receiptId,
      });

      return this.okWithTx(c, {
        txid: settleResult.txid!,
        settlement: settleResult.settlement,
        sponsoredTx: sponsorResult.sponsoredTxHex,
        receiptId,
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
