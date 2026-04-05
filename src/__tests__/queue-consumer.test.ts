import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentRecord, getPaymentRecord, putPaymentRecord, transitionPayment } from "../services/payment-status";
import { handlePaymentQueue } from "../queue-consumer";
import { MemoryKV } from "./helpers/memory-kv";

const mocks = vi.hoisted(() => ({
  deserializeTransaction: vi.fn(),
  sponsorTransaction: vi.fn(),
  broadcastOnly: vi.fn(),
  clearInFlight: vi.fn(),
  updateSenderNonceOnBroadcast: vi.fn(),
  extractSponsorNonce: vi.fn(),
  recordNonceTxid: vi.fn(),
  releaseNonceDO: vi.fn(),
  recordBroadcastOutcomeDO: vi.fn(),
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
    recordNonceTxid: mocks.recordNonceTxid,
    releaseNonceDO: mocks.releaseNonceDO,
    recordBroadcastOutcomeDO: mocks.recordBroadcastOutcomeDO,
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
    mocks.recordNonceTxid.mockResolvedValue(undefined);
    mocks.releaseNonceDO.mockResolvedValue(undefined);
    mocks.recordBroadcastOutcomeDO.mockResolvedValue(undefined);
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

    const failedGapRecord = await getPaymentRecord(kv, "pay_gap");
    const successfulRecord = await getPaymentRecord(kv, "pay_ok");

    expect(gapMessage.ack).toHaveBeenCalledTimes(1);
    expect(okMessage.ack).toHaveBeenCalledTimes(1);
    expect(gapMessage.retry).not.toHaveBeenCalled();
    expect(okMessage.retry).not.toHaveBeenCalled();

    expect(failedGapRecord).toEqual(
      expect.objectContaining({
        status: "failed",
        errorCode: "SENDER_NONCE_GAP",
        terminalReason: "sender_nonce_gap",
      })
    );
    expect(successfulRecord).toEqual(
      expect.objectContaining({
        status: "mempool",
        txid: "0xabc",
      })
    );
    expect(mocks.clearInFlight).toHaveBeenCalledWith(kv, "signer_gap", 8);
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

  it("passes errorReason to releaseNonceDO on TooMuchChaining retry path", async () => {
    // Regression test: the retry path (attempt < MAX_ATTEMPTS) must pass errorReason to
    // releaseNonceDO so the circuit breaker fires immediately on the first TooMuchChaining.
    // Without errorReason the wallet keeps being selected on every retry — amplification loop.
    const kv = new MemoryKV();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const record = transitionPayment(
      createPaymentRecord("pay_chaining_cb", "testnet"),
      "queued"
    );
    record.senderNonce = 20;
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockReturnValue({
      auth: { spendingCondition: { signer: "signer_cb" } },
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_cb_tx",
      walletIndex: 2,
      fee: "1000",
    });
    // extractSponsorNonce returns 55 per beforeEach default
    mocks.broadcastOnly.mockResolvedValue({
      error: "TooMuchChaining",
      tooMuchChaining: true,
      retryable: true,
    });

    const message = createMessage({
      paymentId: "pay_chaining_cb",
      txHex: "cb_tx",
      network: "testnet",
      attempt: 1,
    }, 1);

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    expect(message.retry).toHaveBeenCalledTimes(1);
    // Circuit breaker MUST fire on the retry path — errorReason must be "TooMuchChaining"
    expect(mocks.releaseNonceDO).toHaveBeenCalledWith(
      expect.anything(), // env
      expect.anything(), // logger
      55,                // sponsorNonce (from extractSponsorNonce mock default in beforeEach)
      undefined,         // txid
      2,                 // walletIndex (from sponsorTransaction mock)
      undefined,         // fee
      "TooMuchChaining"  // errorReason — critical: fires circuit breaker on first failure
    );
  });
});
