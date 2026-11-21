import { describe, expect, it } from "vitest";
import { AuthService } from "../services/auth.js";

/**
 * Minimal in-memory stand-in for the Cloudflare KV binding the service uses.
 * Only get/put are exercised by the fee-accounting path.
 */
function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

const logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return logger; },
} as unknown as ConstructorParameters<typeof AuthService>[1];

describe("sponsor fee accounting", () => {
  it("books one sponsored payment's fee exactly once", async () => {
    const kv = makeKv();
    const svc = new AuthService(kv as never, logger);
    const keyId = "key-under-test";
    const fee = 1_000n;

    // The two calls the /sponsor endpoint makes for a single successful
    // sponsorship: recordFeeSpent(), then recordUsage() carrying the same fee.
    await svc.recordFeeSpent(keyId, fee);
    await svc.recordUsage(keyId, {
      success: true,
      tokenType: "STX",
      amount: "500",
      fee,
    });

    const date = new Date().toISOString().split("T")[0];
    const usage = JSON.parse(kv.store.get(`usage:daily:${keyId}:${date}`)!) as {
      feesPaid: string;
    };

    // One payment of `fee` must consume `fee` of the daily cap, not 2x fee.
    expect(usage.feesPaid).toBe(fee.toString());
  });

  it("still accumulates the fee once per payment across two payments", async () => {
    const kv = makeKv();
    const svc = new AuthService(kv as never, logger);
    const keyId = "key-2";
    const fee = 750n;

    for (let i = 0; i < 2; i++) {
      await svc.recordFeeSpent(keyId, fee);
      await svc.recordUsage(keyId, { success: true, tokenType: "STX", amount: "1", fee });
    }

    const date = new Date().toISOString().split("T")[0];
    const usage = JSON.parse(kv.store.get(`usage:daily:${keyId}:${date}`)!) as {
      feesPaid: string;
    };
    expect(usage.feesPaid).toBe((fee * 2n).toString());
  });
});
