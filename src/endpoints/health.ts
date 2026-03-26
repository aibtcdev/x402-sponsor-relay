import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { VERSION } from "../version";

/** Window within which a gap detection is considered "recent" (10 minutes) */
const RECENT_CONFLICT_WINDOW_MS = 10 * 60 * 1000;

/** Fraction of pool that must be available to be considered "healthy" (≥60%) */
const CAPACITY_HEALTHY_THRESHOLD = 0.6;
/** Fraction below which the pool is "critical" (<20%) */
const CAPACITY_CRITICAL_THRESHOLD = 0.2;

/** Machine-readable pool health status for agent circuit-breaker gating */
type PoolStatus = "healthy" | "degraded" | "critical";

/**
 * Derive a PoolStatus from effective capacity and circuit-breaker state.
 * - "critical": circuit breaker open OR capacity < 20%
 * - "degraded": capacity < 60% (but not critical)
 * - "healthy": capacity ≥ 60% and circuit breaker closed
 */
function derivePoolStatus(effectiveCapacity: number, circuitBreakerOpen: boolean): PoolStatus {
  if (circuitBreakerOpen || effectiveCapacity < CAPACITY_CRITICAL_THRESHOLD) {
    return "critical";
  }
  if (effectiveCapacity < CAPACITY_HEALTHY_THRESHOLD) {
    return "degraded";
  }
  return "healthy";
}

/**
 * Condensed nonce pool state surfaced by /health.
 * Derived from the full NonceStatsResponse returned by NonceDO GET /stats.
 */
interface NonceHealthState {
  /** Number of nonces available in the pool (wallet 0, backward compat) */
  poolAvailable: number;
  /** Number of nonces currently in-flight across all wallets */
  poolReserved: number;
  /** Cumulative count of nonce conflicts detected by the coordinator */
  conflictsDetected: number;
  /**
   * Whether the nonce pool is in a degraded state.
   * True when conflicts have been detected recently (within last 10 minutes)
   * or the pool has no available nonces while there are in-flight reservations.
   */
  circuitBreakerOpen: boolean;
  /** ISO timestamp of last gap/conflict detection, or null if none */
  lastConflictAt: string | null;
  /**
   * Fraction of total pool capacity currently available (0.0–1.0).
   * Computed as poolAvailable / (poolAvailable + poolReserved).
   * 1.0 when pool is empty (no reserved nonces) — idle is healthy.
   */
  effectiveCapacity: number;
  /**
   * Machine-readable pool health for agent circuit-breaker gating.
   * "healthy" ≥60% capacity, "degraded" <60%, "critical" <20% or circuit open.
   */
  poolStatus: PoolStatus;
  /**
   * When non-null, clients should take this action instead of submitting sponsored txs.
   * "fallback_to_direct" means the relay's sponsor nonce pool is unhealthy (gaps or
   * all wallets degraded). Clients should not parse gaps/circuitBreakerOpen/available
   * themselves — this field summarizes the decision. Use GET /nonce/state for raw
   * diagnostic data.
   */
  recommendation?: "fallback_to_direct" | null;
}

/**
 * Health check endpoint
 * GET /health
 */
