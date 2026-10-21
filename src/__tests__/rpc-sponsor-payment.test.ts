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
import { SettlementService } from "../services/settlement";
import { SponsorService } from "../services/sponsor";
import type { Env, Logger } from "../types";

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

  it("attributes NotEnoughFunds on a sponsored broadcast to sponsor instead of clientRejection", async () => {
    const senderKey = makeRandomPrivKey();
    const sponsorKey = makeRandomPrivKey();
    const recipient = getAddressFromPrivateKey(makeRandomPrivKey(), "testnet");
    const unsignedTx = await makeSTXTokenTransfer({
      recipient,
      amount: 100n,
      senderKey,
      network: "testnet",
      nonce: 0n,
      fee: 0n,
      sponsored: true,
    });
    const { sponsorTransaction } = await import("@stacks/transactions");
    const sponsoredTx = await sponsorTransaction({
      transaction: unsignedTx,
      sponsorPrivateKey: sponsorKey,
      fee: 50_000n,
      sponsorNonce: 7n,
      network: "testnet",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "transaction rejected",
          reason: "NotEnoughFunds",
          reason_data: { is_origin: false, expected: 50000, actual: 14108 },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );

    const env = { STACKS_NETWORK: "testnet" } as unknown as Env;
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const settlement = new SettlementService(env, logger);
    const broadcastResult = await settlement.broadcastOnly(sponsoredTx);

    expect("error" in broadcastResult).toBe(true);
    if ("error" in broadcastResult) {
      expect(broadcastResult.responsible).toBe("sponsor");
      expect(broadcastResult.clientRejection).toBeUndefined();
      expect(broadcastResult.retryable).toBe(true);
    }
  });

  it("maps sponsor-side NotEnoughFunds at broadcast to SPONSOR_EXHAUSTED in RelayRPC.sponsorPayment", async () => {
    const senderKey = makeRandomPrivKey();
    const recipient = getAddressFromPrivateKey(makeRandomPrivKey(), "testnet");
    const tx = await makeSTXTokenTransfer({
      recipient,
      amount: 100n,
      senderKey,
      network: "testnet",
      nonce: 0n,
      fee: 0n,
      sponsored: true,
    });

    vi.spyOn(SponsorService.prototype, "preflightSponsoredPayment").mockResolvedValue(null);
    vi.spyOn(SponsorService.prototype, "sponsorAndBroadcast").mockResolvedValue({
      ok: false,
      error: "Sponsor wallet has insufficient funds",
      details: "NotEnoughFunds",
      retryable: true,
      responsible: "sponsor",
    });

    const env = {
      STACKS_NETWORK: "testnet",
      SPONSOR_RATE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) },
    } as unknown as Env;

    const result = await new RelayRPC(executionContext, env).sponsorPayment(tx.serialize(), {
      expectedRecipient: recipient,
      minAmount: "100",
      tokenType: "STX",
    });
    expect(result).toMatchObject({
      success: false,
      code: "SPONSOR_EXHAUSTED",
      retryable: true,
    });
  });
});
