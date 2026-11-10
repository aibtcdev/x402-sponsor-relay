import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddressFromPrivateKey, makeRandomPrivKey } from "@stacks/transactions";
import {
  getPaymentSponsorStatus,
  getPaymentSponsorWallet,
  toWalletInfo,
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

  it("is unavailable when Hiro balance is unreadable (matches the payment path)", () => {
    const result = toPaymentSponsorStatus(state({ balance: null }));
    expect(result).toMatchObject({
      status: "unavailable",
      canSponsor: false,
      recommendation: "fallback_to_direct",
      reasons: ["SPONSOR_STATE_UNREADABLE"],
      reconciliation: { lastSuccessfulAt: null, freshness: "unavailable" },
      snapshot: { freshness: "unavailable" },
    });
  });

  it("attaches the wallet block only when one is given", () => {
    const wallet = { address: "SP123", balance: "1", spentToday: null, dailyBudgetPerPath: "2" };
    expect(toPaymentSponsorStatus(state(), Date.now(), wallet).wallet).toEqual(wallet);
    expect(toPaymentSponsorStatus(state()).wallet).toBeUndefined();
  });

  it("reports only SPONSOR_NOT_CONFIGURED when there is no sponsor key", () => {
    expect(toPaymentSponsorStatus(state({ configured: false, balance: null })).reasons).toEqual([
      "SPONSOR_NOT_CONFIGURED",
    ]);
  });
});

describe("toWalletInfo", () => {
  it("maps the snapshot to microSTX strings with per-budget spend", () => {
    expect(
      toWalletInfo({
        address: "SP123",
        balance: 50_000_000n,
        spent: { payments: 250n, sponsor: 8_000_000n },
        dailyBudget: 10_000_000n,
      })
    ).toEqual({
      address: "SP123",
      balance: "50000000",
      spentToday: { payments: "250", sponsor: "8000000" },
      dailyBudgetPerPath: "10000000",
    });
  });

  it("keeps address and null fields when Hiro or the DO is unreadable", () => {
    expect(toWalletInfo({ address: "SP123", balance: null, spent: null, dailyBudget: 1n })).toEqual({
      address: "SP123",
      balance: null,
      spentToday: null,
      dailyBudgetPerPath: "1",
    });
  });

  it("is null when the sponsor is not configured", () => {
    expect(toWalletInfo({ address: null, balance: null, spent: null, dailyBudget: 1n })).toBeNull();
  });
});

describe("getPaymentSponsorStatus", () => {
  function env(spent: string, extra: Partial<Env> = {}, sponsorSpent?: string): Env {
    return {
      STACKS_NETWORK: "mainnet",
      PAYMENT_SPONSOR_PRIVATE_KEY: makeRandomPrivKey(),
      SPONSOR_WALLET_DO: {
        idFromName: () => "id",
        get: () => ({ fetch: async () => Response.json({ day: "x", spent, sponsorSpent }) }),
      } as unknown as DurableObjectNamespace,
      ...extra,
    } as Env;
  }

  const brokenDO = {
    idFromName: () => "id",
    get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }),
  } as unknown as DurableObjectNamespace;

  // Hiro /v2/accounts returns the balance as a Clarity uint hex
  const hiroBalance = (ustx: bigint) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ balance: "0x" + ustx.toString(16).padStart(32, "0") })
    );

  it("reads balance from Hiro and both budgets from the SponsorWalletDO", async () => {
    hiroBalance(5_000_000n);
    const e = env("1234", { SPONSOR_DAILY_BUDGET_USTX: "20000000" }, "8000000");
    const result = await getPaymentSponsorStatus(e, logger);
    expect(result.canSponsor).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.wallet).toEqual({
      address: getAddressFromPrivateKey(e.PAYMENT_SPONSOR_PRIVATE_KEY!, "mainnet"),
      balance: "5000000",
      spentToday: { payments: "1234", sponsor: "8000000" },
      dailyBudgetPerPath: "20000000",
    });
  });

  it("gates readiness on the x402 budget only, not /sponsor spend", async () => {
    hiroBalance(5_000_000n);
    const result = await getPaymentSponsorStatus(
      env("0", { SPONSOR_DAILY_BUDGET_USTX: "10000000" }, "10000000"),
      logger
    );
    expect(result.canSponsor).toBe(true);
  });

  it("throws (500) rather than reporting under-budget when the DO is unreadable", async () => {
    hiroBalance(5_000_000n);
    await expect(getPaymentSponsorStatus(env("0", { SPONSOR_WALLET_DO: brokenDO }), logger)).rejects.toThrow(
      /daily budget/
    );
  });

  it("getPaymentSponsorWallet keeps address and balance when the DO is unreadable", async () => {
    hiroBalance(7_000_000n);
    const wallet = await getPaymentSponsorWallet(env("0", { SPONSOR_WALLET_DO: brokenDO }), logger);
    expect(wallet).toMatchObject({ balance: "7000000", spentToday: null });
    expect(wallet?.address).toMatch(/^SP/);
  });

  it("getPaymentSponsorWallet returns the wallet, or null when not configured", async () => {
    hiroBalance(7_000_000n);
    const wallet = await getPaymentSponsorWallet(env("0"), logger);
    expect(wallet?.balance).toBe("7000000");
    expect(wallet?.address).toMatch(/^SP/);
    expect(
      await getPaymentSponsorWallet(env("0", { PAYMENT_SPONSOR_PRIVATE_KEY: undefined }), logger)
    ).toBeNull();
  });

  it("reports low balance and a spent budget together", async () => {
    hiroBalance(1_000n);
    const result = await getPaymentSponsorStatus(env("10000000"), logger);
    expect(result.reasons).toEqual(["SPONSOR_BALANCE_LOW", "DAILY_BUDGET_REACHED"]);
  });

  it("fails closed when Hiro returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream down", { status: 502 }));
    const result = await getPaymentSponsorStatus(env("0"), logger);
    expect(result).toMatchObject({
      status: "unavailable",
      canSponsor: false,
      recommendation: "fallback_to_direct",
      reasons: ["SPONSOR_STATE_UNREADABLE"],
      snapshot: { freshness: "unavailable" },
    });
  });

  it("fails closed when the Hiro request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect timeout"));
    const result = await getPaymentSponsorStatus(env("0"), logger);
    expect(result.canSponsor).toBe(false);
    expect(result.reasons).toEqual(["SPONSOR_STATE_UNREADABLE"]);
  });

  it("does not touch Hiro when the sponsor is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await getPaymentSponsorStatus(env("0", { PAYMENT_SPONSOR_PRIVATE_KEY: undefined }), logger);
    expect(result.reasons).toEqual(["SPONSOR_NOT_CONFIGURED"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
