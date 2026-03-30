import { describe, expect, it } from "vitest";
import {
  getSponsorReconciliationFreshness,
  getSponsorSnapshotFreshness,
  toSponsorStatusResult,
  type StoredSponsorStatusSnapshot,
} from "../services/sponsor-status";
import { SponsorStatus } from "../endpoints/sponsor-status";

function makeSnapshot(overrides: Partial<StoredSponsorStatusSnapshot> = {}): StoredSponsorStatusSnapshot {
  return {
    asOf: "2026-03-30T18:20:00.000Z",
    walletCount: 4,
    allWalletsDegraded: false,
    recommendation: null,
    noncePool: {
      totalAvailable: 72,
      totalReserved: 8,
      totalCapacity: 80,
      poolAvailabilityRatio: 0.9,
      conflictsDetected: 0,
      lastConflictAt: null,
      healInProgress: false,
    },
    reconciliation: {
      lastSuccessfulAt: "2026-03-30T18:19:30.000Z",
    },
    ...overrides,
  };
}

describe("toSponsorStatusResult", () => {
  it("returns healthy when snapshot and reconciliation are fresh", () => {
    const result = toSponsorStatusResult(
      makeSnapshot(),
      Date.parse("2026-03-30T18:20:10.000Z")
    );

    expect(result.status).toBe("healthy");
    expect(result.canSponsor).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.snapshot.freshness).toBe("fresh");
    expect(result.reconciliation.freshness).toBe("fresh");
  });

  it("degrades stale snapshots without marking them unavailable", () => {
    const result = toSponsorStatusResult(
      makeSnapshot(),
      Date.parse("2026-03-30T18:21:00.000Z")
    );

    expect(result.status).toBe("degraded");
    expect(result.canSponsor).toBe(false);
    expect(result.reasons).toContain("SNAPSHOT_STALE");
    expect(result.snapshot.freshness).toBe("stale");
  });

  it("marks expired snapshots unavailable", () => {
    const result = toSponsorStatusResult(
      makeSnapshot(),
      Date.parse("2026-03-30T18:30:30.000Z")
    );

    expect(result.status).toBe("unavailable");
    expect(result.canSponsor).toBe(false);
    expect(result.reasons).toContain("SNAPSHOT_STALE");
    expect(result.snapshot.freshness).toBe("expired");
  });

  it("marks missing reconciliation metadata unavailable and degrades status", () => {
    const result = toSponsorStatusResult(
      makeSnapshot({
        reconciliation: {
          lastSuccessfulAt: null,
        },
      }),
      Date.parse("2026-03-30T18:20:10.000Z")
    );

    expect(result.status).toBe("degraded");
    expect(result.canSponsor).toBe(false);
    expect(result.reconciliation.freshness).toBe("unavailable");
    expect(result.reasons).toContain("RECONCILIATION_STALE");
  });

  it("adds pool and reconciliation degradation reasons", () => {
    const result = toSponsorStatusResult(
      makeSnapshot({
        allWalletsDegraded: true,
        recommendation: "fallback_to_direct",
        noncePool: {
          totalAvailable: 0,
          totalReserved: 80,
          totalCapacity: 80,
          poolAvailabilityRatio: 0,
          conflictsDetected: 3,
          lastConflictAt: "2026-03-30T18:19:55.000Z",
          healInProgress: true,
        },
        reconciliation: {
          lastSuccessfulAt: "2026-03-30T18:15:00.000Z",
        },
      }),
      Date.parse("2026-03-30T18:20:10.000Z")
    );

    expect(result.status).toBe("degraded");
    expect(result.recommendation).toBe("fallback_to_direct");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "NO_AVAILABLE_NONCES",
        "ALL_WALLETS_DEGRADED",
        "RECENT_CONFLICT",
        "HEAL_IN_PROGRESS",
        "RECONCILIATION_STALE",
      ])
    );
  });
});

describe("sponsor status freshness helpers", () => {
  it("treats snapshot freshness windows as fresh, stale, then expired", () => {
    expect(
      getSponsorSnapshotFreshness(
        "2026-03-30T18:20:00.000Z",
        Date.parse("2026-03-30T18:20:20.000Z")
      )
    ).toBe("fresh");
    expect(
      getSponsorSnapshotFreshness(
        "2026-03-30T18:20:00.000Z",
        Date.parse("2026-03-30T18:21:00.000Z")
      )
    ).toBe("stale");
    expect(
      getSponsorSnapshotFreshness(
        "2026-03-30T18:20:00.000Z",
        Date.parse("2026-03-30T18:26:00.000Z")
      )
    ).toBe("expired");
  });

  it("treats reconciliation freshness windows as fresh, stale, or unavailable", () => {
    expect(
      getSponsorReconciliationFreshness(
        "2026-03-30T18:19:30.000Z",
        Date.parse("2026-03-30T18:20:10.000Z")
      )
    ).toBe("fresh");
    expect(
      getSponsorReconciliationFreshness(
        "2026-03-30T18:15:00.000Z",
        Date.parse("2026-03-30T18:20:10.000Z")
      )
    ).toBe("stale");
    expect(getSponsorReconciliationFreshness(null)).toBe("unavailable");
  });
});

describe("SponsorStatus schema", () => {
  it("documents the canonical cached sponsor status shape", () => {
    const endpoint = new SponsorStatus();
    const properties =
      endpoint.schema.responses["200"].content["application/json"].schema.properties;

    expect(properties).toHaveProperty("noncePool");
    expect(properties).toHaveProperty("reconciliation");
    expect(properties).toHaveProperty("snapshot");
    expect(properties.noncePool.properties).toHaveProperty("poolAvailabilityRatio");
  });
});
