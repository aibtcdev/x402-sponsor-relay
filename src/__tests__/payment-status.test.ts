import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PaymentStatusHttpResponseSchema,
  RpcCheckPaymentResultSchema,
  RpcSubmitPaymentResultSchema,
} from "@aibtc/tx-schemas";
import { AnchorMode, makeRandomPrivKey, makeSTXTokenTransfer } from "@stacks/transactions";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly ctx: ExecutionContext;
    protected readonly env: unknown;

    constructor(ctx: ExecutionContext, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import worker, { RelayRPC } from "../index";
import { PaymentStatus as PaymentStatusEndpoint } from "../endpoints/payment-status";
import { MemoryKV } from "./helpers/memory-kv";
import {
  buildNotFoundPaymentRecord,
  computePaymentArtifactHash,
  createPaymentRecord,
  getReusablePaymentRecord,
  getPaymentIdByArtifact,
  inferReplacementTerminalReason,
  projectPaymentRecord,
  projectCallerFacingPaymentStatus,
  putPaymentArtifact,
  putPaymentRecord,
  transitionPayment,
  type PaymentRecord,
} from "../services/payment-status";
import type { Env } from "../types";

const executionContext = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as ExecutionContext;

let duplicateReuseTxHexPromise: Promise<string> | undefined;

async function getDuplicateReuseTxHex(): Promise<string> {
  if (!duplicateReuseTxHexPromise) {
    duplicateReuseTxHexPromise = (async () => {
      const transaction = await makeSTXTokenTransfer({
        recipient: "ST37NMC4HGFQ1H2JSFP4H3TMNQBF4PY0MVSD1GV7Z",
        amount: 1n,
        senderKey: makeRandomPrivKey(),
        network: "testnet",
        memo: "dup-reuse",
        anchorMode: AnchorMode.Any,
        sponsored: true,
        fee: 0n,
        nonce: 0n,
      });
      return transaction.serialize();
    })();
  }

  return duplicateReuseTxHexPromise;
}

async function getSubmitPaymentTxHex(nonce: bigint): Promise<string> {
  const transaction = await makeSTXTokenTransfer({
    recipient: "ST37NMC4HGFQ1H2JSFP4H3TMNQBF4PY0MVSD1GV7Z",
    amount: 1n,
    senderKey: makeRandomPrivKey(),
    network: "testnet",
    memo: `submit-${nonce.toString()}`,
    anchorMode: AnchorMode.Any,
    sponsored: true,
    fee: 0n,
    nonce,
  });
  return transaction.serialize();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("payment status projection", () => {
  it("projects internal submitted to public queued", () => {
    expect(projectCallerFacingPaymentStatus("submitted")).toBe("queued");

    const projected = projectPaymentRecord(
      createPaymentRecord("pay_123", "testnet")
    );

    expect(projected.status).toBe("queued");
  });

  it("preserves duplicate paymentId by tx artifact until terminal", async () => {
    const kv = new MemoryKV();
    const txArtifactHash = await computePaymentArtifactHash("0xdeadbeef");
    const activeRecord = transitionPayment(
      createPaymentRecord("pay_active", "testnet"),
      "queued"
    );

    await putPaymentRecord(kv, activeRecord);
    await putPaymentArtifact(kv, txArtifactHash, activeRecord.paymentId);

    const reused = await getReusablePaymentRecord(kv, txArtifactHash);
    expect(reused?.paymentId).toBe("pay_active");

    const terminalRecord: PaymentRecord = transitionPayment(activeRecord, "failed", {
      error: "Sender nonce stale",
      errorCode: "SENDER_NONCE_STALE",
      terminalReason: "sender_nonce_stale",
      retryable: false,
    });
    await putPaymentRecord(kv, terminalRecord);

    const afterTerminal = await getReusablePaymentRecord(kv, txArtifactHash);
    expect(afterTerminal).toBeNull();
    expect(await getPaymentIdByArtifact(kv, txArtifactHash)).toBeNull();
  });

  it("normalizes transaction hex case before computing artifact hashes", async () => {
    const lowerHash = await computePaymentArtifactHash("0xdeadbeef");
    const upperHash = await computePaymentArtifactHash("0xDEADBEEF");

    expect(lowerHash).toBe(upperHash);
  });

  it("keeps RPC and HTTP polling on canonical public status while terminalReason stays additive", () => {
    const failedRecord = transitionPayment(
      transitionPayment(createPaymentRecord("pay_rpc", "testnet"), "queued"),
      "failed",
      {
        error: "Sponsor wallet stalled",
        errorCode: "INTERNAL_ERROR",
        terminalReason: "sponsor_failure",
        retryable: false,
      }
    );
    const projectedFailed = projectPaymentRecord(failedRecord);

    expect(
      RpcCheckPaymentResultSchema.parse({
        paymentId: projectedFailed.paymentId,
        status: projectedFailed.status,
        error: projectedFailed.error,
        errorCode: projectedFailed.errorCode,
        retryable: projectedFailed.retryable,
        senderNonceInfo: projectedFailed.senderNonceInfo,
      }).status
    ).toBe("failed");
    expect(projectedFailed.terminalReason).toBe("sponsor_failure");

    const queuedProjected = projectPaymentRecord(
      transitionPayment(createPaymentRecord("pay_http", "testnet"), "queued")
    );
    expect(
      PaymentStatusHttpResponseSchema.parse({
        paymentId: queuedProjected.paymentId,
        status: queuedProjected.status,
        checkStatusUrl: "https://x402-relay.aibtc.dev/payment/pay_http",
      }).status
    ).toBe("queued");
  });

  it("emits canonical not_found and replaced semantics", () => {
    expect(buildNotFoundPaymentRecord("pay_missing")).toEqual(
      expect.objectContaining({
        paymentId: "pay_missing",
        status: "not_found",
        terminalReason: "unknown_payment_identity",
      })
    );
    expect(inferReplacementTerminalReason("rbf")).toBe("nonce_replacement");
    expect(inferReplacementTerminalReason("replaced_by_direct")).toBe("superseded");
  });

  it("drops terminalReason from nonterminal public projections", () => {
    const queuedProjection = projectPaymentRecord({
      ...transitionPayment(createPaymentRecord("pay_nonterminal", "testnet"), "queued"),
      terminalReason: "sponsor_failure",
    });

    expect(queuedProjection.status).toBe("queued");
    expect(queuedProjection.terminalReason).toBeUndefined();
  });

  it("clears held diagnostics when a held payment transitions to a non-held status", () => {
    const heldRecord = transitionPayment(
      createPaymentRecord("pay_hold_clear", "testnet"),
      "queued",
      {
        holdReason: "capacity",
        nextExpectedNonce: 7,
        missingNonces: [7],
        holdExpiresAt: "2026-04-09T12:30:00.000Z",
      }
    );

    const failedRecord = transitionPayment(heldRecord, "failed", {
      error: "relay failed",
      terminalReason: "sponsor_failure",
      retryable: false,
    });

    expect(failedRecord.relayState).toBeUndefined();
    expect(failedRecord.holdReason).toBeUndefined();
    expect(failedRecord.nextExpectedNonce).toBeUndefined();
    expect(failedRecord.missingNonces).toBeUndefined();
    expect(failedRecord.holdExpiresAt).toBeUndefined();
  });
});

describe("submitPayment duplicate reuse", () => {
  async function submitDuplicateForStatus(status: PaymentRecord["status"]) {
    const kv = new MemoryKV();
    const txHex = await getDuplicateReuseTxHex();
    const txArtifactHash = await computePaymentArtifactHash(txHex);
    const senderNonceInfo = { provided: 7, expected: 7, healthy: true } as const;
    const record = transitionPayment(
      createPaymentRecord("pay_duplicate", "testnet", senderNonceInfo),
      status
    );

    await putPaymentRecord(kv, record);
    await putPaymentArtifact(kv, txArtifactHash, record.paymentId);

    const env = {
      RELAY_KV: kv,
      STACKS_NETWORK: "testnet",
      RELAY_BASE_URL: "https://x402-relay.aibtc.dev",
    } as Env;

    const rpc = new RelayRPC(executionContext, env);
    const result = RpcSubmitPaymentResultSchema.parse(
      await rpc.submitPayment(txHex)
    );

    return { result, record };
  }

  it("collapses internal submitted to queued for duplicate reuse responses", async () => {
    const { result, record } = await submitDuplicateForStatus("submitted");

    expect(result).toEqual({
      accepted: true,
      paymentId: record.paymentId,
      status: "queued",
      senderNonce: record.senderNonceInfo,
      checkStatusUrl: "https://x402-relay.aibtc.dev/payment/pay_duplicate",
    });
  });

  it("reuses the same paymentId and returns queued while the active record is queued", async () => {
    const { result, record } = await submitDuplicateForStatus("queued");

    expect(result).toEqual({
      accepted: true,
      paymentId: record.paymentId,
      status: "queued",
      senderNonce: record.senderNonceInfo,
      checkStatusUrl: "https://x402-relay.aibtc.dev/payment/pay_duplicate",
    });
  });

  it("reuses the same paymentId and preserves broadcasting for active in-flight payments", async () => {
    const { result, record } = await submitDuplicateForStatus("broadcasting");

    expect(result).toEqual({
      accepted: true,
      paymentId: record.paymentId,
      status: "broadcasting",
      senderNonce: record.senderNonceInfo,
      checkStatusUrl: "https://x402-relay.aibtc.dev/payment/pay_duplicate",
    });
  });

  it("reuses the same paymentId and preserves mempool for active in-flight payments", async () => {
    const { result, record } = await submitDuplicateForStatus("mempool");

    expect(result).toEqual({
      accepted: true,
      paymentId: record.paymentId,
      status: "mempool",
      senderNonce: record.senderNonceInfo,
      checkStatusUrl: "https://x402-relay.aibtc.dev/payment/pay_duplicate",
    });
  });

  it("stops duplicate reuse once the prior payment reaches a terminal outcome", async () => {
    const kv = new MemoryKV();
    const txHex = await getDuplicateReuseTxHex();
    const txArtifactHash = await computePaymentArtifactHash(txHex);
    const terminalRecord = transitionPayment(
      transitionPayment(createPaymentRecord("pay_terminal", "testnet"), "queued"),
      "failed",
      {
        error: "Sender nonce stale",
        errorCode: "SENDER_NONCE_STALE",
        terminalReason: "sender_nonce_stale",
        retryable: false,
      }
    );

    await putPaymentRecord(kv, terminalRecord);
    await putPaymentArtifact(kv, txArtifactHash, terminalRecord.paymentId);
    expect(await getReusablePaymentRecord(kv, txArtifactHash)).toBeNull();
    expect(await getPaymentIdByArtifact(kv, txArtifactHash)).toBeNull();
  });

  it("reconciles stale sender gap cache from Hiro before accepting a new payment", async () => {
    const kv = new MemoryKV();
    const txHex = await getSubmitPaymentTxHex(26n);
    const queueSend = vi.fn(async () => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        last_executed_tx_nonce: 25,
        possible_next_nonce: 26,
        detected_missing_nonces: [],
      }), { status: 200 })
    );

    await kv.put(
      "sender_nonce:f6d5c77b5384e0c4c22bd705c8066842b8ff6dda",
      JSON.stringify({
        lastSeen: 24,
        lastConfirmed: 24,
        updatedAt: new Date().toISOString(),
      })
    );

    const env = {
      RELAY_KV: kv,
      STACKS_NETWORK: "testnet",
      RELAY_BASE_URL: "https://x402-relay.aibtc.dev",
      PAYMENT_QUEUE: {
        send: queueSend,
      },
    } as unknown as Env;

    const rpc = new RelayRPC(executionContext, env);
    const result = RpcSubmitPaymentResultSchema.parse(
      await rpc.submitPayment(txHex)
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      accepted: true,
      paymentId: expect.stringMatching(/^pay_/),
      status: "queued",
      senderNonce: {
        provided: 26,
        expected: 26,
        healthy: true,
      },
      checkStatusUrl: expect.stringMatching(/^https:\/\/x402-relay\.aibtc\.dev\/payment\/pay_/),
    });
    expect(queueSend).toHaveBeenCalledTimes(1);
  });
});

