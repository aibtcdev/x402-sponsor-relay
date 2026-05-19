import type { BroadcastAndConfirmResult, Logger } from "../types";
import { getHiroBaseUrl } from "../utils";

interface HiroTxStreamEvent {
  tx_id?: string;
  tx_status?: string;
  block_height?: number;
}

interface JsonRpcSuccessMessage {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
}

interface JsonRpcErrorMessage {
  jsonrpc?: string;
  id?: number;
  error?: unknown;
}

interface JsonRpcNotificationMessage {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
}

type JsonRpcMessage =
  | JsonRpcSuccessMessage
  | JsonRpcErrorMessage
  | JsonRpcNotificationMessage;

export interface WebSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

interface WaitForTxStreamParams {
  txid: string;
  network: "mainnet" | "testnet";
  timeoutMs: number;
  logger: Logger;
  webSocketFactory?: WebSocketFactory;
}

const JSON_RPC_VERSION = "2.0";
const SUBSCRIBE_REQUEST_ID = 1;
const WS_NORMAL_CLOSE = 1000;

/** Maximum number of in-flight txid subscriptions per HiroTxStream instance. */
const MAX_PENDING_DEFAULT = 256;

function isTxAborted(txStatus: string | undefined): boolean {
  return txStatus?.startsWith("abort_") === true;
}

function toText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return null;
}

function parseMessages(raw: string): JsonRpcMessage[] {
  const parsed = JSON.parse(raw) as JsonRpcMessage;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function getHiroTxStreamUrl(network: "mainnet" | "testnet"): string {
  const url = new URL(getHiroBaseUrl(network));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/extended/v1/ws";
  url.search = "";
  return url.toString();
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this runtime");
  }
  return new WebSocket(url);
}

type Resolver = (result: BroadcastAndConfirmResult | null) => void;

/**
 * A multiplexed Hiro WebSocket subscription manager for a single sender.
 *
 * Opens ONE WebSocket connection to Hiro and fans out tx_update notifications
 * to multiple concurrent subscribers. Each subscriber calls `subscribe(txid)`
 * and receives a Promise that resolves when the txid reaches a terminal state.
 *
 * Design principles:
 * - WS opens lazily on first subscribe() call.
 * - On WS error or close, all pending resolvers are resolved with null (fallback
 *   to REST polling).
 * - Factory rejection resolves subscribe() with null immediately.
 * - LRU eviction: oldest pending entry is resolved with null when pending exceeds
 *   maxPending (default 256). Evicted callers fall through to polling.
 * - Resolver cleanup happens atomically when a txid resolves.
 * - Do NOT share one instance across different sender addresses.
 *
 * Thread-safety: Cloudflare Workers are single-threaded, so no locking is needed.
 */
export class HiroTxStream {
  private readonly url: string;
  private readonly logger: Logger;
  private readonly wsFactory: WebSocketFactory;
  private readonly maxPending: number;

  /** Pending resolvers keyed by txid. Map insertion order = LRU oldest-first. */
  private readonly pending = new Map<string, Resolver[]>();

  /** The single underlying WebSocket, opened lazily. */
  private socket: WebSocketLike | null = null;

  /** True once the WS handshake is complete and we can send subscribe messages. */
  private ready = false;

  /**
   * Txids subscribed (subscribe message sent) but not yet resolved.
   * Kept separate from pending so we can tell whether a txid needs a fresh
   * subscribe message vs. just having a pending resolver.
   */
  private readonly subscribed = new Set<string>();

  /** Message queue for subscribe requests sent before the WS is open. */
  private readonly sendQueue: string[] = [];

  constructor(
    url: string,
    logger: Logger,
    wsFactory: WebSocketFactory = defaultWebSocketFactory,
    maxPending: number = MAX_PENDING_DEFAULT
  ) {
    this.url = url;
    this.logger = logger;
    this.wsFactory = wsFactory;
    this.maxPending = maxPending;
  }

