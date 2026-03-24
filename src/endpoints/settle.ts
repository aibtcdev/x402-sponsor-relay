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
  SponsorService,
  hasSponsorSignature,
  extractSponsorNonce,
  releaseNonceDO,
  recordBroadcastOutcomeDO,
  recordNonceTxid,
} from "../services";
import { stripHexPrefix } from "../utils";
import type { AppContext, X402SettlementResponseV2, X402SettleRequestV2, TxStatusRecord } from "../types";
import { CAIP2_NETWORKS, X402_V2_ERROR_CODES } from "../types";

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

      // Deserialize transaction to inspect sponsor slot
      let parsedTx: ReturnType<typeof deserializeTransaction>;
      try {
        parsedTx = deserializeTransaction(stripHexPrefix(txHex));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn("Failed to deserialize transaction for sponsor-slot inspection", { error: errMsg });
        c.executionCtx.waitUntil(
          Promise.all([
            statsService.recordError("validation"),
            statsService.logFailure("settle", true),
          ]).catch(() => {})
        );
        return v2Error(X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE, 200);
      }

      // Auto-sponsor branch: if the sponsor slot is empty (fee=0n or all-zeros signer),
      // route through SponsorService to fill it before verification and broadcast.
      // This handles standard x402 clients that build transactions with sponsored:true, fee:0n.
      let activeHex = txHex;
      let sponsorFee: string | undefined;
      let sponsorNonce: number | null = null;
      let sponsorWalletIndex = 0;

      // Shared context for failure stats (used by auto-sponsor, verify, and broadcast paths)
      const failureCtx = { tokenType: settleOptions.tokenType, amount: settleOptions.minAmount };

      if (!hasSponsorSignature(parsedTx)) {
        logger.info("Sponsor slot is empty — auto-sponsoring transaction");

        const sponsorService = new SponsorService(c.env, logger);

        // Validate the transaction is sponsorable
        const validateResult = sponsorService.validateTransaction(txHex);
        if (!validateResult.valid) {
          logger.warn("Transaction failed sponsor validation", { error: validateResult.error });
          c.executionCtx.waitUntil(
            Promise.all([
              statsService.recordError("validation"),
              statsService.logFailure("settle", true, failureCtx),
            ]).catch(() => {})
          );
          return v2Error(X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE, 200);
        }

        // Sponsor the transaction (reserves nonce from NonceDO, adds fee + sponsor sig)
        const sponsorResult = await sponsorService.sponsorTransaction(validateResult.transaction);
        if (!sponsorResult.success) {
          logger.warn("Sponsoring failed", { error: sponsorResult.error, code: sponsorResult.code });
          c.executionCtx.waitUntil(
            Promise.all([
              statsService.recordError("sponsoring"),
              statsService.logFailure("settle", false, failureCtx),
            ]).catch(() => {})
          );
          // LOW_HEADROOM / CHAINING_LIMIT_EXCEEDED are transient — signal retryable
          const errorReason =
            sponsorResult.code === "LOW_HEADROOM" || sponsorResult.code === "CHAINING_LIMIT_EXCEEDED"
              ? X402_V2_ERROR_CODES.BROADCAST_FAILED
              : X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE;
          return v2Error(errorReason, 200);
        }

        // Extract nonce for lifecycle management (release on failure, consume on success)
        const sponsoredTx = deserializeTransaction(stripHexPrefix(sponsorResult.sponsoredTxHex));
        sponsorNonce = extractSponsorNonce(sponsoredTx);
        sponsorWalletIndex = sponsorResult.walletIndex;
        sponsorFee = sponsorResult.fee;
        // Use the sponsored hex for verification and broadcast
        activeHex = sponsorResult.sponsoredTxHex;

        logger.info("Transaction auto-sponsored", {
          fee: sponsorFee,
          walletIndex: sponsorWalletIndex,
          sponsorNonce,
        });
      }

      const verifyResult = settlementService.verifyPaymentParams(activeHex, settleOptions);
      if (!verifyResult.valid) {
        logger.warn("Payment verification failed", { error: verifyResult.error });

        // Release reserved sponsor nonce (if any) before returning — verify failed pre-broadcast
        if (sponsorNonce !== null) {
          c.executionCtx.waitUntil(
            releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex).catch((e) => {
              logger.warn("Failed to release nonce after verify failure", { error: String(e) });
            })
          );
        }

        c.executionCtx.waitUntil(
          Promise.all([
            statsService.recordError("validation"),
            statsService.logFailure("settle", true, failureCtx),
          ]).catch(() => {})
        );
        return v2Error(mapVerifyErrorToV2Code(verifyResult.error), 200);
      }

      // Broadcast only — return immediately after the node accepts the transaction.
      // Confirmation polling is moved to waitUntil() so callers are not blocked.
      const broadcastResult = await settlementService.broadcastOnly(
        verifyResult.data.transaction,
      );

      if ("error" in broadcastResult) {
        // Record nonce lifecycle (release reserved nonce on broadcast failure)
        if (sponsorNonce !== null) {
          c.executionCtx.waitUntil(
            Promise.all([
              recordBroadcastOutcomeDO(
                c.env, logger, sponsorNonce, sponsorWalletIndex,
                undefined, broadcastResult.httpStatus, broadcastResult.nodeUrl, broadcastResult.details
              ),
              releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex),
            ]).catch((e) => {
              logger.warn("Failed nonce lifecycle after broadcast failure", { error: String(e) });
            })
          );
        }

        const clientRejection = broadcastResult.clientRejection;
        const isClientError = clientRejection !== undefined;

        // Record stats once for all error branches
        c.executionCtx.waitUntil(
          statsService.logFailure("settle", isClientError, failureCtx).catch(() => {})
        );

        if (clientRejection) {
          logger.warn("Broadcast rejected by node (client error)", {
            error: broadcastResult.error,
            clientRejection,
          });
          // Nonce conflicts when auto-sponsoring → trigger resync via CONFLICTING_NONCE
          if (broadcastResult.nonceConflict && sponsorNonce !== null) {
            logger.warn("Nonce conflict on auto-sponsored settle", {
              sponsorNonce,
              walletIndex: sponsorWalletIndex,
            });
            return v2Error(X402_V2_ERROR_CODES.CONFLICTING_NONCE, 200);
          }
          return v2Error(mapClientRejectionToV2Code(clientRejection), 200);
        } else {
          logger.warn("Broadcast/confirm failed", {
            error: broadcastResult.error,
            retryable: broadcastResult.retryable,
          });
          const errorReason = broadcastResult.retryable
            ? X402_V2_ERROR_CODES.BROADCAST_FAILED
            : X402_V2_ERROR_CODES.TRANSACTION_FAILED;
          return v2Error(errorReason, 200);
        }
      }

      // Broadcast succeeded — build response immediately, poll in background.
      const { txid } = broadcastResult;

      // Consume the sponsor nonce on broadcast success (fire-and-forget)
      if (sponsorNonce !== null) {
        c.executionCtx.waitUntil(
          Promise.all([
            releaseNonceDO(c.env, logger, sponsorNonce, txid, sponsorWalletIndex, sponsorFee),
            recordNonceTxid(c.env, logger, txid, sponsorNonce),
            recordBroadcastOutcomeDO(
              c.env, logger, sponsorNonce, sponsorWalletIndex,
              txid, 200, undefined, undefined
            ),
          ]).catch((e) => {
            logger.warn("Failed nonce lifecycle after broadcast success", { error: String(e) });
          })
        );
      }

      const payer = settlementService.senderToAddress(
        verifyResult.data.transaction,
        c.env.STACKS_NETWORK
      );

      // Record dedup immediately as "pending" — background polling will update if confirmed
      await settlementService.recordDedup(txHex, {
        txid,
        status: "pending",
        sender: payer,
        recipient: verifyResult.data.recipient,
        amount: verifyResult.data.amount,
      });

      // Store tx status in KV for GET /settle/status/:txid
      // Awaited (not waitUntil) to ensure the record exists before background polling starts
      const txStatusRecord: TxStatusRecord = {
        txid,
        status: "broadcast",
        payer,
        network,
        walletIndex: sponsorNonce !== null ? sponsorWalletIndex : undefined,
        sponsorNonce,
        sponsorFee,
        broadcastAt: new Date().toISOString(),
      };
      await settlementService.recordTxStatus(txStatusRecord);

      // Record successful transaction stats (fire-and-forget)
      c.executionCtx.waitUntil(
        statsService.logTransaction({
          timestamp: new Date().toISOString(),
          endpoint: "settle",
          success: true,
          tokenType: settleOptions.tokenType ?? "STX",
          amount: settleOptions.minAmount,
          txid,
          sender: payer,
          recipient: verifyResult.data.recipient,
          status: "pending",
          fee: sponsorFee,
        }).catch(() => {})
      );

      // Background: poll for confirmation and update KV records
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const pollResult = await settlementService.pollForConfirmationPublic(txid);
            if ("error" in pollResult) {
              // Terminal failure (abort)
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
                  recipient: verifyResult.data.recipient,
                  amount: verifyResult.data.amount,
                  blockHeight: pollResult.blockHeight,
                }),
              ]);
            } else {
              // Still pending after all polling rounds
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

      logger.info("x402 V2 settle broadcast accepted, returning immediately", {
        txid,
        payer,
      });

      const response: X402SettlementResponseV2 = {
        success: true,
        payer,
        transaction: txid,
        network,
        ...(paymentIdentifier
          ? { extensions: { "payment-identifier": { info: { id: paymentIdentifier } } } }
          : {}),
      };

      // Cache the result under the payment-identifier key for idempotent retries
      if (paymentIdentifier && paymentIdPayloadHash) {
        c.executionCtx.waitUntil(
          paymentIdService.recordPaymentId(paymentIdentifier, paymentIdPayloadHash, response, "settle").catch(() => {})
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
