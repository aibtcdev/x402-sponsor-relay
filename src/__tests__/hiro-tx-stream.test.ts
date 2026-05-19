import { describe, it, expect, vi } from "vitest";
import type { Logger } from "../types";
import {
  waitForHiroTxConfirmationViaStream,
  HiroTxStream,
  type WebSocketFactory,
  type WebSocketLike,
} from "../services/hiro-tx-stream";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

class FakeWebSocket implements WebSocketLike {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  sent: string[] = [];
  closed = false;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, existing.filter((candidate) => candidate !== listener));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown = {}): void {
    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

function makeFactory(socket: FakeWebSocket): WebSocketFactory {
  return vi.fn(() => socket);
}

describe("waitForHiroTxConfirmationViaStream", () => {
  it("resolves confirmed when Hiro sends a terminal success update", async () => {
    const socket = new FakeWebSocket();
    const promise = waitForHiroTxConfirmationViaStream({
      txid: "0xabc",
      network: "mainnet",
      timeoutMs: 1_000,
      logger: noopLogger,
      webSocketFactory: makeFactory(socket),
    });

    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { tx_id: "0xabc" },
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "tx_update",
        params: {
          tx_id: "0xabc",
          tx_status: "success",
          block_height: 123,
        },
      }),
    });

    await expect(promise).resolves.toEqual({
      txid: "0xabc",
      status: "confirmed",
      blockHeight: 123,
    });
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toBe(true);
  });

  it("resolves terminal failure for abort statuses", async () => {
    const socket = new FakeWebSocket();
    const promise = waitForHiroTxConfirmationViaStream({
      txid: "0xdef",
      network: "testnet",
      timeoutMs: 1_000,
      logger: noopLogger,
      webSocketFactory: makeFactory(socket),
    });

    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "tx_update",
        params: {
          tx_id: "0xdef",
          tx_status: "abort_by_response",
        },
      }),
    });

    await expect(promise).resolves.toEqual({
      error: "Transaction failed on-chain",
      details: "tx_status: abort_by_response",
      retryable: false,
    });
  });

  it("returns null when the stream closes before a terminal update", async () => {
    const socket = new FakeWebSocket();
    const promise = waitForHiroTxConfirmationViaStream({
      txid: "0x123",
      network: "mainnet",
      timeoutMs: 1_000,
      logger: noopLogger,
      webSocketFactory: makeFactory(socket),
    });

    socket.emit("open");
    socket.emit("close", { code: 1006, reason: "unexpected" });

    await expect(promise).resolves.toBeNull();
  });

  it("returns null when the stream times out without a terminal update", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();

    const promise = waitForHiroTxConfirmationViaStream({
      txid: "0x999",
      network: "mainnet",
      timeoutMs: 500,
      logger: noopLogger,
      webSocketFactory: makeFactory(socket),
    });

    socket.emit("open");
    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBeNull();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// HiroTxStream class tests
// ---------------------------------------------------------------------------

describe("HiroTxStream", () => {
  it("opens exactly ONE WebSocket for N concurrent subscribers on the same instance", async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn<() => WebSocketLike>(() => socket);

    const stream = new HiroTxStream("wss://fake.example.com/ws", noopLogger, factory);

    // Start 5 subscribers before the socket is open.
    const promises = [
      stream.subscribe("0xtx1"),
      stream.subscribe("0xtx2"),
      stream.subscribe("0xtx3"),
      stream.subscribe("0xtx4"),
      stream.subscribe("0xtx5"),
    ];

    // Factory should have been called exactly once.
    expect(factory).toHaveBeenCalledTimes(1);

    // Open the socket and confirm one txid to verify routing works.
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "tx_update",
        params: { tx_id: "0xtx1", tx_status: "success", block_height: 10 },
      }),
    });

    // Remaining txids: resolve via close.
    socket.emit("close", { code: 1000 });

    const [r1, r2, r3, r4, r5] = await Promise.all(promises);
    expect(r1).toEqual({ txid: "0xtx1", status: "confirmed", blockHeight: 10 });
    // Others fell back (close event drained them).
    expect(r2).toBeNull();
    expect(r3).toBeNull();
    expect(r4).toBeNull();
    expect(r5).toBeNull();
  });

  it("LRU eviction resolves oldest entry with null (falls back to polling)", async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn<() => WebSocketLike>(() => socket);

    // maxPending = 2
    const stream = new HiroTxStream("wss://fake.example.com/ws", noopLogger, factory, 2);

    const p1 = stream.subscribe("0xtx1");
    const p2 = stream.subscribe("0xtx2");
    // This subscribe exceeds the cap — oldest (0xtx1) should be evicted with null.
    const p3 = stream.subscribe("0xtx3");

    // p1 should have been evicted and resolved null immediately.
    await expect(p1).resolves.toBeNull();

    // Pending count is 2 (tx2 and tx3).
    expect(stream.pendingCount).toBe(2);

    // Clean up remaining.
    stream.close();
    await expect(p2).resolves.toBeNull();
    await expect(p3).resolves.toBeNull();
  });

  it("factory rejection resolves subscribe() with null (fallback path)", async () => {
    const factory = vi.fn<() => WebSocketLike>(() => {
      throw new Error("429 rate limited");
    });

    const stream = new HiroTxStream("wss://fake.example.com/ws", noopLogger, factory);
    const result = await stream.subscribe("0xtx1");

    expect(result).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("resolver cleanup on terminal state — resolved resolver is not called again", async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn<() => WebSocketLike>(() => socket);
    const stream = new HiroTxStream("wss://fake.example.com/ws", noopLogger, factory);

    const p = stream.subscribe("0xtxA");

    socket.emit("open");
    // Send the success update.
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "tx_update",
        params: { tx_id: "0xtxA", tx_status: "success", block_height: 42 },
      }),
    });

    const result = await p;
    expect(result).toEqual({ txid: "0xtxA", status: "confirmed", blockHeight: 42 });

    // Pending map should be empty after resolution.
    expect(stream.pendingCount).toBe(0);

    // Sending the same update again should not cause errors.
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "tx_update",
        params: { tx_id: "0xtxA", tx_status: "success", block_height: 42 },
      }),
    });
    // Still empty — no double-resolve.
    expect(stream.pendingCount).toBe(0);
  });

  it("existing subscribers reuse the same open WS when socket is already open", async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn<() => WebSocketLike>(() => socket);
    const stream = new HiroTxStream("wss://fake.example.com/ws", noopLogger, factory);

    // First subscriber — triggers WS open.
    const p1 = stream.subscribe("0xtx1");
    socket.emit("open");

    // Second subscriber after the WS is already open.
    const p2 = stream.subscribe("0xtx2");

    // Should still only have opened one WebSocket.
    expect(factory).toHaveBeenCalledTimes(1);

    // Resolve both.
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "tx_update",
        params: { tx_id: "0xtx1", tx_status: "success", block_height: 1 },
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "tx_update",
        params: { tx_id: "0xtx2", tx_status: "success", block_height: 2 },
      }),
    });

    await expect(p1).resolves.toEqual({ txid: "0xtx1", status: "confirmed", blockHeight: 1 });
    await expect(p2).resolves.toEqual({ txid: "0xtx2", status: "confirmed", blockHeight: 2 });
  });

  it("close() drains all pending resolvers with null", async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn<() => WebSocketLike>(() => socket);
    const stream = new HiroTxStream("wss://fake.example.com/ws", noopLogger, factory);

    const p1 = stream.subscribe("0xtx1");
    const p2 = stream.subscribe("0xtx2");

    stream.close();

    await expect(p1).resolves.toBeNull();
    await expect(p2).resolves.toBeNull();
    expect(stream.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Settlement-level pooling: 20 concurrent awaitTxid calls → 1 WS opened
// ---------------------------------------------------------------------------

describe("HiroTxStream burst test (settlement-level pooling)", () => {
  it("20 concurrent subscribers on same stream instance open exactly 1 WebSocket", async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn<() => WebSocketLike>(() => socket);
    const stream = new HiroTxStream("wss://fake.example.com/ws", noopLogger, factory);

    // Simulate 20 concurrent /settle calls, each subscribing to a unique txid.
    const count = 20;
    const txids = Array.from({ length: count }, (_, i) => `0xtx${String(i).padStart(3, "0")}`);
    const promises = txids.map((txid) => stream.subscribe(txid));

    // Core assertion: only ONE WebSocket was opened regardless of concurrent count.
    expect(factory).toHaveBeenCalledTimes(1);

    // Open the socket and resolve all subscribers via close.
    socket.emit("open");
    socket.emit("close", { code: 1000, reason: "done" });

    const results = await Promise.all(promises);
    // All should be null (stream closed before terminal updates).
    expect(results.every((r) => r === null)).toBe(true);
  });
});
