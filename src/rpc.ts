/**
 * RPC Entrypoint for Service Bindings
 *
 * Provides type-safe RPC methods for same-account workers (landing-page, agent-news).
 * No auth required — service binding = trusted caller.
 *
 * Public methods:
 * - submitPayment(txHex, settle) — validate tx, check sender nonce, enqueue, return paymentId
 * - checkPayment(paymentId)      — return current payment status from KV
 * - getSponsorStatus()           — return the cached relay-owned sponsor status snapshot
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
import type {
  RpcCheckPaymentResult as CheckPaymentResult,
  RpcSubmitPaymentResult as SubmitPaymentResult,
} from "@aibtc/tx-schemas/rpc";
import { RPC_ERROR_CODES } from "@aibtc/tx-schemas/rpc";
import { PaymentIdService } from "./services/payment-identifier";
import type { Env, SettleOptions, SponsorStatusResult } from "./types";
import {
  buildPaymentCheckStatusUrl,
  createWorkerLogger,
  emitPaymentLifecycleEvent,
  emitProjectedPaymentPollEvents,
  stripHexPrefix,
} from "./utils";
import {
  buildNotFoundPaymentRecord,
  computePaymentArtifactHash,
  generatePaymentId,
  createPaymentRecord,
  getPaymentRecord,
  getReusablePaymentRecord,
  projectPaymentRecord,
  projectReusablePaymentStatus,
  type PaymentQueueMessage,
  type SenderNonceInfo,
  putPaymentArtifact,
  putPaymentRecord,
  selfHealMempoolRecord,
  transitionPayment,
} from "./services/payment-status";
import {
  checkSenderNonce,
  clearInFlight,
  markInFlight,
  seedSenderNonceFromHiro,
} from "./services/sender-nonce";
import { repairSenderWedgeDO } from "./services";

export type { SubmitPaymentResult, CheckPaymentResult };

type RelayCheckPaymentResult = CheckPaymentResult & {
  relayState?: "held" | "queued" | "broadcasting" | "mempool";
  holdReason?: "gap" | "capacity";
  nextExpectedNonce?: number;
  missingNonces?: number[];
  holdExpiresAt?: string;
  senderWedge?: import("./types").SenderWedgeStatus;
};

type PublicRpcErrorCode = (typeof RPC_ERROR_CODES)[number];

function projectRpcErrorCode(errorCode?: string): PublicRpcErrorCode | undefined {
  if (!errorCode) {
    return undefined;
  }

  return (RPC_ERROR_CODES as readonly string[]).includes(errorCode)
    ? (errorCode as PublicRpcErrorCode)
    : undefined;
}

/**
 * RelayRPC WorkerEntrypoint — service binding interface for internal workers.
 *
 * Usage in consuming workers:
 * ```ts
 * // wrangler.jsonc: "services": [{ "binding": "X402_RELAY", "service": "x402-sponsor-relay", "entrypoint": "RelayRPC" }]
 * const result = await env.X402_RELAY.submitPayment(txHex, settle);
 * const status = await env.X402_RELAY.checkPayment(result.paymentId);
 * const sponsorStatus = await env.X402_RELAY.getSponsorStatus();
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
    settle?: SettleOptions,
    paymentIdentifier?: string
  ): Promise<SubmitPaymentResult> {
    const logger = createWorkerLogger(this.env.LOGS, this.ctx, {
      component: "rpc",
      route: "rpc.submitPayment",
    });
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

    // Validate and deserialize the transaction
    const cleanHex = stripHexPrefix(txHex);
    if (!/^[0-9a-fA-F]+$/.test(cleanHex)) {
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

    const txArtifactHash = await computePaymentArtifactHash(cleanHex);

    // Payment-identifier cache check — lookup before nonce check so a retry with
    // the same id + same payload does not re-enter the nonce validation path.
    const paymentIdService = new PaymentIdService(kv, logger);
    let payloadHash: string | undefined;
    if (paymentIdentifier) {
      payloadHash = await paymentIdService.computePayloadHash(cleanHex, settle ?? null);
      const cacheResult = await paymentIdService.checkPaymentId(paymentIdentifier, payloadHash, "rpc");
      if (cacheResult.status === "hit") {
        logger.info("payment-identifier cache hit, returning cached RPC response", {
          id: paymentIdentifier,
        });
        return cacheResult.response as SubmitPaymentResult;
      }
      if (cacheResult.status === "conflict") {
        logger.warn("payment-identifier conflict on RPC submitPayment", { id: paymentIdentifier });
        return {
          accepted: false,
          error: "Payment identifier already used with a different transaction",
          code: "PAYMENT_IDENTIFIER_CONFLICT",
          retryable: false,
        };
      }
    }

    const existingRecord = await getReusablePaymentRecord(kv, txArtifactHash);
    if (existingRecord) {
      const reusedStatus = projectReusablePaymentStatus(existingRecord.status);
      const projected = projectPaymentRecord(existingRecord);
      const checkStatusUrl = buildPaymentCheckStatusUrl(this.env, projected.paymentId);

      emitPaymentLifecycleEvent(logger, "payment.accepted", {
        route: "rpc.submitPayment",
        paymentId: projected.paymentId,
        status: projected.status,
        terminalReason: projected.terminalReason,
        action: "reuse_active_payment",
        checkStatusUrlPresent: true,
        compatShimUsed: false,
      });

      return {
        accepted: true,
        paymentId: projected.paymentId,
        status: reusedStatus,
        senderNonce: projected.senderNonceInfo,
        checkStatusUrl,
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
      senderAddress,
      network
    );
    let seededSenderNonce = false;

    // Cold cache — seed from Hiro and re-check
    if (nonceCheck.outcome === "unknown") {
      await seedSenderNonceFromHiro(
        kv,
        signerHash,
        senderAddress,
        network,
        this.env.HIRO_API_KEY
      );
      seededSenderNonce = true;
      nonceCheck = await checkSenderNonce(
        kv,
        signerHash,
        senderNonce,
        senderAddress,
        network
      );
    }

    // Stale-low frontier — refresh from Hiro once before treating this as a real gap.
    // This mirrors the cold-cache path for senders who advanced outside the relay.
    if (nonceCheck.outcome === "gap" && !seededSenderNonce) {
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
        senderAddress,
        network
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

    // Duplicate nonce — reject to avoid wasting a sponsor slot
    if (nonceCheck.outcome === "duplicate") {
      return {
        accepted: false,
        error: `Your transaction uses nonce ${nonceCheck.provided}, which is already in-flight (last seen: ${nonceCheck.lastSeen}). Wait for the previous transaction to confirm or expire before resubmitting.`,
        code: "SENDER_NONCE_DUPLICATE",
        retryable: false,
        senderNonce: {
          provided: nonceCheck.provided,
          expected: nonceCheck.lastSeen + 1,
          healthy: false,
        },
      };
    }

    // Build sender nonce info for the response
    let senderNonceInfo: SenderNonceInfo;
    let warning: Extract<SubmitPaymentResult, { accepted: true }>["warning"];

    if (nonceCheck.outcome === "gap") {
      senderNonceInfo = {
        provided: nonceCheck.provided,
        expected: nonceCheck.expected,
        healthy: false,
        warning: `Nonce gap detected: sent ${nonceCheck.provided}, expected ${nonceCheck.expected}`,
      };
      warning = {
        code: "SENDER_NONCE_GAP",
        detail: `Your account has a nonce gap. You sent nonce ${nonceCheck.provided} but nonce ${nonceCheck.expected} hasn't been seen yet. Verify your account nonce via the Stacks API and submit the missing nonce to unblock dispatch.`,
        senderNonce: {
          provided: nonceCheck.provided,
          expected: nonceCheck.expected,
          lastSeen: nonceCheck.lastSeen,
        },
        help: nonceCheck.help,
        action: nonceCheck.action,
      };
    } else if (nonceCheck.outcome === "healthy") {
      senderNonceInfo = {
        provided: nonceCheck.provided,
        expected: nonceCheck.expected,
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

    // Write in-flight marker before enqueuing so concurrent requests for the
    // same sender/nonce are rejected by checkSenderNonce() (#234).
    // TTL of 5 minutes is self-healing if the consumer crashes.
    await markInFlight(kv, signerHash, senderNonce);

    // Generate paymentId and write initial status
    const paymentId = generatePaymentId();
    let record = createPaymentRecord(paymentId, network, senderNonceInfo);
    record.senderAddress = senderAddress;
    record.senderNonce = senderNonce;

    // Transition to queued
    record = transitionPayment(record, "queued");
    await putPaymentRecord(kv, record);
    await putPaymentArtifact(kv, txArtifactHash, paymentId);

    // Enqueue to PAYMENT_QUEUE
    const queue = this.env.PAYMENT_QUEUE;
    if (!queue) {
      // Queue not configured — clear in-flight marker so the sender can retry immediately
      await clearInFlight(kv, signerHash, senderNonce).catch(() => {});
      record = transitionPayment(record, "failed", {
        error: "Payment queue not configured",
        errorCode: "INTERNAL_ERROR",
        terminalReason: "queue_unavailable",
        retryable: true,
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
      settle,
      network,
      attempt: 1,
    };

    try {
      await queue.send(message);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to enqueue payment";

      // Enqueue failed — clear in-flight marker so the sender can retry immediately
      await clearInFlight(kv, signerHash, senderNonce).catch(() => {});

      // Queue send failed — mark payment as failed so status reflects reality
      record = transitionPayment(record, "failed", {
        error: `Payment queue send failed: ${errorMessage}`,
        errorCode: "INTERNAL_ERROR",
        terminalReason: "queue_unavailable",
        retryable: true,
      });
      await putPaymentRecord(kv, record);

      return {
        accepted: false,
        error: "Failed to enqueue payment",
        code: "INTERNAL_ERROR",
        retryable: true,
      };
    }

    const checkStatusUrl = buildPaymentCheckStatusUrl(this.env, paymentId);
    const acceptedStatus = warning ? "queued_with_warning" : "queued";

    emitPaymentLifecycleEvent(logger, "payment.accepted", {
      route: "rpc.submitPayment",
      paymentId,
      status: acceptedStatus,
      action: warning ? "accepted_with_warning" : "accepted_new_payment",
      checkStatusUrlPresent: true,
      compatShimUsed: Boolean(warning),
    });

    if (warning) {
      emitPaymentLifecycleEvent(logger, "payment.fallback_used", {
        route: "rpc.submitPayment",
        paymentId,
        status: acceptedStatus,
        action: "queued_with_warning_projection",
        checkStatusUrlPresent: true,
        compatShimUsed: true,
        warningCode: warning.code,
      }, "warn");
    }

    const acceptedResult: SubmitPaymentResult = {
      accepted: true,
      paymentId,
      status: acceptedStatus,
      senderNonce: senderNonceInfo,
      warning,
      checkStatusUrl,
    };

    if (paymentIdentifier && payloadHash) {
      this.ctx.waitUntil(
        paymentIdService.recordPaymentId(paymentIdentifier, payloadHash, acceptedResult, "rpc").catch(() => {})
      );
    }

    return acceptedResult;
  }

  /**
   * Check the status of a previously submitted payment.
   */
  async checkPayment(paymentId: string): Promise<RelayCheckPaymentResult> {
    const logger = createWorkerLogger(this.env.LOGS, this.ctx, {
      component: "rpc",
      route: "rpc.checkPayment",
      paymentId,
    });
    const kv = this.env.RELAY_KV;
    const checkStatusUrl = buildPaymentCheckStatusUrl(this.env, paymentId);
    if (!kv) {
      return {
        paymentId,
        status: "failed",
        error: "Storage not configured",
        terminalReason: "internal_error",
        retryable: true,
        checkStatusUrl,
      };
    }

    const record = await getPaymentRecord(kv, paymentId);
    if (!record) {
      const notFound = buildNotFoundPaymentRecord(paymentId);
      emitPaymentLifecycleEvent(logger, "payment.poll", {
        route: "rpc.checkPayment",
        paymentId,
        status: notFound.status,
        terminalReason: notFound.terminalReason,
        action: "return_not_found",
        checkStatusUrlPresent: true,
        compatShimUsed: false,
      });
      return {
        ...notFound,
        checkStatusUrl,
      };
    }

    let refreshedRecord = record;
    let senderWedge;
    if (
      record.status === "queued" &&
      record.relayState === "held" &&
      record.holdReason === "gap" &&
      record.senderAddress
    ) {
      senderWedge = await repairSenderWedgeDO(this.env, logger, record.senderAddress);
      refreshedRecord = (await getPaymentRecord(kv, paymentId)) ?? record;
    }

    // Self-healing: check on-chain status for payments stuck in mempool
    refreshedRecord = await selfHealMempoolRecord(
      refreshedRecord, kv, this.env, logger, "rpc.checkPayment"
    );

    const projected = projectPaymentRecord(refreshedRecord);
    const compatShimUsed = refreshedRecord.status === "submitted";

    emitProjectedPaymentPollEvents(
      logger,
      "rpc.checkPayment",
      projected,
      compatShimUsed
    );

    return {
      paymentId: projected.paymentId,
      status: projected.status,
      terminalReason: projected.terminalReason,
      txid: projected.txid,
      blockHeight: projected.blockHeight,
      confirmedAt: projected.confirmedAt,
      explorerUrl: projected.explorerUrl,
      error: projected.error,
      errorCode: projectRpcErrorCode(projected.errorCode),
      retryable: projected.retryable,
      senderNonceInfo: projected.senderNonceInfo,
      ...(projected.relayState && { relayState: projected.relayState }),
      ...(projected.holdReason && { holdReason: projected.holdReason }),
      ...(projected.nextExpectedNonce !== undefined && {
        nextExpectedNonce: projected.nextExpectedNonce,
      }),
      ...(projected.missingNonces && { missingNonces: projected.missingNonces }),
      ...(projected.holdExpiresAt && { holdExpiresAt: projected.holdExpiresAt }),
      ...(senderWedge && { senderWedge }),
      checkStatusUrl,
    };
  }

  /**
   * Return the cached relay-owned sponsor status snapshot.
   * Reads from NonceDO cached state only and never triggers live Hiro fan-out.
   */
  async getSponsorStatus(): Promise<SponsorStatusResult> {
    if (!this.env.NONCE_DO) {
      throw new Error("Nonce coordinator unavailable");
    }

    const stub = this.env.NONCE_DO.get(this.env.NONCE_DO.idFromName("sponsor"));
    const response = await stub.fetch("https://nonce-do/sponsor-status");

    if (!response.ok && response.status !== 503) {
      const body = await response.text();
      throw new Error(body || `NonceDO sponsor status failed with ${response.status}`);
    }

    return (await response.json()) as SponsorStatusResult;
  }
}