  /**
   * Subscribe to tx_update events for `txid`. Returns a Promise that resolves
   * with the terminal BroadcastAndConfirmResult when available, or null when
   * the stream is unavailable (caller should fall back to REST polling).
   *
   * Multiple callers subscribing to the same txid receive independent promises
   * but share a single Hiro subscription over the one WS connection.
   */
  subscribe(txid: string): Promise<BroadcastAndConfirmResult | null> {
    // Evict oldest pending entry if at capacity (LRU).
    if (!this.pending.has(txid) && this.pending.size >= this.maxPending) {
      const iter = this.pending.entries().next();
      if (!iter.done) {
        const [oldestTxid, oldestResolvers] = iter.value;
        this.pending.delete(oldestTxid);
        this.subscribed.delete(oldestTxid);
        this.logger.warn("HiroTxStream LRU eviction; falling back to polling", {
          evictedTxid: oldestTxid,
          pendingCount: this.pending.size,
        });
        for (const r of oldestResolvers) r(null);
      }
    }

    // If already pending for this txid, add another resolver (move to MRU end).
    if (this.pending.has(txid)) {
      const resolvers = this.pending.get(txid)!;
      // Re-insert to move to end (MRU).
      this.pending.delete(txid);
      this.pending.set(txid, resolvers);
      return new Promise<BroadcastAndConfirmResult | null>((resolve) => {
        resolvers.push(resolve);
      });
    }

    // New txid — create resolver list and ensure socket is open.
    const resolvers: Resolver[] = [];
    this.pending.set(txid, resolvers);

    // Ensure socket is open.
    if (!this.socket) {
      this.openSocket();
    } else if (this.ready) {
      // Socket already open; subscribe immediately.
      this.sendSubscribe(txid);
      this.subscribed.add(txid);
    }
    // If socket is open but not ready yet, sendQueue will deliver the subscribe
    // once the open event fires (handled in openSocket → handleOpen).

    return new Promise<BroadcastAndConfirmResult | null>((resolve) => {
      resolvers.push(resolve);
    });
  }

  /**
   * Explicitly close the WebSocket. All pending resolvers are resolved with null.
   * Call on DO hibernation or when the stream will no longer be used.
   */
  close(): void {
    this.drainPending(null);
    if (this.socket) {
      try {
        this.socket.close(WS_NORMAL_CLOSE, "explicit_close");
      } catch {
        // Ignore close errors.
      }
      this.socket = null;
    }
    this.ready = false;
    this.sendQueue.length = 0;
  }

