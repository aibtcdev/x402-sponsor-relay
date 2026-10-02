import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRandomPrivKey } from "@stacks/transactions";
import { checkSponsorAlerts, decideAlerts, firingConditions, type SponsorSnapshot } from "../services/sponsor-alerts";
import { MemoryKV } from "./helpers/memory-kv";
import type { Env, Logger } from "../types";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const HOUR = 60 * 60_000;

const snapshot = (over: Partial<SponsorSnapshot> = {}): SponsorSnapshot => ({
  address: "SP3F6ZPHAR5D0YT0CTPJST7H3NBZ43A5FW226FMYP",
  balance: 50_000_000n,
  minBalance: 10_000_000n,
  spentToday: 0n,
  dailyBudget: 10_000_000n,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("firingConditions", () => {
  it("flags a low balance and a budget at 80% or more", () => {
    expect([...firingConditions(snapshot())]).toEqual([]);
    expect([...firingConditions(snapshot({ balance: 9_999_999n }))]).toEqual(["low_balance"]);
    expect([...firingConditions(snapshot({ spentToday: 8_000_000n }))]).toEqual(["budget_high"]);
  });
});

describe("decideAlerts", () => {
  const firing = new Set(["low_balance"] as const);

  it("alerts on a new condition", () => {
    expect(decideAlerts(firing, {}, 1000)).toEqual({
      send: [{ condition: "low_balance", recovered: false }],
      next: { low_balance: 1000 },
    });
  });

  it("stays quiet within the hour, then repeats", () => {
    expect(decideAlerts(firing, { low_balance: 1000 }, 1000 + HOUR - 1).send).toEqual([]);
    expect(decideAlerts(firing, { low_balance: 1000 }, 1000 + HOUR).send).toEqual([
      { condition: "low_balance", recovered: false },
    ]);
  });

  it("sends one recovery when the condition clears, then nothing", () => {
    const cleared = decideAlerts(new Set(), { low_balance: 1000 }, 5000);
    expect(cleared).toEqual({ send: [{ condition: "low_balance", recovered: true }], next: {} });
    expect(decideAlerts(new Set(), cleared.next, 6000).send).toEqual([]);
  });
});

describe("checkSponsorAlerts", () => {
  function env(kv: MemoryKV, spent = "0", extra: Partial<Env> = {}): Env {
    return {
      STACKS_NETWORK: "mainnet",
      PAYMENT_SPONSOR_PRIVATE_KEY: makeRandomPrivKey(),
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_CHAT_ID: "-100200",
      RELAY_KV: kv as unknown as KVNamespace,
      SPONSOR_WALLET_DO: {
        idFromName: () => "id",
        get: () => ({ fetch: async () => Response.json({ day: "x", spent }) }),
      } as unknown as DurableObjectNamespace,
      ...extra,
    } as Env;
  }

  it("posts a low-balance alert to Telegram once, then stays quiet", async () => {
    const telegram: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (new URL(String(input)).hostname === "api.telegram.org") {
        telegram.push(JSON.parse(String(init?.body)).text);
        return Response.json({ ok: true });
      }
      return Response.json({ balance: "2500000", locked: "0" });
    });
    const kv = new MemoryKV();

    await checkSponsorAlerts(env(kv), logger);
    await checkSponsorAlerts(env(kv), logger);

    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain("2.50 STX left");
  });

  it("does nothing when Telegram is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await checkSponsorAlerts(env(new MemoryKV(), "0", { TELEGRAM_BOT_TOKEN: undefined }), logger);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
