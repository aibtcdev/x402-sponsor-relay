import { describe, expect, it, vi } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

/**
 * #398 Part 3 — the bounded-broadcast zombie guard must RE-DELIVER a still-deliverable
 * sender tx (via the replay buffer) instead of silently dropping it, while still
 * dropping txs that already confirmed or have already been replayed once.
 *
 * Exercises broadcastBoundedQueueEntries() with a single "zombie" entry
 * (sponsor_nonce < walletHead) via the prototype-call-with-double pattern.
 */

interface ZombieEntry {
  wallet_index: number;
  payment_id: string | null;
  sender_tx_hex: string;
  sender_address: string;
  sender_nonce: number;
  sponsor_nonce: number;
  is_gap_fill: number | null;
}

function makeDouble(opts: { entry: ZombieEntry; walletHead: number; senderConfirmed: boolean }) {
  const retireQueuedEntry = vi.fn();
  const addToReplayBuffer = vi.fn();
  const isSenderNonceConfirmed = vi.fn(async () => opts.senderConfirmed);
  const double = {
    env: { STACKS_NETWORK: "testnet" as const },
    sql: { exec: () => ({ toArray: () => [opts.entry] }) },
    ledgerGetWalletHead: () => opts.walletHead,
    retireQueuedEntry,
    addToReplayBuffer,
    isSenderNonceConfirmed,
    log: () => {},
  };
  return { double, retireQueuedEntry, addToReplayBuffer, isSenderNonceConfirmed };
}

const run = (double: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NonceDO as any).prototype.broadcastBoundedQueueEntries.call(double, [{ walletIndex: 0, address: "SP_SPONSOR" }]);

const baseEntry: ZombieEntry = {
  wallet_index: 0,
  payment_id: "pay_zombie",
  sender_tx_hex: "0xdeadbeef",
  sender_address: "SP_SENDER",
  sender_nonce: 866,
  sponsor_nonce: 3881,
  is_gap_fill: 0,
};

describe("bounded-broadcast zombie guard re-delivery (#398)", () => {
  it("re-queues a still-deliverable sender tx to the replay buffer (not dropped)", async () => {
    const { double, retireQueuedEntry, addToReplayBuffer } = makeDouble({
      entry: baseEntry,
      walletHead: 3882, // > sponsor_nonce 3881 → zombie
      senderConfirmed: false,
    });

    await run(double);

    // dead sponsor slot retired AND sender tx re-queued for re-sponsoring
    expect(retireQueuedEntry).toHaveBeenCalledWith(0, 3881, "head_advanced_past_nonce");
    expect(addToReplayBuffer).toHaveBeenCalledWith(0, "0xdeadbeef", "SP_SENDER", 866, 3881, "pay_zombie");
  });

  it("does NOT re-queue when the sender nonce already confirmed on-chain", async () => {
    const { double, retireQueuedEntry, addToReplayBuffer } = makeDouble({
      entry: baseEntry,
      walletHead: 3882,
      senderConfirmed: true,
    });

    await run(double);

    expect(retireQueuedEntry).toHaveBeenCalledWith(0, 3881, "head_advanced_past_nonce");
    expect(addToReplayBuffer).not.toHaveBeenCalled();
  });

  it("does NOT re-queue an entry that is itself a replay (bounds re-delivery to one attempt)", async () => {
    const { double, retireQueuedEntry, addToReplayBuffer, isSenderNonceConfirmed } = makeDouble({
      entry: { ...baseEntry, is_gap_fill: 1 },
      walletHead: 3882,
      senderConfirmed: false,
    });

    await run(double);

    expect(retireQueuedEntry).toHaveBeenCalledWith(0, 3881, "head_advanced_past_nonce");
    expect(addToReplayBuffer).not.toHaveBeenCalled();
    // short-circuits before the Hiro check for already-replayed entries
    expect(isSenderNonceConfirmed).not.toHaveBeenCalled();
  });
});
