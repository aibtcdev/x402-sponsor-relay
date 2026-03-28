import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import {
  Error400Response,
  Error401Response,
  Error500Response,
  Error502Response,
} from "../schemas";

type NonceResetAction = "resync" | "reset" | "clear-pools" | "clear-conflicts" | "flush-wallet";

const VALID_ACTIONS = new Set<string>(["resync", "reset", "clear-pools", "clear-conflicts", "flush-wallet"]);

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
 * - clear-pools: wipe all per-wallet pool state and stored addresses;
 *   pools reinitialize from Hiro on next /assign (use after derivation changes)
 * - clear-conflicts: zero out conflictsDetected and clear lastGapDetected
 *   without touching nonce pool state (manual circuit-breaker escape hatch)
 */
export class NonceReset extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Trigger on-demand nonce recovery",
    description:
      "Immediately trigger nonce gap recovery on the Nonce Durable Object without waiting for the 5-minute alarm cycle. Requires API key authentication.\n\n" +
      "**resync** (default): Applies the same gap-aware logic as the alarm — GAP RECOVERY resets to lowest missing nonce, FORWARD BUMP advances to chain's possible_next_nonce, STALE DETECTION resets if idle and ahead of chain.\n\n" +
      "**reset**: Hard resets the counter to `last_executed_tx_nonce + 1` — the safe floor that cannot conflict with any confirmed transaction.\n\n" +
      "**clear-pools**: Wipes all per-wallet pool state and stored addresses. Pools reinitialize from Hiro on the next request. Use after wallet derivation changes.\n\n" +
      "**clear-conflicts**: Zeroes out `conflictsDetected` and clears `lastGapDetected` without touching nonce pool state. Manual escape hatch when auto-clear hasn't fired yet and the health circuit breaker is blocking traffic.\n\n" +
      "**flush-wallet**: Full wallet flush for a specific wallet index (requires `walletIndex` in body). Retracts all active dispatch_queue entries to the replay buffer, fills the entire nonce range with self-transfers (RBF for occupied slots, gap-fill for empty ones), and resets the wallet head to `last_executed+1`. Use when 18+ scattered gaps cause TooMuchChaining and surgical gap-filling is insufficient. Capped at 50 nonces per flush.",
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
                  enum: ["resync", "reset", "clear-pools", "clear-conflicts", "flush-wallet"],
                  default: "resync",
                  description:
                    "Recovery action to perform. 'resync' applies gap-aware reconciliation; 'reset' hard resets to last_executed_tx_nonce + 1; 'clear-pools' wipes all wallet pools for reinitialization; 'clear-conflicts' zeroes conflictsDetected and clears lastGapDetected without touching pool state; 'flush-wallet' performs a full wallet flush (requires walletIndex).",
                  example: "resync",
                },
                walletIndex: {
                  type: "number" as const,
                  minimum: 0,
                  description:
                    "Wallet index for the 'flush-wallet' action (0-based, required when action is 'flush-wallet'). Ignored for other actions.",
                  example: 0,
                },
                probeDepth: {
                  type: "number" as const,
                  minimum: 1,
                  maximum: 50,
                  description:
                    "Backward probe depth for 'flush-wallet' when the forward nonce range is empty. Broadcasts self-transfers at nonces below last_executed to evict ghost mempool entries from the Stacks node. Only used with 'flush-wallet'.",
                  example: 25,
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
                  enum: ["resync", "reset", "clear-pools", "clear-conflicts", "flush-wallet"],
                  description: "Action that was performed",
                },
                result: {
                  type: "object" as const,
                  description: "Result from the Nonce Durable Object (shape varies by action)",
                  properties: {
                    success: { type: "boolean" as const },
                    action: { type: "string" as const },
                    previousNonce: {
                      type: "number" as const,
                      nullable: true,
                      description: "Nonce counter value before recovery (resync/reset)",
                    },
                    newNonce: {
                      type: "number" as const,
                      nullable: true,
                      description: "Nonce counter value after recovery (resync/reset)",
                    },
                    changed: {
                      type: "boolean" as const,
                      description: "Whether the nonce counter was modified (resync/reset)",
                    },
                    reason: {
                      type: "string" as const,
                      description: "Human-readable reason for the change (resync only)",
                    },
                    cleared: {
                      type: "boolean" as const,
                      description: "Whether conflict counters were cleared (clear-conflicts)",
                    },
                    previousConflicts: {
                      type: "number" as const,
                      description: "Conflict count before clearing (clear-conflicts)",
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
      "502": { ...Error502Response, description: "Hiro API unavailable during nonce recovery" },
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

    // Parse action, optional walletIndex, and optional probeDepth from body (action defaults to "resync")
    let action: NonceResetAction = "resync";
    let walletIndex: number | undefined;
    let probeDepth: number | undefined;
    try {
      const body = await c.req.json() as Record<string, unknown>;
      if (body.action !== undefined) {
        if (!VALID_ACTIONS.has(body.action as string)) {
          return this.err(c, {
            error: "Invalid action",
            code: "NONCE_RESET_FAILED",
            status: 400,
            details: `action must be one of ${[...VALID_ACTIONS].join(", ")}; got '${body.action}'`,
            retryable: false,
          });
        }
        action = body.action as NonceResetAction;
      }
      if (body.walletIndex !== undefined) {
        if (typeof body.walletIndex === "number" && Number.isInteger(body.walletIndex) && body.walletIndex >= 0) {
          walletIndex = body.walletIndex;
        } else {
          return this.err(c, {
            error: "Invalid walletIndex",
            code: "NONCE_RESET_FAILED",
            status: 400,
            details: `walletIndex must be a non-negative integer; got '${body.walletIndex}'`,
            retryable: false,
          });
        }
      }
      if (body.probeDepth !== undefined) {
        if (typeof body.probeDepth === "number" && Number.isInteger(body.probeDepth) && body.probeDepth > 0 && body.probeDepth <= 50) {
          probeDepth = body.probeDepth;
        } else {
          return this.err(c, {
            error: "Invalid probeDepth",
            code: "NONCE_RESET_FAILED",
            status: 400,
            details: `probeDepth must be an integer between 1 and 50; got '${body.probeDepth}'`,
            retryable: false,
          });
        }
      }
    } catch (_e) {
      // Body is optional — empty body or missing Content-Type is fine, use defaults
    }

    // flush-wallet requires an explicit walletIndex — don't silently default to 0
    if (action === "flush-wallet" && walletIndex === undefined) {
      return this.err(c, {
        error: "Missing walletIndex for flush-wallet",
        code: "NONCE_RESET_FAILED",
        status: 400,
        details: "flush-wallet requires a non-negative integer walletIndex in the request body",
        retryable: false,
      });
    }

    logger.info("Nonce recovery triggered", { action, keyId, ...(walletIndex !== undefined && { walletIndex }), ...(probeDepth !== undefined && { probeDepth }) });

    try {
      const stub = c.env.NONCE_DO.get(c.env.NONCE_DO.idFromName("sponsor"));
      // flush-wallet targets a specific wallet; all other actions use the action name as path
      const doUrl = action === "flush-wallet"
        ? `https://nonce-do/flush-wallet/${walletIndex!}${probeDepth ? `?probeDepth=${probeDepth}` : ""}`
        : `https://nonce-do/${action}`;
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
        // Preserve 4xx from DO (operator input errors) — only map 5xx as internal error
        const isClientError = response.status >= 400 && response.status < 500;
        return this.err(c, {
          error: isClientError ? body || "Bad request" : "Nonce recovery failed",
          code: "NONCE_RESET_FAILED",
          status: isClientError ? response.status : 500,
          details: body || `Nonce DO responded with status ${response.status}`,
          retryable: !isClientError,
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
