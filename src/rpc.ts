/**
 * RPC Entrypoint for Service Bindings
 *
 * Provides type-safe RPC methods for same-account workers (landing-page, agent-news).
 * No auth required — service binding = trusted caller.
 *
 * Two public methods:
 * - submitPayment(txHex, settle) — validate tx, check sender nonce, enqueue, return paymentId
 * - checkPayment(paymentId)      — return current payment status from KV
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  deserializeTransaction,
  AuthType,
  AddressHashMode,
  addressHashModeToVersion,
  addressFromVersionHash,
  addressToString,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import type { Env, SettleOptions } from "./types";
import { stripHexPrefix } from "./utils";
import {
  generatePaymentId,
  createPaymentRecord,
  transitionPayment,
  putPaymentRecord,
  getPaymentRecord,
  type PaymentRecord,
  type PaymentQueueMessage,
  type SenderNonceInfo,
} from "./services/payment-status";
import {
  checkSenderNonce,
  seedSenderNonceFromHiro,
  hiroNonceUrl,
} from "./services/sender-nonce";

/**
 * Result returned by submitPayment.
 */
export interface SubmitPaymentResult {
  /** Whether the submission was accepted */
  accepted: boolean;
  /** Unique payment identifier (pay_ prefix) */
  paymentId?: string;
  /** Current status */
  status?: string;
  /** Sender nonce health info */
  senderNonce?: SenderNonceInfo;
  /** Warning for nonce gaps (accepted but flagged) */
  warning?: {
    code: string;
    detail: string;
    senderNonce: { provided: number; expected: number; lastSeen: number };
    help: string;
    action: string;
  };
  /** Error (only when accepted=false) */
  error?: string;
  /** Error code (only when accepted=false) */
  code?: string;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** Help URL for the agent */
  help?: string;
  /** Action the agent should take */
  action?: string;
  /** Status check URL */
  checkStatusUrl?: string;
}

/**
 * Result returned by checkPayment.
 */
export interface CheckPaymentResult {
  paymentId: string;
  status: string;
  txid?: string;
  blockHeight?: number;
  confirmedAt?: string;
  explorerUrl?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  senderNonceInfo?: SenderNonceInfo;
}

/**
 * RelayRPC WorkerEntrypoint — service binding interface for internal workers.
 *
 * Usage in consuming workers:
 * ```ts
 * // wrangler.jsonc: "services": [{ "binding": "X402_RELAY", "service": "x402-sponsor-relay", "entrypoint": "RelayRPC" }]
 * const result = await env.X402_RELAY.submitPayment(txHex, settle);
 * const status = await env.X402_RELAY.checkPayment(result.paymentId);
 * ```
 */
