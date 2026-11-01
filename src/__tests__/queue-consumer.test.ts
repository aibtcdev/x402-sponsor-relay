import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentRecord, getPaymentRecord, putPaymentRecord, transitionPayment } from "../services/payment-status";
import { handlePaymentQueue, handlePaymentDLQ } from "../queue-consumer";
import { MemoryKV } from "./helpers/memory-kv";

const mocks = vi.hoisted(() => ({
  deserializeTransaction: vi.fn(),
  sponsorAndBroadcast: vi.fn(),
  clearInFlight: vi.fn(),
  updateSenderNonceOnBroadcast: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@stacks/transactions", () => ({
  deserializeTransaction: mocks.deserializeTransaction,
}));

vi.mock("../services/sender-nonce", () => ({
  clearInFlight: mocks.clearInFlight,
  updateSenderNonceOnBroadcast: mocks.updateSenderNonceOnBroadcast,
}));

vi.mock("../services", async () => {
  const actual = await vi.importActual("../services");
  return {
    ...actual,
    SponsorService: class {
      async sponsorAndBroadcast(transaction: unknown) {
        return mocks.sponsorAndBroadcast(transaction);
      }
    },
  };
});

const executionContext = {
  waitUntil: (_promise: Promise<unknown>) => {},
} as ExecutionContext;

function createMessage(body: { paymentId: string; txHex: string; network: "mainnet" | "testnet"; attempt: number; settle?: unknown }, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<{
    paymentId: string;
    txHex: string;
    network: "mainnet" | "testnet";
    attempt: number;
    settle?: unknown;
  }>;
}

const env = (kv: MemoryKV) => ({ RELAY_KV: kv, STACKS_NETWORK: "testnet" }) as never;

/** A queued payment record plus a deserializable tx for it. */
async function queued(kv: MemoryKV, paymentId: string, sender?: { nonce: number; address?: string }) {
  const record = transitionPayment(createPaymentRecord(paymentId, "testnet"), "queued");
  if (sender) {
    record.senderNonce = sender.nonce;
    record.senderAddress = sender.address;
  }
  await putPaymentRecord(kv, record);
  return record;
}

const refusal = (fields: Record<string, unknown>) => ({ ok: false, details: "", retryable: true, ...fields });

async function run(kv: MemoryKV, paymentId: string, attempts = 1) {
  const message = createMessage({ paymentId, txHex: `${paymentId}_tx`, network: "testnet", attempt: attempts }, attempts);
  await handlePaymentQueue({ messages: [message] } as MessageBatch<never>, env(kv), executionContext);
  return message;
}

