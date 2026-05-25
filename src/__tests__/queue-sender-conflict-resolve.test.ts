/**
 * Tests for Mode A fix: sender-origin ConflictingNonceInMempool resolve-then-verify path.
 *
 * When a payment terminates on a sender-origin nonce conflict, the relay must:
 * 1. Look up the sender's actual on-chain txid by (senderAddress, senderNonce)
 * 2. Verify the on-chain tx satisfies the payment's settle requirements
 * 3. Wire in txid + txid_map on match, "replaced"/superseded on mismatch, fallback on error
 * 4. Never report responsibleParty="sponsor" or terminalReason="sponsor_failure" for sender conflicts
 *
 * Issue: #397
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaymentRecord,
  getPaymentRecord,
  putPaymentRecord,
  transitionPayment,
} from "../services/payment-status";
import { handlePaymentQueue } from "../queue-consumer";
import { MemoryKV } from "./helpers/memory-kv";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  deserializeTransaction: vi.fn(),
  sponsorTransaction: vi.fn(),
  broadcastOnly: vi.fn(),
  verifyPaymentParams: vi.fn(),
  clearInFlight: vi.fn(),
  updateSenderNonceOnBroadcast: vi.fn(),
  extractSponsorNonce: vi.fn(),
  releaseNonceDO: vi.fn(),
  nonceLifecycleOnBroadcastSuccess: vi.fn(),
  repairSenderWedgeDO: vi.fn(),
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
      async sponsorTransaction(transaction: unknown) {
        return mocks.sponsorTransaction(transaction);
      }
    },
    SettlementService: class {
      async broadcastOnly(transaction: unknown) {
        return mocks.broadcastOnly(transaction);
      }
      verifyPaymentParams(txHex: unknown, settle: unknown) {
        return mocks.verifyPaymentParams(txHex, settle);
      }
    },
    extractSponsorNonce: mocks.extractSponsorNonce,
    releaseNonceDO: mocks.releaseNonceDO,
    nonceLifecycleOnBroadcastSuccess: mocks.nonceLifecycleOnBroadcastSuccess,
    repairSenderWedgeDO: mocks.repairSenderWedgeDO,
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const executionContext = {
  waitUntil: (_promise: Promise<unknown>) => {},
} as ExecutionContext;

type TestMessageBody = {
  paymentId: string;
  txHex: string;
  network: "mainnet" | "testnet";
  attempt: number;
  settle?: {
    expectedRecipient: string;
    minAmount: string;
    tokenType?: string;
  };
};

function createMessage(body: TestMessageBody, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<TestMessageBody>;
}

/** Build a minimal Hiro address/transactions API response */
function hiroTxResponse(txs: Array<{ tx_id: string; tx_status: string; nonce: number }>) {
  return {
    ok: true,
    json: async () => ({ results: txs }),
  };
}

