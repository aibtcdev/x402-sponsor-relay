/**
 * Tests for Mode A fix: sender-origin ConflictingNonceInMempool resolve-then-verify path.
 *
 * When a payment terminates on a sender-origin nonce conflict, the relay must:
 * 1. Look up the sender's actual on-chain txid by (senderAddress, senderNonce)
 * 2. Fetch the raw hex of the resolved on-chain tx from Hiro
 * 3. Verify the ON-CHAIN tx (not the queued txHex) satisfies the payment's settle requirements
 * 4. Wire in txid + txid_map + sender bookkeeping on match, "replaced"/superseded on mismatch
 * 5. Never report responsibleParty="sponsor" or terminalReason="sponsor_failure" for sender conflicts
 *
 * Issue: #397
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  sponsorAndBroadcast: vi.fn(),
  verifyPaymentParams: vi.fn(),
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
    SettlementService: class {
      verifyPaymentParams(txHex: unknown, settle: unknown) {
        return mocks.verifyPaymentParams(txHex, settle);
      }
    },
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
function hiroTxResponse(
  txs: Array<{ tx_id: string; tx_status: string; nonce: number; sender_address?: string }>,
  sender: string
) {
  return {
    ok: true,
    json: async () => ({ results: txs.map((tx) => ({ sender_address: sender, ...tx })) }),
  };
}

/** Build a minimal Hiro raw-tx API response */
function hiroRawTxResponse(rawHex: string) {
  return {
    ok: true,
    json: async () => ({ raw_tx: `0x${rawHex}` }),
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
    mocks.clearInFlight.mockResolvedValue(undefined);
    mocks.updateSenderNonceOnBroadcast.mockResolvedValue(undefined);
    // Replace global fetch with the vitest mock
    vi.stubGlobal("fetch", mocks.fetch);
  });

  // Restore global stubs after every test to prevent leak into other test files
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // 1. Sender-origin conflict, on-chain tx MATCHES settle requirements
  // -------------------------------------------------------------------------
  it("wires txid, txid_map, and sender bookkeeping when on-chain tx matches settle requirements", async () => {
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
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false,
      details: "",
      responsible: "sender",
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // First fetch: Hiro address/transactions lookup returns the confirmed tx
    // Second fetch: Hiro raw-tx fetch returns the on-chain hex
    mocks.fetch
      .mockResolvedValueOnce(hiroTxResponse([{ tx_id: "0x6084cc29", tx_status: "success", nonce: 93 }], "SP3TVW9PM000000000000000000000000000000"))
      .mockResolvedValueOnce(hiroRawTxResponse("deadbeef1234"));

    // Settle verification passes — verifyPaymentParams is called with the RAW on-chain hex
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
    // sender_addr_map must be written (bookkeeping for chainhook/confirm-reconcile healer)
    const senderAddrMap = await kv.get("sender_addr_map:SP3TVW9PM000000000000000000000000000000");
    expect(senderAddrMap).toBe("signer_resolve");
    // updateSenderNonceOnBroadcast must have been called
    expect(mocks.updateSenderNonceOnBroadcast).toHaveBeenCalledWith(
      kv,
      "signer_resolve",
      93,
      "0x6084cc29"
    );
    // verifyPaymentParams must have been called with the on-chain raw hex (stripped of 0x prefix)
    expect(mocks.verifyPaymentParams).toHaveBeenCalledWith("deadbeef1234", DEFAULT_SETTLE);
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
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false,
      details: "",
      responsible: "sender",
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // First fetch: Hiro address/transactions lookup returns a confirmed tx
    // Second fetch: Hiro raw-tx returns the on-chain hex for the resolved txId
    mocks.fetch
      .mockResolvedValueOnce(hiroTxResponse([{ tx_id: "0xwrongtx00", tx_status: "success", nonce: 93 }], "SP3TVWMISMATCH0000000000000000000000000"))
      .mockResolvedValueOnce(hiroRawTxResponse("wrongtxhex"));

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
    // No sender bookkeeping for an unverified txid
    expect(mocks.updateSenderNonceOnBroadcast).not.toHaveBeenCalled();
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
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false,
      details: "",
      responsible: "sender",
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
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false,
      details: "",
      responsible: "sender",
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // Hiro returns results but nonce 93 is not there
    mocks.fetch.mockResolvedValue(
      hiroTxResponse([
        { tx_id: "0xother", tx_status: "success", nonce: 90 },
        { tx_id: "0xother2", tx_status: "success", nonce: 91 },
      ], "SP3TVWNOTFOUND00000000000000000000000000")
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
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false,
      details: "",
      responsible: "sender",
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
    // TooMuchChaining is sponsor-side (isTooMuchChaining=true, isNonceConflict=false)
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false,
      details: "",
      responsible: "sponsor",
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

  // -------------------------------------------------------------------------
  // 7. P1 regression: queued txHex matches settle, but on-chain tx is a DIFFERENT tx
  //    (wrong recipient) — must NOT write txid_map / set record.txid
  // -------------------------------------------------------------------------
  it("does NOT wire txid_map when on-chain tx has wrong recipient (P1 regression guard)", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_p1_regression", "testnet"),
      "queued"
    );
    record.senderNonce = 42;
    record.senderAddress = "SP3TVWP1REGRESS000000000000000000000000";
    await putPaymentRecord(kv, record);

    const originalTx = { auth: { spendingCondition: { signer: "signer_p1" } } };
    const sponsoredTx = { id: "sponsored_p1_tx" };

    mocks.deserializeTransaction.mockImplementation((hex: string) => {
      if (hex === "queued_tx_hex") return originalTx;
      if (hex === "sponsored_p1_hex") return sponsoredTx;
      throw new Error(`unexpected hex: ${hex}`);
    });
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false,
      details: "",
      responsible: "sender",
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // Lookup finds a confirmed tx at nonce 42 — but it is a DIFFERENT tx (different sender)
    mocks.fetch
      .mockResolvedValueOnce(hiroTxResponse([
        { tx_id: "0xdifferenttx", tx_status: "success", nonce: 42 },
      ], "SP3TVWP1REGRESS000000000000000000000000"))
      // Raw-tx fetch succeeds but returns the *different* on-chain tx hex
      .mockResolvedValueOnce(hiroRawTxResponse("different_tx_bytes"));

    // Critically: verifyPaymentParams is called with the ON-CHAIN hex ("different_tx_bytes"),
    // NOT with the queued "queued_tx_hex". The on-chain tx goes to a WRONG recipient.
    // If the old code had been used (verifying queued_tx_hex), this mock would have returned
    // { valid: true } instead — demonstrating the P1 bug.
    mocks.verifyPaymentParams.mockImplementation((rawHex: string) => {
      if (rawHex === "different_tx_bytes") {
        return {
          valid: false,
          error: "recipient_mismatch",
          details: "On-chain tx sends to SP_WRONG_RECIPIENT, expected SP3RECIPIENT000000000000000000000000000",
        };
      }
      // If called with the queued txHex (old buggy behaviour), return valid to expose the bug
      return { valid: true };
    });

    const message = createMessage(
      {
        paymentId: "pay_p1_regression",
        txHex: "queued_tx_hex",
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

    const finalRecord = await getPaymentRecord(kv, "pay_p1_regression");

    // Must be superseded — the on-chain tx didn't satisfy settle requirements
    expect(finalRecord?.status).toBe("replaced");
    expect(finalRecord?.terminalReason).toBe("superseded");
    // MUST NOT write txid_map for the unverified on-chain txid
    const txidMapEntry = await kv.get("txid_map:0xdifferenttx");
    expect(txidMapEntry).toBeNull();
    // record.txid must NOT be set to the unrelated on-chain txid
    expect(finalRecord?.txid).toBeUndefined();
    // No sender bookkeeping for an unverified txid
    expect(mocks.updateSenderNonceOnBroadcast).not.toHaveBeenCalled();
    // Confirm verifyPaymentParams was called with the on-chain hex (not the queued txHex)
    expect(mocks.verifyPaymentParams).toHaveBeenCalledWith("different_tx_bytes", DEFAULT_SETTLE);
    expect(mocks.verifyPaymentParams).not.toHaveBeenCalledWith("queued_tx_hex", DEFAULT_SETTLE);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 8. REGRESSION: resolved tx has an aborted status (abort_by_response)
  //    lookupTxByAddressNonce only returns MINED txs, so non-"success" means
  //    aborted on-chain — NOT pending/mempool. Must terminalize as
  //    failed/sender_nonce_duplicate and NOT write txid_map or set record.txid.
  //    (Wiring an aborted tx to "mempool" creates a stuck-forever record.)
  // -------------------------------------------------------------------------
  it("terminalizes as failed/sender_nonce_duplicate when resolved tx is aborted on-chain (not wired)", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_aborted", "testnet"),
      "queued"
    );
    record.senderNonce = 55;
    record.senderAddress = "SP3TVWABORTED000000000000000000000000000";
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockImplementation((hex: string) => {
      if (hex === "aborted_tx") return { auth: { spendingCondition: { signer: "signer_aborted" } } };
      if (hex === "sponsored_aborted") return { id: "sponsored_aborted" };
      throw new Error(`unexpected hex: ${hex}`);
    });
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false,
      details: "",
      responsible: "sender",
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // Hiro address/transactions lookup returns a tx at nonce 55 — but it is ABORTED
    // (abort_by_response / abort_by_post_condition). The /address/{sender}/transactions
    // endpoint only returns mined txs, so this is an on-chain abortion, not a mempool tx.
    mocks.fetch.mockResolvedValueOnce(
      hiroTxResponse([{ tx_id: "0xabortedtx99", tx_status: "abort_by_response", nonce: 55 }], "SP3TVWABORTED000000000000000000000000000")
    );

    const message = createMessage(
      {
        paymentId: "pay_aborted",
        txHex: "aborted_tx",
        network: "testnet",
        attempt: 5,
        settle: DEFAULT_SETTLE,
      },
      5
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );

    const finalRecord = await getPaymentRecord(kv, "pay_aborted");

    // Must terminalize as failed/sender_nonce_duplicate — not stuck in mempool
    expect(finalRecord?.status).toBe("failed");
    expect(finalRecord?.terminalReason).toBe("sender_nonce_duplicate");
    // MUST NOT set record.txid to the aborted tx (aborted tx never confirms)
    expect(finalRecord?.txid).toBeUndefined();
    // MUST NOT write txid_map (healers would wait forever for a tx that already aborted)
    const txidMapEntry = await kv.get("txid_map:0xabortedtx99");
    expect(txidMapEntry).toBeNull();
    // Must NOT call updateSenderNonceOnBroadcast for an aborted tx
    expect(mocks.updateSenderNonceOnBroadcast).not.toHaveBeenCalled();
    // Must NOT fetch raw tx (aborted branch does not need raw hex)
    expect(mocks.fetch).toHaveBeenCalledTimes(1); // only the address/transactions lookup
    // verifyPaymentParams must NOT be called (no raw hex to verify)
    expect(mocks.verifyPaymentParams).not.toHaveBeenCalled();
    // Message must be acked (not retried)
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    // Never sponsor_failure for a sender-origin conflict
    expect(finalRecord?.terminalReason).not.toBe("sponsor_failure");

    // P2 guard: exactly ONE payment.finalized event, carrying the aborted-onchain action.
    // The aborted branch is self-contained (persist-then-emit-once) and must NOT fall
    // through to the unresolvable terminalization, which would emit a second finalized event.
    const finalizedCalls = warnSpy.mock.calls.filter(
      ([msg]) => msg === "[WARN] payment.finalized"
    );
    expect(finalizedCalls).toHaveLength(1);
    expect(finalizedCalls[0][1]).toEqual(
      expect.objectContaining({
        action: "sender_conflict_aborted_onchain",
        terminalReason: "sender_nonce_duplicate",
        responsibleParty: "sender",
      })
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[WARN] payment.finalized",
      expect.objectContaining({ action: "sender_conflict_unresolvable" })
    );
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 9. Raw-tx fetch fails (timeout or HTTP error) — fail safe, fall back to
  //    sender_nonce_duplicate (do NOT write txid_map for unverified txid)
  // -------------------------------------------------------------------------
  it("falls back to sender_nonce_duplicate when raw-tx fetch fails", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_rawfetch_fail", "testnet"),
      "queued"
    );
    record.senderNonce = 77;
    record.senderAddress = "SP3TVWRAWFAIL00000000000000000000000000";
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockImplementation((hex: string) => {
      if (hex === "rawfail_tx") return { auth: { spendingCondition: { signer: "signer_rawfail" } } };
      if (hex === "sponsored_rawfail") return { id: "sponsored_rawfail" };
      throw new Error(`unexpected hex: ${hex}`);
    });
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false,
      details: "",
      responsible: "sender",
      error: "ConflictingNonceInMempool",
      nonceConflict: true,
      retryable: false,
    });

    // First fetch (address/transactions lookup) succeeds — finds a confirmed tx at nonce 77
    // Second fetch (raw-tx) fails — simulates Hiro timeout or 500
    mocks.fetch
      .mockResolvedValueOnce(hiroTxResponse([{ tx_id: "0xconfirmedtx", tx_status: "success", nonce: 77 }], "SP3TVWRAWFAIL00000000000000000000000000"))
      .mockRejectedValueOnce(new Error("Hiro raw-tx endpoint timed out"));

    const message = createMessage(
      {
        paymentId: "pay_rawfetch_fail",
        txHex: "rawfail_tx",
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

    const finalRecord = await getPaymentRecord(kv, "pay_rawfetch_fail");

    // Fail safe: must NOT write txid_map for an unverified txid
    expect(await kv.get("txid_map:0xconfirmedtx")).toBeNull();
    expect(finalRecord?.txid).toBeUndefined();
    // Must fall back to sender_nonce_duplicate (can't verify, so don't claim it resolved)
    expect(finalRecord?.status).toBe("failed");
    expect(finalRecord?.terminalReason).toBe("sender_nonce_duplicate");
    // No sender bookkeeping for an unverified txid
    expect(mocks.updateSenderNonceOnBroadcast).not.toHaveBeenCalled();
    // verifyPaymentParams must NOT be called (raw hex was unavailable)
    expect(mocks.verifyPaymentParams).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });
});

describe("queue consumer: sender-nonce lookup filters by sender and checks the mempool (#410)", () => {
  const SENDER = "SP3TVW410SENDER000000000000000000000000";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearInFlight.mockResolvedValue(undefined);
    mocks.updateSenderNonceOnBroadcast.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", mocks.fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type Row = { tx_id: string; tx_status: string; nonce: number; sender_address: string };
  /** Route Hiro by URL: mined list, mempool list, raw tx. */
  function hiro(routes: { mined?: Row[]; mempool?: Row[]; raw?: string }) {
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes("/extended/v1/tx/mempool?")) return { ok: true, json: async () => ({ results: routes.mempool ?? [] }) };
      if (url.includes("/extended/v1/tx?")) return { ok: true, json: async () => ({ results: routes.mined ?? [] }) };
      // The old address/transactions list: every tx involving the address, incoming ones too.
      if (url.includes("/address/")) return { ok: true, json: async () => ({ results: routes.mined ?? [] }) };
      if (url.endsWith("/raw")) return routes.raw ? hiroRawTxResponse(routes.raw) : { ok: false, json: async () => ({}) };
      throw new Error(`unexpected url ${url}`);
    });
  }

  async function run(paymentId: string, nonce = 7) {
    const kv = new MemoryKV();
    const record = transitionPayment(createPaymentRecord(paymentId, "testnet"), "queued");
    record.senderNonce = nonce;
    record.senderAddress = SENDER;
    await putPaymentRecord(kv, record);
    mocks.deserializeTransaction.mockReturnValue({ auth: { spendingCondition: { signer: "signer_410" } } });
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false, details: "", responsible: "sender", error: "ConflictingNonceInMempool", nonceConflict: true, retryable: false,
    });
    const message = createMessage({ paymentId, txHex: "tx_410", network: "testnet", attempt: 5, settle: DEFAULT_SETTLE }, 5);
    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );
    return { kv, message, record: await getPaymentRecord(kv, paymentId) };
  }

  it("asks Hiro for the sender's tx at that nonce, not the address's last 50 txs", async () => {
    hiro({ mined: [{ tx_id: "0xmined", tx_status: "success", nonce: 7, sender_address: SENDER }], raw: "minedhex" });
    mocks.verifyPaymentParams.mockReturnValue({ valid: true, data: {} });

    const { record } = await run("pay_410_filter");

    const minedUrl = mocks.fetch.mock.calls.map(([u]) => String(u)).find((u) => u.includes("/extended/v1/tx?"));
    expect(minedUrl).toContain(`from_address=${SENDER}`);
    expect(minedUrl).toContain("nonce=7");
    expect(mocks.fetch.mock.calls.some(([u]) => String(u).includes("/address/"))).toBe(false);
    expect(record).toMatchObject({ status: "mempool", txid: "0xmined" });
  });

  it("ignores a tx at the same nonce sent by another account (incoming transfer)", async () => {
    hiro({
      mined: [{ tx_id: "0xincoming", tx_status: "success", nonce: 7, sender_address: "SP3SOMEONEELSE0000000000000000000000000" }],
      raw: "incominghex",
    });
    // Someone else's transfer never matches this payment's settle params.
    mocks.verifyPaymentParams.mockReturnValue({ valid: false, error: "recipient_mismatch", details: "not this payment" });

    const { record } = await run("pay_410_incoming");

    // Not superseded by someone else's tx: the payment falls back to the plain duplicate outcome.
    expect(record?.status).toBe("failed");
    expect(record?.terminalReason).toBe("sender_nonce_duplicate");
    expect(record?.txid).toBeUndefined();
    expect(mocks.verifyPaymentParams).not.toHaveBeenCalled();
  });

  it("finds a pending tx in the mempool and parks the payment in mempool when it matches", async () => {
    hiro({ mempool: [{ tx_id: "0xpending", tx_status: "pending", nonce: 7, sender_address: SENDER }], raw: "pendinghex" });
    mocks.verifyPaymentParams.mockReturnValue({ valid: true, data: {} });

    const { kv, message, record } = await run("pay_410_mempool_match");

    expect(mocks.verifyPaymentParams).toHaveBeenCalledWith("pendinghex", DEFAULT_SETTLE);
    expect(record).toMatchObject({ status: "mempool", txid: "0xpending" });
    expect(await kv.get("txid_map:0xpending")).toBe("pay_410_mempool_match");
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("marks superseded when the pending tx does not satisfy settle requirements", async () => {
    hiro({ mempool: [{ tx_id: "0xpendingother", tx_status: "pending", nonce: 7, sender_address: SENDER }], raw: "otherhex" });
    mocks.verifyPaymentParams.mockReturnValue({ valid: false, error: "recipient_mismatch", details: "wrong recipient" });

    const { kv, record } = await run("pay_410_mempool_mismatch");

    expect(record?.status).toBe("replaced");
    expect(record?.terminalReason).toBe("superseded");
    expect(await kv.get("txid_map:0xpendingother")).toBeNull();
  });

  it("falls back to sender_nonce_duplicate when neither mined nor mempool has the tx", async () => {
    hiro({ mempool: [{ tx_id: "0xothernonce", tx_status: "pending", nonce: 8, sender_address: SENDER }] });

    const { record } = await run("pay_410_none");

    expect(record?.status).toBe("failed");
    expect(record?.terminalReason).toBe("sender_nonce_duplicate");
  });
});

