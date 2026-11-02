import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRandomPrivKey } from "@stacks/transactions";
import {
  getPaymentSponsorStatus,
  toPaymentSponsorStatus,
  type PaymentSponsorState,
} from "../services/payment-sponsor-status";
import type { AppContext, Env, Logger } from "../types";
import { SponsorStatus } from "../endpoints/sponsor-status";

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

  it("stops sponsoring when the Hiro balance is unreadable", () => {
    const result = toPaymentSponsorStatus(state({ balance: null }), Date.parse("2026-11-03T00:00:00.000Z"));
    expect(result.status).toBe("unavailable");
    expect(result.canSponsor).toBe(false);
    expect(result.recommendation).toBe("fallback_to_direct");
    expect(result.reasons).toEqual(["HIRO_UNAVAILABLE"]);
    expect(result.reconciliation).toMatchObject({ lastSuccessfulAt: null, freshness: "unavailable" });
    expect(result.snapshot).toMatchObject({ freshness: "unavailable" });
  });

  it("does not blame Hiro when the sponsor is simply not configured", () => {
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
    const result = await getPaymentSponsorStatus(env("0"), logger);
    expect(result.canSponsor).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("reports low balance and a spent budget together", async () => {
    hiroBalance(1_000n);
    const result = await getPaymentSponsorStatus(env("10000000"), logger);
    expect(result.reasons).toEqual(["SPONSOR_BALANCE_LOW", "DAILY_BUDGET_REACHED"]);
  });

  it("reports HIRO_UNAVAILABLE when the Hiro read fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("hiro unreachable"));
    const result = await getPaymentSponsorStatus(env("0"), logger);
    expect(result.status).toBe("unavailable");
    expect(result.canSponsor).toBe(false);
    expect(result.recommendation).toBe("fallback_to_direct");
    expect(result.reasons).toEqual(["HIRO_UNAVAILABLE"]);
    expect(result.reconciliation).toMatchObject({ lastSuccessfulAt: null, freshness: "unavailable" });
    expect(result.snapshot.freshness).toBe("unavailable");
  });

  it("does not touch Hiro when the sponsor is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await getPaymentSponsorStatus(env("0", { PAYMENT_SPONSOR_PRIVATE_KEY: undefined }), logger);
    expect(result.reasons).toEqual(["SPONSOR_NOT_CONFIGURED"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves the HTTP route as 503 with HIRO_UNAVAILABLE when Hiro fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("hiro unreachable"));
    const ctx = {
      env: env("0"),
      get: (key: string) => (key === "logger" ? logger : "test-request-id"),
      header: () => {},
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    };
    const res = await new SponsorStatus().handle(ctx as unknown as AppContext);
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      canSponsor: boolean;
      recommendation: string;
      reasons: string[];
      snapshot: { freshness: string };
    };
    expect(body.canSponsor).toBe(false);
    expect(body.recommendation).toBe("fallback_to_direct");
    expect(body.reasons).toEqual(["HIRO_UNAVAILABLE"]);
    expect(body.snapshot.freshness).toBe("unavailable");
  });
});