export class Health extends BaseEndpoint {
  schema = {
    tags: ["Health"],
    summary: "Health check with network info and nonce pool state",
    description:
      "Returns service status, network, version, and a condensed view of the nonce pool state from the NonceDO coordinator. The `nonce` field is null when the coordinator is unavailable.",
    responses: {
      "200": {
        description: "Service health status",
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
                status: { type: "string" as const, example: "ok" },
                network: { type: "string" as const, example: "testnet" },
                version: { type: "string" as const, example: VERSION },
                nonce: {
                  type: "object" as const,
                  nullable: true,
                  description:
                    "Condensed nonce pool state from the NonceDO coordinator. Null when the coordinator is unavailable.",
                  properties: {
                    poolAvailable: {
                      type: "number" as const,
                      description: "Nonces available in the pool ready to be assigned",
                      example: 15,
                    },
                    poolReserved: {
                      type: "number" as const,
                      description: "Nonces currently in-flight (assigned but not yet confirmed)",
                      example: 2,
                    },
                    conflictsDetected: {
                      type: "number" as const,
                      description: "Cumulative count of nonce conflicts detected",
                      example: 0,
                    },
                    circuitBreakerOpen: {
                      type: "boolean" as const,
                      description:
                        "True when recent conflicts or pool exhaustion indicate the pool is degraded",
                      example: false,
                    },
                    lastConflictAt: {
                      type: "string" as const,
                      nullable: true,
                      description:
                        "ISO timestamp of the most recent nonce gap/conflict detection, or null",
                      example: null,
                    },
                    effectiveCapacity: {
                      type: "number" as const,
                      description:
                        "Fraction of pool capacity currently available (0.0–1.0). " +
                        "Computed as poolAvailable / (poolAvailable + poolReserved). " +
                        "1.0 when pool is idle (no reserved nonces).",
                      example: 0.88,
                    },
                    poolStatus: {
                      type: "string" as const,
                      enum: ["healthy", "degraded", "critical"],
                      description:
                        "Machine-readable pool health for agent circuit-breaker gating. " +
                        "'healthy' ≥60% capacity, 'degraded' <60%, " +
                        "'critical' <20% or circuit breaker open.",
                      example: "healthy",
                    },
                    recommendation: {
                      type: "string" as const,
                      nullable: true,
                      enum: ["fallback_to_direct"],
                      description:
                        "When non-null, clients should bypass sponsored submission. " +
                        "Summarizes the gap/circuit-breaker decision — clients should not " +
                        "parse raw fields themselves. Use GET /nonce/state for diagnostics.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    const nonceState = await this.fetchNonceState(c, logger);

    return this.ok(c, {
      status: "ok",
      network: c.env.STACKS_NETWORK,
      version: VERSION,
      nonce: nonceState,
    });
  }

  /**
   * Fetch condensed nonce pool state from NonceDO.
   * Returns null on any error so /health degrades gracefully rather than failing.
   */
  private async fetchNonceState(
    c: AppContext,
    logger: ReturnType<typeof this.getLogger>
  ): Promise<NonceHealthState | null> {
    if (!c.env.NONCE_DO) {
      return null;
    }

    try {
      const stub = c.env.NONCE_DO.get(c.env.NONCE_DO.idFromName("sponsor"));
      const statsResponse = await stub.fetch("https://nonce-do/stats");

      if (!statsResponse.ok) {
        logger.warn("Nonce DO stats unavailable for health check", {
          status: statsResponse.status,
        });
        return null;
      }

      const raw = (await statsResponse.json()) as {
        poolAvailable: number;
        poolReserved: number;
        conflictsDetected: number;
        lastGapDetected: string | null;
      };

      const lastConflictAt = raw.lastGapDetected ?? null;
      const recentConflict =
        lastConflictAt !== null &&
        Date.now() - new Date(lastConflictAt).getTime() <= RECENT_CONFLICT_WINDOW_MS;

      // Pool exhausted by conflicts: both available and reserved are 0 but conflicts
      // were detected — this means the pool drained without recovering (e.g. all
      // wallets hit conflict state and nonces flushed). Phase 1 auto-resets
      // conflictsDetected when resync finds all wallets consistent, so this
      // condition only fires during genuinely unresolved conflict windows.
      const poolExhaustedByConflicts =
        raw.poolAvailable === 0 && raw.poolReserved === 0 && raw.conflictsDetected > 0;

      const circuitBreakerOpen =
        recentConflict || (raw.poolAvailable === 0 && raw.poolReserved > 0) || poolExhaustedByConflicts;

      const totalPool = raw.poolAvailable + raw.poolReserved;
      // When pool is idle (nothing reserved), treat as fully available
      const effectiveCapacity =
        totalPool === 0 ? 1.0 : Math.round((raw.poolAvailable / totalPool) * 100) / 100;
      const poolStatus = derivePoolStatus(effectiveCapacity, circuitBreakerOpen);

      // Only fetch nonce-state when pool looks unhealthy — avoids adding
      // two SQL queries + Promise.all to every pre-flight health check.
      // recommendation is derived inside the DO (single source of truth).
      let recommendation: "fallback_to_direct" | null = null;

      if (poolStatus !== "healthy") {
        try {
          const nonceStateResponse = await stub.fetch("https://nonce-do/nonce-state");
          if (nonceStateResponse.ok) {
            const nonceState = (await nonceStateResponse.json()) as {
              recommendation: "fallback_to_direct" | null;
            };
            recommendation = nonceState.recommendation;
          }
        } catch {
          // best-effort — don't block health response
        }
      }

      return {
        poolAvailable: raw.poolAvailable,
        poolReserved: raw.poolReserved,
        conflictsDetected: raw.conflictsDetected,
        circuitBreakerOpen,
        lastConflictAt,
        effectiveCapacity,
        poolStatus,
        recommendation,
      };
    } catch (e) {
      logger.warn("Failed to fetch nonce state for health check", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }
}
