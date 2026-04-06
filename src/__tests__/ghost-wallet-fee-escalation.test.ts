import { describe, expect, it, vi, afterEach } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constants (mirrored from nonce-do.ts internals)
// ---------------------------------------------------------------------------
const GAP_FILL_FEE = 30_000n;
const MAX_BROADCAST_FEE = 90_000n;
const CHAINING_LIMIT = 20;

// ---------------------------------------------------------------------------
// buildSponsorStatusSnapshot: available math (no ghost-degraded flags)
// ---------------------------------------------------------------------------

describe("buildSponsorStatusSnapshot available math", () => {
  function makeSnapshotDouble(opts: { rawAvailabilities: number[] }) {
    return {
      getInitializedWallets: () => opts.rawAvailabilities.map((_, walletIndex) => ({ walletIndex })),
      walletHeadroom: (walletIndex: number) => opts.rawAvailabilities[walletIndex],
      getStateValue: () => null,
      getStoredCount: () => 0,
    };
  }

  it("reports correct available from headroom", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-04T12:00:00.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotDouble({ rawAvailabilities: [15] })
    );

    expect(snapshot.noncePool.totalAvailable).toBe(15);
    expect(snapshot.noncePool.totalReserved).toBe(CHAINING_LIMIT - 15);
    expect(snapshot.noncePool.totalCapacity).toBe(CHAINING_LIMIT);
    expect(snapshot.allWalletsDegraded).toBe(false);
  });

  it("allWalletsDegraded only when all wallets at zero available", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-04T12:00:00.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotDouble({ rawAvailabilities: [0] })
    );

    expect(snapshot.allWalletsDegraded).toBe(true);
  });

  it("multi-wallet available sums correctly", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-04T12:00:00.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotDouble({ rawAvailabilities: [10, 15] })
    );

    expect(snapshot.noncePool.totalAvailable).toBe(25);
    expect(snapshot.noncePool.totalReserved).toBe(2 * CHAINING_LIMIT - 25);
    expect(snapshot.allWalletsDegraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeEscalatedFee
// ---------------------------------------------------------------------------

describe("computeEscalatedFee", () => {
  const computeEscalatedFee = (NonceDO as any).prototype.computeEscalatedFee;

  function makeSqlDouble(gapFillAttempts: number | null, throwOnQuery = false) {
    return {
      sql: {
        exec: throwOnQuery
          ? () => { throw new Error("SQL error"); }
          : () => ({
              toArray: () =>
                gapFillAttempts !== null
                  ? [{ gap_fill_attempts: gapFillAttempts }]
                  : [],
            }),
      },
    };
  }

  it("returns base fee when no prior attempts", () => {
    const fee = computeEscalatedFee.call(makeSqlDouble(0), 0, 42);
    expect(fee).toBe(GAP_FILL_FEE);
  });

  it("returns base fee when nonce has no row", () => {
    const fee = computeEscalatedFee.call(makeSqlDouble(null), 0, 42);
    expect(fee).toBe(GAP_FILL_FEE);
  });

  it("escalates by prior attempts count", () => {
    const fee = computeEscalatedFee.call(makeSqlDouble(3), 0, 42);
    expect(fee).toBe(GAP_FILL_FEE + 3n);
  });

  it("caps at MAX_BROADCAST_FEE", () => {
    // 100k attempts would push way past 90k cap
    const fee = computeEscalatedFee.call(makeSqlDouble(100_000), 0, 42);
    expect(fee).toBe(MAX_BROADCAST_FEE);
  });

  it("respects custom baseFee", () => {
    const baseFee = 50_000n;
    const fee = computeEscalatedFee.call(makeSqlDouble(5), 0, 42, baseFee);
    expect(fee).toBe(baseFee + 5n);
  });

  it("caps custom baseFee + attempts at MAX_BROADCAST_FEE", () => {
    const baseFee = 89_999n;
    const fee = computeEscalatedFee.call(makeSqlDouble(5), 0, 42, baseFee);
    expect(fee).toBe(MAX_BROADCAST_FEE);
  });

  it("fails open to base fee on SQL error", () => {
    const fee = computeEscalatedFee.call(makeSqlDouble(0, true), 0, 42);
    expect(fee).toBe(GAP_FILL_FEE);
  });
});
