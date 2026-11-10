import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddressFromPrivateKey, makeRandomPrivKey } from "@stacks/transactions";
import {
  getPaymentSponsorStatus,
  getPaymentSponsorWallet,
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

  it("exposes the sponsor wallet's address, balance and budget", () => {
    const result = toPaymentSponsorStatus(state({ address: "SP123", spentToday: 250n }));
    expect(result.wallet).toEqual({
      address: "SP123",
      balance: "50000000",
      spentToday: "250",
      dailyBudget: "10000000",
    });
  });

  it("keeps the wallet block with a null balance when Hiro is unreadable", () => {
    const result = toPaymentSponsorStatus(state({ address: "SP123", balance: null }));
    expect(result.wallet?.balance).toBeNull();
    expect(result.wallet?.address).toBe("SP123");
  });

  it("omits the wallet block when the sponsor is not configured", () => {
    expect(toPaymentSponsorStatus(state({ configured: false, balance: null })).wallet).toBeUndefined();
  });

  it("reports only SPONSOR_NOT_CONFIGURED when there is no sponsor key", () => {
    expect(toPaymentSponsorStatus(state({ configured: false, balance: null })).reasons).toEqual([
      "SPONSOR_NOT_CONFIGURED",
    ]);
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
    const e = env("1234");
    const result = await getPaymentSponsorStatus(e, logger);
    expect(result.canSponsor).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.wallet).toEqual({
      address: getAddressFromPrivateKey(e.PAYMENT_SPONSOR_PRIVATE_KEY!, "mainnet"),
      balance: "5000000",
      spentToday: "1234",
      dailyBudget: result.wallet!.dailyBudget,
    });
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
