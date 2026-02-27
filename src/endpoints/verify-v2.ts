import { BaseEndpoint } from "./BaseEndpoint";
import {
  validateV2Request,
  mapVerifyErrorToV2Code,
  V2_REQUEST_BODY_SCHEMA,
} from "./v2-helpers";
import { StatsService, PaymentIdService } from "../services";
import type { AppContext, X402VerifyResponseV2, X402SettleRequestV2, X402SettlementResponseV2 } from "../types";
import { X402_V2_ERROR_CODES } from "../types";

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
            schema: V2_REQUEST_BODY_SCHEMA,
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

    const statsService = new StatsService(c.env, logger);
    const paymentIdService = new PaymentIdService(c.env.RELAY_KV, logger);

    const v2Invalid = (invalidReason: string): Response => {
      const response: X402VerifyResponseV2 = { isValid: false, invalidReason };
      return c.json(response, 200);
    };

    const v2Conflict = (): Response => {
      const response: X402VerifyResponseV2 = {
        isValid: false,
        invalidReason: X402_V2_ERROR_CODES.PAYMENT_IDENTIFIER_CONFLICT,
      };
      return c.json(response, 409);
    };

    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("verify", true).catch(() => {}));
        return v2Invalid(X402_V2_ERROR_CODES.INVALID_PAYLOAD);
      }

      const validation = validateV2Request(body, c.env, logger);
      if (!validation.valid) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("verify", true).catch(() => {}));
        return v2Invalid(validation.error.errorReason);
      }

      const { settleOptions, txHex, settlementService } = validation.data;
      const paymentIdentifier = validation.data.paymentIdentifier;

      // Payment-identifier cache check (client-controlled idempotency)
      let paymentIdPayloadHash: string | undefined;
      if (paymentIdentifier) {
        const rawBody = body as X402SettleRequestV2;
        paymentIdPayloadHash = await paymentIdService.computePayloadHash(
          rawBody.paymentPayload,
          rawBody.paymentRequirements
        );
        const cacheResult = await paymentIdService.checkPaymentId(paymentIdentifier, paymentIdPayloadHash);
        if (cacheResult.status === "hit") {
          logger.info("payment-identifier cache hit, returning cached verify response", {
            id: paymentIdentifier,
          });
          return c.json(cacheResult.response as unknown as X402VerifyResponseV2, 200);
        }
        if (cacheResult.status === "conflict") {
          logger.warn("payment-identifier conflict detected", { id: paymentIdentifier });
          return v2Conflict();
        }
      }

      const verifyResult = settlementService.verifyPaymentParams(txHex, settleOptions);

      if (!verifyResult.valid) {
        logger.info("Payment verification failed", { error: verifyResult.error });
        c.executionCtx.waitUntil(statsService.logFailure("verify", true, { tokenType: settleOptions.tokenType, amount: settleOptions.minAmount }).catch(() => {}));
        return v2Invalid(mapVerifyErrorToV2Code(verifyResult.error));
      }

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

      c.executionCtx.waitUntil(statsService.logTransaction({
        timestamp: new Date().toISOString(),
        endpoint: "verify",
        success: true,
        tokenType: settleOptions.tokenType ?? "STX",
        amount: settleOptions.minAmount,
        ...(payer ? { sender: payer } : {}),
      }).catch(() => {}));

      const response: X402VerifyResponseV2 = {
        isValid: true,
        ...(payer ? { payer } : {}),
        ...(paymentIdentifier
          ? { extensions: { "payment-identifier": { info: { id: paymentIdentifier } } } }
          : {}),
      };

      // Cache the verify result under the payment-identifier key for idempotent retries
      if (paymentIdentifier && paymentIdPayloadHash) {
        c.executionCtx.waitUntil(
          paymentIdService
            .recordPaymentId(
              paymentIdentifier,
              paymentIdPayloadHash,
              response as unknown as X402SettlementResponseV2
            )
            .catch(() => {})
        );
      }

      return c.json(response, 200);
    } catch (e) {
      logger.error("Unexpected verify error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      c.executionCtx.waitUntil(statsService.recordError("internal").catch(() => {}));
      c.executionCtx.waitUntil(statsService.logFailure("verify", false).catch(() => {}));
      return v2Invalid(X402_V2_ERROR_CODES.UNEXPECTED_VERIFY_ERROR);
    }
  }
}
