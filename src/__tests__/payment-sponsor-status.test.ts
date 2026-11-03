import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRandomPrivKey } from "@stacks/transactions";
import {
  getPaymentSponsorStatus,
  toPaymentSponsorStatus,
  type PaymentSponsorState,
} from "../services/payment-sponsor-status";
import type { Env, Logger } from "../types";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const state = (over: Partial<PaymentSponsorState> = {}): PaymentSponsorState => ({
  configured: true,
  balance: 50_000_000n,
  spentToday: 0n,
  dailyBudget: 10_000_000n,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toPaymentSponsorStatus", () => {
  it("is healthy when configured, funded and under budget", () => {
    const result = toPaymentSponsorStatus(state(), Date.parse("2026-10-27T12:00:00.000Z"));
    expect(result).toMatchObject({
      status: "healthy",
      canSponsor: true,
      recommendation: null,
      reasons: [],
      noncePool: { healInProgress: false, lastConflictAt: null },
      reconciliation: { lastSuccessfulAt: "2026-10-27T12:00:00.000Z", freshness: "fresh" },
      snapshot: { asOf: "2026-10-27T12:00:00.000Z", ageMs: 0, freshness: "fresh" },
    });
  });

  it("is unavailable when the sponsor key is not configured", () => {
    const result = toPaymentSponsorStatus(state({ configured: false, balance: null }));
    expect(result.canSponsor).toBe(false);
    expect(result.status).toBe("unavailable");
    expect(result.recommendation).toBe("fallback_to_direct");
    expect(result.reasons).toEqual(["SPONSOR_NOT_CONFIGURED"]);
  });

  it("is unavailable when the balance is below the 0.1 STX depleted threshold", () => {
    expect(toPaymentSponsorStatus(state({ balance: 99_999n })).reasons).toEqual(["SPONSOR_BALANCE_LOW"]);
    expect(toPaymentSponsorStatus(state({ balance: 100_000n })).canSponsor).toBe(true);
  });

  it("is unavailable once today's budget is spent", () => {
    const result = toPaymentSponsorStatus(state({ spentToday: 10_000_000n }));
    expect(result.canSponsor).toBe(false);
    expect(result.reasons).toEqual(["DAILY_BUDGET_REACHED"]);
  });

  it("cannot establish readiness when Hiro balance is unreadable", () => {
    const result = toPaymentSponsorStatus(state({ balance: null }));
    expect(result).toMatchObject({
      status: "unavailable",
      canSponsor: false,
      recommendation: "fallback_to_direct",
      reasons: ["SPONSOR_STATE_UNREADABLE"],
      noncePool: { totalAvailable: 0, poolAvailabilityRatio: 0 },
      snapshot: { freshness: "unavailable" },
    });
    expect(result.reconciliation).toMatchObject({ lastSuccessfulAt: null, freshness: "unavailable" });
  });

  it("retains the budget reason when the balance is also unreadable", () => {
    expect(toPaymentSponsorStatus(state({ balance: null, spentToday: 10_000_000n })).reasons)
      .toEqual(["SPONSOR_STATE_UNREADABLE", "DAILY_BUDGET_REACHED"]);
  });
});

describe("getPaymentSponsorStatus", () => {
  function env(spent: string, extra: Partial<Env> = {}): Env {
    return {
      STACKS_NETWORK: "mainnet",
      PAYMENT_SPONSOR_PRIVATE_KEY: makeRandomPrivKey(),
      SPONSOR_WALLET_DO: {
        idFromName: () => "id",
        get: () => ({ fetch: async () => Response.json({ day: "x", spent }) }),
      } as unknown as DurableObjectNamespace,
      ...extra,
    } as Env;
  }

  // Hiro /v2/accounts returns the balance as a Clarity uint hex
  const hiroBalance = (ustx: bigint) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ balance: "0x" + ustx.toString(16).padStart(32, "0") })
    );

  it("reads balance from Hiro and spend from the SponsorWalletDO", async () => {
    hiroBalance(5_000_000n);
    const result = await getPaymentSponsorStatus(env("0"), logger);
    expect(result.canSponsor).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("reports low balance and a spent budget together", async () => {
    hiroBalance(1_000n);
    const result = await getPaymentSponsorStatus(env("10000000"), logger);
    expect(result.reasons).toEqual(["SPONSOR_BALANCE_LOW", "DAILY_BUDGET_REACHED"]);
  });

  it("does not touch Hiro when the sponsor is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await getPaymentSponsorStatus(env("0", { PAYMENT_SPONSOR_PRIVATE_KEY: undefined }), logger);
    expect(result.reasons).toEqual(["SPONSOR_NOT_CONFIGURED"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses a successful cached balance without an extra Hiro probe", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const get = vi.fn().mockResolvedValue("5000000");
    const result = await getPaymentSponsorStatus(env("0", {
      RELAY_KV: { get } as unknown as KVNamespace,
    }), logger);
    expect(result.canSponsor).toBe(true);
    expect(result.snapshot.freshness).toBe("fresh");
    expect(get).toHaveBeenCalledWith(expect.stringMatching(/^wallet_balance:/));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not cache a failed read and recovers on the next successful read", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const put = vi.fn().mockResolvedValue(undefined);
    const bindings = env("0", { RELAY_KV: { get, put } as unknown as KVNamespace });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Hiro unreachable"))
      .mockResolvedValueOnce(Response.json({ balance: "0x4c4b40" }));

    const failed = await getPaymentSponsorStatus(bindings, logger);
    expect(failed.canSponsor).toBe(false);
    expect(failed.reasons).toEqual(["SPONSOR_STATE_UNREADABLE"]);
    expect(put).not.toHaveBeenCalled();

    const recovered = await getPaymentSponsorStatus(bindings, logger);
    expect(recovered).toMatchObject({
      status: "healthy", canSponsor: true, reasons: [], recommendation: null,
      snapshot: { freshness: "fresh" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^wallet_balance:/), "5000000", { expirationTtl: 60 }
    );
  });
});
