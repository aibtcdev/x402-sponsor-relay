import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { makeRandomPrivKey } from "@stacks/transactions";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(protected readonly ctx: ExecutionContext, protected readonly env: unknown) {}
  },
}));

import { SponsorStatus } from "../endpoints/sponsor-status";
import { RelayRPC } from "../rpc";
import type { AppVariables, Env, Logger, SponsorStatusResult } from "../types";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;
const now = new Date("2026-10-27T12:00:00.000Z");

function makeEnv(spent = "0", extra: Partial<Env> = {}): Env {
  return {
    STACKS_NETWORK: "testnet",
    PAYMENT_SPONSOR_PRIVATE_KEY: makeRandomPrivKey(),
    SPONSOR_WALLET_DO: {
      idFromName: () => "id",
      get: () => ({ fetch: async () => Response.json({ day: "2026-10-27", spent }) }),
    } as unknown as DurableObjectNamespace,
    ...extra,
  } as Env;
}

// Exercise the actual HTTP handler and RPC entrypoint with their shared reader intact.
async function readBoth(env: Env, expectedHttpStatus: 200 | 503) {
  vi.spyOn(Date, "now").mockReturnValue(now.getTime());
  const endpoint = new SponsorStatus();
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.get("/status/sponsor", c => {
    c.set("logger", logger);
    c.set("requestId", "test-request");
    return endpoint.handle(c);
  });
  const response = await app.request("/status/sponsor", undefined, env);
  expect(response.status).toBe(expectedHttpStatus);
  const body = await response.json() as SponsorStatusResult & { success: boolean; requestId: string };
  const { success, requestId, ...httpStatus } = body;
  expect(success).toBe(true);
  expect(requestId).toBe("test-request");
  const rpcStatus = await new RelayRPC(ctx, env).getSponsorStatus();
  expect(rpcStatus).toEqual(httpStatus);

  const schema = endpoint.schema.responses[String(expectedHttpStatus) as "200" | "503"]
    .content["application/json"].schema.properties;
  expect(schema.status.enum).toContain(body.status);
  expect(schema.snapshot.properties.freshness.enum).toContain(body.snapshot.freshness);
  expect(schema.reconciliation.properties.freshness.enum).toContain(body.reconciliation.freshness);
  for (const reason of body.reasons) expect(schema.reasons.items.enum).toContain(reason);
  return rpcStatus;
}

afterEach(() => vi.restoreAllMocks());

describe("payment sponsor HTTP and RPC readiness", () => {
  it.each(["rejected fetch", "non-2xx response", "invalid JSON"])("fails closed on %s", async failure => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    if (failure === "rejected fetch") fetchSpy.mockRejectedValue(new Error("Hiro unreachable"));
    else if (failure === "non-2xx response") fetchSpy.mockImplementation(async () => new Response("unavailable", { status: 503 }));
    else fetchSpy.mockImplementation(async () => new Response("not JSON", { status: 200 }));

    const result = await readBoth(makeEnv(), 503);
    expect(result).toMatchObject({
      status: "unavailable", canSponsor: false, recommendation: "fallback_to_direct",
      reasons: ["SPONSOR_STATE_UNREADABLE"],
      reconciliation: { lastSuccessfulAt: null, freshness: "unavailable" },
      snapshot: { asOf: now.toISOString(), ageMs: 0, freshness: "unavailable" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    { balance: 0n, spent: "0", code: 503, reasons: ["SPONSOR_BALANCE_LOW"] },
    { balance: 99_999n, spent: "0", code: 503, reasons: ["SPONSOR_BALANCE_LOW"] },
    { balance: 100_000n, spent: "0", code: 200, reasons: [] },
    { balance: 5_000_000n, spent: "10000000", code: 503, reasons: ["DAILY_BUDGET_REACHED"] },
  ] as const)("keeps readable balance $balance fresh with spend $spent", async ({ balance, spent, code, reasons }) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ balance: "0x" + balance.toString(16).padStart(32, "0") })
    );
    const result = await readBoth(makeEnv(spent), code);
    expect(result).toMatchObject({
      canSponsor: code === 200,
      recommendation: code === 200 ? null : "fallback_to_direct",
      reasons,
      reconciliation: { freshness: "fresh", lastSuccessfulAt: now.toISOString() },
      snapshot: { freshness: "fresh" },
    });
  });

  it.each(["PAYMENT_SPONSOR_PRIVATE_KEY", "SPONSOR_WALLET_DO"] as const)("reports missing %s without reading Hiro", async key => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await readBoth(makeEnv("0", { [key]: undefined }), 503);
    expect(result).toMatchObject({
      canSponsor: false, reasons: ["SPONSOR_NOT_CONFIGURED"],
      snapshot: { freshness: "unavailable" },
      reconciliation: { lastSuccessfulAt: null, freshness: "unavailable" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
