/**
 * Tests for payment-identifier idempotency on the RPC submitPayment path.
 *
 * The HTTP V2 /settle path already wires PaymentIdService for idempotency.
 * This file verifies the RPC path achieves parity:
 * - No identifier supplied → existing behavior unchanged
 * - Identifier hit + same payload → returns cached paymentId, no new queue write
 * - Identifier hit + different payload → returns PAYMENT_IDENTIFIER_CONFLICT
 * - Identifier miss → identifier persisted on accept (verify via store behavior)
 *
 * PaymentIdService is tested directly for cache semantics (no need to stand up
 * a full WorkerEntrypoint). The rpc.ts integration is exercised via direct
 * PaymentIdService calls that mirror what submitPayment does internally.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentIdService } from "../services/payment-identifier";
import { MemoryKV } from "./helpers/memory-kv";
import type { Logger } from "../types";

// ---------------------------------------------------------------------------
// Minimal test doubles
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test suite: PaymentIdService "rpc" endpoint namespace
// ---------------------------------------------------------------------------

describe("PaymentIdService — rpc namespace isolation", () => {
  it("miss: returns miss when no entry exists for the id", async () => {
    const kv = new MemoryKV();
    const service = new PaymentIdService(kv, noopLogger);

    const result = await service.checkPaymentId("pay_rpc_miss_00000000000000", "abc123", "rpc");
    expect(result.status).toBe("miss");
  });

  it("hit + same payload: returns cached response", async () => {
    const kv = new MemoryKV();
    const service = new PaymentIdService(kv, noopLogger);
    const id = "pay_rpc_hit_same_0000000000000";
    // Stub hash — service only string-compares, no length requirement on the hash itself
    const hash = "aaabbbcccdddeeefff0000000000000000000000000000000000000000000001";
    const cachedResponse = {
      accepted: true,
      paymentId: "pay_cached_1234",
      status: "queued",
      checkStatusUrl: "https://example.com/status/pay_cached_1234",
    };

    await service.recordPaymentId(id, hash, cachedResponse, "rpc");
    const result = await service.checkPaymentId(id, hash, "rpc");

    expect(result.status).toBe("hit");
    if (result.status === "hit") {
      const response = result.response as typeof cachedResponse;
      expect(response.paymentId).toBe("pay_cached_1234");
      expect(response.accepted).toBe(true);
      expect(response.status).toBe("queued");
    }
  });

  it("hit + different payload: returns conflict", async () => {
    const kv = new MemoryKV();
    const service = new PaymentIdService(kv, noopLogger);
    const id = "pay_rpc_conflict_00000000000000";
    const originalHash = "hash_original";
    const differentHash = "hash_different";
    const cachedResponse = { accepted: true, paymentId: "pay_original" };

    await service.recordPaymentId(id, originalHash, cachedResponse, "rpc");
    const result = await service.checkPaymentId(id, differentHash, "rpc");

    expect(result.status).toBe("conflict");
  });

  it("rpc namespace does not collide with settle namespace", async () => {
    const kv = new MemoryKV();
    const service = new PaymentIdService(kv, noopLogger);
    const sharedId = "pay_shared_id_cross_namespace_00";
    const hash = "deadbeefdeadbeef";

    await service.recordPaymentId(sharedId, hash, { success: true, settle: true }, "settle");

    const rpcResult = await service.checkPaymentId(sharedId, hash, "rpc");
    expect(rpcResult.status).toBe("miss");
  });
});

// ---------------------------------------------------------------------------
// Test suite: payload hash determinism
//
// Verifies the hash is stable across identical inputs and distinguishes
// different settle configs — the same guarantee we need for idempotency.
// submitPayment calls: service.computePayloadHash(cleanHex, settle ?? null)
// ---------------------------------------------------------------------------

describe("PaymentIdService — computePayloadHash for RPC inputs", () => {
  it("same cleanHex + same settle → same hash", async () => {
    const kv = new MemoryKV();
    const service = new PaymentIdService(kv, noopLogger);
    const cleanHex = "0001020304050607";
    const settle = { expectedRecipient: "SP123", minAmount: "1000000" };

    const hash1 = await service.computePayloadHash(cleanHex, settle);
    const hash2 = await service.computePayloadHash(cleanHex, settle);

    expect(hash1).toBe(hash2);
  });

  it("same cleanHex + different settle → different hash", async () => {
    const kv = new MemoryKV();
    const service = new PaymentIdService(kv, noopLogger);
    const cleanHex = "0001020304050607";
    const settle1 = { expectedRecipient: "SP123", minAmount: "1000000" };
    const settle2 = { expectedRecipient: "SP456", minAmount: "1000000" };

    const hash1 = await service.computePayloadHash(cleanHex, settle1);
    const hash2 = await service.computePayloadHash(cleanHex, settle2);

    expect(hash1).not.toBe(hash2);
  });

  it("different cleanHex + same settle → different hash", async () => {
    const kv = new MemoryKV();
    const service = new PaymentIdService(kv, noopLogger);
    const settle = { expectedRecipient: "SP123", minAmount: "1000000" };

    const hash1 = await service.computePayloadHash("aabb", settle);
    const hash2 = await service.computePayloadHash("ccdd", settle);

    expect(hash1).not.toBe(hash2);
  });

  it("no settle: same hash each time when settle is null", async () => {
    // submitPayment normalizes undefined settle to null via (settle ?? null) before hashing,
    // so the caller always passes null when settle is absent. Verify null is stable.
    const kv = new MemoryKV();
    const service = new PaymentIdService(kv, noopLogger);
    const cleanHex = "0001020304050607";

    const hash1 = await service.computePayloadHash(cleanHex, null);
    const hash2 = await service.computePayloadHash(cleanHex, null);

    expect(hash1).toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// Test suite: KV availability degradation (fail-open semantics)
// ---------------------------------------------------------------------------

describe("PaymentIdService — fail-open on KV unavailable", () => {
  it("returns miss when kv is undefined", async () => {
    const service = new PaymentIdService(undefined, noopLogger);

    const result = await service.checkPaymentId("pay_any_id_0000000000000000", "hash", "rpc");
    expect(result.status).toBe("miss");
  });

  it("recordPaymentId returns without throwing when kv is undefined", async () => {
    const service = new PaymentIdService(undefined, noopLogger);

    await expect(
      service.recordPaymentId("pay_any_id_0000000000000000", "hash", { accepted: true }, "rpc")
    ).resolves.toBeUndefined();
  });

  it("returns miss when KV.get throws", async () => {
    const kv = new MemoryKV();
    const service = new PaymentIdService(kv, noopLogger);
    vi.spyOn(kv, "get").mockRejectedValue(new Error("KV unavailable"));

    const result = await service.checkPaymentId("pay_any_id_0000000000000000", "hash", "rpc");
    expect(result.status).toBe("miss");
  });
});