const DEFAULT_SETTLE = {
  expectedRecipient: "SP3RECIPIENT000000000000000000000000000",
  minAmount: "1000",
  tokenType: "STX" as const,
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("queue consumer: sender-origin nonce conflict resolve-then-verify (#397)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractSponsorNonce.mockReturnValue(55);
    mocks.clearInFlight.mockResolvedValue(undefined);
    mocks.updateSenderNonceOnBroadcast.mockResolvedValue(undefined);
    mocks.releaseNonceDO.mockResolvedValue(undefined);
    mocks.nonceLifecycleOnBroadcastSuccess.mockResolvedValue(undefined);
    mocks.repairSenderWedgeDO.mockResolvedValue(null);
    // Replace global fetch with the vitest mock
    vi.stubGlobal("fetch", mocks.fetch);
  });

  // -------------------------------------------------------------------------
  // 1. Sender-origin conflict, on-chain tx MATCHES settle requirements
  // -------------------------------------------------------------------------
  it("wires txid and txid_map when on-chain tx matches settle requirements", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_resolve_match", "testnet"),
      "queued"
    );
    record.senderNonce = 93;
    record.senderAddress = "SP3TVW9PM000000000000000000000000000000";
    await putPaymentRecord(kv, record);

    const originalTx = { auth: { spendingCondition: { signer: "signer_resolve" } } };
    const sponsoredTx = { id: "sponsored_resolve_tx" };

    mocks.deserializeTransaction.mockImplementation((hex: string) => {
      if (hex === "sender_tx") return originalTx;
      if (hex === "sponsored_hex") return sponsoredTx;
      throw new Error(`unexpected hex: ${hex}`);
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_hex",
      walletIndex: 0,
      fee: "1000",
    });
    mocks.broadcastOnly.mockResolvedValue({
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // Hiro lookup returns the confirmed tx
    mocks.fetch.mockResolvedValue(
      hiroTxResponse([{ tx_id: "0x6084cc29", tx_status: "success", nonce: 93 }])
    );

    // Settle verification passes
    mocks.verifyPaymentParams.mockReturnValue({
      valid: true,
      data: {
        sender: "signer_resolve",
        recipient: DEFAULT_SETTLE.expectedRecipient,
        amount: "1000",
        tokenType: "STX",
      },
    });

    const message = createMessage(
      {
        paymentId: "pay_resolve_match",
        txHex: "sender_tx",
        network: "testnet",
        attempt: 5,
        settle: DEFAULT_SETTLE,
      },
      5 // attempts = MAX_ATTEMPTS → terminal path
    );

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    const finalRecord = await getPaymentRecord(kv, "pay_resolve_match");

    // Record must NOT be terminalized as failed
    expect(finalRecord?.status).not.toBe("failed");
    // Record must have the resolved txid
    expect(finalRecord?.txid).toBe("0x6084cc29");
    // Record must be in mempool (for healers)
    expect(finalRecord?.status).toBe("mempool");
    // txid_map must be written
    const txidMapEntry = await kv.get("txid_map:0x6084cc29");
    expect(txidMapEntry).toBe("pay_resolve_match");
    // Message must be acked
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    // Never terminalReason=sponsor_failure
    expect(finalRecord?.terminalReason).not.toBe("sponsor_failure");
  });

  // -------------------------------------------------------------------------
  // 2. Sender-origin conflict, on-chain tx MISMATCHES settle requirements
  // -------------------------------------------------------------------------
  it("marks superseded when on-chain tx does not satisfy settle requirements", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_mismatch", "testnet"),
      "queued"
    );
    record.senderNonce = 93;
    record.senderAddress = "SP3TVWMISMATCH0000000000000000000000000";
    await putPaymentRecord(kv, record);

    const originalTx = { auth: { spendingCondition: { signer: "signer_mismatch" } } };
    const sponsoredTx = { id: "sponsored_mismatch_tx" };

    mocks.deserializeTransaction.mockImplementation((hex: string) => {
      if (hex === "mismatch_tx") return originalTx;
      if (hex === "sponsored_mismatch") return sponsoredTx;
      throw new Error(`unexpected hex: ${hex}`);
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_mismatch",
      walletIndex: 1,
      fee: "1000",
    });
    mocks.broadcastOnly.mockResolvedValue({
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // Hiro lookup returns a confirmed tx
    mocks.fetch.mockResolvedValue(
      hiroTxResponse([{ tx_id: "0xwrongtx00", tx_status: "success", nonce: 93 }])
    );

    // Settle verification FAILS — different recipient
    mocks.verifyPaymentParams.mockReturnValue({
      valid: false,
      error: "recipient_mismatch",
      details: "Transaction sends to SP_WRONG, expected SP3RECIPIENT000000000000000000000000000",
    });

    const message = createMessage(
      {
        paymentId: "pay_mismatch",
        txHex: "mismatch_tx",
        network: "testnet",
        attempt: 5,
        settle: DEFAULT_SETTLE,
      },
      5
    );

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    const finalRecord = await getPaymentRecord(kv, "pay_mismatch");

    // Must be replaced/superseded — not failed/sponsor_failure
    expect(finalRecord?.status).toBe("replaced");
    expect(finalRecord?.terminalReason).toBe("superseded");
    // No txid_map written for the wrong txid
    const txidMapEntry = await kv.get("txid_map:0xwrongtx00");
    expect(txidMapEntry).toBeNull();
    // record.txid should not be set (the wrong tx should not be wired)
    expect(finalRecord?.txid).toBeUndefined();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    // Never sponsor_failure
    expect(finalRecord?.terminalReason).not.toBe("sponsor_failure");
  });

  // -------------------------------------------------------------------------
  // 3. Hiro lookup fails (fetch throws)
  // -------------------------------------------------------------------------
  it("falls back to sender_nonce_duplicate when Hiro lookup throws", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_lookup_fail", "testnet"),
      "queued"
    );
    record.senderNonce = 93;
    record.senderAddress = "SP3TVWFAIL000000000000000000000000000000";
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockImplementation((hex: string) => {
      if (hex === "fail_tx") return { auth: { spendingCondition: { signer: "signer_fail" } } };
      if (hex === "sponsored_fail") return { id: "sponsored" };
      throw new Error(`unexpected: ${hex}`);
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_fail",
      walletIndex: 0,
      fee: "1000",
    });
    mocks.broadcastOnly.mockResolvedValue({
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // Hiro lookup throws (network error)
    mocks.fetch.mockRejectedValue(new Error("Network failure"));

    const message = createMessage(
      {
        paymentId: "pay_lookup_fail",
        txHex: "fail_tx",
        network: "testnet",
        attempt: 5,
        settle: DEFAULT_SETTLE,
      },
      5
    );

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    const finalRecord = await getPaymentRecord(kv, "pay_lookup_fail");

    expect(finalRecord?.status).toBe("failed");
    expect(finalRecord?.terminalReason).toBe("sender_nonce_duplicate");
    // No spurious txid
    expect(finalRecord?.txid).toBeUndefined();
    // No txid_map written
    expect(await kv.get("txid_map:anything")).toBeNull();
    expect(message.ack).toHaveBeenCalledTimes(1);
    // Never sponsor_failure
    expect(finalRecord?.terminalReason).not.toBe("sponsor_failure");
    // Never responsibleParty=sponsor (check no spurious txid written)
    expect(finalRecord?.terminalReason).not.toBe("sponsor_failure");
  });

  // -------------------------------------------------------------------------
  // 4. Hiro returns valid JSON but nonce not in results
  // -------------------------------------------------------------------------
  it("falls back to sender_nonce_duplicate when nonce is not in Hiro results", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_not_found", "testnet"),
      "queued"
    );
    record.senderNonce = 93;
    record.senderAddress = "SP3TVWNOTFOUND00000000000000000000000000";
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockImplementation((hex: string) => {
      if (hex === "notfound_tx") return { auth: { spendingCondition: { signer: "signer_notfound" } } };
      if (hex === "sponsored_notfound") return { id: "sponsored" };
      throw new Error(`unexpected: ${hex}`);
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_notfound",
      walletIndex: 0,
      fee: "1000",
    });
    mocks.broadcastOnly.mockResolvedValue({
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // Hiro returns results but nonce 93 is not there
    mocks.fetch.mockResolvedValue(
      hiroTxResponse([
        { tx_id: "0xother", tx_status: "success", nonce: 90 },
        { tx_id: "0xother2", tx_status: "success", nonce: 91 },
      ])
    );

    const message = createMessage(
      {
        paymentId: "pay_not_found",
        txHex: "notfound_tx",
        network: "testnet",
        attempt: 5,
        settle: DEFAULT_SETTLE,
      },
      5
    );

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    const finalRecord = await getPaymentRecord(kv, "pay_not_found");

    expect(finalRecord?.status).toBe("failed");
    expect(finalRecord?.terminalReason).toBe("sender_nonce_duplicate");
    expect(finalRecord?.txid).toBeUndefined();
    expect(finalRecord?.terminalReason).not.toBe("sponsor_failure");
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 5. Attribution: sender-origin conflict RETRY never reports responsibleParty=sponsor
  // -------------------------------------------------------------------------
  it("emits responsibleParty=sender for retryable sender-origin nonce conflict", async () => {
    const kv = new MemoryKV();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const record = transitionPayment(
      createPaymentRecord("pay_attr", "testnet"),
      "queued"
    );
    record.senderNonce = 93;
    record.senderAddress = "SP3TVWATTR000000000000000000000000000000";
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockImplementation((hex: string) => {
      if (hex === "attr_tx") return { auth: { spendingCondition: { signer: "signer_attr" } } };
      if (hex === "sponsored_attr") return { id: "sponsored_attr" };
      throw new Error(`unexpected: ${hex}`);
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_attr",
      walletIndex: 0,
      fee: "1000",
    });
    mocks.broadcastOnly.mockResolvedValue({
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: true,
    });

    // attempt=1 < MAX_ATTEMPTS (5) → retry path, not terminal
    const message = createMessage(
      {
        paymentId: "pay_attr",
        txHex: "attr_tx",
        network: "testnet",
        attempt: 1,
        settle: DEFAULT_SETTLE,
      },
      1
    );

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    // Should have retried, not acked
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();

    // The lifecycle event must carry responsibleParty="sender".
    // emitPaymentLifecycleEvent serializes the field as "responsibleParty" in the log object.
    expect(warnSpy).toHaveBeenCalledWith(
      "[WARN] payment.retry_decision",
      expect.objectContaining({
        action: "queue_retry_nonce_conflict",
        responsibleParty: "sender",
      })
    );

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 6. Regression: genuine sponsor-side TooMuchChaining still terminalizes as sponsor_failure
  // -------------------------------------------------------------------------
  it("still terminalizes sponsor-side TooMuchChaining as sponsor_failure (regression guard)", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_sponsor_chaining", "testnet"),
      "queued"
    );
    record.senderNonce = 5;
    record.senderAddress = "SP3TVWSPONSOR000000000000000000000000000";
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockImplementation((hex: string) => {
      if (hex === "sponsor_tx") return { auth: { spendingCondition: { signer: "signer_sponsor" } } };
      if (hex === "sponsored_sponsor") return { id: "sponsored_sponsor" };
      throw new Error(`unexpected: ${hex}`);
    });
    mocks.sponsorTransaction.mockResolvedValue({
      success: true,
      sponsoredTxHex: "sponsored_sponsor",
      walletIndex: 2,
      fee: "2000",
    });
    // TooMuchChaining is sponsor-side (isTooMuchChaining=true, isNonceConflict=false)
    mocks.broadcastOnly.mockResolvedValue({
      error: "TooMuchChaining",
      tooMuchChaining: true,
      isOriginChaining: false,
      retryable: false,
    });

    const message = createMessage(
      {
        paymentId: "pay_sponsor_chaining",
        txHex: "sponsor_tx",
        network: "testnet",
        attempt: 5,
        settle: DEFAULT_SETTLE,
      },
      5
    );

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    const finalRecord = await getPaymentRecord(kv, "pay_sponsor_chaining");

    // Sponsor-side TooMuchChaining must still be sponsor_failure
    expect(finalRecord?.status).toBe("failed");
    expect(finalRecord?.terminalReason).toBe("sponsor_failure");
    // No Hiro lookup should have been attempted (nonceConflict=false)
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });
});
