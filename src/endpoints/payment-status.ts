import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import {
  buildNotFoundPaymentRecord,
  getPaymentRecord,
  selfHealMempoolRecord,
  projectPaymentRecord,
} from "../services/payment-status";
import {
  buildPaymentCheckStatusUrl,
  emitPaymentLifecycleEvent,
  emitProjectedPaymentPollEvents,
} from "../utils";
import { repairSenderWedgeDO } from "../services";

/**
 * GET /payment/:id — Public payment status endpoint.
 *
 * Returns the current status of a queued payment with explorer link when confirmed.
 * No auth required — paymentId acts as a bearer token (unguessable UUID).
 */
export class PaymentStatus extends BaseEndpoint {
  schema = {
    tags: ["Payment"],
    summary: "Check payment status",
    description:
      "Returns the current status of a payment submitted via RPC queue. No authentication required. The payment ID is passed as a URL path parameter.",
    responses: {
      "200": {
        description: "Payment status found",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["success", "requestId", "paymentId", "status", "submittedAt"],
              properties: {
                success: { type: "boolean" as const },
                requestId: { type: "string" as const },
                paymentId: { type: "string" as const },
                status: {
                  type: "string" as const,
                  enum: ["queued", "broadcasting", "mempool", "confirmed", "failed", "replaced"],
                },
                terminalReason: { type: "string" as const },
                txid: { type: "string" as const },
                blockHeight: { type: "number" as const },
                explorerUrl: { type: "string" as const },
                checkStatusUrl: { type: "string" as const },
                senderAddress: { type: "string" as const },
                senderNonce: { type: "number" as const },
                sponsorFee: { type: "string" as const },
                error: { type: "string" as const },
                errorCode: { type: "string" as const },
                retryable: { type: "boolean" as const },
                submittedAt: { type: "string" as const },
                queuedAt: { type: "string" as const },
                mempoolAt: { type: "string" as const },
                confirmedAt: { type: "string" as const },
                failedAt: { type: "string" as const },
                replacedAt: { type: "string" as const },
                replacedReason: { type: "string" as const },
                replacementTxid: { type: "string" as const },
                resubmittable: { type: "boolean" as const },
                senderNonceInfo: { type: "object" as const },
                relayState: { type: "string" as const },
                holdReason: { type: "string" as const },
                nextExpectedNonce: { type: "number" as const },
                missingNonces: { type: "array" as const, items: { type: "number" as const } },
                holdExpiresAt: { type: "string" as const },
                senderWedge: { type: "object" as const },
              },
            },
          },
        },
      },
      "404": {
        description: "Payment not found or expired",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["success", "requestId", "paymentId", "status", "terminalReason", "error", "retryable"],
              properties: {
                success: { type: "boolean" as const },
                requestId: { type: "string" as const },
                paymentId: { type: "string" as const },
                status: {
                  type: "string" as const,
                  enum: ["not_found"],
                },
                terminalReason: {
                  type: "string" as const,
                  enum: ["expired", "unknown_payment_identity"],
                },
                error: { type: "string" as const },
                retryable: { type: "boolean" as const },
                checkStatusUrl: { type: "string" as const },
              },
            },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const paymentId = c.req.param("id");
    const logger = this.getLogger(c);

    if (!paymentId || !paymentId.startsWith("pay_")) {
      const notFound = buildNotFoundPaymentRecord(
        paymentId ?? "unknown",
        "Invalid payment ID format"
      );
      emitPaymentLifecycleEvent(logger, "payment.poll", {
        route: "GET /payment/:id",
        paymentId: notFound.paymentId,
        status: notFound.status,
        terminalReason: notFound.terminalReason,
        action: "return_invalid_payment_id",
        checkStatusUrlPresent: false,
        compatShimUsed: false,
      });
      return c.json(
        {
          success: true,
          requestId: this.getRequestId(c),
          ...notFound,
        },
        404
      );
    }

    const kv = c.env.RELAY_KV;
    if (!kv) {
      return this.err(c, {
        error: "Storage not configured",
        code: "INTERNAL_ERROR",
        status: 500,
        retryable: true,
      });
    }

    const record = await getPaymentRecord(kv, paymentId);
    if (!record) {
      const notFound = buildNotFoundPaymentRecord(paymentId);
      const checkStatusUrl = buildPaymentCheckStatusUrl(c.env, paymentId);
      emitPaymentLifecycleEvent(logger, "payment.poll", {
        route: "GET /payment/:id",
        paymentId: notFound.paymentId,
        status: notFound.status,
        terminalReason: notFound.terminalReason,
        action: "return_not_found",
        checkStatusUrlPresent: true,
        compatShimUsed: false,
      });
      return c.json(
        {
          success: true,
          requestId: this.getRequestId(c),
          ...notFound,
          checkStatusUrl,
        },
        404
      );
    }

    let refreshedRecord = record;
    let senderWedge;
    if (
      record.status === "queued" &&
      record.relayState === "held" &&
      record.holdReason === "gap" &&
      record.senderAddress
    ) {
      senderWedge = await repairSenderWedgeDO(c.env, logger, record.senderAddress);
      refreshedRecord = (await getPaymentRecord(kv, paymentId)) ?? record;
    }

    // Self-healing: check on-chain status for payments stuck in mempool
    refreshedRecord = await selfHealMempoolRecord(
      refreshedRecord, kv, c.env, logger, "GET /payment/:id"
    );

    const projected = projectPaymentRecord(refreshedRecord);
    const checkStatusUrl = buildPaymentCheckStatusUrl(c.env, projected.paymentId);
    const compatShimUsed = refreshedRecord.status === "submitted";

    emitProjectedPaymentPollEvents(
      logger,
      "GET /payment/:id",
      projected,
      compatShimUsed
    );

    return this.ok(c, {
      paymentId: projected.paymentId,
      status: projected.status,
      ...(projected.terminalReason && {
        terminalReason: projected.terminalReason,
      }),
      ...(projected.txid && { txid: projected.txid }),
      ...(projected.blockHeight && { blockHeight: projected.blockHeight }),
      ...(projected.confirmedAt && { confirmedAt: projected.confirmedAt }),
      ...(projected.explorerUrl && { explorerUrl: projected.explorerUrl }),
      checkStatusUrl,
      ...(projected.senderAddress && { senderAddress: projected.senderAddress }),
      ...(projected.senderNonce !== undefined && {
        senderNonce: projected.senderNonce,
      }),
      ...(projected.sponsorFee && { sponsorFee: projected.sponsorFee }),
      ...(projected.error && { error: projected.error }),
      ...(projected.errorCode && { errorCode: projected.errorCode }),
      ...(projected.retryable !== undefined && { retryable: projected.retryable }),
      ...(projected.senderNonceInfo && {
        senderNonceInfo: projected.senderNonceInfo,
      }),
      ...(projected.relayState && { relayState: projected.relayState }),
      ...(projected.holdReason && { holdReason: projected.holdReason }),
      ...(projected.nextExpectedNonce !== undefined && {
        nextExpectedNonce: projected.nextExpectedNonce,
      }),
      ...(projected.missingNonces && { missingNonces: projected.missingNonces }),
      ...(projected.holdExpiresAt && { holdExpiresAt: projected.holdExpiresAt }),
      ...(senderWedge && { senderWedge }),
      submittedAt: projected.submittedAt,
      ...(projected.queuedAt && { queuedAt: projected.queuedAt }),
      ...(projected.mempoolAt && { mempoolAt: projected.mempoolAt }),
      ...(projected.failedAt && { failedAt: projected.failedAt }),
      ...(projected.replacedAt && { replacedAt: projected.replacedAt }),
      ...(projected.replacedReason && { replacedReason: projected.replacedReason }),
      ...(projected.replacementTxid && { replacementTxid: projected.replacementTxid }),
      ...(projected.resubmittable !== undefined && {
        resubmittable: projected.resubmittable,
      }),
    });
  }
}
