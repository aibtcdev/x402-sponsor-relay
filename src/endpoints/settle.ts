import { BaseEndpoint } from "./BaseEndpoint";
import { SettlementService } from "../services";
import type {
  AppContext,
  X402SettleRequestV2,
  X402SettlementResponseV2,
  SettleOptions,
} from "../types";
import { CAIP2_NETWORKS, X402_V2_ERROR_CODES } from "../types";

/**
 * Settle endpoint - x402 V2 facilitator settle
 * POST /settle (spec section 7.2)
 *
 * Verifies payment parameters locally and broadcasts the transaction.
 * Does NOT sponsor — expects a pre-sponsored transaction in paymentPayload.
 * Returns x402 V2 spec-compliant settlement response.
 */
export class Settle extends BaseEndpoint {
  schema = {
    tags: ["x402 V2"],
    summary: "Settle an x402 V2 payment",
    description:
      "x402 V2 facilitator settle endpoint (spec section 7.2). Verifies payment parameters locally and broadcasts the transaction to the Stacks network. Does not sponsor — expects a fully-sponsored transaction in paymentPayload.payload.transaction. Returns HTTP 200 for all settlement results (success or failure); HTTP 400 for invalid request schema.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["paymentPayload", "paymentRequirements"],
              properties: {
                x402Version: {
                  type: "number" as const,
                  description: "x402 protocol version (optional at top level, library compat)",
                  example: 2,
                },
                paymentPayload: {
                  type: "object" as const,
                  description: "Client payment authorization",
                  required: ["payload"],
                  properties: {
                    x402Version: { type: "number" as const },
                    payload: {
                      type: "object" as const,
                      required: ["transaction"],
                      properties: {
                        transaction: {
                          type: "string" as const,
                          description: "Hex-encoded signed sponsored transaction",
                          example: "0x00000001...",
                        },
                      },
                    },
                  },
                },
                paymentRequirements: {
                  type: "object" as const,
                  description: "Server payment requirements to validate against",
                  required: ["network", "payTo", "amount", "asset"],
                  properties: {
                    scheme: { type: "string" as const, example: "exact" },
                    network: { type: "string" as const, description: "CAIP-2 network identifier", example: "stacks:2147483648" },
                    amount: { type: "string" as const, description: "Required amount in smallest unit", example: "1000000" },
                    asset: { type: "string" as const, description: "Asset identifier (STX, sBTC, or CAIP-19 contract address)", example: "STX" },
                    payTo: { type: "string" as const, description: "Recipient Stacks address", example: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE" },
                    maxTimeoutSeconds: { type: "number" as const, example: 60 },
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
        description: "Settlement result (success or failure — check success field)",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["success", "transaction", "network"],
              properties: {
                success: { type: "boolean" as const },
                errorReason: {
                  type: "string" as const,
                  description: "Error reason code if settlement failed",
                  example: "recipient_mismatch",
                },
                payer: {
                  type: "string" as const,
                  description: "Payer Stacks address (present on success or partial failure)",
                  example: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
                },
                transaction: {
                  type: "string" as const,
                  description: "Transaction ID on the network (empty string on pre-broadcast failure)",
                  example: "0x1234...",
                },
                network: {
                  type: "string" as const,
                  description: "CAIP-2 network identifier",
                  example: "stacks:2147483648",
                },
              },
            },
          },
        },
      },
      "400": {
        description: "Invalid request — missing or malformed required fields",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["success", "errorReason", "transaction", "network"],
              properties: {
                success: { type: "boolean" as const, example: false },
                errorReason: { type: "string" as const, example: "invalid_payload" },
                transaction: { type: "string" as const, example: "" },
                network: { type: "string" as const, example: "stacks:2147483648" },
              },
            },
          },
        },
      },
      "500": {
        description: "Unexpected internal error",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["success", "errorReason", "transaction", "network"],
              properties: {
                success: { type: "boolean" as const, example: false },
                errorReason: { type: "string" as const, example: "unexpected_settle_error" },
                transaction: { type: "string" as const, example: "" },
                network: { type: "string" as const, example: "stacks:2147483648" },
              },
            },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("x402 V2 settle request received");

    const network = CAIP2_NETWORKS[c.env.STACKS_NETWORK];

    // Helper to return V2-shaped error responses
    const v2Error = (
      errorReason: string,
      status: 200 | 400 | 500,
      payer?: string
    ): Response => {
      const body: X402SettlementResponseV2 = {
        success: false,
        errorReason,
        transaction: "",
        network,
        ...(payer ? { payer } : {}),
      };
      return c.json(body, status);
    };

    try {
      // Parse request body
      let body: X402SettleRequestV2;
      try {
        body = (await c.req.json()) as X402SettleRequestV2;
      } catch {
        return v2Error(X402_V2_ERROR_CODES.INVALID_PAYLOAD, 400);
      }

      // Validate required top-level fields
      if (!body.paymentPayload || !body.paymentRequirements) {
        return v2Error(X402_V2_ERROR_CODES.INVALID_PAYLOAD, 400);
      }

      // Validate paymentRequirements has required fields
      const req = body.paymentRequirements;
      if (!req.network || !req.payTo || !req.amount) {
        return v2Error(X402_V2_ERROR_CODES.INVALID_PAYMENT_REQUIREMENTS, 400);
      }

      // Validate network matches relay's configured network
      if (req.network !== network) {
        logger.warn("Network mismatch", {
          expected: network,
          received: req.network,
        });
        return v2Error(X402_V2_ERROR_CODES.INVALID_NETWORK, 400);
      }

      // Map asset to internal token type
      const settlementService = new SettlementService(c.env, logger);
      const tokenType = settlementService.mapAssetToTokenType(req.asset || "STX");
      if (tokenType === null) {
        logger.warn("Unsupported asset", { asset: req.asset });
        return v2Error(X402_V2_ERROR_CODES.UNSUPPORTED_SCHEME, 400);
      }

      // Build internal settle options from paymentRequirements
      const settleOptions: SettleOptions = {
        expectedRecipient: req.payTo,
        minAmount: req.amount,
        tokenType,
      };

      // Extract transaction hex from payload
      const txHex = body.paymentPayload?.payload?.transaction;
      if (!txHex) {
        return v2Error(X402_V2_ERROR_CODES.INVALID_PAYLOAD, 400);
      }

      // Check dedup — return cached result if available
      const dedupResult = await settlementService.checkDedup(txHex);
      if (dedupResult) {
        logger.info("Dedup hit, returning cached settle result", {
          txid: dedupResult.txid,
          status: dedupResult.status,
        });
        const response: X402SettlementResponseV2 = {
          success: true,
          payer: dedupResult.sender,
          transaction: dedupResult.txid,
          network,
        };
        return c.json(response, 200);
      }

      // Verify payment parameters locally (no broadcast)
      const verifyResult = settlementService.verifyPaymentParams(txHex, settleOptions);
      if (!verifyResult.valid) {
        logger.warn("Payment verification failed", { error: verifyResult.error });

        // Map internal error to V2 error reason
        let errorReason: string = X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE;
        if (verifyResult.error === "Recipient mismatch") {
          errorReason = X402_V2_ERROR_CODES.RECIPIENT_MISMATCH;
        } else if (verifyResult.error === "Insufficient payment amount") {
          errorReason = X402_V2_ERROR_CODES.AMOUNT_INSUFFICIENT;
        } else if (verifyResult.error === "Token type mismatch") {
          errorReason = X402_V2_ERROR_CODES.SENDER_MISMATCH;
        }

        return v2Error(errorReason, 200);
      }

      // Broadcast and poll for confirmation
      const broadcastResult = await settlementService.broadcastAndConfirm(
        verifyResult.data.transaction
      );

      if ("error" in broadcastResult) {
        logger.warn("Broadcast/confirm failed", {
          error: broadcastResult.error,
          retryable: broadcastResult.retryable,
        });
        const errorReason = broadcastResult.retryable
          ? X402_V2_ERROR_CODES.BROADCAST_FAILED
          : X402_V2_ERROR_CODES.TRANSACTION_FAILED;
        return v2Error(errorReason, 200);
      }

      // Convert signer hash160 to human-readable Stacks address
      const payer = settlementService.senderToAddress(
        verifyResult.data.transaction,
        c.env.STACKS_NETWORK
      );

      // Record dedup for idempotent retries
      await settlementService.recordDedup(txHex, {
        txid: broadcastResult.txid,
        status: broadcastResult.status,
        sender: payer,
        recipient: verifyResult.data.recipient,
        amount: verifyResult.data.amount,
        ...(broadcastResult.status === "confirmed"
          ? { blockHeight: broadcastResult.blockHeight }
          : {}),
      });

      logger.info("x402 V2 settle succeeded", {
        txid: broadcastResult.txid,
        payer,
        status: broadcastResult.status,
      });

      const response: X402SettlementResponseV2 = {
        success: true,
        payer,
        transaction: broadcastResult.txid,
        network,
      };
      return c.json(response, 200);
    } catch (e) {
      logger.error("Unexpected settle error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return v2Error(X402_V2_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, 500);
    }
  }
}
