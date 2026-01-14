import { BaseEndpoint } from "./BaseEndpoint";
import { SponsorService } from "../services/sponsor";
import { FacilitatorService } from "../services/facilitator";
import type { AppContext, RelayRequest } from "../types";

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
                txid: {
                  type: "string" as const,
                  description: "Transaction ID",
                  example: "0x1234...",
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
              },
            },
          },
        },
      },
      "400": {
        description: "Invalid request",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                error: { type: "string" as const },
                details: { type: "string" as const },
              },
            },
          },
        },
      },
      "429": {
        description: "Rate limit exceeded",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                error: { type: "string" as const },
                details: { type: "string" as const },
              },
            },
          },
        },
      },
      "500": {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                error: { type: "string" as const },
                details: { type: "string" as const },
              },
            },
          },
        },
      },
      "502": {
        description: "Facilitator error",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                error: { type: "string" as const },
                details: { type: "string" as const },
              },
            },
          },
        },
      },
      "504": {
        description: "Facilitator timeout",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                error: { type: "string" as const },
                details: { type: "string" as const },
              },
            },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Relay request received");

    try {
      // Parse request body
      const body = (await c.req.json()) as RelayRequest;

      // Validate required fields
      if (!body.transaction) {
        return this.errorResponse(c, "Missing transaction field", 400);
      }

      if (!body.settle) {
        return this.errorResponse(c, "Missing settle options", 400);
      }

      // Initialize services
      const sponsorService = new SponsorService(c.env, logger);
      const facilitatorService = new FacilitatorService(c.env, logger);

      // Validate settle options
      const settleValidation = facilitatorService.validateSettleOptions(
        body.settle
      );
      if (settleValidation.valid === false) {
        return this.errorResponse(c, settleValidation.error, 400, settleValidation.details);
      }

      // Validate and deserialize transaction
      const validation = sponsorService.validateTransaction(body.transaction);
      if (!validation.valid) {
        return this.errorResponse(
          c,
          validation.error!,
          400,
          validation.details
        );
      }

      // Store sender address in context for rate limiting middleware
      // (already handled before this endpoint is called)

      // Sponsor the transaction
      const sponsorResult = await sponsorService.sponsorTransaction(
        validation.transaction!
      );
      if (!sponsorResult.success) {
        return this.errorResponse(
          c,
          sponsorResult.error!,
          500,
          sponsorResult.details
        );
      }

      // Call facilitator to settle
      const settleResult = await facilitatorService.settle(
        sponsorResult.sponsoredTxHex!,
        body.settle
      );

      if (!settleResult.success) {
        return this.errorResponse(
          c,
          settleResult.error!,
          settleResult.httpStatus || 500,
          settleResult.details
        );
      }

      logger.info("Transaction sponsored and settled", {
        txid: settleResult.txid,
        sender: validation.senderAddress,
        settlement_status: settleResult.settlement?.status,
      });

      return c.json({
        txid: settleResult.txid,
        settlement: settleResult.settlement,
      });
    } catch (e) {
      logger.error("Unexpected error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.errorResponse(
        c,
        "Internal server error",
        500,
        e instanceof Error ? e.message : "Unknown error"
      );
    }
  }
}
