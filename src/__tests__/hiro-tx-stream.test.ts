import { describe, it, expect, vi } from "vitest";
import type { Logger } from "../types";
import {
  waitForHiroTxConfirmationViaStream,
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
