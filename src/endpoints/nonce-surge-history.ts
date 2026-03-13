import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { Error500Response, Error503Response } from "../schemas";

/**
 * Nonce surge history endpoint — returns the last 20 surge events recorded by the NonceDO.
 * Proxies to the NonceDO GET /surge-history internal route.
 *
 * A surge event is recorded when overall pool pressure across all sponsor wallets
 * exceeds 80%. Each event includes peak pressure, peak reserved nonces, wallet count
 * at peak, and duration. Resolved surges also emit a surge_pattern structured log
 * with time-of-day and day-of-week context for operator capacity planning.
 *
 * GET /nonce/surge-history
 */
export class NonceSurgeHistory extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Get surge event history",
    description:
      "Returns the last 20 pool-pressure surge events recorded by the nonce coordinator. " +
      "A surge starts when overall pool pressure exceeds 80% and resolves when it drops below. " +
      "Use this to identify recurring high-traffic windows and pre-provision sponsor wallets. " +
      "Each resolved surge emits a surge_pattern log with time_of_day, day_of_week, " +
      "peak_pressure_pct, and duration for capacity planning.",
    responses: {
      "200": {
        description: "Surge history retrieved successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                surgeEvents: {
                  type: "array" as const,
                  items: {
                    type: "object" as const,
                    properties: {
                      id: { type: "integer" as const },
                      started_at: { type: "string" as const, description: "ISO timestamp when surge started" },
                      peak_pressure_pct: { type: "integer" as const, description: "Peak pool pressure percentage (0-100)" },
                      peak_reserved: { type: "integer" as const, description: "Peak in-flight nonce count across all wallets" },
                      wallet_count_at_peak: { type: "integer" as const, description: "Number of sponsor wallets active at peak" },
                      duration_ms: { type: "integer" as const, nullable: true, description: "Surge duration in milliseconds (null if still active)" },
                      resolved_at: { type: "string" as const, nullable: true, description: "ISO timestamp when surge resolved (null if still active)" },
                    },
                  },
                  description: "List of surge events, most recent first (up to 20)",
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
      "500": Error500Response,
      "503": Error503Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);

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
      const doResponse = await stub.fetch("https://nonce-do/surge-history", {
        method: "GET",
      });

      if (!doResponse.ok) {
        const body = await doResponse.text();
        logger.warn("Nonce DO surge-history request failed", {
          status: doResponse.status,
          body,
        });
        return this.err(c, {
          error: "Failed to fetch surge history",
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
      logger.error("Nonce surge history request failed", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to fetch surge history",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
