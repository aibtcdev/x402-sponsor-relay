import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import {
  Error400Response,
  Error401Response,
  Error500Response,
  Error502Response,
} from "../schemas";

/**
 * Per-wallet gap-fill endpoint — admin tool for unsticking blocked wallets.
 * POST /nonce/fill-gaps/:wallet
 *
 * Immediately broadcasts gap-fill transactions (1 uSTX self-transfers) for
 * all detected gaps in a specific wallet. Bypasses the alarm's rate limits
 * and RBF logic — intended for manual intervention when a wallet is stuck.
 */
export class NonceFillGaps extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Fill nonce gaps for a specific wallet",
    description:
      "Immediately broadcast gap-fill transactions for all detected gaps in a specific wallet. " +
      "Bypasses alarm rate limits (MAX_GAP_FILLS_PER_ALARM) and gap-fill throttle. " +
      "Requires API key authentication.\n\n" +
      "Use when a wallet is stuck due to nonce gaps blocking the chain head. " +
      "Each gap-fill is a 1 uSTX transfer at 30k fee.",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "Gap-fill results",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const },
                requestId: { type: "string" as const, format: "uuid" },
                walletIndex: { type: "number" as const },
                address: { type: "string" as const },
                possible_next_nonce: { type: "number" as const },
                head: { type: "number" as const, nullable: true },
                filled: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      nonce: { type: "number" as const },
                      txid: { type: "string" as const },
                    },
                  },
                },
                failed: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      nonce: { type: "number" as const },
                      reason: { type: "string" as const },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "401": Error401Response,
      "500": Error500Response,
      "502": { ...Error502Response, description: "Hiro API unavailable during gap detection" },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);

    if (!c.env.NONCE_DO) {
      return this.err(c, {
        error: "Nonce coordinator unavailable",
        code: "INTERNAL_ERROR",
        status: 500,
        details: "NONCE_DO binding not configured",
        retryable: true,
        retryAfter: 5,
      });
    }

    const walletIndex = parseInt(c.req.param("wallet") ?? "", 10);
    if (isNaN(walletIndex) || walletIndex < 0 || walletIndex > 99) {
      return this.err(c, {
        error: "Invalid wallet index",
        code: "INVALID_TRANSACTION",
        status: 400,
        details: "wallet must be 0-99",
        retryable: false,
      });
    }

    const auth = c.get("auth")!;
    const keyId = auth.metadata?.keyId ?? "unknown";
    logger.info("Admin gap-fill triggered", { walletIndex, keyId });

    try {
      const stub = c.env.NONCE_DO.get(c.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch(`https://nonce-do/fill-gaps/${walletIndex}`, {
        method: "POST",
      });

      if (response.status === 503) {
        return this.err(c, {
          error: "Hiro API unavailable — gap detection requires Hiro connectivity",
          code: "INTERNAL_ERROR",
          status: 502,
          details: "Retry shortly.",
          retryable: true,
          retryAfter: 5,
        });
      }

      if (!response.ok) {
        const body = await response.text();
        logger.warn("Gap-fill request failed", { walletIndex, status: response.status, body });
        return this.err(c, {
          error: "Gap-fill failed",
          code: "INTERNAL_ERROR",
          status: response.status >= 400 && response.status < 500 ? 400 : 500,
          details: body,
          retryable: response.status >= 500,
        });
      }

      const result = await response.json();
      logger.info("Admin gap-fill completed", { walletIndex, keyId, result });
      return this.ok(c, result as object);
    } catch (e) {
      logger.error("Gap-fill request failed", {
        walletIndex,
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Gap-fill failed",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
      });
    }
  }
}
