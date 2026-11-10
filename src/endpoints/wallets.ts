import { BaseEndpoint } from "./BaseEndpoint";
import { SponsorService } from "../services";
import { getPaymentSponsorWallet } from "../services/payment-sponsor-status";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";

/**
 * Wallet monitoring endpoint
 * GET /wallets — returns per-wallet balance, fee stats, pool state, and health status
 */
export class Wallets extends BaseEndpoint {
  schema = {
    tags: ["Wallets"],
    summary: "Get sponsor wallet status (payment sponsor + legacy pool)",
    description:
      "`paymentSponsor` is the wallet that sponsors every live path (POST /sponsor and the RelayRPC " +
      "sponsorPayment/submitPayment binding); fund this one. " +
      "`wallets` is the legacy SPONSOR_MNEMONIC nonce pool, which no live path sponsors from any more: " +
      "per-wallet STX balance, cumulative fees spent, transaction counts, live nonce pool state, and health status. " +
      "Balances are cached for 60 seconds. " +
      "This is the detailed operator/debugging path; use GET /status/sponsor for the canonical cached sponsor readiness surface.",
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
                paymentSponsor: {
                  type: "object" as const,
                  nullable: true,
                  description:
                    "The x402 payment-sponsor wallet (PAYMENT_SPONSOR_PRIVATE_KEY). null when not configured or unreadable.",
                  properties: {
                    address: { type: "string" as const },
                    balance: { type: "string" as const, nullable: true, description: "STX balance in microSTX; null when Hiro is unreadable" },
                    spentToday: { type: "string" as const, description: "Sponsored fees spent today (UTC) in microSTX" },
                    dailyBudget: { type: "string" as const, description: "Daily sponsored-fee budget in microSTX" },
                  },
                },
                legacyPool: {
                  type: "boolean" as const,
                  example: true,
                  description: "Always true: `wallets` is the legacy pool, not used for live sponsoring",
                },
                wallets: {
                  type: "array" as const,
                  description: "Legacy nonce-pool wallets, ordered by wallet index",
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
                      gapFillFeesTotal: { type: "string" as const, description: "Cumulative fees paid for gap-fill txs in microSTX" },
                      gapFillCount: { type: "number" as const, description: "Number of gap-fill transactions broadcast for this wallet" },
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
      const [result, paymentSponsor] = await Promise.all([
        sponsorService.getWalletStatuses(),
        // Never let the payment-sponsor read break the pool report.
        getPaymentSponsorWallet(c.env, logger).catch((e) => {
          logger.warn("Payment sponsor wallet read failed", {
            error: e instanceof Error ? e.message : String(e),
          });
          return null;
        }),
      ]);

      return this.ok(c, { paymentSponsor, legacyPool: true, ...result }, {
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
