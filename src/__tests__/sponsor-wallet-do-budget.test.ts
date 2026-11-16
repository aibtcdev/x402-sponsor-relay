/**
 * SponsorWalletDO GET /budget reports today's spend for both daily budgets:
 * `spent` (x402 payments, read by the alert cron) and `sponsorSpent` (POST /sponsor).
 */
import { describe, expect, it } from "vitest";
import { SponsorWalletDO } from "../durable-objects/sponsor-wallet-do";
import type { Env } from "../types";

function makeDO(stored: Record<string, unknown>) {
  const storage = { get: async (k: string) => stored[k] };
  const state = { storage } as unknown as DurableObjectState;
  return new SponsorWalletDO(state, { STACKS_NETWORK: "mainnet" } as Env);
}

async function readBudget(stored: Record<string, unknown>) {
  const res = await makeDO(stored).fetch(new Request("https://sponsor-wallet/budget", { method: "GET" }));
  return (await res.json()) as { day: string; spent: string; sponsorSpent: string };
}

describe("SponsorWalletDO GET /budget", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("returns both budgets for today", async () => {
    const body = await readBudget({
      budget: { day: today, spent: "1234" },
      "budget:sponsor": { day: today, spent: "8000000" },
    });
    expect(body).toEqual({ day: today, spent: "1234", sponsorSpent: "8000000" });
  });

  it("reports 0 for a budget last written on an earlier day or never", async () => {
    const body = await readBudget({ "budget:sponsor": { day: "2000-01-01", spent: "999" } });
    expect(body).toMatchObject({ spent: "0", sponsorSpent: "0" });
  });
});
