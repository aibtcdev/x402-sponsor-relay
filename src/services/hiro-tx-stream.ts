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
  | JsonRpcNotificationMessage
  | JsonRpcMessage[];

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

export async function waitForHiroTxConfirmationViaStream(
  params: WaitForTxStreamParams
): Promise<BroadcastAndConfirmResult | null> {
  const { txid, network, timeoutMs, logger } = params;
  if (timeoutMs <= 0) return null;

  const createSocket = params.webSocketFactory ?? defaultWebSocketFactory;
  const url = getHiroTxStreamUrl(network);

  return await new Promise<BroadcastAndConfirmResult | null>((resolve) => {
    let socket: WebSocketLike;
    let settled = false;
    let subscribeAcked = false;

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      if (socket.removeEventListener) {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("message", handleMessage);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleClose);
      }
    };

    const closeSocket = (code = WS_NORMAL_CLOSE, reason?: string) => {
      try {
        socket.close(code, reason);
      } catch {
        // Ignore close errors during fallback cleanup.
      }
    };

    const finish = (result: BroadcastAndConfirmResult | null, closeReason?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket(WS_NORMAL_CLOSE, closeReason);
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      logger.info("Hiro tx stream timed out before terminal update; falling back", {
        txid,
        timeoutMs,
      });
      finish(null, "timeout");
    }, timeoutMs);

    const handleOpen = () => {
      try {
        socket.send(JSON.stringify({
          jsonrpc: JSON_RPC_VERSION,
          id: SUBSCRIBE_REQUEST_ID,
          method: "subscribe",
          params: {
            event: "tx_update",
            tx_id: txid,
          },
        }));
      } catch (error) {
        logger.warn("Failed to subscribe to Hiro tx stream; falling back", {
          txid,
          error: error instanceof Error ? error.message : String(error),
        });
        finish(null, "subscribe_send_failed");
      }
    };

    const handleMessage = (event: unknown) => {
      try {
        const raw = toText((event as { data?: unknown })?.data);
        if (!raw) return;

        const messages = parseMessages(raw);
        for (const message of messages) {
          if ("id" in message && message.id === SUBSCRIBE_REQUEST_ID && "error" in message && message.error) {
            logger.warn("Hiro tx stream subscription rejected; falling back", {
              txid,
              error: JSON.stringify(message.error),
            });
            finish(null, "subscribe_rejected");
            return;
          }

          if ("id" in message && message.id === SUBSCRIBE_REQUEST_ID && "result" in message) {
            subscribeAcked = true;
            continue;
          }

          if ("method" in message && message.method === "tx_update") {
            const txEvent = message.params as HiroTxStreamEvent | undefined;
            if (!txEvent || txEvent.tx_id !== txid) continue;

            const txStatus = txEvent.tx_status;
            if (txStatus === "success") {
              if (typeof txEvent.block_height === "number") {
                logger.info("Transaction confirmed via Hiro tx stream", {
                  txid,
                  blockHeight: txEvent.block_height,
                });
                finish({
                  txid,
                  status: "confirmed",
                  blockHeight: txEvent.block_height,
                }, "confirmed");
                return;
              }

              logger.warn("Hiro tx stream reported success without block height; waiting for follow-up", {
                txid,
              });
              continue;
            }

            if (isTxAborted(txStatus)) {
              logger.warn("Transaction aborted on-chain via Hiro tx stream", {
                txid,
                txStatus,
              });
              finish({
                error: "Transaction failed on-chain",
                details: `tx_status: ${txStatus}`,
                retryable: false,
              }, "aborted");
              return;
            }

            logger.debug("Observed non-terminal Hiro tx stream update", {
              txid,
              txStatus: txStatus ?? "unknown",
            });
          }
        }
      } catch (error) {
        logger.warn("Failed to parse Hiro tx stream message; falling back", {
          txid,
          error: error instanceof Error ? error.message : String(error),
        });
        finish(null, "parse_error");
      }
    };

    const handleError = (event: unknown) => {
      logger.warn("Hiro tx stream errored; falling back", {
        txid,
        error: JSON.stringify(event),
      });
      finish(null, "error");
    };

    const handleClose = (event: unknown) => {
      if (settled) return;
      const closeEvent = event as { code?: number; reason?: string };
      logger.warn("Hiro tx stream closed before terminal update; falling back", {
        txid,
        code: closeEvent?.code ?? null,
        reason: closeEvent?.reason ?? null,
        subscribed: subscribeAcked,
      });
      finish(null, "closed");
    };

    try {
      socket = createSocket(url);
    } catch (error) {
      logger.warn("Failed to open Hiro tx stream socket; falling back", {
        txid,
        error: error instanceof Error ? error.message : String(error),
      });
      clearTimeout(timeoutHandle);
      resolve(null);
      return;
    }

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
}
