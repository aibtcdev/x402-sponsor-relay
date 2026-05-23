import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentRecord, getPaymentRecord, putPaymentRecord, transitionPayment } from "../services/payment-status";
import { handlePaymentQueue, handlePaymentDLQ } from "../queue-consumer";
import { MemoryKV } from "./helpers/memory-kv";

const mocks = vi.hoisted(() => ({
  deserializeTransaction: vi.fn(),
  sponsorTransaction: vi.fn(),
  broadcastOnly: vi.fn(),
  clearInFlight: vi.fn(),
  updateSenderNonceOnBroadcast: vi.fn(),
  extractSponsorNonce: vi.fn(),
  releaseNonceDO: vi.fn(),
  nonceLifecycleOnBroadcastSuccess: vi.fn(),
  repairSenderWedgeDO: vi.fn(),
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
      async sponsorTransaction(transaction: unknown) {
        return mocks.sponsorTransaction(transaction);
      }
    },
    SettlementService: class {
      async broadcastOnly(transaction: unknown) {
        return mocks.broadcastOnly(transaction);
      }
    },
    extractSponsorNonce: mocks.extractSponsorNonce,
    releaseNonceDO: mocks.releaseNonceDO,
    nonceLifecycleOnBroadcastSuccess: mocks.nonceLifecycleOnBroadcastSuccess,
    repairSenderWedgeDO: mocks.repairSenderWedgeDO,
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

describe("queue consumer recovery boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractSponsorNonce.mockReturnValue(55);
    mocks.clearInFlight.mockResolvedValue(undefined);
    mocks.updateSenderNonceOnBroadcast.mockResolvedValue(undefined);
    mocks.releaseNonceDO.mockResolvedValue(undefined);
    mocks.nonceLifecycleOnBroadcastSuccess.mockResolvedValue(undefined);
    mocks.repairSenderWedgeDO.mockResolvedValue(null);
  });

  it("keeps mixed x402 and non-x402 queued traffic moving when one sender hits a nonce gap", async () => {
    const kv = new MemoryKV();

    const gapRecord = transitionPayment(
      createPaymentRecord("pay_gap", "testnet"),
      "queued"
    );
    gapRecord.senderNonce = 8;
    gapRecord.senderAddress = "STGAP000000000000000000000000000000000";

    const okRecord = transitionPayment(
      createPaymentRecord("pay_ok", "testnet"),
      "queued"
    );
    okRecord.senderNonce = 9;
    okRecord.senderAddress = "STOK0000000000000000000000000000000000";

    await putPaymentRecord(kv, gapRecord);
    await putPaymentRecord(kv, okRecord);

    const originalGapTx = {
      auth: { spendingCondition: { signer: "signer_gap" } },
    };
    const originalOkTx = {
      auth: { spendingCondition: { signer: "signer_ok" } },
    };
    const sponsoredOkTx = { id: "sponsored_ok_tx" };

    mocks.deserializeTransaction.mockImplementation((txHex: string) => {
      switch (txHex) {
        case "gap_tx":
          return originalGapTx;
        case "ok_tx":
          return originalOkTx;
        case "sponsored_ok":
          return sponsoredOkTx;
        default:
          throw new Error(`unexpected tx hex ${txHex}`);
      }
    });

    mocks.sponsorTransaction
      .mockResolvedValueOnce({
        success: false,
        held: true,
        holdReason: "gap",
        nextExpected: 5,
        missingNonces: [5, 6, 7],
      })
      .mockResolvedValueOnce({
        success: true,
        sponsoredTxHex: "sponsored_ok",
        walletIndex: 0,
        fee: "1500",
      });

    mocks.broadcastOnly.mockResolvedValueOnce({
      txid: "0xabc",
    });

    const gapMessage = createMessage({
      paymentId: "pay_gap",
      txHex: "gap_tx",
      network: "testnet",
      attempt: 1,
      settle: { expectedRecipient: "STX402", minAmount: "1" },
    });
    const okMessage = createMessage({
      paymentId: "pay_ok",
      txHex: "ok_tx",
      network: "testnet",
      attempt: 1,
    });

    await handlePaymentQueue(
      { messages: [gapMessage, okMessage] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    const heldGapRecord = await getPaymentRecord(kv, "pay_gap");
    const successfulRecord = await getPaymentRecord(kv, "pay_ok");

    expect(gapMessage.ack).toHaveBeenCalledTimes(1);
    expect(okMessage.ack).toHaveBeenCalledTimes(1);
    expect(gapMessage.retry).not.toHaveBeenCalled();
    expect(okMessage.retry).not.toHaveBeenCalled();

    expect(heldGapRecord).toEqual(
      expect.objectContaining({
        status: "queued",
        relayState: "held",
        holdReason: "gap",
        nextExpectedNonce: 5,
        missingNonces: [5, 6, 7],
      })
    );
    expect(successfulRecord).toEqual(
      expect.objectContaining({
        status: "mempool",
        txid: "0xabc",
      })
    );
    expect(mocks.clearInFlight).not.toHaveBeenCalledWith(kv, "signer_gap", 8);
    expect(mocks.repairSenderWedgeDO).toHaveBeenCalledWith(
      expect.objectContaining({ RELAY_KV: kv, STACKS_NETWORK: "testnet" }),
      expect.anything(),
      "STGAP000000000000000000000000000000000"
    );
  });

  it("keeps sponsor recovery relay-owned for temporary capacity failures", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_capacity", "testnet"),
      "queued"
    );
    record.senderNonce = 4;
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockReturnValue({
      auth: { spendingCondition: { signer: "signer_capacity" } },
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: false,
      held: true,
      holdReason: "capacity",
      nextExpected: 4,
      missingNonces: [],
    });

    const message = createMessage({
      paymentId: "pay_capacity",
      txHex: "capacity_tx",
      network: "testnet",
      attempt: 1,
    });

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    const updatedRecord = await getPaymentRecord(kv, "pay_capacity");

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(updatedRecord).toEqual(
      expect.objectContaining({
        status: "queued",
        error: "Sponsor pool temporarily has no dispatch capacity",
        relayState: "held",
        holdReason: "capacity",
      })
    );
    expect(mocks.clearInFlight).not.toHaveBeenCalled();
  });

  it("keeps sponsor-side contention relay-owned until retries exhaust, then emits sponsor_failure", async () => {
    const kv = new MemoryKV();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const record = transitionPayment(
      createPaymentRecord("pay_chaining", "testnet"),
      "queued"
    );
    record.senderNonce = 10;
    await putPaymentRecord(kv, record);

    const originalTx = {
      auth: { spendingCondition: { signer: "signer_chaining" } },
    };
    const sponsoredTx = { id: "sponsored_chaining_tx" };

    mocks.deserializeTransaction.mockImplementation((txHex: string) => {
      if (txHex === "chaining_tx") {
        return originalTx;
      }
      if (txHex === "sponsored_chaining") {
        return sponsoredTx;
      }
      throw new Error(`unexpected tx hex ${txHex}`);
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_chaining",
      walletIndex: 1,
      fee: "2000",
    });
    mocks.broadcastOnly.mockResolvedValue({
      error: "TooMuchChaining",
      tooMuchChaining: true,
      retryable: true,
    });

    const retryMessage = createMessage({
      paymentId: "pay_chaining",
      txHex: "chaining_tx",
      network: "testnet",
      attempt: 1,
    }, 1);

    await handlePaymentQueue(
      { messages: [retryMessage] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    expect(retryMessage.retry).toHaveBeenCalledTimes(1);
    expect(await getPaymentRecord(kv, "pay_chaining")).toEqual(
      expect.objectContaining({
        status: "queued",
        error: "Broadcast contention: TooMuchChaining",
      })
    );
    expect(warnSpy).toHaveBeenCalledWith("[WARN] payment.retry_decision", expect.objectContaining({
      service: "relay",
      paymentId: "pay_chaining",
      action: "queue_retry_too_much_chaining",
      status: "queued",
      compat_shim_used: false,
      repo_version: expect.any(String),
    }));

    const terminalMessage = createMessage({
      paymentId: "pay_chaining",
      txHex: "chaining_tx",
      network: "testnet",
      attempt: 5,
    }, 5);

    await handlePaymentQueue(
      { messages: [terminalMessage] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    expect(terminalMessage.ack).toHaveBeenCalledTimes(1);
    expect(terminalMessage.retry).not.toHaveBeenCalled();
    expect(await getPaymentRecord(kv, "pay_chaining")).toEqual(
      expect.objectContaining({
        status: "failed",
        terminalReason: "sponsor_failure",
        errorCode: "BROADCAST_FAILED",
      })
    );
    expect(warnSpy).toHaveBeenCalledWith("[WARN] payment.finalized", expect.objectContaining({
      service: "relay",
      paymentId: "pay_chaining",
      action: "broadcast_failed_terminal",
      status: "failed",
      terminalReason: "sponsor_failure",
      compat_shim_used: false,
      repo_version: expect.any(String),
    }));
  });

  it("writes unified payment correlation on normal broadcast success", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_owner", "testnet"),
      "queued"
    );
    record.senderNonce = 12;
    record.senderAddress = "STOWNER00000000000000000000000000000000";
    await putPaymentRecord(kv, record);

    const originalTx = {
      auth: { spendingCondition: { signer: "signer_owner", nonce: 12n } },
    };
    const sponsoredTx = { id: "sponsored_owner_tx" };

    mocks.deserializeTransaction.mockImplementation((txHex: string) => {
      if (txHex === "owner_tx") return originalTx;
      if (txHex === "sponsored_owner") return sponsoredTx;
      throw new Error(`unexpected tx hex ${txHex}`);
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_owner",
      walletIndex: 2,
      fee: "3000",
    });
    mocks.broadcastOnly.mockResolvedValue({ txid: "0xowner" });

    const message = createMessage({
      paymentId: "pay_owner",
      txHex: "owner_tx",
      network: "testnet",
      attempt: 1,
    });

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    expect(mocks.nonceLifecycleOnBroadcastSuccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        paymentId: "pay_owner",
        senderTxHex: "owner_tx",
        senderAddress: "STOWNER00000000000000000000000000000000",
        senderNonce: 12,
        sponsorNonce: 55,
        walletIndex: 2,
        txid: "0xowner",
      })
    );
  });

  it("does not fabricate an empty sender identity when correlating broadcast success", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_legacy", "testnet"),
      "queued"
    );
    await putPaymentRecord(kv, record);

    const originalTx = {
      auth: { spendingCondition: { signer: "signer_legacy", nonce: 3n } },
    };
    const sponsoredTx = { id: "sponsored_legacy_tx" };

    mocks.deserializeTransaction.mockImplementation((txHex: string) => {
      if (txHex === "legacy_tx") return originalTx;
      if (txHex === "sponsored_legacy") return sponsoredTx;
      throw new Error(`unexpected tx hex ${txHex}`);
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_legacy",
      walletIndex: 0,
      fee: "1200",
    });
    mocks.broadcastOnly.mockResolvedValue({ txid: "0xlegacy" });

    const message = createMessage({
      paymentId: "pay_legacy",
      txHex: "legacy_tx",
      network: "testnet",
      attempt: 1,
    });

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    expect(mocks.nonceLifecycleOnBroadcastSuccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        paymentId: "pay_legacy",
        senderAddress: undefined,
        senderNonce: undefined,
      })
    );
  });

  it("terminalizes a non-terminal payment when retries are exhausted, so it can't be stranded at queued (#398)", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_exhaust", "testnet"),
      "queued"
    );
    record.senderNonce = 42;
    record.senderAddress = "STEXHAUST00000000000000000000000000000";
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockReturnValue({
      auth: { spendingCondition: { signer: "signer_exhaust" } },
    });
    // Unhandled error during processing → bubbles to the handler catch-all.
    mocks.sponsorTransaction.mockRejectedValue(new Error("NonceDO unavailable"));

    // attempts === MAX_ATTEMPTS (5) → dead-letter branch.
    const message = createMessage(
      { paymentId: "pay_exhaust", txHex: "exhaust_tx", network: "testnet", attempt: 5 },
      5
    );

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();

    const finalRecord = await getPaymentRecord(kv, "pay_exhaust");
    expect(finalRecord).toEqual(
      expect.objectContaining({
        status: "failed",
        retryable: true,
        terminalReason: "internal_error",
        errorCode: "BROADCAST_EXHAUSTED",
      })
    );
  });

  it("does not terminalize while retries remain (under the attempt limit) (#398)", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_retry", "testnet"),
      "queued"
    );
    record.senderNonce = 7;
    record.senderAddress = "STRETRY000000000000000000000000000000";
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockReturnValue({
      auth: { spendingCondition: { signer: "signer_retry" } },
    });
    mocks.sponsorTransaction.mockRejectedValue(new Error("transient"));

    // attempts < MAX_ATTEMPTS → retry, not terminalize.
    const message = createMessage(
      { paymentId: "pay_retry", txHex: "retry_tx", network: "testnet", attempt: 2 },
      2
    );

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();

    const finalRecord = await getPaymentRecord(kv, "pay_retry");
    // Left for the queue to retry — not prematurely terminalized.
    expect(finalRecord?.status).not.toBe("failed");
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
