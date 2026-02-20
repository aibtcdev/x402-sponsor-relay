import { BaseEndpoint } from "./BaseEndpoint";
import { SponsorService } from "../services";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";

/**
 * Wallet monitoring endpoint
 * GET /wallets — returns per-wallet balance, fee stats, pool state, and health status
 */
export class Wallets extends BaseEndpoint {
  schema = {
    tags: ["Wallets"],
    summary: "Get per-wallet sponsor status",
    description:
      "Returns current STX balance, cumulative fees spent, transaction counts, live nonce pool state, " +
      "and health status for each configured sponsor wallet. " +
      "Balances are cached for 60 seconds. " +
      "Use this endpoint to identify wallets that need funding.",
    responses: {
      "200": {
        description: "Wallet statuses retrieved successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: {
                  type: "string" as const,
                  format: "uuid",
                  description: "Unique request identifier for tracking",
                },
                wallets: {
                  type: "array" as const,
                  description: "Per-wallet status array ordered by wallet index",
                  items: {
                    type: "object" as const,
                    properties: {
                      index: { type: "number" as const, description: "0-based BIP-44 account index" },
                      address: { type: "string" as const, description: "Stacks address for this wallet" },
                      balance: { type: "string" as const, description: "Current STX balance in microSTX" },
                      totalFeesSpent: { type: "string" as const, description: "Cumulative fees paid since tracking began (microSTX)" },
                      txCount: { type: "number" as const, description: "Total transactions sponsored by this wallet" },
                      txCountToday: { type: "number" as const, description: "Transactions sponsored today (UTC)" },
                      feesToday: { type: "string" as const, description: "Fees paid today in microSTX" },
                      pool: {
                        type: "object" as const,
                        description: "Live nonce pool state",
                        properties: {
                          available: { type: "number" as const, description: "Nonces available for assignment" },
                          reserved: { type: "number" as const, description: "Nonces currently in-flight" },
                          maxNonce: { type: "number" as const, description: "Highest nonce in the pool" },
                        },
                      },
                      status: {
                        type: "string" as const,
                        enum: ["healthy", "low_balance", "depleted"],
                        description: "healthy: balance >= 1 STX; low_balance: >= 0.1 STX; depleted: < 0.1 STX",
                      },
                    },
                  },
                },
                totals: {
                  type: "object" as const,
                  description: "Aggregate totals across all wallets",
                  properties: {
                    totalBalance: { type: "string" as const, description: "Sum of all wallet balances in microSTX" },
                    totalFeesSpent: { type: "string" as const, description: "Sum of all fees ever paid in microSTX" },
                    totalTxCount: { type: "number" as const, description: "Total transactions across all wallets" },
                    walletCount: { type: "number" as const, description: "Number of configured sponsor wallets" },
                  },
                },
                thresholds: {
                  type: "object" as const,
                  description: "Balance thresholds used to classify wallet health (microSTX)",
                  properties: {
                    lowBalanceWarning: { type: "string" as const, example: "1000000" },
                    depletedThreshold: { type: "string" as const, example: "100000" },
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
      const sponsorService = new SponsorService(c.env, logger);
      const result = await sponsorService.getWalletStatuses();

      return this.ok(c, result, {
        "Cache-Control": "public, max-age=30",
      });
    } catch (e) {
      logger.error("Failed to get wallet statuses", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to retrieve wallet statuses",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
