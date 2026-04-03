import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PaymentStatusHttpResponseSchema,
  RpcCheckPaymentResultSchema,
} from "@aibtc/tx-schemas";

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

class MemoryKV implements KVNamespace {
  private readonly store = new Map<string, string>();

  async get(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream"
  ): Promise<string | null>;
  async get<T>(
    key: string,
    type: "json"
  ): Promise<T | null>;
  async get(
    key: string,
    _type: "arrayBuffer"
  ): Promise<ArrayBuffer | null>;
  async get(
    key: string,
    _type: "stream"
  ): Promise<ReadableStream | null>;
  async get<T>(
    key: string,
    type: "text" | "json" | "arrayBuffer" | "stream" = "text"
  ): Promise<T | string | ArrayBuffer | ReadableStream | null> {
    const value = this.store.get(key) ?? null;
    if (value === null) {
      return null;
    }

    if (type === "json") {
      return JSON.parse(value) as T;
    }

    if (type === "arrayBuffer") {
      return new TextEncoder().encode(value).buffer;
    }

    if (type === "stream") {
      return null;
    }

    return value;
  }

  async getWithMetadata(): Promise<KVNamespaceGetWithMetadataResult<unknown, string>> {
    throw new Error("not implemented");
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<KVNamespaceListResult<unknown>> {
    throw new Error("not implemented");
  }
}

const executionContext = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as ExecutionContext;

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
    expect(rpcResult.terminalReason).toBe("unknown_payment_identity");
    expect(httpResult.terminalReason).toBe("unknown_payment_identity");
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
  });
});
