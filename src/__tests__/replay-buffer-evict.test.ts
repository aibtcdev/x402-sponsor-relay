import { describe, expect, it, vi, beforeEach } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

/**
 * #403 — processReplayBuffer must NOT re-broadcast a sender tx whose nonce is already
 * confirmed on-chain. Instead, it should evict the entry and wire finalization so healers
 * can advance the payment record.
 *
 * Additionally, entries that keep failing broadcast and are never confirmed must be evicted
 * after a bounded retry cap (REPLAY_MAX_BROADCAST_ATTEMPTS = 10) to prevent infinite looping.
 *
 * Phase 5 hardening (#403): Before crediting (writing txid_map + transitioning to mempool),
 * the eviction path MUST verify that the on-chain tx at the sender's nonce is actually OUR
 * payment (same origin signature) and not a foreign tx that superseded our nonce. Mirrors
 * Mode A's verify-before-credit fix in queue-consumer.ts (PR #409).
 *
 * Exercises processReplayBuffer() via prototype-call-with-double (same pattern as
 * nonce-do-zombie-requeue.test.ts).
 */

// Mock @stacks/transactions so the re-broadcast path doesn't fail on dummy hex.
// deserializeTransaction is input-aware: it returns a tx object with a distinct origin
// signature based on the hex passed in, so match vs mismatch scenarios can be exercised.
vi.mock("@stacks/transactions", async () => {
  const actual = await vi.importActual("@stacks/transactions");
  return {
    ...actual,
    deserializeTransaction: vi.fn((hex: string) => {
      // Return a mock tx whose origin signature encodes the input hex.
      // This lets extractOriginSignature distinguish "same tx" from "different tx"
      // without needing real Stacks transaction encoding.
      const cleanHex = hex.replace(/^0x/i, "");
      return {
        auth: {
          spendingCondition: {
            signature: { data: `sig_for_${cleanHex}` },
          },
        },
      };
    }),
    sponsorTransaction: vi.fn(async () => ({})),
    STACKS_MAINNET: (actual as Record<string, unknown>).STACKS_MAINNET,
    STACKS_TESTNET: (actual as Record<string, unknown>).STACKS_TESTNET,
  };
});

// Mock wallet-sdk to avoid mnemonic derivation in tests
vi.mock("@stacks/wallet-sdk", () => ({
  generateWallet: vi.fn(async () => ({ accounts: [{ stxPrivateKey: "aabbcc" }] })),
  generateNewAccount: vi.fn((wallet: { accounts: unknown[] }) => ({
    ...wallet,
    accounts: [...wallet.accounts, { stxPrivateKey: "aabbcc" }],
  })),
}));

interface ReplayEntry {
  id: number;
  wallet_index: number;
  payment_id: string | null;
  sender_tx_hex: string;
  sender_address: string;
  sender_nonce: number;
  original_sponsor_nonce: number;
  queued_at: string;
  broadcast_attempts: number;
}

/**
 * Build a minimal test double for processReplayBuffer.
 * Only stubs the methods that processReplayBuffer calls directly.
 */