  /** Number of txids currently awaiting resolution. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ---------------------------------------------------------------------------
  // Private implementation
  // ---------------------------------------------------------------------------

  private openSocket(): void {
    let socket: WebSocketLike;
    try {
      socket = this.wsFactory(this.url);
    } catch (error) {
      this.logger.warn("HiroTxStream: failed to open WebSocket; all pending will fall back", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.drainPending(null);
      return;
    }

    this.socket = socket;

    const handleOpen = () => {
      this.ready = true;
      // Subscribe to all txids that were queued before open.
      for (const txid of this.pending.keys()) {
        if (!this.subscribed.has(txid)) {
          this.sendSubscribe(txid);
          this.subscribed.add(txid);
        }
      }
      // Flush any subscribe messages queued before open.
      for (const msg of this.sendQueue) {
        try {
          socket.send(msg);
        } catch {
          // Ignore — socket might have closed already.
        }
      }
      this.sendQueue.length = 0;
    };

    const handleMessage = (event: unknown) => {
      try {
        const raw = toText((event as { data?: unknown })?.data);
        if (!raw) return;

        const messages = parseMessages(raw);
        for (const message of messages) {
          // Subscription acknowledgement — skip.
          if ("id" in message && "result" in message) {
            continue;
          }

          // Subscription error — drain all and fall back.
          if ("id" in message && "error" in message && message.error) {
            this.logger.warn("HiroTxStream: subscription rejected; draining pending", {
              error: JSON.stringify(message.error),
            });
            this.drainPending(null);
            this.closeSocket("subscribe_rejected");
            return;
          }

          // tx_update notification.
          if ("method" in message && message.method === "tx_update") {
            const txEvent = message.params as HiroTxStreamEvent | undefined;
            if (!txEvent?.tx_id) continue;

            const txid = txEvent.tx_id;
            const txStatus = txEvent.tx_status;

            if (txStatus === "success") {
              if (typeof txEvent.block_height === "number") {
                this.logger.info("HiroTxStream: tx confirmed", {
                  txid,
                  blockHeight: txEvent.block_height,
                });
                this.resolveOne(txid, {
                  txid,
                  status: "confirmed",
                  blockHeight: txEvent.block_height,
                });
              }
              // success without block_height — wait for follow-up.
              continue;
            }

            if (isTxAborted(txStatus)) {
              this.logger.warn("HiroTxStream: tx aborted on-chain", {
                txid,
                txStatus,
              });
              this.resolveOne(txid, {
                error: "Transaction failed on-chain",
                details: `tx_status: ${txStatus}`,
                retryable: false,
              });
              continue;
            }

            // Non-terminal update — keep waiting.
            this.logger.debug("HiroTxStream: non-terminal update", {
              txid,
              txStatus: txStatus ?? "unknown",
            });
          }
        }
      } catch (error) {
        this.logger.warn("HiroTxStream: parse error; draining pending", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.drainPending(null);
        this.closeSocket("parse_error");
      }
    };

    const handleError = (event: unknown) => {
      const err = event as { message?: string; type?: string; code?: number };
      this.logger.warn("HiroTxStream: WebSocket error; draining pending", {
        type: err?.type ?? null,
        code: err?.code ?? null,
        message: err?.message ?? "(no enumerable properties)",
      });
      this.drainPending(null);
      this.socket = null;
      this.ready = false;
    };

    const handleClose = (event: unknown) => {
      const closeEvent = event as { code?: number; reason?: string };
      if (this.pending.size > 0) {
        this.logger.warn("HiroTxStream: WebSocket closed with pending subscribers; draining", {
          code: closeEvent?.code ?? null,
          reason: closeEvent?.reason ?? null,
          pendingCount: this.pending.size,
        });
        this.drainPending(null);
      }
      this.socket = null;
      this.ready = false;
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  }

  private sendSubscribe(txid: string): void {
    const msg = JSON.stringify({
      jsonrpc: JSON_RPC_VERSION,
      id: SUBSCRIBE_REQUEST_ID,
      method: "subscribe",
      params: {
        event: "tx_update",
        tx_id: txid,
      },
    });
    try {
      this.socket?.send(msg);
    } catch (error) {
      this.logger.warn("HiroTxStream: failed to send subscribe; resolver will fall back", {
        txid,
        error: error instanceof Error ? error.message : String(error),
      });
      // Resolve just this txid with null.
      this.resolveOne(txid, null);
    }
  }

  private resolveOne(txid: string, result: BroadcastAndConfirmResult | null): void {
    const resolvers = this.pending.get(txid);
    if (!resolvers) return;
    this.pending.delete(txid);
    this.subscribed.delete(txid);
    for (const r of resolvers) r(result);
  }

  private drainPending(result: BroadcastAndConfirmResult | null): void {
    for (const [, resolvers] of this.pending) {
      for (const r of resolvers) r(result);
    }
    this.pending.clear();
    this.subscribed.clear();
  }

  private closeSocket(reason: string): void {
    if (this.socket) {
      try {
        this.socket.close(WS_NORMAL_CLOSE, reason);
      } catch {
        // Ignore.
      }
      this.socket = null;
    }
    this.ready = false;
  }
}

/**
 * One-shot WebSocket stream wait for a single txid.
 * Thin wrapper around HiroTxStream for backward compatibility with existing
 * callers that pass a per-call webSocketFactory (e.g. tests).
 */
export async function waitForHiroTxConfirmationViaStream(
  params: WaitForTxStreamParams
): Promise<BroadcastAndConfirmResult | null> {
  const { txid, network, timeoutMs, logger } = params;
  if (timeoutMs <= 0) return null;

  const createSocket = params.webSocketFactory ?? defaultWebSocketFactory;
  const url = getHiroTxStreamUrl(network);

  const stream = new HiroTxStream(url, logger, createSocket, /* maxPending */ 1);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => {
      logger.info("Hiro tx stream timed out before terminal update; falling back", {
        txid,
        timeoutMs,
      });
      stream.close();
      resolve(null);
    }, timeoutMs);
  });

  const result = await Promise.race([stream.subscribe(txid), timeoutPromise]);

  // Cancel the timeout if the subscribe promise won the race.
  if (timeoutHandle !== null) {
    clearTimeout(timeoutHandle);
  }
  // Close the stream unconditionally — for one-shot use, we're done.
  stream.close();

  return result;
}

/**
 * Build the Hiro WebSocket URL for the given network.
 * Exported for use by SettlementService when creating pooled HiroTxStream instances.
 */
export function buildHiroTxStreamUrl(network: "mainnet" | "testnet"): string {
  return getHiroTxStreamUrl(network);
}