describe("payment polling runtime alignment", () => {
  it("keeps RPC and HTTP polling aligned on queued for internal submitted records", async () => {
    const kv = new MemoryKV();
    const record = createPaymentRecord("pay_submitted", "testnet");
    await putPaymentRecord(kv, record);

    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const env = {
      RELAY_KV: kv,
      STACKS_NETWORK: "testnet",
      RELAY_BASE_URL: "https://x402-relay.aibtc.dev",
    } as Env;

    const rpc = new RelayRPC(executionContext, env);
    const rpcResult = RpcCheckPaymentResultSchema.parse(
      await rpc.checkPayment("pay_submitted")
    );

    const response = await worker.fetch(
      new Request("https://x402-relay.aibtc.dev/payment/pay_submitted"),
      env,
      executionContext
    );
    const httpBody = await response.json();
    const httpResult = PaymentStatusHttpResponseSchema.parse(httpBody);

    expect(response.status).toBe(200);
    expect(rpcResult.status).toBe("queued");
    expect(httpResult.status).toBe("queued");
    expect(rpcResult.checkStatusUrl).toBe(
      "https://x402-relay.aibtc.dev/payment/pay_submitted"
    );
    expect(httpBody.checkStatusUrl).toBe(
      "https://x402-relay.aibtc.dev/payment/pay_submitted"
    );
    expect(rpcResult.terminalReason).toBeUndefined();
    expect(httpResult.terminalReason).toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith("[INFO] payment.poll", expect.objectContaining({
      service: "relay",
      route: "rpc.checkPayment",
      paymentId: "pay_submitted",
      status: "queued",
      checkStatusUrl_present: true,
      compat_shim_used: true,
      repo_version: expect.any(String),
    }));
    expect(infoSpy).toHaveBeenCalledWith("[INFO] payment.poll", expect.objectContaining({
      service: "relay",
      route: "GET /payment/:id",
      paymentId: "pay_submitted",
      status: "queued",
      checkStatusUrl_present: true,
      compat_shim_used: true,
      repo_version: expect.any(String),
    }));
    expect(warnSpy).toHaveBeenCalledWith("[WARN] payment.fallback_used", expect.objectContaining({
      service: "relay",
      paymentId: "pay_submitted",
      action: "submitted_projection",
      compat_shim_used: true,
      repo_version: expect.any(String),
    }));
  });

  it("keeps RPC and HTTP polling aligned on terminal status and terminalReason", async () => {
    const kv = new MemoryKV();
    const failedRecord = transitionPayment(
      transitionPayment(createPaymentRecord("pay_failed", "testnet"), "queued"),
      "failed",
      {
        error: "Sponsor wallet stalled",
        errorCode: "INTERNAL_ERROR",
        terminalReason: "sponsor_failure",
        retryable: false,
      }
    );
    await putPaymentRecord(kv, failedRecord);

    const env = {
      RELAY_KV: kv,
      STACKS_NETWORK: "testnet",
      RELAY_BASE_URL: "https://x402-relay.aibtc.dev",
    } as Env;

    const rpc = new RelayRPC(executionContext, env);
    const rpcResult = RpcCheckPaymentResultSchema.parse(
      await rpc.checkPayment("pay_failed")
    );

    const response = await worker.fetch(
      new Request("https://x402-relay.aibtc.dev/payment/pay_failed"),
      env,
      executionContext
    );
    const httpBody = await response.json();
    const httpResult = PaymentStatusHttpResponseSchema.parse(httpBody);

    expect(response.status).toBe(200);
    expect(rpcResult.status).toBe("failed");
    expect(httpResult.status).toBe("failed");
    expect(rpcResult.checkStatusUrl).toBe(
      "https://x402-relay.aibtc.dev/payment/pay_failed"
    );
    expect(httpBody.checkStatusUrl).toBe(
      "https://x402-relay.aibtc.dev/payment/pay_failed"
    );
    expect(rpcResult.terminalReason).toBe("sponsor_failure");
    expect(httpResult.terminalReason).toBe("sponsor_failure");
  });

  it("returns canonical not_found identity semantics from RPC and HTTP polling", async () => {
    const kv = new MemoryKV();
    const env = {
      RELAY_KV: kv,
      STACKS_NETWORK: "testnet",
      RELAY_BASE_URL: "https://x402-relay.aibtc.dev",
    } as Env;

    const rpc = new RelayRPC(executionContext, env);
    const rpcResult = RpcCheckPaymentResultSchema.parse(
      await rpc.checkPayment("pay_missing")
    );

    const response = await worker.fetch(
      new Request("https://x402-relay.aibtc.dev/payment/pay_missing"),
      env,
      executionContext
    );
    const httpBody = await response.json();
    const httpResult = PaymentStatusHttpResponseSchema.parse(httpBody);

    expect(response.status).toBe(404);
    expect(rpcResult.status).toBe("not_found");
    expect(httpResult.status).toBe("not_found");
    expect(rpcResult.checkStatusUrl).toBe(
      "https://x402-relay.aibtc.dev/payment/pay_missing"
    );
    expect(httpBody.checkStatusUrl).toBe(
      "https://x402-relay.aibtc.dev/payment/pay_missing"
    );
    expect(rpcResult.terminalReason).toBe("unknown_payment_identity");
    expect(httpResult.terminalReason).toBe("unknown_payment_identity");
  });

  it("surfaces held sender-wedge diagnostics consistently from RPC and HTTP polling", async () => {
    const kv = new MemoryKV();
    const heldRecord = transitionPayment(
      createPaymentRecord("pay_held", "testnet"),
      "queued",
      {
        holdReason: "gap",
        nextExpectedNonce: 4,
        missingNonces: [4, 5],
        holdExpiresAt: "2026-04-09T12:30:00.000Z",
      }
    );
    heldRecord.senderAddress = "STHOLD000000000000000000000000000000000";
    heldRecord.relayState = "held";
    await putPaymentRecord(kv, heldRecord);

    const env = {
      RELAY_KV: kv,
      STACKS_NETWORK: "testnet",
      RELAY_BASE_URL: "https://x402-relay.aibtc.dev",
      NONCE_DO: {
        idFromName: () => "sponsor",
        get: () => ({
          fetch: vi.fn(async () => new Response(JSON.stringify({
            senderAddress: "STHOLD000000000000000000000000000000000",
            blocked: true,
            blockedOnFrontierMismatch: true,
            adminRecoveryLikely: false,
            nextExpectedNonce: 4,
            lowestHeldNonce: 6,
            missingNonces: [4, 5],
            heldCount: 1,
            oldestHeldAgeMs: 120000,
            lastRepairAttemptAt: null,
            lastRepairFailureAt: null,
            repairEligible: false,
            repairTriggered: true,
            repairAdvanced: false,
            activePaymentIds: ["pay_held"],
          }))),
        }),
      },
    } as unknown as Env;

    const rpc = new RelayRPC(executionContext, env);
    const rpcResult = await rpc.checkPayment("pay_held");

    const response = await worker.fetch(
      new Request("https://x402-relay.aibtc.dev/payment/pay_held"),
      env,
      executionContext
    );
    const httpBody = await response.json();

    expect(response.status).toBe(200);
    expect(rpcResult.status).toBe("queued");
    expect(httpBody.status).toBe("queued");
    expect((rpcResult as Record<string, unknown>).relayState).toBe("held");
    expect((rpcResult as Record<string, unknown>).holdReason).toBe("gap");
    expect((rpcResult as Record<string, unknown>).nextExpectedNonce).toBe(4);
    expect((rpcResult as Record<string, unknown>).missingNonces).toEqual([4, 5]);
    expect((rpcResult as Record<string, unknown>).senderWedge).toEqual(
      expect.objectContaining({
        blockedOnFrontierMismatch: true,
        repairTriggered: true,
      })
    );
    expect(httpBody.senderWedge).toEqual(
      expect.objectContaining({
        senderAddress: "STHOLD000000000000000000000000000000000",
        missingNonces: [4, 5],
      })
    );
  });
});

