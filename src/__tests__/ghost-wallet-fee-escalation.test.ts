import { describe, expect, it, vi, afterEach } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constants (mirrored from nonce-do.ts internals)
// ---------------------------------------------------------------------------
const GHOST_FAILURE_THRESHOLD = 5;
const GAP_FILL_FEE = 30_000n;
const MAX_BROADCAST_FEE = 90_000n;
const CHAINING_LIMIT = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal nonce_state KV store for ghost counter tests */
function makeStateStore(initial: Record<string, number> = {}) {
  const store = new Map<string, number | null>();
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, v);
  }
  return {
    getStateValue: (key: string) => store.get(key) ?? null,
    setStateValue: (key: string, value: number) => store.set(key, value),
    walletGhostFailuresKey: (NonceDO as any).prototype.walletGhostFailuresKey,
    walletGhostDegradedKey: (NonceDO as any).prototype.walletGhostDegradedKey,
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Ghost counter semantics
// ---------------------------------------------------------------------------

describe("ghost wallet counter semantics", () => {
  const incrementGhostFailures = (NonceDO as any).prototype.incrementGhostFailures;
  const resetGhostState = (NonceDO as any).prototype.resetGhostState;
  const walletGhostFailuresKey = (NonceDO as any).prototype.walletGhostFailuresKey;
  const walletGhostDegradedKey = (NonceDO as any).prototype.walletGhostDegradedKey;

  it("increments ghost failures and marks degraded at threshold", () => {
    const ctx = { ...makeStateStore(), log: vi.fn() };

    // Increment up to threshold - 1: NOT degraded yet
    for (let i = 1; i < GHOST_FAILURE_THRESHOLD; i++) {
      const becameDegraded = incrementGhostFailures.call(ctx, 0);
      expect(becameDegraded).toBe(false);
      expect(ctx.getStateValue(walletGhostFailuresKey.call(ctx, 0))).toBe(i);
      expect(ctx.getStateValue(walletGhostDegradedKey.call(ctx, 0))).toBeNull();
    }

    // One more push reaches threshold → degraded
    const becameDegraded = incrementGhostFailures.call(ctx, 0);
    expect(becameDegraded).toBe(true);
    expect(ctx.getStateValue(walletGhostFailuresKey.call(ctx, 0))).toBe(GHOST_FAILURE_THRESHOLD);
    expect(ctx.getStateValue(walletGhostDegradedKey.call(ctx, 0))).toBe(1);
    expect(ctx.log).toHaveBeenCalledWith("warn", "ghost_wallet_degraded", expect.objectContaining({
      walletIndex: 0,
      ghostFailures: GHOST_FAILURE_THRESHOLD,
      threshold: GHOST_FAILURE_THRESHOLD,
    }));
  });

  it("does not re-log degraded on subsequent increments past threshold", () => {
    const ctx = { ...makeStateStore(), log: vi.fn() };

    // Push past threshold
    for (let i = 0; i <= GHOST_FAILURE_THRESHOLD; i++) {
      incrementGhostFailures.call(ctx, 0);
    }
    expect(ctx.log).toHaveBeenCalledTimes(1); // only the first crossing

    // One more: already degraded, no new log
    const becameDegraded = incrementGhostFailures.call(ctx, 0);
    expect(becameDegraded).toBe(false);
    expect(ctx.log).toHaveBeenCalledTimes(1);
  });

  it("resetGhostState clears counter and degraded flag", () => {
    const ctx = {
      ...makeStateStore({
        "wallet_ghost_failures:2": GHOST_FAILURE_THRESHOLD + 3,
        "wallet_ghost_degraded:2": 1,
      }),
      log: vi.fn(),
    };

    resetGhostState.call(ctx, 2);

    expect(ctx.getStateValue(walletGhostFailuresKey.call(ctx, 2))).toBe(0);
    expect(ctx.getStateValue(walletGhostDegradedKey.call(ctx, 2))).toBe(0);
    expect(ctx.log).toHaveBeenCalledWith("info", "ghost_wallet_recovered", { walletIndex: 2 });
  });

  it("resetGhostState does not log recovery when wallet was not degraded", () => {
    const ctx = {
      ...makeStateStore({
        "wallet_ghost_failures:1": 2,
      }),
      log: vi.fn(),
    };

    resetGhostState.call(ctx, 1);

    expect(ctx.getStateValue(walletGhostFailuresKey.call(ctx, 1))).toBe(0);
    expect(ctx.log).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildSponsorStatusSnapshot: ghost-degraded wallets report 0 available
// ---------------------------------------------------------------------------

describe("buildSponsorStatusSnapshot ghost-degraded wallets", () => {
  function makeSnapshotDouble(opts: { rawAvailabilities: number[]; ghostDegradedWallets?: number[] }) {
    const ghostSet = new Set(opts.ghostDegradedWallets ?? []);
    return {
      getInitializedWallets: async () => opts.rawAvailabilities.map((_, walletIndex) => ({ walletIndex })),
      state: {
        storage: {
          get: async () => [],
        },
      },
      walletQuarantineRecentKey: (walletIndex: number) => `quarantine:${walletIndex}`,
      walletHeadroom: (walletIndex: number) => opts.rawAvailabilities[walletIndex],
      walletGhostDegradedKey: (walletIndex: number) => `wallet_ghost_degraded:${walletIndex}`,
      walletChainingDegradedKey: (walletIndex: number) => `wallet_chaining_degraded:${walletIndex}`,
      getStateValue: (key: string) => {
        // Parse wallet index from key like "wallet_ghost_degraded:3"
        const match = key.match(/wallet_ghost_degraded:(\d+)/);
        if (match && ghostSet.has(Number(match[1]))) return 1;
        return null;
      },
      getStoredCount: () => 0,
    };
  }

  it("reports available: 0 for ghost-degraded wallet with positive headroom", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-04T12:00:00.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotDouble({ rawAvailabilities: [15], ghostDegradedWallets: [0] })
    );

    expect(snapshot.noncePool.totalAvailable).toBe(0);
    expect(snapshot.noncePool.totalReserved).toBe(CHAINING_LIMIT);
    expect(snapshot.noncePool.totalCapacity).toBe(CHAINING_LIMIT);
  });

  it("includes ghost-degraded in allWalletsDegraded check", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-04T12:00:00.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotDouble({ rawAvailabilities: [10], ghostDegradedWallets: [0] })
    );

    expect(snapshot.allWalletsDegraded).toBe(true);
  });

  it("healthy wallet unaffected when sibling is ghost-degraded", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-04T12:00:00.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotDouble({ rawAvailabilities: [10, 15], ghostDegradedWallets: [0] })
    );

    // Wallet 0: ghost-degraded → 0 available, 20 reserved
    // Wallet 1: healthy → 15 available, 5 reserved
    expect(snapshot.noncePool.totalAvailable).toBe(15);
    expect(snapshot.noncePool.totalReserved).toBe(25);
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
