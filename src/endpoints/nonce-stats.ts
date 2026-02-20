import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import { Error500Response } from "../schemas";

/** Window within which a gap detection is considered "recent" (10 minutes) */
const RECENT_GAP_WINDOW_MS = 10 * 60 * 1000;

interface NonceStats {
  totalAssigned: number;
  conflictsDetected: number;
  lastAssignedNonce: number | null;
  lastAssignedAt: string | null;
  nextNonce: number | null;
  txidCount: number;
  /** Number of times the alarm recovered from a nonce gap */
  gapsRecovered: number;
  /** ISO timestamp of last successful Hiro nonce sync (null if never) */
  lastHiroSync: string | null;
  /** ISO timestamp of last gap detection (null if no gaps detected) */
  lastGapDetected: string | null;
}

/** Human-readable summary of current gap state */
type GapStatus = "recent_gap" | "gaps_recovered_historically" | "no_gaps";

/**
 * Derive a human-readable gap status from raw NonceStats fields.
 * - "recent_gap": lastGapDetected is within the last 10 minutes
 * - "gaps_recovered_historically": at least one gap was recovered but not recently
 * - "no_gaps": no gap has ever been detected
 */
function deriveGapStatus(stats: NonceStats): GapStatus {
  if (stats.lastGapDetected !== null) {
    const gapAgeMs = Date.now() - new Date(stats.lastGapDetected).getTime();
    if (gapAgeMs <= RECENT_GAP_WINDOW_MS) {
      return "recent_gap";
    }
  }
  if (stats.gapsRecovered > 0) {
    return "gaps_recovered_historically";
  }
  return "no_gaps";
}

/**
 * Nonce stats endpoint - returns Durable Object stats
 * GET /nonce/stats
 */
export class NonceStatsEndpoint extends BaseEndpoint {
  schema = {
    tags: ["Nonce"],
    summary: "Get nonce coordinator stats",
    description:
      "Returns nonce assignment and txid tracking statistics from the Nonce Durable Object. Includes gap recovery counters and a derived gapStatus summary.",
    responses: {
      "200": {
        description: "Nonce stats retrieved successfully",
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
                stats: {
                  type: "object" as const,
                  properties: {
                    totalAssigned: { type: "number" as const },
                    conflictsDetected: { type: "number" as const },
                    lastAssignedNonce: { type: "number" as const, nullable: true },
                    lastAssignedAt: { type: "string" as const, nullable: true },
                    nextNonce: { type: "number" as const, nullable: true },
                    txidCount: { type: "number" as const },
                    gapsRecovered: {
                      type: "number" as const,
                      description: "Number of times the alarm or on-demand resync recovered from a nonce gap",
                    },
                    lastHiroSync: {
                      type: "string" as const,
                      nullable: true,
                      description: "ISO timestamp of last successful Hiro nonce sync",
                    },
                    lastGapDetected: {
                      type: "string" as const,
                      nullable: true,
                      description: "ISO timestamp of last gap detection",
                    },
                    gapStatus: {
                      type: "string" as const,
                      enum: ["recent_gap", "gaps_recovered_historically", "no_gaps"],
                      description:
                        "Derived gap health summary. 'recent_gap' = gap detected within the last 10 minutes; 'gaps_recovered_historically' = at least one gap was recovered but not recently; 'no_gaps' = no gap ever detected.",
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

    try {
      const stub = c.env.NONCE_DO.get(c.env.NONCE_DO.idFromName("sponsor"));
      const response = await stub.fetch("https://nonce-do/stats");

      if (!response.ok) {
        const body = await response.text();
        logger.warn("Nonce DO stats request failed", {
          status: response.status,
          body,
        });
        return this.err(c, {
          error: "Failed to fetch nonce stats",
          code: "INTERNAL_ERROR",
          status: 500,
          details: body || "Nonce DO responded with error",
          retryable: true,
          retryAfter: 5,
        });
      }

      const rawStats = (await response.json()) as NonceStats;
      const gapStatus = deriveGapStatus(rawStats);
      const stats = { ...rawStats, gapStatus };

      return this.ok(c, { stats });
    } catch (e) {
      logger.error("Nonce stats request failed", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Failed to fetch nonce stats",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