describe("PaymentStatus endpoint schema", () => {
  it("documents canonical public statuses without submitted and documents not_found terminal reasons", () => {
    const endpoint = new PaymentStatusEndpoint();
    const okProperties =
      endpoint.schema.responses["200"].content["application/json"].schema.properties;
    const notFoundProperties =
      endpoint.schema.responses["404"].content["application/json"].schema.properties;

    expect(okProperties.status.enum).toEqual([
      "queued",
      "broadcasting",
      "mempool",
      "confirmed",
      "failed",
      "replaced",
    ]);
    expect(okProperties).toHaveProperty("terminalReason");
    expect(notFoundProperties.status.enum).toEqual(["not_found"]);
    expect(notFoundProperties.terminalReason.enum).toEqual([
      "expired",
      "unknown_payment_identity",
    ]);
    expect(notFoundProperties).toHaveProperty("checkStatusUrl");
  });

  it("keeps generated openapi and llms docs aligned on caller-facing payment polling fields", async () => {
    const env = {
      STACKS_NETWORK: "testnet",
      RELAY_BASE_URL: "https://x402-relay.aibtc.dev",
    } as Env;

    const openapiResponse = await worker.fetch(
      new Request("https://x402-relay.aibtc.dev/openapi.json"),
      env,
      executionContext
    );
    const openapi = await openapiResponse.json();
    const paymentGet =
      openapi.paths["/payment/{id}"].get.responses;
    const okProperties =
      paymentGet["200"].content["application/json"].schema.properties;
    const notFoundProperties =
      paymentGet["404"].content["application/json"].schema.properties;

    expect(openapiResponse.status).toBe(200);
    expect(okProperties.status.enum).toEqual([
      "queued",
      "broadcasting",
      "mempool",
      "confirmed",
      "failed",
      "replaced",
    ]);
    expect(okProperties).toHaveProperty("terminalReason");
    expect(okProperties).toHaveProperty("checkStatusUrl");
    expect(notFoundProperties.terminalReason.enum).toEqual([
      "expired",
      "unknown_payment_identity",
    ]);

    const llmsResponse = await worker.fetch(
      new Request("https://x402-relay.aibtc.dev/llms-full.txt"),
      env,
      executionContext
    );
    const llms = await llmsResponse.text();

    expect(llmsResponse.status).toBe(200);
    expect(llms).toContain("## Queue Payment Polling");
    expect(llms).toContain("Canonical public statuses:");
    expect(llms).toContain("\"terminalReason\": \"sender_nonce_gap\"");
    expect(llms).toContain("\"checkStatusUrl\": \"https://x402-relay.aibtc.dev/payment/pay_01J...\"");
    expect(llms).toContain("The duplicate submission response returns the");
  });
});