export class RelayRPC extends WorkerEntrypoint<Env> {
  /**
   * Submit a payment for queue-based processing.
   *
   * 1. Deserializes and validates the transaction
   * 2. Checks sender nonce health against KV cache
   * 3. Generates paymentId and writes initial status to KV
   * 4. Enqueues to PAYMENT_QUEUE
   * 5. Returns immediately with paymentId + sender nonce info
   */
  async submitPayment(
    txHex: string,
    settle?: SettleOptions
  ): Promise<SubmitPaymentResult> {
    const network = this.env.STACKS_NETWORK;
    const kv = this.env.RELAY_KV;

    // Validate KV is available
    if (!kv) {
      return {
        accepted: false,
        error: "Relay storage not configured",
        code: "INTERNAL_ERROR",
        retryable: true,
      };
    }

    // Deserialize and validate the transaction
    let cleanHex: string;
    try {
      cleanHex = stripHexPrefix(txHex);
    } catch {
      return {
        accepted: false,
        error: "Invalid transaction hex",
        code: "INVALID_TRANSACTION",
        retryable: false,
      };
    }

    let transaction;
    try {
      transaction = deserializeTransaction(cleanHex);
    } catch {
      return {
        accepted: false,
        error: "Could not deserialize transaction",
        code: "INVALID_TRANSACTION",
        retryable: false,
      };
    }

    // Must be a sponsored transaction
    if (transaction.auth.authType !== AuthType.Sponsored) {
      return {
        accepted: false,
        error: "Transaction must be sponsored (build with sponsored: true)",
        code: "NOT_SPONSORED",
        retryable: false,
      };
    }

    // Extract sender info from spending condition
    const { hashMode, signer, nonce } = transaction.auth.spendingCondition;
    const senderNonce = Number(nonce);
    const signerHash = signer; // 40-char hex hash160

    // Derive human-readable sender address
    const stacksNetwork =
      network === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
    const version = addressHashModeToVersion(
      hashMode as AddressHashMode,
      stacksNetwork
    );
    const senderAddress = addressToString(
      addressFromVersionHash(version, signerHash)
    );

    // Check sender nonce against cache
    let nonceCheck = await checkSenderNonce(
      kv,
      signerHash,
      senderNonce,
      senderAddress
    );

    // Cold cache — seed from Hiro and re-check
    if (nonceCheck.outcome === "unknown") {
      await seedSenderNonceFromHiro(
        kv,
        signerHash,
        senderAddress,
        network,
        this.env.HIRO_API_KEY
      );
      nonceCheck = await checkSenderNonce(
        kv,
        signerHash,
        senderNonce,
        senderAddress
      );
    }

    // Stale nonce — reject immediately, no sponsor slot wasted
    if (nonceCheck.outcome === "stale") {
      return {
        accepted: false,
        error: `Your transaction uses nonce ${nonceCheck.provided}, which is already confirmed on-chain. Re-sign with the current nonce.`,
        code: "SENDER_NONCE_STALE",
        retryable: true,
        help: nonceCheck.help,
        action: nonceCheck.action,
        senderNonce: {
          provided: nonceCheck.provided,
          expected: nonceCheck.currentNonce,
          healthy: false,
        },
      };
    }

    // Build sender nonce info for the response
    let senderNonceInfo: SenderNonceInfo;
    let warning: SubmitPaymentResult["warning"];

    if (nonceCheck.outcome === "gap") {
      senderNonceInfo = {
        provided: nonceCheck.provided,
        expected: nonceCheck.expected,
        healthy: false,
        warning: `Nonce gap detected: sent ${nonceCheck.provided}, expected ${nonceCheck.expected}`,
      };
      warning = {
        code: "SENDER_NONCE_GAP",
        detail: `Your account has a nonce gap. You sent nonce ${nonceCheck.provided} but nonce ${nonceCheck.expected} hasn't been seen yet. Your payment will sit in the mempool until the gap is filled or expires (~42 hours).`,
        senderNonce: {
          provided: nonceCheck.provided,
          expected: nonceCheck.expected,
          lastSeen: nonceCheck.lastSeen,
        },
        help: nonceCheck.help,
        action: nonceCheck.action,
      };
    } else if (
      nonceCheck.outcome === "healthy" ||
      nonceCheck.outcome === "duplicate"
    ) {
      senderNonceInfo = {
        provided: nonceCheck.provided,
        expected:
          nonceCheck.outcome === "healthy"
            ? nonceCheck.expected
            : nonceCheck.provided,
        healthy: true,
      };
    } else {
      // unknown — first contact, no cache data
      senderNonceInfo = {
        provided: senderNonce,
        expected: senderNonce,
        healthy: true,
      };
    }

    // Generate paymentId and write initial status
    const paymentId = generatePaymentId();
    let record = createPaymentRecord(paymentId, network, senderNonceInfo);
    record.senderAddress = senderAddress;
    record.senderNonce = senderNonce;

    // Transition to queued
    record = transitionPayment(record, "queued");
    await putPaymentRecord(kv, record);

    // Enqueue to PAYMENT_QUEUE
    const queue = this.env.PAYMENT_QUEUE;
    if (!queue) {
      // Queue not configured — mark as failed
      record = transitionPayment(record, "failed", {
        error: "Payment queue not configured",
        errorCode: "INTERNAL_ERROR",
      });
      await putPaymentRecord(kv, record);
      return {
        accepted: false,
        error: "Payment queue not available",
        code: "INTERNAL_ERROR",
        retryable: true,
      };
    }

    const message: PaymentQueueMessage = {
      paymentId,
      txHex: cleanHex,
      settle: settle
        ? {
            expectedRecipient: settle.expectedRecipient,
            minAmount: settle.minAmount,
            tokenType: settle.tokenType,
            expectedSender: settle.expectedSender,
            resource: settle.resource,
            method: settle.method,
            maxTimeoutSeconds: settle.maxTimeoutSeconds,
          }
        : undefined,
      network,
      attempt: 1,
    };

    await queue.send(message);

    // Build the status check URL
    const baseUrl =
      network === "mainnet"
        ? "https://x402-relay.aibtc.com"
        : "https://x402-relay.aibtc.dev";
    const checkStatusUrl = `${baseUrl}/payment/${paymentId}`;

    return {
      accepted: true,
      paymentId,
      status: warning ? "queued_with_warning" : "queued",
      senderNonce: senderNonceInfo,
      warning,
      checkStatusUrl,
    };
  }

  /**
   * Check the status of a previously submitted payment.
   */
  async checkPayment(paymentId: string): Promise<CheckPaymentResult> {
    const kv = this.env.RELAY_KV;
    if (!kv) {
      return {
        paymentId,
        status: "unknown",
        error: "Storage not configured",
      };
    }

    const record = await getPaymentRecord(kv, paymentId);
    if (!record) {
      return {
        paymentId,
        status: "not_found",
        error: `Payment ${paymentId} not found or expired`,
      };
    }

    return {
      paymentId: record.paymentId,
      status: record.status,
      txid: record.txid,
      blockHeight: record.blockHeight,
      confirmedAt: record.confirmedAt,
      explorerUrl: record.explorerUrl,
      error: record.error,
      errorCode: record.errorCode,
      retryable: record.retryable,
      senderNonceInfo: record.senderNonceInfo,
    };
  }
}
