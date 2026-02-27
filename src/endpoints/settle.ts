import { BaseEndpoint } from "./BaseEndpoint";
import {
  validateV2Request,
  mapVerifyErrorToV2Code,
  V2_REQUEST_BODY_SCHEMA,
  V2_ERROR_RESPONSE_SCHEMA,
} from "./v2-helpers";
import { StatsService, PaymentIdService } from "../services";
import type { AppContext, X402SettlementResponseV2, X402SettleRequestV2 } from "../types";
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

    const statsService = new StatsService(c.env, logger);
    const paymentIdService = new PaymentIdService(c.env.RELAY_KV, logger);

    const network = CAIP2_NETWORKS[c.env.STACKS_NETWORK];

    const v2Error = (
      errorReason: string,
      status: 200 | 400 | 409 | 500,
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
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return v2Error(X402_V2_ERROR_CODES.INVALID_PAYLOAD, 400);
      }

      const validation = validateV2Request(body, c.env, logger);
      if (!validation.valid) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return v2Error(validation.error.errorReason, validation.error.status);
      }

      const { settleOptions, txHex, settlementService, paymentIdentifier } = validation.data;

      // Payment-identifier cache check (client-controlled idempotency, higher priority than dedup)
      let paymentIdPayloadHash: string | undefined;
      if (paymentIdentifier) {
        const rawBody = body as X402SettleRequestV2;
        paymentIdPayloadHash = await paymentIdService.computePayloadHash(
          rawBody.paymentPayload,
          rawBody.paymentRequirements
        );
        const cacheResult = await paymentIdService.checkPaymentId(paymentIdentifier, paymentIdPayloadHash);
        if (cacheResult.status === "hit") {
          logger.info("payment-identifier cache hit, returning cached settle response", {
            id: paymentIdentifier,
          });
          return c.json(cacheResult.response as X402SettlementResponseV2, 200);
        }
        if (cacheResult.status === "conflict") {
          logger.warn("payment-identifier conflict detected", { id: paymentIdentifier });
          return v2Error(X402_V2_ERROR_CODES.PAYMENT_IDENTIFIER_CONFLICT, 409);
        }
      }

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

      const verifyResult = settlementService.verifyPaymentParams(txHex, settleOptions);
      if (!verifyResult.valid) {
        logger.warn("Payment verification failed", { error: verifyResult.error });
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("settle", true, { tokenType: settleOptions.tokenType, amount: settleOptions.minAmount }).catch(() => {}));
        return v2Error(mapVerifyErrorToV2Code(verifyResult.error), 200);
      }

      // Broadcast and poll for confirmation.
      // Cap poll time to caller's maxTimeoutSeconds (from paymentRequirements)
      // so the relay responds before the caller's own timeout fires.
      // Reserve 5s for broadcast overhead and response serialization.
      const SETTLE_OVERHEAD_MS = 5_000;
      const maxPollTimeMs = validation.data.maxTimeoutSeconds != null
        ? Math.max(validation.data.maxTimeoutSeconds * 1000 - SETTLE_OVERHEAD_MS, 1_000)
        : undefined;
      const broadcastResult = await settlementService.broadcastAndConfirm(
        verifyResult.data.transaction,
        maxPollTimeMs
      );

      if ("error" in broadcastResult) {
        if (broadcastResult.nonceConflict) {
          logger.info("Broadcast rejected due to client nonce conflict (pre-signed tx)", {
            error: broadcastResult.error,
            senderSigner: verifyResult.data.sender,
          });
          c.executionCtx.waitUntil(statsService.logFailure("settle", true, { tokenType: settleOptions.tokenType, amount: settleOptions.minAmount }).catch(() => {}));
        } else {
          logger.warn("Broadcast/confirm failed", {
            error: broadcastResult.error,
            retryable: broadcastResult.retryable,
          });
          c.executionCtx.waitUntil(statsService.logFailure("settle", false, { tokenType: settleOptions.tokenType, amount: settleOptions.minAmount }).catch(() => {}));
        }

        let errorReason: string;
        if (broadcastResult.nonceConflict) {
          errorReason = X402_V2_ERROR_CODES.CONFLICTING_NONCE;
        } else if (broadcastResult.retryable) {
          errorReason = X402_V2_ERROR_CODES.BROADCAST_FAILED;
        } else {
          errorReason = X402_V2_ERROR_CODES.TRANSACTION_FAILED;
        }
        return v2Error(errorReason, 200);
      }

      const payer = settlementService.senderToAddress(
        verifyResult.data.transaction,
        c.env.STACKS_NETWORK
      );

      const confirmedBlockHeight =
        broadcastResult.status === "confirmed"
          ? broadcastResult.blockHeight
          : undefined;

      await settlementService.recordDedup(txHex, {
        txid: broadcastResult.txid,
        status: broadcastResult.status,
        sender: payer,
        recipient: verifyResult.data.recipient,
        amount: verifyResult.data.amount,
        blockHeight: confirmedBlockHeight,
      });

      // Record successful transaction stats (fire-and-forget, never blocks response)
      // No fee: /settle does not sponsor, it only broadcasts pre-sponsored txs
      c.executionCtx.waitUntil(
        statsService.logTransaction({
          timestamp: new Date().toISOString(),
          endpoint: "settle",
          success: true,
          tokenType: settleOptions.tokenType ?? "STX",
          amount: settleOptions.minAmount,
          txid: broadcastResult.txid,
          sender: payer,
          recipient: verifyResult.data.recipient,
          status: broadcastResult.status,
          blockHeight: confirmedBlockHeight,
        }).catch(() => {})
      );

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
        ...(paymentIdentifier
          ? { extensions: { "payment-identifier": { info: { id: paymentIdentifier } } } }
          : {}),
      };

      // Cache the result under the payment-identifier key for idempotent retries
      if (paymentIdentifier && paymentIdPayloadHash) {
        c.executionCtx.waitUntil(
          paymentIdService.recordPaymentId(paymentIdentifier, paymentIdPayloadHash, response).catch(() => {})
        );
      }

      return c.json(response, 200);
    } catch (e) {
      logger.error("Unexpected settle error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      c.executionCtx.waitUntil(statsService.recordError("internal").catch(() => {}));
      return v2Error(X402_V2_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, 500);
    }
  }
}
