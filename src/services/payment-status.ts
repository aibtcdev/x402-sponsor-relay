/**
 * Payment status tracking for queue-based transaction processing.
 *
 * Stores payment records in RELAY_KV with 24h TTL, keyed by paymentId.
 * Status flows: submitted → queued → broadcasting → mempool → confirmed | failed
 */

import type { SettleOptions } from "../types";
import { buildExplorerUrl } from "../utils";

// KV key prefix and TTL
const PAYMENT_KEY_PREFIX = "payment:";
const PAYMENT_TTL_SECONDS = 86_400; // 24 hours

/**
 * Payment lifecycle statuses.
 *
 * - submitted: RPC received the request, pre-validation passed
 * - queued: message enqueued to PAYMENT_QUEUE
 * - broadcasting: queue consumer is sponsoring and broadcasting
 * - mempool: broadcast succeeded, tx is in the mempool
 * - confirmed: tx confirmed on-chain (set by chainhook or polling)
 * - failed: terminal failure (abort_*, invalid tx, etc.)
 */
export type PaymentStatus =
  | "submitted"
  | "queued"
  | "broadcasting"
  | "mempool"
  | "confirmed"
  | "failed";

/**
 * Sender nonce health info returned alongside payment status.
 */
export interface SenderNonceInfo {
  /** The nonce the sender's transaction used */
  provided: number;
  /** The expected next nonce based on cache */
  expected: number;
  /** Whether the nonce is healthy (matches expected) */
  healthy: boolean;
  /** Warning message if nonce has a gap */
  warning?: string;
}

/**
 * A payment record stored in KV.
 */
export interface PaymentRecord {
  /** Unique payment identifier (pay_ prefix) */
  paymentId: string;
  /** Current status */
  status: PaymentStatus;
  /** On-chain transaction ID (set after broadcast) */
  txid?: string;
  /** Sender's Stacks address (from the signed transaction) */
  senderAddress?: string;
  /** Sender's nonce from the transaction */
  senderNonce?: number;
  /** Sponsor wallet index used */
  sponsorWalletIndex?: number;
  /** Sponsor nonce assigned */
  sponsorNonce?: number;
  /** Sponsor fee in microSTX */
  sponsorFee?: string;
  /** Block height (set on confirmation) */
  blockHeight?: number;
  /** Explorer URL (set after broadcast) */
  explorerUrl?: string;
  /** Error message (set on failure) */
  error?: string;
  /** Machine-readable error code (set on failure) */
  errorCode?: string;
  /** Whether the failure is retryable */
  retryable?: boolean;
  /** ISO timestamp when submitted */
  submittedAt: string;
  /** ISO timestamp when queued */
  queuedAt?: string;
  /** ISO timestamp when broadcasting started */
  broadcastingAt?: string;
  /** ISO timestamp when entered mempool */
  mempoolAt?: string;
  /** ISO timestamp when confirmed */
  confirmedAt?: string;
  /** ISO timestamp when failed */
  failedAt?: string;
  /** Sender nonce health at submission time */
  senderNonceInfo?: SenderNonceInfo;
  /** Network (mainnet or testnet) */
  network: "mainnet" | "testnet";
  /** Number of queue processing attempts */
  attempts?: number;
}

/**
 * Queue message body for PAYMENT_QUEUE.
 */
export interface PaymentQueueMessage {
  paymentId: string;
  /** Hex-encoded signed sponsored transaction */
  txHex: string;
  /** Settlement options (optional, for /relay path) */
  settle?: SettleOptions;
  /** Network at time of submission */
  network: "mainnet" | "testnet";
  /** Attempt counter (incremented on retry) */
  attempt: number;
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

function paymentKey(paymentId: string): string {
  return `${PAYMENT_KEY_PREFIX}${paymentId}`;
}

/**
 * Read a payment record from KV. Returns null if not found or expired.
 */
export async function getPaymentRecord(
  kv: KVNamespace,
  paymentId: string
): Promise<PaymentRecord | null> {
  const raw = await kv.get(paymentKey(paymentId), "text");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PaymentRecord;
  } catch {
    return null;
  }
}

/**
 * Write a payment record to KV with 24h TTL.
 */
export async function putPaymentRecord(
  kv: KVNamespace,
  record: PaymentRecord
): Promise<void> {
  await kv.put(paymentKey(record.paymentId), JSON.stringify(record), {
    expirationTtl: PAYMENT_TTL_SECONDS,
  });
}

/**
 * Create the initial payment record in "submitted" status.
 */
export function createPaymentRecord(
  paymentId: string,
  network: "mainnet" | "testnet",
  senderNonceInfo?: SenderNonceInfo
): PaymentRecord {
  return {
    paymentId,
    status: "submitted",
    submittedAt: new Date().toISOString(),
    network,
    senderNonceInfo,
  };
}

/**
 * Transition a payment record to a new status with timestamp.
 * Returns a shallow copy — does NOT write to KV (caller must putPaymentRecord).
 */
export function transitionPayment(
  record: PaymentRecord,
  status: PaymentStatus,
  extra?: Partial<PaymentRecord>
): PaymentRecord {
  const now = new Date().toISOString();
  const updated: PaymentRecord = { ...record, status };

  switch (status) {
    case "queued":
      updated.queuedAt = now;
      break;
    case "broadcasting":
      updated.broadcastingAt = now;
      updated.attempts = (record.attempts ?? 0) + 1;
      break;
    case "mempool":
      updated.mempoolAt = now;
      break;
    case "confirmed":
      updated.confirmedAt = now;
      break;
    case "failed":
      updated.failedAt = now;
      break;
  }

  if (extra) {
    Object.assign(updated, extra);
  }

  // Build explorer URL when txid is first set
  if (updated.txid && !updated.explorerUrl) {
    updated.explorerUrl = buildExplorerUrl(updated.txid, updated.network);
  }

  return updated;
}

/**
 * Generate a payment ID with pay_ prefix.
 * Uses crypto.randomUUID() which is available in Cloudflare Workers.
 */
export function generatePaymentId(): string {
  return `pay_${crypto.randomUUID().replace(/-/g, "")}`;
}
