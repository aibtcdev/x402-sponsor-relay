/**
 * Unit tests for sender-nonce in-flight idempotency.
 *
 * Covers:
 * - markInFlight stores structured SenderInflightRecord in KV
 * - getInFlight returns the record on a hit
 * - getInFlight returns null for missing keys and for legacy bare "1" markers
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  markInFlight,
  getInFlight,
  clearInFlight,
  type SenderInflightRecord,
} from "../services/sender-nonce";

// ---------------------------------------------------------------------------
// Minimal KV mock
// ---------------------------------------------------------------------------

function makeMockKV(): KVNamespace {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, { value, ttl: opts?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
    // Unused methods — type-safe no-ops
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

describe("sender-nonce in-flight idempotency", () => {
  const SIGNER_HASH = "abcdef1234567890abcdef1234567890abcdef12";
  const NONCE = 42;
  const PAYMENT_ID = "pay_test_12345";
  const TX_HASH = "a".repeat(64); // fake SHA-256 hex

  let kv: KVNamespace;

  beforeEach(() => {
    kv = makeMockKV();
  });

  it("getInFlight returns null when no marker exists", async () => {
    const record = await getInFlight(kv, SIGNER_HASH, NONCE);
    expect(record).toBeNull();
  });

  it("getInFlight returns null for legacy bare '1' marker (backward compat)", async () => {
    await (kv as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      `sender_inflight:${SIGNER_HASH}:${NONCE}`,
      "1"
    );
    const record = await getInFlight(kv, SIGNER_HASH, NONCE);
    expect(record).toBeNull();
  });

  it("markInFlight stores a structured record with paymentId and txHash", async () => {
    await markInFlight(kv, SIGNER_HASH, NONCE, PAYMENT_ID, TX_HASH);
    const record = await getInFlight(kv, SIGNER_HASH, NONCE);
    expect(record).not.toBeNull();
    expect(record!.paymentId).toBe(PAYMENT_ID);
    expect(record!.txHash).toBe(TX_HASH);
    expect(record!.submittedAt).toBeTruthy();
  });

  it("getInFlight returns null after clearInFlight removes the marker", async () => {
    await markInFlight(kv, SIGNER_HASH, NONCE, PAYMENT_ID, TX_HASH);
    await clearInFlight(kv, SIGNER_HASH, NONCE);
    const record = await getInFlight(kv, SIGNER_HASH, NONCE);
    expect(record).toBeNull();
  });

  it("getInFlight returns null for malformed JSON in the KV value", async () => {
    await (kv as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      `sender_inflight:${SIGNER_HASH}:${NONCE}`,
      "not-json"
    );
    const record = await getInFlight(kv, SIGNER_HASH, NONCE);
    expect(record).toBeNull();
  });

  it("records for different signer/nonce combos are independent", async () => {
    await markInFlight(kv, SIGNER_HASH, NONCE, PAYMENT_ID, TX_HASH);
    await markInFlight(kv, SIGNER_HASH, NONCE + 1, "pay_other", "b".repeat(64));

    const r1 = await getInFlight(kv, SIGNER_HASH, NONCE);
    const r2 = await getInFlight(kv, SIGNER_HASH, NONCE + 1);

    expect(r1!.paymentId).toBe(PAYMENT_ID);
    expect(r2!.paymentId).toBe("pay_other");
  });

  it("markInFlight records a submittedAt ISO timestamp", async () => {
    const before = new Date().toISOString();
    await markInFlight(kv, SIGNER_HASH, NONCE, PAYMENT_ID, TX_HASH);
    const after = new Date().toISOString();

    const record = await getInFlight(kv, SIGNER_HASH, NONCE);
    expect(record).not.toBeNull();
    expect(record!.submittedAt >= before).toBe(true);
    expect(record!.submittedAt <= after).toBe(true);
  });
});
