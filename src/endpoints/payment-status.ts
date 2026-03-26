import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { getPaymentRecord } from "../services/payment-status";

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
              properties: {
                success: { type: "boolean" as const },
                requestId: { type: "string" as const },
                paymentId: { type: "string" as const },
                status: { type: "string" as const },
                txid: { type: "string" as const },
                blockHeight: { type: "number" as const },
                explorerUrl: { type: "string" as const },
              },
            },
          },
        },
      },
      "404": {
        description: "Payment not found or expired",
      },
    },
  };

  async handle(c: AppContext) {
    const paymentId = c.req.param("id");

    if (!paymentId || !paymentId.startsWith("pay_")) {
      return this.err(c, {
        error: "Invalid payment ID format",
        code: "NOT_FOUND",
        status: 404,
        retryable: false,
      });
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
      return this.err(c, {
        error: `Payment ${paymentId} not found or expired`,
        code: "NOT_FOUND",
        status: 404,
        retryable: false,
      });
    }

    return this.ok(c, {
      paymentId: record.paymentId,
      status: record.status,
      ...(record.txid && { txid: record.txid }),
      ...(record.blockHeight && { blockHeight: record.blockHeight }),
      ...(record.confirmedAt && { confirmedAt: record.confirmedAt }),
      ...(record.explorerUrl && { explorerUrl: record.explorerUrl }),
      ...(record.senderAddress && { senderAddress: record.senderAddress }),
      ...(record.senderNonce !== undefined && {
        senderNonce: record.senderNonce,
      }),
      ...(record.sponsorFee && { sponsorFee: record.sponsorFee }),
      ...(record.error && { error: record.error }),
      ...(record.errorCode && { errorCode: record.errorCode }),
      ...(record.retryable !== undefined && { retryable: record.retryable }),
      ...(record.senderNonceInfo && {
        senderNonceInfo: record.senderNonceInfo,
      }),
      submittedAt: record.submittedAt,
      ...(record.queuedAt && { queuedAt: record.queuedAt }),
      ...(record.mempoolAt && { mempoolAt: record.mempoolAt }),
      ...(record.failedAt && { failedAt: record.failedAt }),
    });
  }
}
