import { BaseEndpoint } from "./BaseEndpoint";
import {
  validateV2Request,
  mapVerifyErrorToV2Code,
  V2_REQUEST_BODY_SCHEMA,
  V2_ERROR_RESPONSE_SCHEMA,
} from "./v2-helpers";
import { StatsService } from "../services";
import type { AppContext, X402SettlementResponseV2 } from "../types";
import { CAIP2_NETWORKS, X402_V2_ERROR_CODES } from "../types";

/**
 * Settle endpoint - x402 V2 facilitator settle
 * POST /settle (spec section 7.2)
 *
 * Verifies payment parameters locally and broadcasts the transaction.
 * Does NOT sponsor -- expects a pre-sponsored transaction in paymentPayload.
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
            schema: V2_REQUEST_BODY_SCHEMA,
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
            schema: V2_ERROR_RESPONSE_SCHEMA,
          },
        },
      },
      "500": {
        description: "Unexpected internal error",
        content: {
          "application/json": {
            schema: {
              ...V2_ERROR_RESPONSE_SCHEMA,
              properties: {
                ...V2_ERROR_RESPONSE_SCHEMA.properties,
                errorReason: { type: "string" as const, example: "unexpected_settle_error" },
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

    // Initialize stats service for metrics recording
    const statsService = new StatsService(c.env.RELAY_KV, logger);

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
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return v2Error(X402_V2_ERROR_CODES.INVALID_PAYLOAD, 400);
      }

      // Validate V2 request structure (shared with /verify)
      const validation = validateV2Request(body, c.env, logger);
      if (!validation.valid) {
        await statsService.recordError("validation");
        return v2Error(validation.error.errorReason, validation.error.status);
      }

      const { settleOptions, txHex, settlementService } = validation.data;

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

      // Verify payment parameters locally
      const verifyResult = settlementService.verifyPaymentParams(txHex, settleOptions);
      if (!verifyResult.valid) {
        logger.warn("Payment verification failed", { error: verifyResult.error });
        await statsService.recordError("validation");
        return v2Error(mapVerifyErrorToV2Code(verifyResult.error), 200);
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
        await statsService.recordTransaction({
          success: false,
          tokenType: settleOptions.tokenType ?? "STX",
          amount: settleOptions.minAmount,
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

      // Record successful transaction stats
      await statsService.recordTransaction({
        success: true,
        tokenType: settleOptions.tokenType ?? "STX",
        amount: settleOptions.minAmount,
        // No fee: /settle does not sponsor, it only broadcasts pre-sponsored txs
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
      await statsService.recordError("internal");
      return v2Error(X402_V2_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, 500);
    }
  }
}