function makeDouble(opts: {
  entries: ReplayEntry[];
  senderConfirmed: boolean;
  onChainTxid?: { txId: string; txStatus: string } | null;
  // Raw hex returned by fetchOnChainRawTx for the on-chain tx.
  // Pass the same hex as entry.sender_tx_hex to simulate a MATCH,
  // or a different hex to simulate a MISMATCH.
  // Pass null to simulate a fetch failure (default: same as first entry's sender_tx_hex).
  onChainRawHex?: string | null;
  broadcastResult?: { ok: boolean; txid?: string; reason?: string; status?: number };
  kvRecord?: { status: string } | null;
}) {
  const removeFromReplayBuffer = vi.fn();
  const broadcastRawTx = vi.fn(async () =>
    opts.broadcastResult ?? { ok: false, reason: "ConflictingNonceInMempool", status: 409 }
  );
  const isSenderNonceConfirmed = vi.fn(async () => opts.senderConfirmed);
  const lookupSenderNonceTxid = vi.fn(async () => opts.onChainTxid ?? null);
  const ledgerAssign = vi.fn();
  const ledgerRelease = vi.fn();
  const queueDispatch = vi.fn();
  const transitionQueueEntry = vi.fn();
  const ledgerBroadcastOutcome = vi.fn();
  const syncPaymentAfterBroadcast = vi.fn(async () => {});
  const logSpy = vi.fn();

  // fetchOnChainRawTx: by default returns the first entry's sender_tx_hex (match scenario).
  // Set opts.onChainRawHex explicitly to override (mismatch: different hex; null: fetch failure).
  const defaultRawHex =
    opts.onChainRawHex !== undefined
      ? opts.onChainRawHex
      : (opts.entries[0]?.sender_tx_hex ?? null);
  const fetchOnChainRawTx = vi.fn(async (_txId: string) => defaultRawHex);

  // extractOriginSignature delegates to the real implementation (reads .auth.spendingCondition.signature.data)
  // The deserializeTransaction mock above returns objects with the hex baked into the sig,
  // so extractOriginSignature will naturally return different strings for different hexes.
  // We let the real method run on the double by NOT stubbing it here; it's called as
  // this.extractOriginSignature(tx) where tx is the mock object returned by deserializeTransaction.

  // sql.exec handles:
  //   - getReplayBuffer SELECT: routed via getReplayBuffer
  //   - UPDATE replay_buffer SET broadcast_attempts: no-op
  //   - SELECT broadcast_attempts: returns updated attempts
  const sqlExecMock = vi.fn((_query: string, ..._args: unknown[]) => ({
    toArray: () => [],
  }));

  // KV mock: getPaymentRecord reads from RELAY_KV.get, putPaymentRecord writes to RELAY_KV.put
  const storedRecord =
    opts.kvRecord !== undefined
      ? opts.kvRecord
        ? JSON.stringify({ status: opts.kvRecord.status, paymentId: "pay_test_abc123" })
        : null
      : JSON.stringify({ status: "queued", paymentId: "pay_test_abc123" });

  const kvPut = vi.fn(async () => {});
  const kvGet = vi.fn(async (_key: string) => storedRecord);

  const double = {
    env: {
      STACKS_NETWORK: "testnet" as const,
      HIRO_API_KEY: undefined,
      RELAY_KV: {
        put: kvPut,
        get: kvGet,
      },
    },
    // getReplayBuffer is called per-wallet in the loop
    getReplayBuffer: vi.fn((_walletIndex: number) => opts.entries),
    walletHeadroom: vi.fn(() => 5),
    derivePrivateKeyForWallet: vi.fn(async () => "dummyprivatekey"),
    ledgerGetWalletHead: vi.fn(() => 100),
    ledgerAssign,
    ledgerRelease,
    broadcastRawTx,
    queueDispatch,
    transitionQueueEntry,
    ledgerBroadcastOutcome,
    syncPaymentAfterBroadcast,
    removeFromReplayBuffer,
    isSenderNonceConfirmed,
    lookupSenderNonceTxid,
    fetchOnChainRawTx,
    sql: { exec: sqlExecMock },
    log: logSpy,
  };

  return {
    double,
    removeFromReplayBuffer,
    broadcastRawTx,
    isSenderNonceConfirmed,
    lookupSenderNonceTxid,
    fetchOnChainRawTx,
    ledgerRelease,
    kvPut,
    kvGet,
    logSpy,
    sqlExecMock,
  };
}

const wallets = [{ walletIndex: 0, address: "SP_SPONSOR_0" }];

// Helper to invoke processReplayBuffer on the double
function run(double: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (NonceDO as any).prototype.processReplayBuffer.call(double, wallets, 5);
}

const baseEntry: ReplayEntry = {
  id: 42,
  wallet_index: 0,
  payment_id: "pay_test_abc123",
  sender_tx_hex: "0xdeadbeef",
  sender_address: "SP1EANQABCDEF",
  sender_nonce: 189,
  original_sponsor_nonce: 3900,
  queued_at: "2026-05-25T00:00:00.000Z",
  broadcast_attempts: 0,
};