describe("queue consumer (payment sponsor via SponsorWalletDO)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearInFlight.mockResolvedValue(undefined);
    mocks.updateSenderNonceOnBroadcast.mockResolvedValue(undefined);
    mocks.deserializeTransaction.mockImplementation((hex: string) => ({
      auth: { spendingCondition: { signer: `signer_${hex}` } },
    }));
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parks the payment in mempool with its txid and writes the healer bookkeeping", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_ok", { nonce: 12, address: "STOWNER00000000000000000000000000000000" });
    mocks.sponsorAndBroadcast.mockResolvedValue({ ok: true, txid: "0xowner", sponsorNonce: 157, fee: "3000" });

    const message = await run(kv, "pay_ok");

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(await getPaymentRecord(kv, "pay_ok")).toEqual(expect.objectContaining({
      status: "mempool", txid: "0xowner", sponsorNonce: 157, sponsorFee: "3000",
    }));
    expect(await kv.get("txid_map:0xowner")).toBe("pay_ok");
    expect(await kv.get("sender_addr_map:STOWNER00000000000000000000000000000000")).toBe("signer_pay_ok_tx");
    expect(mocks.clearInFlight).toHaveBeenCalledWith(kv, "signer_pay_ok_tx", 12);
    expect(mocks.updateSenderNonceOnBroadcast).toHaveBeenCalledWith(kv, "signer_pay_ok_tx", 12, "0xowner");
  });

  it("does not fabricate sender bookkeeping for a record without sender identity", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_legacy");
    mocks.sponsorAndBroadcast.mockResolvedValue({ ok: true, txid: "0xlegacy", sponsorNonce: 3, fee: "1200" });

    await run(kv, "pay_legacy");

    expect(await getPaymentRecord(kv, "pay_legacy")).toEqual(expect.objectContaining({ status: "mempool", txid: "0xlegacy" }));
    expect(await kv.get("txid_map:0xlegacy")).toBe("pay_legacy");
    expect(mocks.clearInFlight).not.toHaveBeenCalled();
    expect(mocks.updateSenderNonceOnBroadcast).not.toHaveBeenCalled();
  });

  it("holds a sender with a nonce gap and retries later, while other senders keep moving", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_gap", { nonce: 8, address: "STGAP000000000000000000000000000000000" });
    await queued(kv, "pay_next", { nonce: 9, address: "STOK0000000000000000000000000000000000" });
    mocks.sponsorAndBroadcast
      .mockResolvedValueOnce(refusal({ senderNonceCode: "SENDER_NONCE_GAP", expectedNonce: 5, responsible: "sender", error: "Sender nonce out of order" }))
      .mockResolvedValueOnce({ ok: true, txid: "0xabc", sponsorNonce: 4, fee: "1500" });

    const gap = await run(kv, "pay_gap");
    const next = await run(kv, "pay_next");

    expect(gap.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(gap.ack).not.toHaveBeenCalled();
    expect(await getPaymentRecord(kv, "pay_gap")).toEqual(expect.objectContaining({
      status: "queued", relayState: "held", holdReason: "gap", nextExpectedNonce: 5,
    }));
    expect(mocks.clearInFlight).not.toHaveBeenCalledWith(kv, "signer_pay_gap_tx", 8);
    expect(next.ack).toHaveBeenCalledTimes(1);
    expect(await getPaymentRecord(kv, "pay_next")).toEqual(expect.objectContaining({ status: "mempool", txid: "0xabc" }));
  });

  it("waits for the sender's previous payment, then fails retryable once retries run out", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_dup", { nonce: 6, address: "STDUP000000000000000000000000000000000" });
    mocks.sponsorAndBroadcast.mockResolvedValue(refusal({
      senderNonceCode: "SENDER_NONCE_DUPLICATE", responsible: "sender", error: "Previous payment from this sender is still pending",
    }));

    const first = await run(kv, "pay_dup", 2);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(await getPaymentRecord(kv, "pay_dup")).toEqual(expect.objectContaining({ status: "queued", relayState: "queued" }));

    const last = await run(kv, "pay_dup", 5);
    expect(last.ack).toHaveBeenCalledTimes(1);
    expect(await getPaymentRecord(kv, "pay_dup")).toEqual(expect.objectContaining({
      status: "failed", terminalReason: "sender_nonce_duplicate", retryable: true,
    }));
    expect(mocks.clearInFlight).toHaveBeenCalledWith(kv, "signer_pay_dup_tx", 6);
  });

  it("wires the on-chain txid when the sender's nonce is already used by this payment", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_stale", { nonce: 93, address: "SP3TVWSTALE00000000000000000000000000000" });
    mocks.sponsorAndBroadcast.mockResolvedValue(refusal({
      senderNonceCode: "SENDER_NONCE_STALE", expectedNonce: 94, responsible: "sender", retryable: false, error: "Sender nonce out of order",
    }));
    mocks.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ tx_id: "0xlanded", tx_status: "success", nonce: 93 }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ raw_tx: "0xbeef" }) });
    const message = createMessage({
      paymentId: "pay_stale", txHex: "pay_stale_tx", network: "testnet", attempt: 1,
      settle: { expectedRecipient: "SP3RECIPIENT000000000000000000000000000", minAmount: "1000" },
    });
    const verify = vi.spyOn((await import("../services")).SettlementService.prototype, "verifyPaymentParams")
      .mockReturnValue({ valid: true } as never);

    await handlePaymentQueue({ messages: [message] } as MessageBatch<never>, env(kv), executionContext);

    expect(verify).toHaveBeenCalledWith("beef", expect.objectContaining({ minAmount: "1000" }));
    expect(await getPaymentRecord(kv, "pay_stale")).toEqual(expect.objectContaining({ status: "mempool", txid: "0xlanded" }));
    expect(await kv.get("txid_map:0xlanded")).toBe("pay_stale");
    expect(message.ack).toHaveBeenCalledTimes(1);
    verify.mockRestore();
  });

  it("fails a stale sender nonce that no matching on-chain tx explains", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_stale_x", { nonce: 3, address: "SP3TVWSTALEX0000000000000000000000000000" });
    mocks.sponsorAndBroadcast.mockResolvedValue(refusal({
      senderNonceCode: "SENDER_NONCE_STALE", responsible: "sender", retryable: false, error: "Sender nonce out of order",
    }));

    const message = await run(kv, "pay_stale_x");

    expect(message.retry).not.toHaveBeenCalled();
    expect(await getPaymentRecord(kv, "pay_stale_x")).toEqual(expect.objectContaining({
      status: "failed", terminalReason: "sender_nonce_stale", errorCode: "SENDER_NONCE_STALE", retryable: false,
    }));
  });

  it("retries sponsor-side contention, then terminalizes with the sponsor reason", async () => {
    const kv = new MemoryKV();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await queued(kv, "pay_chaining", { nonce: 10 });
    mocks.sponsorAndBroadcast.mockResolvedValue(refusal({
      error: "Sponsor wallet congested — too many pending transactions", tooMuchChaining: true, responsible: "sponsor",
    }));

    const retry = await run(kv, "pay_chaining", 1);
    expect(retry.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
    expect(await getPaymentRecord(kv, "pay_chaining")).toEqual(expect.objectContaining({
      status: "queued", error: "Sponsor contention: Sponsor wallet congested — too many pending transactions",
    }));
    expect(warnSpy).toHaveBeenCalledWith("[WARN] payment.retry_decision", expect.objectContaining({
      paymentId: "pay_chaining", action: "queue_retry_sponsor_contention", responsibleParty: "sponsor",
    }));

    const last = await run(kv, "pay_chaining", 5);
    expect(last.ack).toHaveBeenCalledTimes(1);
    expect(await getPaymentRecord(kv, "pay_chaining")).toEqual(expect.objectContaining({
      status: "failed", terminalReason: "sponsor_failure", errorCode: "BROADCAST_FAILED", retryable: true,
    }));
    expect(warnSpy).toHaveBeenCalledWith("[WARN] payment.finalized", expect.objectContaining({
      paymentId: "pay_chaining", action: "sponsor_failed_terminal", terminalReason: "sponsor_failure",
    }));
    warnSpy.mockRestore();
  });

  it("fails at once on the daily sponsor budget, which only resets at UTC midnight", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_budget", { nonce: 1 });
    mocks.sponsorAndBroadcast.mockResolvedValue(refusal({ error: "Daily sponsor budget reached", responsible: "sponsor" }));

    const message = await run(kv, "pay_budget", 1);

    expect(message.retry).not.toHaveBeenCalled();
    expect(await getPaymentRecord(kv, "pay_budget")).toEqual(expect.objectContaining({
      status: "failed", terminalReason: "sponsor_exhausted", errorCode: "SPONSOR_EXHAUSTED",
    }));
  });

  it("fails a node rejection of the client's tx at once, without retrying", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_funds", { nonce: 2 });
    mocks.sponsorAndBroadcast.mockResolvedValue(refusal({
      error: "Broadcast failed", clientRejection: "NotEnoughFunds", httpStatus: 400, retryable: false, responsible: "sender",
    }));

    const message = await run(kv, "pay_funds", 1);

    expect(message.retry).not.toHaveBeenCalled();
    expect(await getPaymentRecord(kv, "pay_funds")).toEqual(expect.objectContaining({
      status: "failed", errorCode: "CLIENT_NOTENOUGHFUNDS", terminalReason: "broadcast_failure", retryable: false,
    }));
  });

  it("terminalizes a non-terminal payment when retries are exhausted, so it can't be stranded at queued (#398)", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_exhaust", { nonce: 42, address: "STEXHAUST00000000000000000000000000000" });
    // Unhandled error during processing → bubbles to the handler catch-all.
    mocks.sponsorAndBroadcast.mockRejectedValue(new Error("SponsorWalletDO unavailable"));

    // attempts === MAX_ATTEMPTS (5) → drop branch (final ack, not routed to DLQ).
    const message = await run(kv, "pay_exhaust", 5);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(await getPaymentRecord(kv, "pay_exhaust")).toEqual(expect.objectContaining({
      status: "failed", retryable: true, terminalReason: "internal_error", errorCode: "BROADCAST_EXHAUSTED",
    }));
  });

  it("does not terminalize while retries remain (under the attempt limit) (#398)", async () => {
    const kv = new MemoryKV();
    await queued(kv, "pay_retry", { nonce: 7, address: "STRETRY000000000000000000000000000000" });
    mocks.sponsorAndBroadcast.mockRejectedValue(new Error("transient"));

    const message = await run(kv, "pay_retry", 2);

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect((await getPaymentRecord(kv, "pay_retry"))?.status).not.toBe("failed");
  });
});

