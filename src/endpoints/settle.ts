import { deserializeTransaction } from "@stacks/transactions";
import { BaseEndpoint } from "./BaseEndpoint";
import {
  validateV2Request,
  mapVerifyErrorToV2Code,
  mapClientRejectionToV2Code,
  V2_REQUEST_BODY_SCHEMA,
  V2_ERROR_RESPONSE_SCHEMA,
} from "./v2-helpers";
import {
  StatsService,
  PaymentIdService,
  SettlementService,
  hasSponsorSignature,
} from "../services";
import { stripHexPrefix } from "../utils";
import { checkAndRecordMalformed } from "../middleware";
import type { AppContext, BroadcastOnlyResult, SettleOptions, TokenType, X402SettlementResponseV2, X402SettleRequestV2, TxStatusRecord, Logger } from "../types";
import { CAIP2_NETWORKS, X402_V2_ERROR_CODES } from "../types";

/** Parameters for the shared post-broadcast success handler */
interface BroadcastSuccessParams {
  c: AppContext;
  logger: Logger;
  txid: string;
  txHex: string;
  network: string;
  verifiedTx: import("@stacks/transactions").StacksTransactionWire;
  recipient: string;
  amount: string;
  settleOptions: SettleOptions;
  settlementService: SettlementService;
  statsService: StatsService;
  paymentIdService: PaymentIdService;
  paymentIdentifier: string | undefined;
  paymentIdPayloadHash: string | undefined;
}

/**
 * Settle endpoint - x402 V2 facilitator settle
 * POST /settle (spec section 7.2)
 *
 * Verifies payment parameters locally and broadcasts the transaction.
 * Auto-sponsors transactions with an empty sponsor slot (fee=0 / all-zeros signer).
 * Returns x402 V2 spec-compliant settlement response.
 */
