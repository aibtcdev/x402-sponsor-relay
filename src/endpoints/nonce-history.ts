import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { Error400Response, Error500Response, Error503Response } from "../schemas";

/**
 * Nonce history endpoint — returns the full event trail for a specific (wallet, nonce) pair.
 * Proxies to the NonceDO GET /history/:wallet/:nonce internal route.
 *
 * Useful for diagnosing nonce lifecycle issues: see every state transition from
 * 'assigned' through 'broadcasted' / 'conflict' / 'failed' / 'confirmed'.
 *
 * GET /nonce/history/:wallet/:nonce
 */
export class NonceHistory extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Get nonce event history",
    description:
      "Returns the nonce_intents row and full nonce_events audit trail for a specific " +
      "(wallet_index, nonce) pair. Use this to diagnose broadcast failures, conflicts, " +
      "and reconciliation outcomes for a single nonce.",
    responses: {
      "200": {
        description: "Nonce history retrieved successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                intent: {
                  type: "object" as const,
                  nullable: true,
                  description: "Current nonce_intents row (null if not found)",
                },
                events: {
                  type: "array" as const,
                  items: { type: "object" as const },
                  description: "Ordered list of nonce_events for this (wallet, nonce) pair",
                },
                timestamp: {
                  type: "string" as const,
                  description: "ISO timestamp of the response",
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "500": Error500Response,
      "503": Error503Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    const wallet = c.req.param("wallet");
    const nonce = c.req.param("nonce");

    const walletIdx = parseInt(wallet ?? "", 10);
    const nonceVal = parseInt(nonce ?? "", 10);

    if (!Number.isInteger(walletIdx) || walletIdx < 0) {
      return this.err(c, {
        error: "Invalid wallet index",
        code: "INVALID_TRANSACTION",
        status: 400,
        details: "wallet must be a non-negative integer",
        retryable: false,
      });
    }

    if (!Number.isInteger(nonceVal) || nonceVal < 0) {
      return this.err(c, {
        error: "Invalid nonce",
        code: "INVALID_TRANSACTION",
        status: 400,
        details: "nonce must be a non-negative integer",
        retryable: false,
      });
    }

    if (!c.env.NONCE_DO) {
      return this.err(c, {
        error: "Nonce coordinator unavailable",
        code: "INTERNAL_ERROR",
        status: 503,
        details: "NONCE_DO binding not configured",
        retryable: true,
        retryAfter: 5,
      });
    }

    try {
      const stub = c.env.NONCE_DO.get(c.env.NONCE_DO.idFromName("sponsor"));
      const doResponse = await stub.fetch(
        `https://nonce-do/history/${walletIdx}/${nonceVal}`,
        { method: "GET" }
      );

      if (!doResponse.ok) {
        const body = await doResponse.text();
        logger.warn("Nonce DO history request failed", {
          status: doResponse.status,
          body,
          walletIdx,
          nonceVal,
        });
        return this.err(c, {
          error: "Failed to fetch nonce history",
          code: "INTERNAL_ERROR",
          status: 500,
          details: body || "NonceDO responded with error",
          retryable: true,
          retryAfter: 5,
        });
      }

      const data = await doResponse.json();
      return c.json(data);
    } catch (e) {
      logger.error("Nonce history request failed", {
        error: e instanceof Error ? e.message : "Unknown error",
        walletIdx,
        nonceVal,
      });
      return this.err(c, {
        error: "Failed to fetch nonce history",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