describe("replay-buffer evict-on-confirmed (#403)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evicts an entry whose sender nonce is confirmed on-chain and wires txid_map for finalization (verified match)", async () => {
    // onChainRawHex is the same as entry.sender_tx_hex — deserializeTransaction will produce
    // the same mock object for both, so extractOriginSignature returns the same sig → match.
    const { double, removeFromReplayBuffer, broadcastRawTx, kvPut, logSpy, fetchOnChainRawTx } =
      makeDouble({
        entries: [baseEntry],
        senderConfirmed: true,
        onChainTxid: { txId: "0xconfirmed_txid", txStatus: "success" },
        onChainRawHex: "deadbeef", // same payload as sender_tx_hex (0xdeadbeef stripped)
      });

    const result = await run(double);

    // Must evict — not re-broadcast
    expect(removeFromReplayBuffer).toHaveBeenCalledWith(42);
    expect(broadcastRawTx).not.toHaveBeenCalled();

    // Must fetch the on-chain raw tx for verification
    expect(fetchOnChainRawTx).toHaveBeenCalledWith("0xconfirmed_txid");

    // Must write txid_map so healers can finalize
    expect(kvPut).toHaveBeenCalledWith(
      "txid_map:0xconfirmed_txid",
      "pay_test_abc123",
      expect.objectContaining({ expirationTtl: 86_400 })
    );

    // Must emit replay_evict_confirmed at info level with verified: true
    const evictCall = logSpy.mock.calls.find(
      ([_level, event]: [string, string]) => event === "replay_evict_confirmed"
    );
    expect(evictCall).toBeDefined();
    expect(evictCall[0]).toBe("info");
    expect(evictCall[2]).toMatchObject({
      replayId: 42,
      senderAddress: "SP1EANQABCDEF",
      senderNonce: 189,
      resolvedTxId: "0xconfirmed_txid",
      finalized: true,
      verified: true,
    });

    // Counts as processed (not failed)
    expect(result).toEqual({ processed: 1, failed: 0 });
  });

  it("retains and re-broadcasts when isSenderNonceConfirmed returns false (Hiro error fail-safe)", async () => {
    const { double, removeFromReplayBuffer, broadcastRawTx, ledgerRelease } = makeDouble({
      entries: [baseEntry],
      senderConfirmed: false, // Hiro error → fail-open → false
      broadcastResult: { ok: false, reason: "ConflictingNonceInMempool", status: 409 },
    });

    await run(double);

    // Must NOT evict on uncertainty
    expect(removeFromReplayBuffer).not.toHaveBeenCalled();

    // Must still attempt re-broadcast (fail-open behavior)
    expect(broadcastRawTx).toHaveBeenCalled();

    // Nonce released on broadcast failure
    expect(ledgerRelease).toHaveBeenCalled();
  });

  it("re-sponsors and removes a genuinely-unsent tx when sender nonce is not confirmed and broadcast succeeds", async () => {
    const { double, removeFromReplayBuffer, broadcastRawTx, logSpy } = makeDouble({
      entries: [baseEntry],
      senderConfirmed: false,
      broadcastResult: { ok: true, txid: "0xnew_txid" },
    });

    const result = await run(double);

    // Re-broadcast must run
    expect(broadcastRawTx).toHaveBeenCalled();

    // Evicted after broadcast success
    expect(removeFromReplayBuffer).toHaveBeenCalledWith(42);

    // Success log emitted
    const successCall = logSpy.mock.calls.find(
      ([_level, event]: [string, string]) => event === "replay_respon_success"
    );
    expect(successCall).toBeDefined();

    // Counts as processed
    expect(result).toEqual({ processed: 1, failed: 0 });
  });

  it("evicts with replay_evict_max_attempts after reaching the bounded retry cap", async () => {
    // Entry already at cap - 1 attempts; next failure will hit the cap
    const entryAtCap: ReplayEntry = {
      ...baseEntry,
      broadcast_attempts: 9, // REPLAY_MAX_BROADCAST_ATTEMPTS - 1 (cap = 10)
    };

    const { double, removeFromReplayBuffer, logSpy, sqlExecMock } = makeDouble({
      entries: [entryAtCap],
      senderConfirmed: false, // not confirmed → falls through to re-broadcast path
      broadcastResult: { ok: false, reason: "ConflictingNonceInMempool", status: 409 },
    });

    // Stub the SQL UPDATE + SELECT for broadcast_attempts to simulate increment to cap
    sqlExecMock.mockImplementation((_query: string, ..._args: unknown[]) => {
      if (typeof _query === "string" && _query.includes("broadcast_attempts")) {
        return {
          toArray: () => [{ broadcast_attempts: 10 }], // after increment: hits cap
        };
      }
      return { toArray: () => [] };
    });

    await run(double);

    // Must evict after hitting cap
    expect(removeFromReplayBuffer).toHaveBeenCalledWith(entryAtCap.id);

    // Must emit replay_evict_max_attempts at warn level
    const evictCall = logSpy.mock.calls.find(
      ([_level, event]: [string, string]) => event === "replay_evict_max_attempts"
    );
    expect(evictCall).toBeDefined();
    expect(evictCall[0]).toBe("warn");
    expect(evictCall[2]).toMatchObject({
      replayId: entryAtCap.id,
      senderAddress: entryAtCap.sender_address,
      attempts: 10,
    });
  });

  it("P1 regression guard: evicts with replay_evict_superseded and does NOT write txid_map when on-chain tx is a foreign tx (origin sig mismatch)", async () => {
    // The on-chain raw hex is DIFFERENT from entry.sender_tx_hex.
    // deserializeTransaction mock returns sig_for_deadbeef for sender_tx_hex
    // and sig_for_foreightx for the on-chain hex → mismatch → superseded.
    const { double, removeFromReplayBuffer, broadcastRawTx, kvPut, logSpy, fetchOnChainRawTx } =
      makeDouble({
        entries: [baseEntry], // sender_tx_hex: "0xdeadbeef"
        senderConfirmed: true,
        onChainTxid: { txId: "0xforeign_txid", txStatus: "success" },
        onChainRawHex: "foreightx", // DIFFERENT hex → different origin sig
      });

    const result = await run(double);

    // Must evict (re-broadcast is futile — nonce is permanently consumed)
    expect(removeFromReplayBuffer).toHaveBeenCalledWith(42);

    // Must NOT re-broadcast
    expect(broadcastRawTx).not.toHaveBeenCalled();

    // Must fetch the on-chain raw tx to attempt verification
    expect(fetchOnChainRawTx).toHaveBeenCalledWith("0xforeign_txid");

    // Must NOT write txid_map — the foreign txid must not be credited to this payment
    const txidMapCalls = kvPut.mock.calls.filter(([key]: [string]) =>
      key.startsWith("txid_map:")
    );
    expect(txidMapCalls).toHaveLength(0);

    // Must emit replay_evict_superseded at warn level with the foreign txid
    const supersededCall = logSpy.mock.calls.find(
      ([_level, event]: [string, string]) => event === "replay_evict_superseded"
    );
    expect(supersededCall).toBeDefined();
    expect(supersededCall[0]).toBe("warn");
    expect(supersededCall[2]).toMatchObject({
      replayId: 42,
      senderAddress: "SP1EANQABCDEF",
      senderNonce: 189,
      paymentId: "pay_test_abc123",
      foreignTxId: "0xforeign_txid",
    });

    // Must NOT emit replay_evict_confirmed
    const confirmedCall = logSpy.mock.calls.find(
      ([_level, event]: [string, string]) => event === "replay_evict_confirmed"
    );
    expect(confirmedCall).toBeUndefined();

    // Counts as processed (evicted, not re-broadcast)
    expect(result).toEqual({ processed: 1, failed: 0 });
  });

  it("fail-safe: raw-tx fetch failure retains entry and falls through to re-broadcast (no txid_map written, no evict-as-confirmed)", async () => {
    // fetchOnChainRawTx returns null → cannot verify → fall through to re-broadcast
    const { double, removeFromReplayBuffer, broadcastRawTx, kvPut, logSpy, fetchOnChainRawTx } =
      makeDouble({
        entries: [baseEntry],
        senderConfirmed: true,
        onChainTxid: { txId: "0xunverifiable_txid", txStatus: "success" },
        onChainRawHex: null, // fetch failure
        broadcastResult: { ok: false, reason: "ConflictingNonceInMempool", status: 409 },
      });

    await run(double);

    // Must have attempted the raw-tx fetch
    expect(fetchOnChainRawTx).toHaveBeenCalledWith("0xunverifiable_txid");

    // Must NOT evict as confirmed (uncertainty → fail-safe)
    // (Entry may get evicted if re-broadcast also fails and hits cap, but not in this run)
    // The key assertion: txid_map must NOT be written
    const txidMapCalls = kvPut.mock.calls.filter(([key]: [string]) =>
      key.startsWith("txid_map:")
    );
    expect(txidMapCalls).toHaveLength(0);

    // Must NOT emit replay_evict_confirmed
    const confirmedCall = logSpy.mock.calls.find(
      ([_level, event]: [string, string]) => event === "replay_evict_confirmed"
    );
    expect(confirmedCall).toBeUndefined();

    // Must emit the raw-fetch-failed warning
    const fetchFailCall = logSpy.mock.calls.find(
      ([_level, event]: [string, string]) => event === "replay_evict_raw_fetch_failed"
    );
    expect(fetchFailCall).toBeDefined();
    expect(fetchFailCall[0]).toBe("warn");

    // Must fall through to re-broadcast attempt
    expect(broadcastRawTx).toHaveBeenCalled();

    // removeFromReplayBuffer should NOT have been called (entry retained for retry)
    expect(removeFromReplayBuffer).not.toHaveBeenCalled();
  });
});
