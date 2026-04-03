/**
 * Payment status tracking for queue-based transaction processing.
 *
 * Stores payment records in RELAY_KV with 24h TTL, keyed by paymentId.
 * Relay internals may use the transient submitted state, but caller-facing
 * polling always projects submitted to queued.
 */

import type {
  NotFoundTerminalReason,
  ReplacedTerminalReason,
  TerminalReason,
  TrackedPaymentState,
} from "@aibtc/tx-schemas/core";
import type { SettleOptions } from "../types";
import { buildExplorerUrl, stripHexPrefix } from "../utils";

// KV key prefix and TTL
const PAYMENT_KEY_PREFIX = "payment:";
const PAYMENT_ARTIFACT_KEY_PREFIX = "payment_artifact:";
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
 * - replaced: sponsor replaced the transaction via RBF or head-bump; agent should resubmit
 */
export type PaymentStatus =
  | "submitted"
  | "queued"
  | "broadcasting"
  | "mempool"
  | "confirmed"
  | "failed"
  | "replaced";

export type PublicPaymentStatus = Exclude<TrackedPaymentState, "submitted">;
export type ReusablePaymentStatus = Extract<
  PublicPaymentStatus,
  "queued" | "broadcasting" | "mempool"
>;

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
  /** Canonical terminal reason for terminal outcomes */
  terminalReason?: TerminalReason;
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
  /** ISO timestamp when replaced (RBF or head-bump) */
  replacedAt?: string;
  /** Reason the transaction was replaced: "rbf" | "head_bump" */
  replacedReason?: string;
  /** Txid of the replacement transaction that took this nonce slot */
  replacementTxid?: string;
  /** Whether the agent can safely resubmit its original transaction */
  resubmittable?: boolean;
  /** Sender nonce health at submission time */
  senderNonceInfo?: SenderNonceInfo;
  /** Network (mainnet or testnet) */
  network: "mainnet" | "testnet";
  /** Number of queue processing attempts */
  attempts?: number;
}

export interface PublicPaymentRecord
  extends Omit<PaymentRecord, "status" | "terminalReason"> {
  status: PublicPaymentStatus;
  terminalReason?: TerminalReason;
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

function paymentArtifactKey(txArtifactHash: string): string {
  return `${PAYMENT_ARTIFACT_KEY_PREFIX}${txArtifactHash}`;
}

export function isTerminalPaymentStatus(
  status: PaymentStatus | PublicPaymentStatus
): status is "confirmed" | "failed" | "replaced" | "not_found" {
  return (
    status === "confirmed" ||
    status === "failed" ||
    status === "replaced" ||
    status === "not_found"
  );
}

export function projectCallerFacingPaymentStatus(
  status: PaymentStatus
): PublicPaymentStatus {
  return status === "submitted" ? "queued" : status;
}

export function projectReusablePaymentStatus(
  status: PaymentStatus
): ReusablePaymentStatus {
  const projected = projectCallerFacingPaymentStatus(status);

  switch (projected) {
    case "queued":
    case "broadcasting":
    case "mempool":
      return projected;
    default:
      throw new Error(`Payment status ${projected} is not reusable`);
  }
}

export function inferReplacementTerminalReason(
  replacedReason?: string
): ReplacedTerminalReason {
  switch (replacedReason) {
    case "rbf":
    case "head_bump":
      return "nonce_replacement";
    default:
      return "superseded";
  }
}

export function projectPaymentRecord(record: PaymentRecord): PublicPaymentRecord {
  const projectedStatus = projectCallerFacingPaymentStatus(record.status);
  const { terminalReason, ...rest } = record;
  return {
    ...rest,
    status: projectedStatus,
    ...(isTerminalPaymentStatus(projectedStatus) && terminalReason
      ? { terminalReason }
      : {}),
  };
}

export function buildNotFoundPaymentRecord(
  paymentId: string,
  detail?: string,
  terminalReason: NotFoundTerminalReason = "unknown_payment_identity"
): {
  paymentId: string;
  status: "not_found";
  terminalReason: NotFoundTerminalReason;
  error: string;
  retryable: false;
} {
  return {
    paymentId,
    status: "not_found",
    terminalReason,
    error: detail ?? `Payment ${paymentId} not found or expired`,
    retryable: false,
  };
}

export async function computePaymentArtifactHash(txHex: string): Promise<string> {
  const normalizedHex = stripHexPrefix(txHex).toLowerCase();
  const data = new TextEncoder().encode(normalizedHex);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
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

export async function getPaymentIdByArtifact(
  kv: KVNamespace,
  txArtifactHash: string
): Promise<string | null> {
  return kv.get(paymentArtifactKey(txArtifactHash), "text");
}

export async function putPaymentArtifact(
  kv: KVNamespace,
  txArtifactHash: string,
  paymentId: string
): Promise<void> {
  await kv.put(paymentArtifactKey(txArtifactHash), paymentId, {
    expirationTtl: PAYMENT_TTL_SECONDS,
  });
}

export async function getReusablePaymentRecord(
  kv: KVNamespace,
  txArtifactHash: string
): Promise<PaymentRecord | null> {
  const paymentId = await getPaymentIdByArtifact(kv, txArtifactHash);
  if (!paymentId) {
    return null;
  }

  const record = await getPaymentRecord(kv, paymentId);
  if (!record) {
    await kv.delete(paymentArtifactKey(txArtifactHash)).catch(() => {});
    return null;
  }

  if (isTerminalPaymentStatus(record.status)) {
    await kv.delete(paymentArtifactKey(txArtifactHash)).catch(() => {});
    return null;
  }

  return record;
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
    case "replaced":
      updated.replacedAt = now;
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