export class Settle extends BaseEndpoint {
  schema = {
    tags: ["x402 V2"],
    summary: "Settle an x402 V2 payment",
    description:
      "x402 V2 facilitator settle endpoint (spec section 7.2). Verifies payment parameters locally and broadcasts the transaction to the Stacks network. Auto-sponsors transactions with an empty sponsor slot (fee=0 / all-zeros signer) — standard x402 clients that build transactions with sponsored:true and fee:0 are handled transparently. Returns HTTP 200 for settlement results (success or failure); HTTP 400 for invalid request schema; HTTP 409 when a payment-identifier conflicts with a prior request.",
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
                extensions: {
                  type: "object" as const,
                  description: "Echoed protocol extensions (e.g. payment-identifier)",
                },
              },
            },
          },
        },
      },
      "409": {
        description: "Payment-identifier conflict — same id used with a different payload",
        content: {
          "application/json": {
            schema: V2_ERROR_RESPONSE_SCHEMA,
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

  /**
   * Shared post-broadcast success handler used by both the primary and retry paths.
   * Records dedup, tx status, stats, schedules background polling,
   * and returns the V2 settlement response.
   */
  private async handleBroadcastSuccess(params: BroadcastSuccessParams): Promise<Response> {
    const {
      c, logger, txid, txHex, network,
      verifiedTx, recipient, amount,
      settleOptions, settlementService, statsService,
      paymentIdService, paymentIdentifier, paymentIdPayloadHash,
    } = params;

    const payer = settlementService.senderToAddress(verifiedTx, c.env.STACKS_NETWORK);

    // Await dedup + tx status before returning — these must be visible to subsequent
    // requests for idempotency (dedup) and for the background poller (tx status).
    await settlementService.recordDedup(txHex, {
      txid,
      status: "pending",
      sender: payer,
      recipient,
      amount,
    });

    const txStatusRecord: TxStatusRecord = {
      txid,
      status: "broadcast",
      payer,
      network,
      broadcastAt: new Date().toISOString(),
    };
    await settlementService.recordTxStatus(txStatusRecord);

    // Record stats in background (non-blocking)
    c.executionCtx.waitUntil(
      statsService.logTransaction({
        timestamp: new Date().toISOString(),
        endpoint: "settle",
        success: true,
        tokenType: settleOptions.tokenType ?? "STX",
        amount: settleOptions.minAmount,
        txid,
        sender: payer,
        recipient,
        status: "pending",
      }).catch(() => {})
    );

    // Background: poll for confirmation and update KV records
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const pollResult = await settlementService.awaitConfirmationPublic(txid);
          if ("error" in pollResult) {
            await settlementService.updateTxStatus(txid, {
              status: "failed",
              errorReason: pollResult.details,
            });
          } else if (pollResult.status === "confirmed") {
            await Promise.all([
              settlementService.updateTxStatus(txid, {
                status: "confirmed",
                confirmedAt: new Date().toISOString(),
                blockHeight: pollResult.blockHeight,
              }),
              settlementService.recordDedup(txHex, {
                txid,
                status: "confirmed",
                sender: payer,
                recipient,
                amount,
                blockHeight: pollResult.blockHeight,
              }),
            ]);
          } else {
            await settlementService.updateTxStatus(txid, { status: "pending" });
          }
        } catch (e) {
          logger.warn("Background confirmation polling failed", {
            txid,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })()
    );

    logger.info("x402 V2 settle broadcast accepted, returning immediately", { txid, payer });

    const response: X402SettlementResponseV2 = {
      success: true,
      payer,
      transaction: txid,
      network,
      ...(paymentIdentifier
        ? { extensions: { "payment-identifier": { info: { id: paymentIdentifier } } } }
        : {}),
    };

    if (paymentIdentifier && paymentIdPayloadHash) {
      c.executionCtx.waitUntil(
        paymentIdService.recordPaymentId(paymentIdentifier, paymentIdPayloadHash, response, "settle").catch(() => {})
      );
    }

    return c.json(response, 200);
  }

  /** Map a failed broadcast (relay-sponsored or self-paid) to a V2 settle error. */
  private broadcastFailure(
    c: AppContext,
    logger: Logger,
    failure: Extract<BroadcastOnlyResult, { error: string }>,
    statsService: StatsService,
    failureCtx: { tokenType?: TokenType; amount?: string },
    v2Error: (errorReason: string, status: 200 | 400 | 409 | 500) => Response
  ): Response {
    const isClientError = failure.clientRejection !== undefined || failure.responsible === "sender";
    logger.warn("Broadcast failed", {
      error: failure.error,
      details: failure.details,
      responsible: failure.responsible,
      clientRejection: failure.clientRejection,
      nonceConflict: failure.nonceConflict,
      tooMuchChaining: failure.tooMuchChaining,
    });
    c.executionCtx.waitUntil(
      statsService.logFailure("settle", isClientError, failureCtx, isClientError ? "invalid_transaction" : "broadcast_failure").catch(() => {})
    );
    if (failure.clientRejection) {
      return v2Error(mapClientRejectionToV2Code(failure.clientRejection), 200);
    }
    if (failure.nonceConflict) {
      return v2Error(
        failure.responsible === "sender"
          ? X402_V2_ERROR_CODES.SENDER_NONCE_CONFLICT
          : X402_V2_ERROR_CODES.CONFLICTING_NONCE,
        200
      );
    }
    return v2Error(
      failure.retryable ? X402_V2_ERROR_CODES.BROADCAST_FAILED : X402_V2_ERROR_CODES.TRANSACTION_FAILED,
      200
    );
  }

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
        const cacheResult = await paymentIdService.checkPaymentId(paymentIdentifier, paymentIdPayloadHash, "settle");
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

      const clientIp = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null;

      // Fast hex pre-validation before expensive deserialization (mirrors SponsorService.preValidateTxHex)
      const cleanHexForCheck = stripHexPrefix(txHex);
      if (
        cleanHexForCheck.length < 4 ||
        cleanHexForCheck.length % 2 !== 0 ||
        !/^[0-9a-fA-F]+$/.test(cleanHexForCheck)
      ) {
        if (clientIp) checkAndRecordMalformed(clientIp);
        logger.info("Malformed transaction hex rejected before deserialization", {
          txHexLength: txHex.length,
          reason: "invalid hex format",
        });
        c.executionCtx.waitUntil(
          Promise.all([
            statsService.recordError("validation"),
            statsService.logFailure("settle", true, undefined, "invalid_transaction"),
          ]).catch(() => {})
        );
        return v2Error(X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE, 200);
      }

      // Deserialize transaction to inspect sponsor slot
      let parsedTx: ReturnType<typeof deserializeTransaction>;
      try {
        parsedTx = deserializeTransaction(cleanHexForCheck);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (clientIp) checkAndRecordMalformed(clientIp);
        logger.info("Failed to deserialize transaction for sponsor-slot inspection", {
          error: errMsg,
          txHexLength: txHex.length,
          txHexPrefix: cleanHexForCheck.slice(0, 20),
        });
        c.executionCtx.waitUntil(
          Promise.all([
            statsService.recordError("validation"),
            statsService.logFailure("settle", true, undefined, "invalid_transaction"),
          ]).catch(() => {})
        );
        return v2Error(X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE, 200);
      }

      // Shared context for failure stats
      const failureCtx = { tokenType: settleOptions.tokenType, amount: settleOptions.minAmount };

      // Recipient / amount / token live in the client-signed payload; the sponsor slot
      // does not affect them, so verify once before sponsoring or broadcasting.
      const verifyResult = settlementService.verifyPaymentParams(txHex, settleOptions);
      if (!verifyResult.valid) {
        logger.warn("Payment verification failed", { error: verifyResult.error });
        c.executionCtx.waitUntil(
          Promise.all([
            statsService.recordError("validation"),
            statsService.logFailure("settle", true, failureCtx, "invalid_transaction"),
          ]).catch(() => {})
        );
        return v2Error(mapVerifyErrorToV2Code(verifyResult.error), 200);
      }

      // Public /settle only broadcasts self-paid (or already-sponsored) transactions.
      // Sponsorship is offered to aibtc.com alone, over the RelayRPC.sponsorPayment binding.
      if (!hasSponsorSignature(parsedTx)) {
        logger.info("Refusing to sponsor on public /settle — sponsorship is service-binding only");
        c.executionCtx.waitUntil(
          statsService.logFailure("settle", true, failureCtx, "not_sponsored").catch(() => {})
        );
        return v2Error(X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE, 200);
      }

      const broadcastResult = await settlementService.broadcastOnly(verifyResult.data.transaction);
      if ("error" in broadcastResult) {
        return this.broadcastFailure(c, logger, broadcastResult, statsService, failureCtx, v2Error);
      }
      const txid = broadcastResult.txid;

      return this.handleBroadcastSuccess({
        c, logger, txid, txHex, network,
        verifiedTx: verifyResult.data.transaction,
        recipient: verifyResult.data.recipient,
        amount: verifyResult.data.amount,
        settleOptions, settlementService, statsService,
        paymentIdService, paymentIdentifier, paymentIdPayloadHash,
      });
    } catch (e) {
      logger.error("Unexpected settle error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      c.executionCtx.waitUntil(statsService.recordError("internal").catch(() => {}));
      return v2Error(X402_V2_ERROR_CODES.UNEXPECTED_SETTLE_ERROR, 500);
    }
  }
}
