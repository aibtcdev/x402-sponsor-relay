import { describe, expect, it, vi, afterEach } from "vitest";
import type { LogsRPC } from "../types";
import { createWorkerLogger } from "../utils/logger";

describe("createWorkerLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers LOGS RPC with waitUntil when available", async () => {
    const logs: LogsRPC = {
      info: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
    };
    const waitUntil = vi.fn((promise: Promise<void>) => promise);

    const logger = createWorkerLogger(logs, { waitUntil }, { paymentId: "p_123", attempt: 2 });
    logger.warn("Queue retry scheduled", { code: "LOW_HEADROOM" });

    expect(logs.warn).toHaveBeenCalledWith("x402-relay", "Queue retry scheduled", {
      paymentId: "p_123",
      attempt: 2,
      code: "LOW_HEADROOM",
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("falls back to console when LOGS binding is unavailable", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createWorkerLogger(undefined, undefined, {
      paymentId: "p_456",
      attempt: 1,
    });

    logger.warn("Queue retry scheduled", { code: "NONCE_DO_UNAVAILABLE" });

    expect(warnSpy).toHaveBeenCalledWith("[WARN] Queue retry scheduled", {
      paymentId: "p_456",
      attempt: 1,
      code: "NONCE_DO_UNAVAILABLE",
    });
  });

  it("swallows synchronous LOGS binding failures", () => {
    const logs: LogsRPC = {
      info: vi.fn(() => {
        throw new Error("stub exploded");
      }),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
    };
    const waitUntil = vi.fn();
    const logger = createWorkerLogger(logs, { waitUntil }, { paymentId: "p_789" });

    expect(() => logger.info("Queue log")).not.toThrow();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("swallows waitUntil failures after starting an RPC log call", () => {
    const logs: LogsRPC = {
      info: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      debug: vi.fn(async () => {}),
    };
    const waitUntil = vi.fn(() => {
      throw new Error("bad waitUntil");
    });
    const logger = createWorkerLogger(logs, { waitUntil }, { paymentId: "p_999" });

    expect(() => logger.info("Queue log")).not.toThrow();
    expect(logs.info).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
