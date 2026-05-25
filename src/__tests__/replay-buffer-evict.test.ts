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
 * Exercises processReplayBuffer() via prototype-call-with-double (same pattern as
 * nonce-do-zombie-requeue.test.ts).
 */

// Mock @stacks/transactions so the re-broadcast path doesn't fail on dummy hex
vi.mock("@stacks/transactions", async () => {
  const actual = await vi.importActual("@stacks/transactions");
  return {
    ...actual,
    deserializeTransaction: vi.fn(() => ({})),
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
  broadcastResult?: { ok: boolean; txid?: string; reason?: string; status?: number };
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

  // sql.exec handles:
  //   - getReplayBuffer SELECT: routed via getReplayBuffer
  //   - UPDATE replay_buffer SET broadcast_attempts: no-op
  //   - SELECT broadcast_attempts: returns updated attempts
  const sqlExecMock = vi.fn((_query: string, ..._args: unknown[]) => ({
    toArray: () => [],
  }));

  const kvPut = vi.fn(async () => {});
  const kvGet = vi.fn(async () => null);

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
    sql: { exec: sqlExecMock },
    log: logSpy,
  };

  return {
    double,
    removeFromReplayBuffer,
    broadcastRawTx,
    isSenderNonceConfirmed,
    lookupSenderNonceTxid,
    ledgerRelease,
    kvPut,
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

  it("evicts an entry whose sender nonce is confirmed on-chain and wires txid_map for finalization", async () => {
    const { double, removeFromReplayBuffer, broadcastRawTx, kvPut, logSpy } = makeDouble({
      entries: [baseEntry],
      senderConfirmed: true,
      onChainTxid: { txId: "0xconfirmed_txid", txStatus: "success" },
    });

    const result = await run(double);

    // Must evict — not re-broadcast
    expect(removeFromReplayBuffer).toHaveBeenCalledWith(42);
    expect(broadcastRawTx).not.toHaveBeenCalled();

    // Must write txid_map so healers can finalize
    expect(kvPut).toHaveBeenCalledWith(
      "txid_map:0xconfirmed_txid",
      "pay_test_abc123",
      expect.objectContaining({ expirationTtl: 86_400 })
    );

    // Must emit replay_evict_confirmed at info level
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
});
