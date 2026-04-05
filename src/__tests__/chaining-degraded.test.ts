import { describe, expect, it, vi, afterEach } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constants (mirrored from nonce-do.ts internals)
// ---------------------------------------------------------------------------
const CHAINING_FAILURE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal nonce_state KV store for chaining counter tests */
function makeStateStore(initial: Record<string, number> = {}) {
  const store = new Map<string, number | null>();
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, v);
  }
  return {
    getStateValue: (key: string) => store.get(key) ?? null,
    setStateValue: (key: string, value: number) => store.set(key, value),
    walletChainingFailuresKey: (NonceDO as any).prototype.walletChainingFailuresKey,
    walletChainingDegradedKey: (NonceDO as any).prototype.walletChainingDegradedKey,
    walletChainingDegradedAtKey: (NonceDO as any).prototype.walletChainingDegradedAtKey,
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Chaining counter semantics
// ---------------------------------------------------------------------------

describe("chaining wallet counter semantics", () => {
  const incrementChainingFailures = (NonceDO as any).prototype.incrementChainingFailures;
  const resetChainingState = (NonceDO as any).prototype.resetChainingState;
  const walletChainingFailuresKey = (NonceDO as any).prototype.walletChainingFailuresKey;
  const walletChainingDegradedKey = (NonceDO as any).prototype.walletChainingDegradedKey;
  const walletChainingDegradedAtKey = (NonceDO as any).prototype.walletChainingDegradedAtKey;

  it("increments chaining failures and marks degraded at threshold", () => {
    const frozenNow = Date.parse("2026-04-04T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(frozenNow);
    const ctx = { ...makeStateStore(), log: vi.fn() };

    // Increment up to threshold - 1: NOT degraded yet
    for (let i = 1; i < CHAINING_FAILURE_THRESHOLD; i++) {
      const becameDegraded = incrementChainingFailures.call(ctx, 0);
      expect(becameDegraded).toBe(false);
      expect(ctx.getStateValue(walletChainingFailuresKey.call(ctx, 0))).toBe(i);
      expect(ctx.getStateValue(walletChainingDegradedKey.call(ctx, 0))).toBeNull();
    }

    // One more push reaches threshold → degraded
    const becameDegraded = incrementChainingFailures.call(ctx, 0);
    expect(becameDegraded).toBe(true);
    expect(ctx.getStateValue(walletChainingFailuresKey.call(ctx, 0))).toBe(CHAINING_FAILURE_THRESHOLD);
    expect(ctx.getStateValue(walletChainingDegradedKey.call(ctx, 0))).toBe(1);
    // degradedAt timestamp recorded
    expect(ctx.getStateValue(walletChainingDegradedAtKey.call(ctx, 0))).toBe(frozenNow);
    expect(ctx.log).toHaveBeenCalledWith("warn", "chaining_wallet_degraded", expect.objectContaining({
      walletIndex: 0,
      chainingFailures: CHAINING_FAILURE_THRESHOLD,
      threshold: CHAINING_FAILURE_THRESHOLD,
    }));
  });

  it("does not re-log degraded on subsequent increments past threshold", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-04T12:00:00.000Z"));
    const ctx = { ...makeStateStore(), log: vi.fn() };

    // Push past threshold
    for (let i = 0; i <= CHAINING_FAILURE_THRESHOLD; i++) {
      incrementChainingFailures.call(ctx, 0);
    }
    expect(ctx.log).toHaveBeenCalledTimes(1); // only the first crossing

    // One more: already degraded, no new log
    const becameDegraded = incrementChainingFailures.call(ctx, 0);
    expect(becameDegraded).toBe(false);
    expect(ctx.log).toHaveBeenCalledTimes(1);
  });

  it("resetChainingState clears counter, degraded flag, and degradedAt key", () => {
    const ctx = {
      ...makeStateStore({
        "wallet_chaining_failures:2": CHAINING_FAILURE_THRESHOLD + 1,
        "wallet_chaining_degraded:2": 1,
        "wallet_chaining_degraded_at:2": Date.parse("2026-04-04T11:00:00.000Z"),
      }),
      log: vi.fn(),
    };

    resetChainingState.call(ctx, 2);

    expect(ctx.getStateValue(walletChainingFailuresKey.call(ctx, 2))).toBe(0);
    expect(ctx.getStateValue(walletChainingDegradedKey.call(ctx, 2))).toBe(0);
    expect(ctx.getStateValue(walletChainingDegradedAtKey.call(ctx, 2))).toBe(0);
    expect(ctx.log).toHaveBeenCalledWith("info", "chaining_wallet_recovered", { walletIndex: 2 });
  });

  it("resetChainingState does not log recovery when wallet was not degraded", () => {
    const ctx = {
      ...makeStateStore({
        "wallet_chaining_failures:1": 2,
      }),
      log: vi.fn(),
    };

    resetChainingState.call(ctx, 1);

    expect(ctx.getStateValue(walletChainingFailuresKey.call(ctx, 1))).toBe(0);
    expect(ctx.log).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Chaining probe recovery
// ---------------------------------------------------------------------------

describe("chaining probe recovery (attemptChainingProbe)", () => {
  const attemptChainingProbe = (NonceDO as any).prototype.attemptChainingProbe;
  const walletChainingDegradedKey = (NonceDO as any).prototype.walletChainingDegradedKey;
  const walletChainingDegradedAtKey = (NonceDO as any).prototype.walletChainingDegradedAtKey;
  const walletChainingFailuresKey = (NonceDO as any).prototype.walletChainingFailuresKey;

  function makeProbeCtx(opts: {
    possible_next_nonce: number;
    broadcastResult: { ok: true; txid: string } | { ok: false; status: number; reason: string; body: string };
    chainingState?: Record<string, number>;
  }) {
    const stateStore = makeStateStore(opts.chainingState ?? {
      "wallet_chaining_degraded:0": 1,
      "wallet_chaining_degraded_at:0": Date.parse("2026-04-04T11:50:00.000Z"),
      "wallet_chaining_failures:0": CHAINING_FAILURE_THRESHOLD,
    });

    return {
      ...stateStore,
      log: vi.fn(),
      hiroNonceCache: new Map([[0, { value: opts.possible_next_nonce, expiresAt: Date.now() + 60_000 }]]),
      derivePrivateKeyForWallet: vi.fn().mockResolvedValue("0101010101010101010101010101010101010101010101010101010101010101"),
      getFlushRecipientAsync: vi.fn().mockResolvedValue({
        network: "testnet",
        recipient: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      }),
      broadcastRawTx: vi.fn().mockResolvedValue(opts.broadcastResult),
      // resetChainingState and walletChainingDegradedAtKey are bound methods — we need them on ctx
      resetChainingState: (NonceDO as any).prototype.resetChainingState,
      walletChainingFailuresKey: (NonceDO as any).prototype.walletChainingFailuresKey,
      walletChainingDegradedKey: (NonceDO as any).prototype.walletChainingDegradedKey,
      walletChainingDegradedAtKey: (NonceDO as any).prototype.walletChainingDegradedAtKey,
    };
  }

  it("calls resetChainingState when broadcast probe succeeds", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-04T12:00:00.000Z"));

    const ctx = makeProbeCtx({
      possible_next_nonce: 42,
      broadcastResult: { ok: true, txid: "0xdeadbeef" },
    });

    await attemptChainingProbe.call(ctx, 0, "ST1ADDR");

    // resetChainingState clears the degraded flag and counter
    expect(ctx.getStateValue(walletChainingDegradedKey.call(ctx, 0))).toBe(0);
    expect(ctx.getStateValue(walletChainingFailuresKey.call(ctx, 0))).toBe(0);
    expect(ctx.log).toHaveBeenCalledWith("info", "chaining_probe_success", expect.objectContaining({
      walletIndex: 0,
      txid: "0xdeadbeef",
    }));
    expect(ctx.log).toHaveBeenCalledWith("info", "chaining_wallet_recovered", { walletIndex: 0 });
  });

  it("updates cooldown timestamp when TooMuchChaining is returned", async () => {
    const frozenNow = Date.parse("2026-04-04T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(frozenNow);

    const ctx = makeProbeCtx({
      possible_next_nonce: 42,
      broadcastResult: { ok: false, status: 400, reason: "TooMuchChaining", body: "" },
    });

    const degradedAtBefore = ctx.getStateValue(walletChainingDegradedAtKey.call(ctx, 0));

    await attemptChainingProbe.call(ctx, 0, "ST1ADDR");

    // Should NOT call resetChainingState — wallet still degraded
    expect(ctx.getStateValue(walletChainingDegradedKey.call(ctx, 0))).toBe(1);
    // degradedAt should be updated to the current time (new cooldown)
    const degradedAtAfter = ctx.getStateValue(walletChainingDegradedAtKey.call(ctx, 0));
    expect(degradedAtAfter).toBe(frozenNow);
    expect(degradedAtAfter).not.toBe(degradedAtBefore);
    expect(ctx.log).toHaveBeenCalledWith("warn", "chaining_probe_still_full", expect.objectContaining({
      walletIndex: 0,
      reason: "TooMuchChaining",
    }));
  });

  it("does not update cooldown on other broadcast failure", async () => {
    const frozenNow = Date.parse("2026-04-04T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(frozenNow);

    const originalDegradedAt = Date.parse("2026-04-04T11:50:00.000Z");
    const ctx = makeProbeCtx({
      possible_next_nonce: 42,
      broadcastResult: { ok: false, status: 400, reason: "BadNonce", body: "" },
      chainingState: {
        "wallet_chaining_degraded:0": 1,
        "wallet_chaining_degraded_at:0": originalDegradedAt,
        "wallet_chaining_failures:0": CHAINING_FAILURE_THRESHOLD,
      },
    });

    await attemptChainingProbe.call(ctx, 0, "ST1ADDR");

    // Should NOT call resetChainingState — wallet still degraded
    expect(ctx.getStateValue(walletChainingDegradedKey.call(ctx, 0))).toBe(1);
    // degradedAt should NOT be updated — keep original cooldown
    expect(ctx.getStateValue(walletChainingDegradedAtKey.call(ctx, 0))).toBe(originalDegradedAt);
    expect(ctx.log).toHaveBeenCalledWith("warn", "chaining_probe_failed", expect.objectContaining({
      walletIndex: 0,
      reason: "BadNonce",
    }));
  });

  it("returns early with warning when no cached nonce info", async () => {
    const ctx = makeProbeCtx({
      possible_next_nonce: 42,
      broadcastResult: { ok: true, txid: "0xdeadbeef" },
    });
    // Remove the cached nonce info
    ctx.hiroNonceCache.clear();

    await attemptChainingProbe.call(ctx, 0, "ST1ADDR");

    // No broadcast should have occurred
    expect(ctx.broadcastRawTx).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith("warn", "chaining_probe_no_nonce_info", expect.objectContaining({
      walletIndex: 0,
    }));
  });
});
