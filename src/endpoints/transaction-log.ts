import { BaseEndpoint } from "./BaseEndpoint";
import { StatsService } from "../services";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";

/**
 * Transaction log endpoint — returns recent individual transactions
 * GET /stats/transactions?days=1&limit=50&endpoint=relay
 */
export class TransactionLog extends BaseEndpoint {
  schema = {
    tags: ["Dashboard"],
    summary: "Get recent transaction log",
    description:
      "Returns individual transaction records (newest-first). " +
      "Query params: days (1-7, default 1), limit (1-200, default 50), endpoint (relay|sponsor|settle).",
    responses: {
      "200": {
        description: "Transaction log retrieved successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: { type: "string" as const, format: "uuid" },
                count: {
                  type: "number" as const,
                  description: "Number of entries returned",
                },
                transactions: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      timestamp: {
                        type: "string" as const,
                        format: "date-time",
                      },
                      endpoint: {
                        type: "string" as const,
                        enum: ["relay", "sponsor", "settle"],
                      },
                      success: { type: "boolean" as const },
                      tokenType: {
                        type: "string" as const,
                        enum: ["STX", "sBTC", "USDCx"],
                      },
                      amount: { type: "string" as const },
                      fee: { type: "string" as const },
                      txid: { type: "string" as const },
                      sender: { type: "string" as const },
                      recipient: { type: "string" as const },
                      status: {
                        type: "string" as const,
                        enum: ["confirmed", "pending", "failed"],
                      },
                      blockHeight: { type: "number" as const },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "500": Error500Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);

    try {
      const url = new URL(c.req.url);
      const rawDays = parseInt(url.searchParams.get("days") || "1", 10);
      const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
      const endpoint = url.searchParams.get("endpoint") || undefined;

      const days = Math.min(Math.max(rawDays, 1), 7);
      const limit = Math.min(Math.max(rawLimit, 1), 200);

      const statsService = new StatsService(c.env.RELAY_KV, logger);
      const transactions = await statsService.getTransactionLog({
        days,
        limit,
        endpoint,
      });

      return this.ok(c, {
        count: transactions.length,
        transactions,
      }, {
        "Cache-Control": "public, max-age=10",
      });
    } catch (e) {
      logger.error("Failed to get transaction log", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to retrieve transaction log",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
