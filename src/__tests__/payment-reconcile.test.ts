import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPaymentRecord,
  getPaymentRecord,
  putPaymentRecord,
  transitionPayment,
  type PaymentRecord,
  type PaymentStatus,
} from "../services/payment-status";
import { reconcileStuckPayments } from "../services/payment-reconcile";
import { MemoryKV } from "./helpers/memory-kv";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof reconcileStuckPayments>[1];

const env = (kv: MemoryKV) =>
  ({ RELAY_KV: kv, STACKS_NETWORK: "mainnet" }) as unknown as Parameters<typeof reconcileStuckPayments>[0];

/** Build a stuck record older than the 5-minute staleness threshold. */
function staleRecord(
  id: string,
  sender: string,
  nonce: number,
  status: PaymentStatus = "queued",
): PaymentRecord {
  const r = transitionPayment(createPaymentRecord(id, "mainnet"), status);
  r.senderAddress = sender;
  r.senderNonce = nonce;
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  r.submittedAt = old;
  r.queuedAt = old;
  return r;
}

interface MockTx {
  nonce: number;
  tx_id: string;
  tx_status: string;
  sponsored?: boolean;
  block_height?: number;
}

function mockHiro(opts: { lastExec: number | null; next: number | null; mempool?: number[]; txs?: MockTx[] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/nonces")) {
        return {
          ok: true,
          json: async () => ({
            last_executed_tx_nonce: opts.lastExec,
            possible_next_nonce: opts.next,
            detected_mempool_nonces: opts.mempool ?? [],
          }),
        };
      }
      if (url.includes("/transactions")) {
        return { ok: true, json: async () => ({ results: opts.txs ?? [] }) };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

describe("reconcileStuckPayments (#398)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("confirms a stuck record whose sender nonce settled via a sponsored tx (+ writes txid_map)", async () => {
    const kv = new MemoryKV();
    await putPaymentRecord(kv, staleRecord("pay_conf", "SP_SENDER", 47));
    mockHiro({
      lastExec: 49,
      next: 50,
      txs: [{ nonce: 47, tx_id: "0xabc", tx_status: "success", sponsored: true, block_height: 100 }],
    });

    await reconcileStuckPayments(env(kv), logger);

    const r = await getPaymentRecord(kv, "pay_conf");
    expect(r).toEqual(expect.objectContaining({ status: "confirmed", txid: "0xabc", blockHeight: 100 }));
    expect(await kv.get("txid_map:0xabc")).toBe("pay_conf");
  });

  it("marks a record superseded when a different (self-paid) tx took the nonce", async () => {
    const kv = new MemoryKV();
    await putPaymentRecord(kv, staleRecord("pay_sup", "SP_SENDER", 47));
    mockHiro({
      lastExec: 49,
      next: 50,
      txs: [{ nonce: 47, tx_id: "0xdef", tx_status: "success", sponsored: false }],
    });

    await reconcileStuckPayments(env(kv), logger);

    const r = await getPaymentRecord(kv, "pay_sup");
    expect(r).toEqual(expect.objectContaining({ status: "replaced", terminalReason: "superseded" }));
    expect(await kv.get("txid_map:0xdef")).toBeNull();
  });

  it("fails a record whose tx aborted on-chain", async () => {
    const kv = new MemoryKV();
    await putPaymentRecord(kv, staleRecord("pay_abort", "SP_SENDER", 47));
    mockHiro({
      lastExec: 49,
      next: 50,
      txs: [{ nonce: 47, tx_id: "0xbad", tx_status: "abort_by_response", sponsored: true }],
    });

    await reconcileStuckPayments(env(kv), logger);

    const r = await getPaymentRecord(kv, "pay_abort");
    expect(r).toEqual(
      expect.objectContaining({ status: "failed", terminalReason: "chain_abort", retryable: false }),
    );
  });

  it("terminalizes a never-landed stuck record (nonce open, not in mempool) as failed+retryable", async () => {
    const kv = new MemoryKV();
    await putPaymentRecord(kv, staleRecord("pay_stale", "SP_SENDER", 47));
    mockHiro({ lastExec: 46, next: 47, mempool: [] });

    await reconcileStuckPayments(env(kv), logger);

    const r = await getPaymentRecord(kv, "pay_stale");
    expect(r).toEqual(
      expect.objectContaining({ status: "failed", retryable: true, terminalReason: "internal_error" }),
    );
  });

  it("leaves an in-flight record (nonce in mempool) untouched", async () => {
    const kv = new MemoryKV();
    await putPaymentRecord(kv, staleRecord("pay_inflight", "SP_SENDER", 47));
    mockHiro({ lastExec: 46, next: 47, mempool: [47] });

    await reconcileStuckPayments(env(kv), logger);

    const r = await getPaymentRecord(kv, "pay_inflight");
    expect(r?.status).toBe("queued");
  });

  it("skips records that are too recent to be stale", async () => {
    const kv = new MemoryKV();
    // Fresh record — createPaymentRecord stamps submittedAt = now.
    const fresh = transitionPayment(createPaymentRecord("pay_fresh", "mainnet"), "queued");
    fresh.senderAddress = "SP_SENDER";
    fresh.senderNonce = 47;
    await putPaymentRecord(kv, fresh);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await reconcileStuckPayments(env(kv), logger);

    expect(fetchSpy).not.toHaveBeenCalled();
    const r = await getPaymentRecord(kv, "pay_fresh");
    expect(r?.status).toBe("queued");
  });

  it("skips already-terminal records", async () => {
    const kv = new MemoryKV();
    await putPaymentRecord(kv, staleRecord("pay_done", "SP_SENDER", 47, "confirmed"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await reconcileStuckPayments(env(kv), logger);

    expect(fetchSpy).not.toHaveBeenCalled();
    const r = await getPaymentRecord(kv, "pay_done");
    expect(r?.status).toBe("confirmed");
  });
});
