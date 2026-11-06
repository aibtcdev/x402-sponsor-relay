import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddressFromPrivateKey, makeRandomPrivKey, makeSTXTokenTransfer } from "@stacks/transactions";

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

import { RelayRPC } from "../index";
import type { Env } from "../types";

const executionContext = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as ExecutionContext;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RelayRPC.sponsorPayment", () => {
  it("refuses a payment to the sender's own address before any network call or signature", async () => {
    const key = makeRandomPrivKey();
    const self = getAddressFromPrivateKey(key, "testnet");
    const tx = await makeSTXTokenTransfer({
      recipient: self, amount: 100n, senderKey: key, network: "testnet", nonce: 0n, fee: 0n, sponsored: true,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rateLimit = vi.fn();
    const env = { STACKS_NETWORK: "testnet", SPONSOR_RATE_LIMIT: { limit: rateLimit } } as unknown as Env;

    const result = await new RelayRPC(executionContext, env).sponsorPayment(tx.serialize(), {
      expectedRecipient: self,
      minAmount: "100",
      tokenType: "STX",
    });

    expect(result).toMatchObject({ success: false, code: "PAYMENT_MISMATCH", retryable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("returns the txid of an earlier sponsorship of the same tx before the rate limit or balance preflight", async () => {
    const key = makeRandomPrivKey();
    const recipient = getAddressFromPrivateKey(makeRandomPrivKey(), "testnet");
    const tx = await makeSTXTokenTransfer({
      recipient, amount: 100n, senderKey: key, network: "testnet", nonce: 0n, fee: 0n, sponsored: true,
    });
    const doFetch = vi.fn(async (url: string) => {
      expect(url).toBe("https://sponsor-wallet/lookup");
      return Response.json({ ok: true, txid: "abc123", sponsorNonce: 4, fee: "3000", replayed: true });
    });
    const rateLimit = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = {
      STACKS_NETWORK: "testnet",
      SPONSOR_RATE_LIMIT: { limit: rateLimit },
      SPONSOR_WALLET_DO: { idFromName: () => "id", get: () => ({ fetch: doFetch }) },
    } as unknown as Env;

    const result = await new RelayRPC(executionContext, env).sponsorPayment(tx.serialize(), {
      expectedRecipient: recipient, minAmount: "100", tokenType: "STX",
    });

    expect(result).toEqual({
      success: true, txid: "abc123", payer: getAddressFromPrivateKey(key, "testnet"), fee: "3000", replayed: true,
    });
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
