import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkSenderNonce,
  markInFlight,
  seedSenderNonceFromHiro,
} from "../services/sender-nonce";
import { MemoryKV } from "./helpers/memory-kv";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sender nonce recovery boundaries", () => {
  it("treats stale sender nonces as sender-owned recovery", async () => {
    const kv = new MemoryKV();
    await kv.put(
      "sender_nonce:signer_stale",
      JSON.stringify({
        lastSeen: 8,
        lastConfirmed: 8,
        updatedAt: new Date().toISOString(),
      })
    );

    const result = await checkSenderNonce(
      kv,
      "signer_stale",
      8,
      "STTESTSTALENONCE0000000000000000000000",
      "testnet"
    );

    expect(result.outcome).toBe("stale");
    if (result.outcome === "stale") {
      expect(result.currentNonce).toBe(9);
      expect(result.action).toContain("re-sign");
    }
  });

  it("treats sender nonce gaps as sender-owned recovery", async () => {
    const kv = new MemoryKV();
    await kv.put(
      "sender_nonce:signer_gap",
      JSON.stringify({
        lastSeen: 4,
        lastConfirmed: 4,
        updatedAt: new Date().toISOString(),
      })
    );

    const result = await checkSenderNonce(
      kv,
      "signer_gap",
      7,
      "STTESTGAPNONCE000000000000000000000000",
      "testnet"
    );

    expect(result.outcome).toBe("gap");
    if (result.outcome === "gap") {
      expect(result.expected).toBe(5);
      expect(result.action).toContain("submit a transaction with nonce 5");
    }
  });

  it("treats duplicate sender nonces as sender-owned recovery", async () => {
    const kv = new MemoryKV();
    await markInFlight(kv, "signer_duplicate", 12);

    const result = await checkSenderNonce(
      kv,
      "signer_duplicate",
      12,
      "STTESTDUPLICATE0000000000000000000000",
      "testnet"
    );

    expect(result).toEqual({
      outcome: "duplicate",
      provided: 12,
      lastSeen: 12,
    });
  });

  it("keeps Hiro refresh monotonic when cached sender state is newer", async () => {
    const kv = new MemoryKV();
    await kv.put(
      "sender_nonce:signer_refresh",
      JSON.stringify({
        lastSeen: 12,
        lastConfirmed: 11,
        lastTxid: "0xabc123",
        updatedAt: new Date().toISOString(),
      })
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        last_executed_tx_nonce: 9,
        possible_next_nonce: 10,
        detected_missing_nonces: [],
      }), { status: 200 })
    );

    const seeded = await seedSenderNonceFromHiro(
      kv,
      "signer_refresh",
      "STTESTREFRESH000000000000000000000000",
      "testnet"
    );

    expect(seeded).toEqual({
      lastSeen: 12,
      lastConfirmed: 11,
      lastTxid: "0xabc123",
      updatedAt: expect.any(String),
    });
  });
});
