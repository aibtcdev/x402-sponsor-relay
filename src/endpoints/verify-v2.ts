import { BaseEndpoint } from "./BaseEndpoint";
import { SettlementService } from "../services";
import type {
  AppContext,
  X402VerifyRequestV2,
  X402VerifyResponseV2,
  SettleOptions,
} from "../types";
import { CAIP2_NETWORKS, X402_V2_ERROR_CODES } from "../types";

/**
 * V2 Verify endpoint - x402 V2 facilitator verify
 * POST /verify (spec section 7.1)
 *
 * Validates the payment locally without broadcasting to the network.
 * Returns HTTP 200 for all results (valid or invalid).
 */
export class VerifyV2 extends BaseEndpoint {
  schema = {
    tags: ["x402 V2"],
    summary: "Verify an x402 V2 payment (local validation only)",
    description:
      "x402 V2 facilitator verify endpoint (spec section 7.1). Validates payment parameters by deserializing the transaction locally — does NOT broadcast. Returns HTTP 200 for all results; check isValid field.",
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
        description: "Verification result (valid or invalid — check isValid field)",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["isValid"],
              properties: {
                isValid: { type: "boolean" as const },
                invalidReason: {
                  type: "string" as const,
                  description: "Reason for invalidity if isValid is false",
                  example: "recipient_mismatch",
                },
                payer: {
                  type: "string" as const,
                  description: "Payer Stacks address (if determinable from transaction)",
                  example: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
                },
              },
            },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("x402 V2 verify request received");

    const network = CAIP2_NETWORKS[c.env.STACKS_NETWORK];

    try {
      // Parse request body
      let body: X402VerifyRequestV2;
      try {
        body = (await c.req.json()) as X402VerifyRequestV2;
      } catch {
        const response: X402VerifyResponseV2 = {
          isValid: false,
          invalidReason: X402_V2_ERROR_CODES.INVALID_PAYLOAD,
        };
        return c.json(response, 200);
      }

      // Validate required top-level fields
      if (!body.paymentPayload || !body.paymentRequirements) {
        const response: X402VerifyResponseV2 = {
          isValid: false,
          invalidReason: X402_V2_ERROR_CODES.INVALID_PAYLOAD,
        };
        return c.json(response, 200);
      }

      // Validate paymentRequirements has required fields
      const req = body.paymentRequirements;
      if (!req.network || !req.payTo || !req.amount) {
        const response: X402VerifyResponseV2 = {
          isValid: false,
          invalidReason: X402_V2_ERROR_CODES.INVALID_PAYMENT_REQUIREMENTS,
        };
        return c.json(response, 200);
      }

      // Validate network matches relay's configured network
      if (req.network !== network) {
        logger.warn("Network mismatch in verify", {
          expected: network,
          received: req.network,
        });
        const response: X402VerifyResponseV2 = {
          isValid: false,
          invalidReason: X402_V2_ERROR_CODES.INVALID_NETWORK,
        };
        return c.json(response, 200);
      }

      // Map asset to internal token type
      const settlementService = new SettlementService(c.env, logger);
      const tokenType = settlementService.mapAssetToTokenType(req.asset || "STX");
      if (tokenType === null) {
        logger.warn("Unsupported asset in verify", { asset: req.asset });
        const response: X402VerifyResponseV2 = {
          isValid: false,
          invalidReason: X402_V2_ERROR_CODES.UNSUPPORTED_SCHEME,
        };
        return c.json(response, 200);
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
        const response: X402VerifyResponseV2 = {
          isValid: false,
          invalidReason: X402_V2_ERROR_CODES.INVALID_PAYLOAD,
        };
        return c.json(response, 200);
      }

      // Verify payment parameters locally (no broadcast)
      const verifyResult = settlementService.verifyPaymentParams(txHex, settleOptions);

      if (!verifyResult.valid) {
        logger.info("Payment verification failed", { error: verifyResult.error });

        // Map internal error to V2 invalidReason
        let invalidReason: string = X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE;
        if (verifyResult.error === "Recipient mismatch") {
          invalidReason = X402_V2_ERROR_CODES.RECIPIENT_MISMATCH;
        } else if (verifyResult.error === "Insufficient payment amount") {
          invalidReason = X402_V2_ERROR_CODES.AMOUNT_INSUFFICIENT;
        } else if (verifyResult.error === "Token type mismatch") {
          invalidReason = X402_V2_ERROR_CODES.SENDER_MISMATCH;
        }

        const response: X402VerifyResponseV2 = {
          isValid: false,
          invalidReason,
        };
        return c.json(response, 200);
      }

      // Attempt to convert signer to human-readable address for the payer field
      let payer: string | undefined;
      try {
        payer = settlementService.senderToAddress(
          verifyResult.data.transaction,
          c.env.STACKS_NETWORK
        );
      } catch (e) {
        logger.warn("Could not convert signer to address", {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      logger.info("x402 V2 verify succeeded", { payer });

      const response: X402VerifyResponseV2 = {
        isValid: true,
        ...(payer ? { payer } : {}),
      };
      return c.json(response, 200);
    } catch (e) {
      logger.error("Unexpected verify error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      const response: X402VerifyResponseV2 = {
        isValid: false,
        invalidReason: X402_V2_ERROR_CODES.UNEXPECTED_VERIFY_ERROR,
      };
      return c.json(response, 200);
    }
  }
}
