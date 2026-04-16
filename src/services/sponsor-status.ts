import type {
  SponsorReconciliationFreshness,
  SponsorSnapshotFreshness,
  SponsorStatusReason,
  SponsorStatusResult,
} from "../types";

// Re-export canonical tx-schemas wallet state types so callers import from one place.
// Phase 2: establishes the type bridge. Phase 3+ wires these into decision points.
export type { WalletCapacity, OccupiedNonce } from "@aibtc/tx-schemas";

export const SPONSOR_STATUS_SNAPSHOT_FRESH_MS = 5 * 60 * 1000;
export const SPONSOR_STATUS_SNAPSHOT_EXPIRED_MS = 10 * 60 * 1000;
export const SPONSOR_STATUS_RECONCILIATION_FRESH_MS = 5 * 60 * 1000;
export const SPONSOR_STATUS_RECENT_CONFLICT_WINDOW_MS = 10 * 60 * 1000;

export interface StoredSponsorStatusSnapshot {
  asOf: string;
  walletCount: number;
  allWalletsDegraded: boolean;
  recommendation: "fallback_to_direct" | null;
  noncePool: {
    totalAvailable: number;
    totalReserved: number;
    totalCapacity: number;
    poolAvailabilityRatio: number;
    conflictsDetected: number;
    lastConflictAt: string | null;
    healInProgress: boolean;
  };
  reconciliation: {
    lastSuccessfulAt: string | null;
  };
}

export function getSponsorSnapshotFreshness(
  asOf: string,
  nowMs = Date.now()
): SponsorSnapshotFreshness {
  const ageMs = Math.max(0, nowMs - new Date(asOf).getTime());
  if (ageMs <= SPONSOR_STATUS_SNAPSHOT_FRESH_MS) {
    return "fresh";
  }
  if (ageMs <= SPONSOR_STATUS_SNAPSHOT_EXPIRED_MS) {
    return "stale";
  }
  return "expired";
}

export function getSponsorReconciliationFreshness(
  lastSuccessfulAt: string | null,
  nowMs = Date.now()
): SponsorReconciliationFreshness {
  if (!lastSuccessfulAt) {
    return "unavailable";
  }
  const ageMs = Math.max(0, nowMs - new Date(lastSuccessfulAt).getTime());
  return ageMs <= SPONSOR_STATUS_RECONCILIATION_FRESH_MS ? "fresh" : "stale";
}

export function toSponsorStatusResult(
  snapshot: StoredSponsorStatusSnapshot,
  nowMs = Date.now()
): SponsorStatusResult {
  const snapshotAgeMs = Math.max(0, nowMs - new Date(snapshot.asOf).getTime());
  const snapshotFreshness = getSponsorSnapshotFreshness(snapshot.asOf, nowMs);
  const reconciliationFreshness = getSponsorReconciliationFreshness(
    snapshot.reconciliation.lastSuccessfulAt,
    nowMs
  );

  const reasons: SponsorStatusReason[] = [];

  if (snapshot.noncePool.totalAvailable === 0) {
    reasons.push("NO_AVAILABLE_NONCES");
  }
  if (snapshot.allWalletsDegraded) {
    reasons.push("ALL_WALLETS_DEGRADED");
  }
  if (
    snapshot.noncePool.lastConflictAt &&
    nowMs - new Date(snapshot.noncePool.lastConflictAt).getTime() <=
      SPONSOR_STATUS_RECENT_CONFLICT_WINDOW_MS
  ) {
    reasons.push("RECENT_CONFLICT");
  }
  if (snapshot.noncePool.healInProgress) {
    reasons.push("HEAL_IN_PROGRESS");
  }
  if (reconciliationFreshness !== "fresh") {
    reasons.push("RECONCILIATION_STALE");
  }
  if (snapshotFreshness !== "fresh") {
    reasons.push("SNAPSHOT_STALE");
  }

  let status: SponsorStatusResult["status"] = "healthy";
  if (snapshotFreshness === "expired") {
    status = "unavailable";
  } else if (reasons.length > 0) {
    status = "degraded";
  }

  return {
    status,
    canSponsor: status === "healthy",
    walletCount: snapshot.walletCount,
    recommendation: snapshot.recommendation,
    reasons,
    noncePool: {
      totalAvailable: snapshot.noncePool.totalAvailable,
      totalReserved: snapshot.noncePool.totalReserved,
      totalCapacity: snapshot.noncePool.totalCapacity,
      poolAvailabilityRatio: snapshot.noncePool.poolAvailabilityRatio,
      conflictsDetected: snapshot.noncePool.conflictsDetected,
      lastConflictAt: snapshot.noncePool.lastConflictAt,
      healInProgress: snapshot.noncePool.healInProgress,
    },
    reconciliation: {
      source: "hiro",
      lastSuccessfulAt: snapshot.reconciliation.lastSuccessfulAt,
      freshness: reconciliationFreshness,
    },
    snapshot: {
      asOf: snapshot.asOf,
      ageMs: snapshotAgeMs,
      freshness: snapshotFreshness,
    },
  };
}
