/**
 * Regression: the /settle tx-hex dedup cache must not vouch for a payment that
 * does not satisfy the current paymentRequirements.
 *
 * Before the fix, checkDedup ran before verifyPaymentParams, so a hex settled once
 * for payTo A could be resubmitted within the dedup TTL with payTo B (or a larger
 * amount) and still get `success: true`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeSTXTokenTransfer,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import { Settle } from "../endpoints/settle";
import { MemoryKV } from "./helpers/memory-kv";
import type { DedupResult, Logger } from "../types";

const SENDER_KEY = "753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601";
const RECIPIENT_A = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const RECIPIENT_B = "ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC";

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function buildSelfPaidTx(): Promise<string> {
  const tx = await makeSTXTokenTransfer({
    recipient: RECIPIENT_A,
    amount: 1_000_000n,
    senderKey: SENDER_KEY,
    network: "testnet",
    fee: 1000n,
    nonce: 0n,
  });
  return tx.serialize();
}

async function seedDedup(kv: MemoryKV, txHex: string): Promise<void> {
  const normalized = txHex.toLowerCase().replace(/^0x/, "");
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const txHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const record: DedupResult = {
    txid: "0xcached",
    status: "pending",
    sender: getAddressFromPrivateKey(SENDER_KEY, "testnet"),
    recipient: RECIPIENT_A,
    amount: "1000000",
    recordedAt: Date.now(),
  };
  await kv.put(`dedup:${txHash}`, JSON.stringify(record));
}

function makeContext(kv: MemoryKV, body: unknown) {
  return {
    env: { STACKS_NETWORK: "testnet", RELAY_KV: kv },
    req: {
      json: async () => body,
      header: () => undefined,
    },
    get: (key: string) => (key === "logger" ? noopLogger : "req-id"),
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    executionCtx: { waitUntil: () => {} },
  };
}

function settleBody(txHex: string, payTo: string, amount: string) {
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, payload: { transaction: txHex } },
    paymentRequirements: {
      scheme: "exact",
      network: "stacks:2147483648",
      amount,
      asset: "STX",
      payTo,
      maxTimeoutSeconds: 60,
    },
  };
}

async function runSettle(kv: MemoryKV, body: unknown) {
  const ctx = makeContext(kv, body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Response = await new Settle().handle(ctx as any);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("/settle dedup respects paymentRequirements", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a cached hex resubmitted with a different payTo", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = new MemoryKV();
    const txHex = await buildSelfPaidTx();
    await seedDedup(kv, txHex);

    const { json } = await runSettle(kv, settleBody(txHex, RECIPIENT_B, "1000000"));

    expect(json.success).toBe(false);
    expect(json.errorReason).toBe("recipient_mismatch");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a cached hex resubmitted with a higher amount", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const kv = new MemoryKV();
    const txHex = await buildSelfPaidTx();
    await seedDedup(kv, txHex);

    const { json } = await runSettle(kv, settleBody(txHex, RECIPIENT_A, "5000000"));

    expect(json.success).toBe(false);
    expect(json.errorReason).toBe("amount_insufficient");
  });

  it("still returns the cached result when the requirements match", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = new MemoryKV();
    const txHex = await buildSelfPaidTx();
    await seedDedup(kv, txHex);

    const { status, json } = await runSettle(kv, settleBody(txHex, RECIPIENT_A, "1000000"));

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.transaction).toBe("0xcached");
    // Served from cache: no broadcast.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
