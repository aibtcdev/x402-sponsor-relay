/**
 * Regression tests for verifyTxidAlive Hiro status handling.
 *
 * verifyTxidAlive is private, so we exercise it indirectly through checkDedup:
 * seed the KV with a stale "pending" entry (age > DEDUP_LIVENESS_AGE_MS=60s),
 * mock fetch to return a specific HTTP status, and assert whether checkDedup
 * returns a cached result (alive=true) or null (alive=false / invalidated).
 *
 * Covered:
 *   429 → fail-closed (returns false, dedup invalidated)
 *   502 → fail-closed (returns false, dedup invalidated)
 *   503 → fail-closed (returns false, dedup invalidated)
 *   500 → fail-open  (returns true, dedup preserved)
 *   200 (success tx status) → alive (returns true, dedup preserved)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SettlementService } from "../services/settlement";
import { MemoryKV } from "./helpers/memory-kv";
import type { Env, Logger, DedupResult } from "../types";

// ---------------------------------------------------------------------------
// Minimal test doubles
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeService(kv: KVNamespace): SettlementService {
  const env: Partial<Env> = {
    STACKS_NETWORK: "testnet",
    RELAY_KV: kv,
  };
  return new SettlementService(env as Env, noopLogger);
}

// ---------------------------------------------------------------------------
// Helpers: seed a stale pending dedup entry for a given txHex
// ---------------------------------------------------------------------------

// Must exceed DEDUP_LIVENESS_AGE_MS (60s) so checkDedup triggers a liveness check.
const STALE_AGE_MS = 90_000;

async function seedStalePendingDedup(kv: MemoryKV, txHex: string): Promise<void> {
  // Replicate the dedup key: SHA-256 of lowercase txHex (see computeTxHash in settlement.ts)
  const normalized = txHex.toLowerCase().replace(/^0x/, "");
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const txHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `dedup:${txHash}`;

  const record: DedupResult = {
    txid: "0xdeadbeef1234",
    status: "pending",
    sender: "aabbccdd",
    recipient: "ST37NMC4HGFQ1H2JSFP4H3TMNQBF4PY0MVSD1GV7Z",
    amount: "1000000",
    recordedAt: Date.now() - STALE_AGE_MS,
  };

  await kv.put(key, JSON.stringify(record));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyTxidAlive — fail-closed on Hiro error statuses", () => {
  const txHex = "0000000000deadbeef";

  it("returns false and invalidates the dedup entry when Hiro returns 429", async () => {
    const kv = new MemoryKV();
    await seedStalePendingDedup(kv, txHex);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 429 })
    );

    const service = makeService(kv);
    const result = await service.checkDedup(txHex);

    expect(result).toBeNull();
  });

  it("returns false and invalidates the dedup entry when Hiro returns 502", async () => {
    const kv = new MemoryKV();
    await seedStalePendingDedup(kv, txHex);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 502 })
    );

    const service = makeService(kv);
    const result = await service.checkDedup(txHex);

    expect(result).toBeNull();
  });

  it("returns false and invalidates the dedup entry when Hiro returns 503", async () => {
    const kv = new MemoryKV();
    await seedStalePendingDedup(kv, txHex);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 })
    );

    const service = makeService(kv);
    const result = await service.checkDedup(txHex);

    expect(result).toBeNull();
  });

  it("preserves the dedup entry (fail-open) when Hiro returns an unexpected 500", async () => {
    const kv = new MemoryKV();
    await seedStalePendingDedup(kv, txHex);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500 })
    );

    const service = makeService(kv);
    const result = await service.checkDedup(txHex);

    expect(result).not.toBeNull();
    expect(result?.status).toBe("pending");
  });

  it("preserves the dedup entry when Hiro returns a successful 200 with pending tx_status", async () => {
    const kv = new MemoryKV();
    await seedStalePendingDedup(kv, txHex);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tx_status: "pending" }), { status: 200 })
    );

    const service = makeService(kv);
    const result = await service.checkDedup(txHex);

    expect(result).not.toBeNull();
    expect(result?.status).toBe("pending");
  });
});
