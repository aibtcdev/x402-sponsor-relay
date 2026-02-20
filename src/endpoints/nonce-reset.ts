import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import {
  Error400Response,
  Error401Response,
  Error500Response,
} from "../schemas";

type NonceResetAction = "resync" | "reset";

/**
 * Nonce reset endpoint - trigger on-demand nonce recovery
 * POST /nonce/reset
 *
 * Allows admins with API keys to immediately trigger nonce gap recovery
 * on the NonceDO without waiting for the 5-minute alarm cycle.
 *
 * Actions:
 * - resync (default): gap-aware reconciliation — applies GAP RECOVERY,
 *   FORWARD BUMP, or STALE DETECTION depending on chain state
 * - reset: hard reset to last_executed_tx_nonce + 1 (safe floor)
 */
export class NonceReset extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Trigger on-demand nonce recovery",
    description:
      "Immediately trigger nonce gap recovery on the Nonce Durable Object without waiting for the 5-minute alarm cycle. Requires API key authentication.\n\n" +
      "**resync** (default): Applies the same gap-aware logic as the alarm — GAP RECOVERY resets to lowest missing nonce, FORWARD BUMP advances to chain's possible_next_nonce, STALE DETECTION resets if idle and ahead of chain.\n\n" +
      "**reset**: Hard resets the counter to `last_executed_tx_nonce + 1` — the safe floor that cannot conflict with any confirmed transaction.",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                action: {
                  type: "string" as const,
                  enum: ["resync", "reset"],
                  default: "resync",
                  description:
                    "Recovery action to perform. 'resync' applies gap-aware reconciliation; 'reset' hard resets to last_executed_tx_nonce + 1.",
                  example: "resync",
                },
              },
              description: "Optional action to perform (defaults to 'resync')",
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Nonce recovery triggered successfully",
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
                action: {
                  type: "string" as const,
                  enum: ["resync", "reset"],
                  description: "Action that was performed",
                },
                result: {
                  type: "object" as const,
                  description: "Result from the Nonce Durable Object",
                  properties: {
                    success: { type: "boolean" as const },
                    action: { type: "string" as const },
                    previousNonce: {
                      type: "number" as const,
                      nullable: true,
                      description: "Nonce counter value before recovery",
                    },
                    newNonce: {
                      type: "number" as const,
                      nullable: true,
                      description: "Nonce counter value after recovery",
                    },
                    changed: {
                      type: "boolean" as const,
                      description: "Whether the nonce counter was modified",
                    },
                    reason: {
                      type: "string" as const,
                      description: "Human-readable reason for the change (resync only)",
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

    // Auth is guaranteed by requireAuthMiddleware
    const auth = c.get("auth")!;
    const keyId = auth.metadata?.keyId ?? "unknown";

    // Parse action from body (optional, defaults to "resync")
    let action: NonceResetAction = "resync";
    try {
      const body = await c.req.json() as Record<string, unknown>;
      if (body.action !== undefined) {
        if (body.action !== "resync" && body.action !== "reset") {
          return this.err(c, {
            error: "Invalid action",
            code: "NONCE_RESET_FAILED",
            status: 400,
            details: `action must be 'resync' or 'reset', got '${body.action}'`,
            retryable: false,
          });
        }
        action = body.action as NonceResetAction;
      }
    } catch (_e) {
      // Body is optional — empty body or missing Content-Type is fine, use default
    }

    logger.info("Nonce recovery triggered", { action, keyId });

    try {
      const stub = c.env.NONCE_DO.get(c.env.NONCE_DO.idFromName("sponsor"));
      const doUrl = `https://nonce-do/${action}`;
      const response = await stub.fetch(doUrl, { method: "POST" });

      if (response.status === 503) {
        logger.warn("Nonce DO Hiro API unavailable during recovery", { action });
        return this.err(c, {
          error: "Hiro API unavailable — nonce recovery requires Hiro connectivity",
          code: "NONCE_RESET_FAILED",
          status: 502,
          details: "The Nonce Durable Object could not reach the Hiro API. Retry shortly.",
          retryable: true,
          retryAfter: 5,
        });
      }

      if (!response.ok) {
        const body = await response.text();
        logger.warn("Nonce DO recovery request failed", {
          action,
          status: response.status,
          body,
        });
        return this.err(c, {
          error: "Nonce recovery failed",
          code: "NONCE_RESET_FAILED",
          status: 500,
          details: body || `Nonce DO responded with status ${response.status}`,
          retryable: true,
        });
      }

      const result = await response.json();
      logger.info("Nonce recovery completed", { action, keyId, result });

      return this.ok(c, { action, result });
    } catch (e) {
      logger.error("Nonce recovery request failed", {
        action,
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Nonce recovery failed",
        code: "NONCE_RESET_FAILED",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
      });
    }
  }
}