describe("queue consumer: sender-conflict resolve does not steal another payment's txid claim (#397)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearInFlight.mockResolvedValue(undefined);
    mocks.updateSenderNonceOnBroadcast.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", mocks.fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** p2 hits a sender nonce conflict; the tx holding that nonce matches p2's settle params. */
  async function runConflict(kv: MemoryKV, paymentId: string) {
    const record = transitionPayment(createPaymentRecord(paymentId, "testnet"), "queued");
    record.senderNonce = 93;
    record.senderAddress = "SP3TVWCLAIM00000000000000000000000000000";
    await putPaymentRecord(kv, record);

    mocks.deserializeTransaction.mockReturnValue({ auth: { spendingCondition: { signer: "signer_claim" } } });
    mocks.sponsorAndBroadcast.mockResolvedValue({
      ok: false, details: "", responsible: "sender", error: "ConflictingNonceInMempool", nonceConflict: true, retryable: false,
    });
    mocks.fetch
      .mockResolvedValueOnce(hiroTxResponse([{ tx_id: "0xT1", tx_status: "success", nonce: 93 }], "SP3TVWCLAIM00000000000000000000000000000"))
      .mockResolvedValueOnce(hiroRawTxResponse("t1hex"));
    // Same recipient / amount / token as the sibling: verification alone cannot tell them apart.
    mocks.verifyPaymentParams.mockReturnValue({
      valid: true,
      data: { sender: "signer_claim", recipient: DEFAULT_SETTLE.expectedRecipient, amount: "1000", tokenType: "STX" },
    });

    const message = createMessage(
      { paymentId, txHex: "claim_tx", network: "testnet", attempt: 5, settle: DEFAULT_SETTLE },
      5
    );
    await handlePaymentQueue(
      { messages: [message] } as MessageBatch<never>,
      { RELAY_KV: kv, STACKS_NETWORK: "testnet" } as never,
      executionContext
    );
    return { message, record: await getPaymentRecord(kv, paymentId) };
  }

  it("finalizes as a duplicate and keeps the sibling's claim when the tx is already claimed", async () => {
    const kv = new MemoryKV();
    // p1 broadcast tx T1 at this sender nonce first and claimed it on the happy path.
    await kv.put("txid_map:0xT1", "pay_p1");

    const { message, record } = await runConflict(kv, "pay_p2");

    expect(await kv.get("txid_map:0xT1")).toBe("pay_p1");
    expect(record?.status).toBe("failed");
    expect(record?.terminalReason).toBe("sender_nonce_duplicate");
    expect(record?.retryable).toBe(false);
    expect(record?.txid).toBeUndefined();
    expect(record?.error).toContain("pay_p1");
    expect(mocks.updateSenderNonceOnBroadcast).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("still wires the txid when the existing claim is this same payment", async () => {
    const kv = new MemoryKV();
    await kv.put("txid_map:0xT1", "pay_self");

    const { record } = await runConflict(kv, "pay_self");

    expect(record?.status).toBe("mempool");
    expect(record?.txid).toBe("0xT1");
    expect(await kv.get("txid_map:0xT1")).toBe("pay_self");
  });
});