describe("payment DLQ consumer (#398)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("terminalizes a dead-lettered payment still stuck non-terminal", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_dlq", "testnet"),
      "queued"
    );
    record.senderNonce = 3;
    record.senderAddress = "STDLQ00000000000000000000000000000000";
    await putPaymentRecord(kv, record);

    const message = createMessage({
      paymentId: "pay_dlq",
      txHex: "dlq_tx",
      network: "testnet",
      attempt: 5,
    });

    await handlePaymentDLQ(
      {
        queue: "x402-payment-dlq-test",
        messages: [message],
      } as unknown as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    expect(message.ack).toHaveBeenCalledTimes(1);
    const finalRecord = await getPaymentRecord(kv, "pay_dlq");
    expect(finalRecord).toEqual(
      expect.objectContaining({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        errorCode: "BROADCAST_EXHAUSTED",
      })
    );
  });

  it("does not regress an already-terminal dead-lettered payment", async () => {
    const kv = new MemoryKV();
    const confirmed = transitionPayment(
      createPaymentRecord("pay_dlq_confirmed", "testnet"),
      "confirmed",
      { txid: "0xdef" }
    );
    await putPaymentRecord(kv, confirmed);

    const message = createMessage({
      paymentId: "pay_dlq_confirmed",
      txHex: "x",
      network: "testnet",
      attempt: 5,
    });

    await handlePaymentDLQ(
      {
        queue: "x402-payment-dlq-test",
        messages: [message],
      } as unknown as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    expect(message.ack).toHaveBeenCalledTimes(1);
    const finalRecord = await getPaymentRecord(kv, "pay_dlq_confirmed");
    expect(finalRecord?.status).toBe("confirmed");
  });
});
