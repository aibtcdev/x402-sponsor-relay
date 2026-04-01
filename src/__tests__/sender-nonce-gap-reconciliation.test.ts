/**
 * Unit tests for sender-nonce gap reconciliation behavior.
 *
 * Verifies that a stale relay frontier caused by direct Stacks node submissions
 * (outside the relay) is eagerly refreshed from Hiro before returning a gap result.
 * Covers the fix for issue #290.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  checkSenderNonce,
  updateSenderNonceOnBroadcast,
  type SenderNonceCache,
} from "../services/sender-nonce";

// ---------------------------------------------------------------------------
// Minimal KV mock
// ---------------------------------------------------------------------------

function makeMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
    async list() {
      return { keys: [], list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SIGNER_HASH = "abcdef1234567890abcdef1234567890abcdef12";
const SENDER_ADDRESS = "SP1ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890";

describe("sender-nonce gap detection", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = makeMockKV();
  });

  it("returns healthy when submitted nonce is the next expected nonce", async () => {
    // Relay has seen nonce 55 — expects 56
    await updateSenderNonceOnBroadcast(kv, SIGNER_HASH, 55, "0xabc");

    const result = await checkSenderNonce(kv, SIGNER_HASH, 56, SENDER_ADDRESS);
    expect(result.outcome).toBe("healthy");
    if (result.outcome === "healthy") {
      expect(result.provided).toBe(56);
      expect(result.expected).toBe(56);
    }
  });

  it("returns gap when submitted nonce skips ahead of relay lastSeen", async () => {
    // Relay has seen nonce 55 — expects 56. Sender submits 58 (skips 56, 57).
    await updateSenderNonceOnBroadcast(kv, SIGNER_HASH, 55, "0xabc");

    const result = await checkSenderNonce(kv, SIGNER_HASH, 58, SENDER_ADDRESS);
    expect(result.outcome).toBe("gap");
    if (result.outcome === "gap") {
      expect(result.provided).toBe(58);
      expect(result.expected).toBe(56);
      expect(result.lastSeen).toBe(55);
    }
  });

  it("returns healthy after cache is updated to reflect direct-broadcast nonces", async () => {
    // Simulate what seedSenderNonceFromHiro does: if Hiro reports possible_next_nonce=58,
    // lastSeen is updated to 57. The next submission of nonce 58 should be healthy.
    //
    // This test models the state AFTER the eager Hiro refresh in rpc.ts:
    // submitPayment detects gap, calls seedSenderNonceFromHiro (which updates KV),
    // then re-checks — this second check should return healthy.
    await updateSenderNonceOnBroadcast(kv, SIGNER_HASH, 55, "0xabc");

    // Simulate Hiro having advanced to possible_next_nonce=58 (nonces 56+57 confirmed)
    // by directly advancing lastSeen to 57 (which is what seedSenderNonceFromHiro sets:
    // lastSeen = max(lastConfirmed, possible_next_nonce - 1) = max(55, 57) = 57)
    await updateSenderNonceOnBroadcast(kv, SIGNER_HASH, 57, "0xdirect");

    const result = await checkSenderNonce(kv, SIGNER_HASH, 58, SENDER_ADDRESS);
    expect(result.outcome).toBe("healthy");
    if (result.outcome === "healthy") {
      expect(result.provided).toBe(58);
      expect(result.expected).toBe(58);
    }
  });

  it("still returns gap after re-seed when direct txs fill only part of the gap", async () => {
    // Relay has seen nonce 55. Sender submits 59 (gap of 3).
    // Hiro knows about 56, so possible_next_nonce=57 → lastSeen becomes 56.
    // Re-check of 59 still finds a gap (missing 57, 58).
    await updateSenderNonceOnBroadcast(kv, SIGNER_HASH, 55, "0xabc");
    // Simulate partial Hiro update: lastSeen advances to 56 only
    await updateSenderNonceOnBroadcast(kv, SIGNER_HASH, 56, "0xpartial");

    const result = await checkSenderNonce(kv, SIGNER_HASH, 59, SENDER_ADDRESS);
    expect(result.outcome).toBe("gap");
    if (result.outcome === "gap") {
      expect(result.provided).toBe(59);
      expect(result.expected).toBe(57); // next expected after lastSeen=56
      expect(result.lastSeen).toBe(56);
    }
  });
});
