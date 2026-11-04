import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRandomPrivKey } from "@stacks/transactions";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly ctx: ExecutionContext;
    protected readonly env: unknown;

    constructor(ctx: ExecutionContext, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import worker, { RelayRPC } from "../index";
import { SponsorStatus } from "../endpoints/sponsor-status";
import { MemoryKV } from "./helpers/memory-kv";
import type { Env, SponsorStatusResult } from "../types";

const executionContext = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as ExecutionContext;

function environment(spent = "0"): Env {
  return {
    STACKS_NETWORK: "testnet",
    RELAY_KV: new MemoryKV(),
    PAYMENT_SPONSOR_PRIVATE_KEY: makeRandomPrivKey(),
    SPONSOR_WALLET_DO: {
      idFromName: () => "sponsor",
      get: () => ({ fetch: async () => Response.json({ day: "test", spent }) }),
    } as unknown as DurableObjectNamespace,
  } as Env;
}

function readableBalance(balance = 5_000_000n): Response {
  return Response.json({ balance: "0x" + balance.toString(16).padStart(32, "0") });
}

async function httpStatus(env: Env) {
  const response = await worker.fetch(
    new Request("https://relay.test/status/sponsor"),
    env,
    executionContext
  );
  return { status: response.status, body: (await response.json()) as SponsorStatusResult & { success: boolean } };
}

function assertDocumentedSnapshot(status: "200" | "503", result: SponsorStatusResult) {
  const properties = new SponsorStatus().schema.responses[status].content["application/json"].schema.properties;
  expect(properties.snapshot.properties.freshness.enum).toContain(result.snapshot.freshness);
  for (const reason of result.reasons) {
    expect(properties.reasons.items.enum).toContain(reason);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("payment sponsor readiness HTTP and RPC contract", () => {
  it.each([
    ["a rejected fetch", () => Promise.reject(new Error("Hiro unavailable"))],
    ["an HTTP error", () => Promise.resolve(new Response("unavailable", { status: 503 }))],
    ["invalid JSON", () => Promise.resolve(new Response("not JSON"))],
  ] as const)("reports unavailable through both public surfaces after %s", async (_name, hiro) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hiro);
    const env = environment();
    const http = await httpStatus(env);
    const rpc = await new RelayRPC(executionContext, env).getSponsorStatus();

    expect(http.status).toBe(503);
    expect(http.body.success).toBe(true);
    for (const status of [http.body, rpc]) {
      expect(status).toMatchObject({
        canSponsor: false,
        status: "unavailable",
        reasons: ["HIRO_UNAVAILABLE"],
        recommendation: "fallback_to_direct",
        snapshot: { freshness: "unavailable" },
        reconciliation: { freshness: "unavailable", lastSuccessfulAt: null },
      });
      assertDocumentedSnapshot("503", status);
    }
  });

  it("recovers after an uncached failed read, without persisting a healthy result for that failure", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Hiro unavailable"))
      .mockResolvedValueOnce(readableBalance());
    const env = environment();
    expect((await httpStatus(env)).status).toBe(503);
    const recovered = await new RelayRPC(executionContext, env).getSponsorStatus();
    expect(recovered).toMatchObject({ canSponsor: true, reasons: [], snapshot: { freshness: "fresh" } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    assertDocumentedSnapshot("200", recovered);
  });

  it("keeps a successfully read cached balance usable during its existing TTL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(readableBalance());
    const env = environment();
    expect((await httpStatus(env)).status).toBe(200);
    fetchSpy.mockRejectedValue(new Error("upstream unavailable after the cached read"));
    const cached = await new RelayRPC(executionContext, env).getSponsorStatus();
    expect(cached).toMatchObject({ canSponsor: true, reasons: [], snapshot: { freshness: "fresh" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a readable zero balance", "0", 0n, "SPONSOR_BALANCE_LOW"],
    ["an exhausted budget", "10000000", 5_000_000n, "DAILY_BUDGET_REACHED"],
  ] as const)("documents the fresh 503 response for %s", async (_name, spent, balance, reason) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(readableBalance(balance));
    const http = await httpStatus(environment(spent));
    expect(http.status).toBe(503);
    expect(http.body).toMatchObject({ canSponsor: false, reasons: [reason], snapshot: { freshness: "fresh" } });
    assertDocumentedSnapshot("503", http.body);
  });
});
