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
   * Per-wallet gap counts. Only present when gaps are detected.
   * Keys are "wallet_N" strings, values are arrays of missing nonce numbers.
   */
  gaps?: Record<string, number[]>;
  /**
   * True when gap-fill is actively running (gap detected within last 2 alarm cycles).
   */
  healInProgress?: boolean;
  /**
   * When non-null, clients should take this action instead of submitting sponsored txs.
   * "fallback_to_direct" means the relay's sponsor nonce pool is unhealthy.
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
                    gaps: {
                      type: "object" as const,
                      nullable: true,
                      description:
                        "Per-wallet gap arrays (e.g. {\"wallet_0\": [45]}). " +
                        "Only present when gaps are detected.",
                    },
                    healInProgress: {
                      type: "boolean" as const,
                      description: "True when gap-fill was triggered recently",
                    },
                    recommendation: {
                      type: "string" as const,
                      nullable: true,
                      enum: ["fallback_to_direct"],
                      description:
                        "When non-null, clients should bypass sponsored submission. " +
                        "Set when nonce gaps or circuit breakers make sponsoring unreliable.",
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

      // Fetch both stats and nonce-state in parallel
      const [statsResponse, nonceStateResponse] = await Promise.all([
        stub.fetch("https://nonce-do/stats"),
        stub.fetch("https://nonce-do/nonce-state"),
      ]);

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

      const circuitBreakerOpen =
        recentConflict || (raw.poolAvailable === 0 && raw.poolReserved > 0);

      const totalPool = raw.poolAvailable + raw.poolReserved;
      // When pool is idle (nothing reserved), treat as fully available
      const effectiveCapacity =
        totalPool === 0 ? 1.0 : Math.round((raw.poolAvailable / totalPool) * 100) / 100;
      const poolStatus = derivePoolStatus(effectiveCapacity, circuitBreakerOpen);

      // Extract gap and heal data from nonce-state (best-effort)
      let gaps: Record<string, number[]> | undefined;
      let healInProgress: boolean | undefined;
      let recommendation: "fallback_to_direct" | null = null;

      if (nonceStateResponse.ok) {
        const nonceState = (await nonceStateResponse.json()) as {
          wallets: Array<{
            walletIndex: number;
            gaps: number[];
            circuitBreakerOpen: boolean;
            available: number;
          }>;
          healthy: boolean;
          healInProgress: boolean;
        };

        // Build per-wallet gap map (only include wallets with gaps)
        const gapMap: Record<string, number[]> = {};
        let hasGaps = false;
        for (const w of nonceState.wallets) {
          if (w.gaps.length > 0) {
            gapMap[`wallet_${w.walletIndex}`] = w.gaps;
            hasGaps = true;
          }
        }
        if (hasGaps) {
          gaps = gapMap;
        }

        healInProgress = nonceState.healInProgress || undefined;

        // Recommend fallback when unhealthy (gaps or all degraded)
        const allDegraded =
          nonceState.wallets.length > 0 &&
          nonceState.wallets.every((w) => w.circuitBreakerOpen || w.available === 0);
        if (!nonceState.healthy && (hasGaps || allDegraded)) {
          recommendation = "fallback_to_direct";
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
        ...(gaps && { gaps }),
        ...(healInProgress !== undefined && { healInProgress }),
        ...(recommendation && { recommendation }),
      };
    } catch (e) {
      logger.warn("Failed to fetch nonce state for health check", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return null;
    }
  }
}
