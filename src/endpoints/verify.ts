import { BaseEndpoint } from "./BaseEndpoint";
import { ReceiptService } from "../services";
import type { AppContext } from "../types";
import { Error400Response, Error404Response, Error500Response } from "../schemas";
import { buildExplorerUrl } from "../utils";

/**
 * Verify endpoint - check payment receipt status
 * GET /verify/:receiptId
 */
export class Verify extends BaseEndpoint {
  schema = {
    tags: ["Verify"],
    summary: "Verify a payment receipt",
    description:
      "Look up a payment receipt by ID and return its status. Receipts are created when a transaction is successfully settled via POST /relay. The receiptId is passed as a URL path parameter.",
    responses: {
      "200": {
        description: "Receipt found",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: { type: "string" as const, format: "uuid" },
                receipt: {
                  type: "object" as const,
                  properties: {
                    receiptId: { type: "string" as const, format: "uuid" },
                    status: {
                      type: "string" as const,
                      enum: ["valid", "consumed"],
                      description: "Receipt status",
                    },
                    createdAt: { type: "string" as const, format: "date-time" },
                    expiresAt: { type: "string" as const, format: "date-time" },
                    senderAddress: {
                      type: "string" as const,
                      description: "Agent's Stacks address",
                    },
                    txid: { type: "string" as const, description: "Transaction ID" },
                    explorerUrl: { type: "string" as const },
                    settlement: {
                      type: "object" as const,
                      properties: {
                        success: { type: "boolean" as const },
                        status: { type: "string" as const },
                        recipient: { type: "string" as const },
                        amount: { type: "string" as const },
                      },
                    },
                    resource: { type: "string" as const, description: "Requested resource" },
                    method: { type: "string" as const, description: "HTTP method" },
                    accessCount: {
                      type: "number" as const,
                      description: "Number of times this receipt has been used",
                    },
                  },
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "404": Error404Response,
      "500": Error500Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    const receiptId = c.req.param("receiptId");

    if (!receiptId) {
      return this.err(c, {
        error: "Missing receipt ID",
        code: "MISSING_TRANSACTION", // reusing existing code
        status: 400,
        retryable: false,
      });
    }

    logger.info("Verify receipt request", { receiptId });

    try {
      const receiptService = new ReceiptService(c.env.RELAY_KV, logger);
      const receipt = await receiptService.getReceipt(receiptId);

      if (!receipt) {
        return this.err(c, {
          error: "Receipt not found or expired",
          code: "NOT_FOUND",
          status: 404,
          retryable: false,
        });
      }

      // Determine receipt status
      const status = receipt.consumed ? "consumed" : "valid";

      logger.info("Receipt verified", {
        receiptId,
        status,
        senderAddress: receipt.senderAddress,
        txid: receipt.txid,
      });

      return this.ok(c, {
        receipt: {
          receiptId: receipt.receiptId,
          status,
          createdAt: receipt.createdAt,
          expiresAt: receipt.expiresAt,
          senderAddress: receipt.senderAddress,
          txid: receipt.txid,
          explorerUrl: buildExplorerUrl(receipt.txid, c.env.STACKS_NETWORK),
          settlement: {
            success: receipt.settlement.success,
            status: receipt.settlement.status,
            recipient: receipt.settlement.recipient,
            amount: receipt.settlement.amount,
          },
          resource: receipt.settleOptions.resource,
          method: receipt.settleOptions.method,
          accessCount: receipt.accessCount,
        },
      });
    } catch (e) {
      logger.error("Failed to verify receipt", {
        receiptId,
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
      });
    }
  }
}
