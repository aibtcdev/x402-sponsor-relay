import { describe, expect, it, vi, afterEach } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSnapshotBuilderDouble(rawAvailabilities: number[]) {
  return {
    getInitializedWallets: async () => rawAvailabilities.map((_, walletIndex) => ({ walletIndex })),
    state: {
      storage: {
        get: async () => [],
      },
    },
    walletQuarantineRecentKey: (walletIndex: number) => `quarantine:${walletIndex}`,
    walletHeadroom: (walletIndex: number) => rawAvailabilities[walletIndex],
    getStateValue: () => null,
    getStoredCount: () => 0,
  };
}

describe("NonceDO sponsor status snapshot clamp", () => {
  it("floors negative wallet headroom at zero available", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-30T18:20:10.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotBuilderDouble([-3])
    );

    expect(snapshot.noncePool.totalAvailable).toBe(0);
    expect(snapshot.noncePool.totalReserved).toBe(20);
    expect(snapshot.noncePool.totalCapacity).toBe(20);
    expect(snapshot.noncePool.poolAvailabilityRatio).toBe(0);
  });

  it("caps oversized wallet headroom at the chaining limit", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-30T18:20:10.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotBuilderDouble([27])
    );

    expect(snapshot.noncePool.totalAvailable).toBe(20);
    expect(snapshot.noncePool.totalReserved).toBe(0);
    expect(snapshot.noncePool.totalCapacity).toBe(20);
    expect(snapshot.noncePool.poolAvailabilityRatio).toBe(1);
  });
});
