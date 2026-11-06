/**
 * Queue consumer for PAYMENT_QUEUE.
 *
 * Processes payment messages serially — each message:
 * 1. Reads payment record from KV
 * 2. Sponsors and broadcasts through the payment sponsor (SponsorWalletDO), which reads its
 *    sponsor nonce from the chain at broadcast time — a failed attempt leaves no nonce gap
 * 3. Updates payment status in KV
 * 4. Updates sender nonce cache
 *
 * A sender that is not ready (previous tx still pending, or an earlier nonce missing) and
 * sponsor-side contention are retried by the queue with backoff.
 */

// NOTE: This file uses dual logging intentionally.
// - emitPaymentLifecycleEvent() emits structured telemetry with standardized fields
//   (compatShimUsed, checkStatusUrlPresent, terminalReason, etc.) for dashboards and alerting.
// - logger.info/warn() calls emit human-readable operational logs for debugging.
// Both are needed: lifecycle events are machine-parseable and follow a fixed schema;
// operational logs carry ad-hoc context (txid, nonce, attempt) that doesn't fit the schema.

import { deserializeTransaction } from "@stacks/transactions";
import type { Env, Logger } from "./types";
import { createWorkerLogger, emitPaymentLifecycleEvent, getHiroBaseUrl, getHiroHeaders } from "./utils";
import {
  getPaymentRecord,
  putPaymentRecord,
  transitionPayment,
  isTerminalPaymentStatus,
  type PaymentQueueMessage,
  type PaymentRecord,
} from "./services/payment-status";
import { clearInFlight, updateSenderNonceOnBroadcast } from "./services/sender-nonce";
import { SponsorService, SettlementService } from "./services";
import type { SponsorWalletResult } from "./durable-objects/sponsor-wallet-do";

/** Max retries before dead-lettering */
const MAX_ATTEMPTS = 5;

/** Timeout for Hiro address/transactions lookup and raw-tx fetch (ms).
 *  Mirrors seedSenderNonceFromHiro's HIRO_NONCE_SEED_TIMEOUT_MS value. */
const HIRO_LOOKUP_TIMEOUT_MS = 8_000;

/** Fields set during retryable contention — cleared on next attempt */
const TRANSIENT_ERROR_FIELDS: Partial<PaymentRecord> = {
  error: undefined,
  errorCode: undefined,
  retryable: undefined,
};

/**
 * Resolve the on-chain transaction for a sender address at a specific nonce.
 *
 * Queries Hiro GET /extended/v1/address/{sender}/transactions?limit=50 and finds
 * the entry whose nonce matches senderNonce. Used to recover the real txid when a
 * payment is terminated due to a sender-origin ConflictingNonceInMempool — the
 * sender's own in-flight tx occupied the nonce before the relay could sponsor a new one.
 *
 * Never throws — returns null on any error or when no match is found.
 *
 * @param env - Worker env (for STACKS_NETWORK and optional HIRO_API_KEY)
 * @param senderAddress - Stacks sender address (SP... / ST...)
 * @param senderNonce - The nonce to look up
 * @returns { txId, txStatus } if a matching tx is found, null otherwise
 */
async function lookupTxByAddressNonce(
  env: Env,
  senderAddress: string,
  senderNonce: number
): Promise<{ txId: string; txStatus: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HIRO_LOOKUP_TIMEOUT_MS);
  try {
    const base = getHiroBaseUrl(env.STACKS_NETWORK ?? "testnet");
    const headers = getHiroHeaders(env.HIRO_API_KEY);
    const url = `${base}/extended/v1/address/${senderAddress}/transactions?limit=50`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return null;
    const json = await response.json() as { results?: Array<{ tx_id: string; tx_status: string; nonce: number }> };
    const results = json?.results;
    if (!Array.isArray(results)) return null;
    const match = results.find((tx) => tx.nonce === senderNonce);
    if (!match) return null;
    return { txId: match.tx_id, txStatus: match.tx_status };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the raw hex of an on-chain transaction from Hiro.
 *
 * Uses GET /extended/v1/tx/{txId}/raw which returns { raw_tx: "0x..." }.
 * Returns the raw hex string (with or without the leading "0x") on success,
 * null on any error or timeout. Applies the same AbortController timeout as
 * lookupTxByAddressNonce so a slow Hiro response cannot stall the queue consumer.
 *
 * Fail-safe: never throws.
 */
async function fetchOnChainRawTx(env: Env, txId: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HIRO_LOOKUP_TIMEOUT_MS);
  try {
    const base = getHiroBaseUrl(env.STACKS_NETWORK ?? "testnet");
    const headers = getHiroHeaders(env.HIRO_API_KEY);
    const url = `${base}/extended/v1/tx/${txId}/raw`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return null;
    const json = await response.json() as { raw_tx?: string };
    const rawTx = json?.raw_tx;
    if (typeof rawTx !== "string" || rawTx.length === 0) return null;
    // Hiro returns "0x<hex>" — strip the prefix so verifyPaymentParams gets bare hex
    return rawTx.startsWith("0x") ? rawTx.slice(2) : rawTx;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Process a single payment queue message.
 */
async function processPaymentMessage(
  env: Env,
  message: Message<PaymentQueueMessage>,
  logger: Logger
): Promise<void> {
  const body = message.body;
  const { paymentId, txHex, network } = body;
  // Use queue-provided attempt count — message.body.attempt is never incremented by retry()
  const attempt = message.attempts;

  const kv = env.RELAY_KV;
  if (!kv) {
    logger.error("RELAY_KV not configured, acking message to prevent infinite retry");
    message.ack();
    return;
  }

  // Read current payment record
  let record = await getPaymentRecord(kv, paymentId);
  if (!record) {
    logger.warn("Payment record not found, may have expired", { paymentId });
    message.ack();
    return;
  }

  // Guard: if already in a terminal state, skip
  if (
    record.status === "confirmed" ||
    record.status === "failed" ||
    record.status === "replaced"
  ) {
    emitPaymentLifecycleEvent(logger, "payment.retry_decision", {
      route: "PAYMENT_QUEUE",
      paymentId,
      status: record.status,
      terminalReason: record.terminalReason,
      action: "skip_terminal_payment",
      checkStatusUrlPresent: false,
      compatShimUsed: false,
      attempt,
    });
    logger.info("Payment already terminal, skipping", {
      paymentId,
      status: record.status,
    });
    message.ack();
    return;
  }

  // Guard: if txid already set, a prior attempt broadcast this tx successfully.
  // Skip re-sponsoring to avoid burning a fresh nonce slot.
  if (record.txid) {
    // #327: Idempotent retry reusing an existing broadcast is bookkeeping,
    // not an incident — emit at info level. Keep the human-readable
    // `Payment already has txid…` line at warn so operators still see one
    // message per occurrence in human-tail logs.
    emitPaymentLifecycleEvent(logger, "payment.fallback_used", {
      route: "PAYMENT_QUEUE",
      paymentId,
      status: record.status,
      terminalReason: record.terminalReason,
      action: "reuse_existing_broadcast_state",
      checkStatusUrlPresent: false,
      compatShimUsed: false,
      txid: record.txid,
      attempt,
    });
    logger.warn("Payment already has txid, skipping re-sponsor", {
      paymentId,
      txid: record.txid,
      status: record.status,
    });
    record = transitionPayment(record, "mempool", { txid: record.txid });
    await putPaymentRecord(kv, record);
    message.ack();
    return;
  }

  // Transition to broadcasting — clear any transient error from prior attempt
  record = transitionPayment(record, "broadcasting", TRANSIENT_ERROR_FIELDS);
  await putPaymentRecord(kv, record);

  // Deserialize the transaction
  let transaction;
  try {
    transaction = deserializeTransaction(txHex);
  } catch (e) {
    record = transitionPayment(record, "failed", {
      error: "Could not deserialize transaction",
      errorCode: "INVALID_TRANSACTION",
      terminalReason: "invalid_transaction",
      retryable: false,
    });
    await putPaymentRecord(kv, record);
    emitPaymentLifecycleEvent(logger, "payment.finalized", {
      route: "PAYMENT_QUEUE",
      paymentId,
      status: record.status,
      terminalReason: record.terminalReason,
      action: "deserialization_failed",
      checkStatusUrlPresent: false,
      compatShimUsed: false,
      attempt,
    }, "warn");
    message.ack();
    return;
  }

  // Extract signer hash once — used for in-flight markers and sender nonce cache
  const signerHash = transaction.auth.spendingCondition.signer;

  const sponsorService = new SponsorService(env, logger);
  const sent = await sponsorService.sponsorAndBroadcast(transaction);

  if (!sent.ok) {
    await handleSponsorFailure(env, message, logger, record, sent, signerHash);
    return;
  }

  // Broadcast accepted (or an earlier broadcast of this tx was found landed) — tx is in mempool
  const txid = sent.txid;
  record.sponsorNonce = sent.sponsorNonce;
  record.sponsorFee = sent.fee;
  record = transitionPayment(record, "mempool", { txid });
  await putPaymentRecord(kv, record);
  await recordBroadcastBookkeeping(kv, logger, record, paymentId, txid, signerHash);

  logger.info("Payment broadcast successful", {
    paymentId,
    txid,
    sponsorNonce: sent.sponsorNonce,
    fee: sent.fee,
    replayed: sent.replayed === true,
  });

  message.ack();
}

/**
 * KV bookkeeping once a payment has a txid in the mempool or on chain: txid → paymentId
 * (chainhook / confirm healers), clear the in-flight marker, update the sender nonce cache
 * and sender address → signer hash mapping.
 */
async function recordBroadcastBookkeeping(
  kv: KVNamespace,
  logger: Logger,
  record: PaymentRecord,
  paymentId: string,
  txid: string,
  signerHash: string
): Promise<void> {
  await kv
    .put(`txid_map:${txid}`, paymentId, { expirationTtl: 86_400 })
    .catch((e) => logger.warn("Failed to write txid mapping", { error: String(e) }));

  if (record.senderNonce === undefined) return;
  // The marker key only depends on signerHash + nonce, so clear it even without senderAddress.
  await clearInFlight(kv, signerHash, record.senderNonce).catch((e) =>
    logger.warn("Failed to clear in-flight marker on broadcast success", { error: String(e) })
  );
  if (!record.senderAddress) return;
  await updateSenderNonceOnBroadcast(kv, signerHash, record.senderNonce, txid).catch((e) =>
    logger.warn("Failed to update sender nonce cache", { error: String(e) })
  );
  await kv
    .put(`sender_addr_map:${record.senderAddress}`, signerHash, { expirationTtl: 86_400 })
    .catch((e) => logger.warn("Failed to write sender address mapping", { error: String(e) }));
}

/** Queue backoff for a payment that may go through later (seconds). */
function retryDelaySeconds(attempt: number, senderNotReady: boolean): number {
  // A sender's next payment waits for the previous one to execute and Hiro to index it:
  // 30s, 60s, 120s, 240s — about 7.5 minutes before the last attempt.
  return senderNotReady ? Math.min(240, 30 * Math.pow(2, attempt - 1)) : Math.min(30, Math.pow(2, attempt));
}

/**
 * Map a SponsorWalletDO refusal or broadcast failure onto the payment record:
 * retry while the payment may still go through, terminalize otherwise.
 */
async function handleSponsorFailure(
  env: Env,
  message: Message<PaymentQueueMessage>,
  logger: Logger,
  record: PaymentRecord,
  sent: Extract<SponsorWalletResult, { ok: false }>,
  signerHash: string
): Promise<void> {
  const kv = env.RELAY_KV!;
  const { paymentId } = message.body;
  const attempt = message.attempts;
  const canRetry = attempt < MAX_ATTEMPTS;

  const terminalize = async (fields: Partial<PaymentRecord>, action: string, responsibleParty?: "sender" | "sponsor") => {
    if (record.senderNonce !== undefined) {
      await clearInFlight(kv, signerHash, record.senderNonce).catch(
        (e) => logger.warn("Failed to clear in-flight marker on sponsor fail", { error: String(e) })
      );
    }
    const failed = transitionPayment(record, "failed", fields);
    await putPaymentRecord(kv, failed);
    emitPaymentLifecycleEvent(logger, "payment.finalized", {
      route: "PAYMENT_QUEUE",
      paymentId,
      status: failed.status,
      terminalReason: failed.terminalReason,
      action,
      checkStatusUrlPresent: false,
      compatShimUsed: false,
      attempt,
      ...(responsibleParty && { responsibleParty }),
    }, "warn");
    message.ack();
  };

  const requeue = async (
    fields: Partial<PaymentRecord>,
    action: string,
    responsibleParty: "sender" | "sponsor",
    senderNotReady: boolean,
    level: "info" | "warn" = senderNotReady ? "info" : "warn"
  ) => {
    const queued = transitionPayment(record, "queued", fields);
    await putPaymentRecord(kv, queued);
    emitPaymentLifecycleEvent(logger, "payment.retry_decision", {
      route: "PAYMENT_QUEUE",
      paymentId,
      status: queued.status,
      action,
      checkStatusUrlPresent: false,
      compatShimUsed: false,
      attempt,
      responsibleParty,
    }, level);
    message.retry({ delaySeconds: retryDelaySeconds(attempt, senderNotReady) });
  };

  logger.warn("Sponsor/broadcast did not go through", {
    paymentId,
    attempt,
    error: sent.error,
    details: sent.details,
    senderNonceCode: sent.senderNonceCode,
    responsible: sent.responsible,
    nonceConflict: sent.nonceConflict,
    tooMuchChaining: sent.tooMuchChaining,
  });

  // Sender's previous tx is still pending (or our own earlier send of this one is unseen yet).
  if (sent.senderNonceCode === "SENDER_NONCE_DUPLICATE") {
    if (canRetry) {
      await requeue({ error: "Waiting for the sender's previous transaction to confirm" }, "queue_retry_sender_pending", "sender", true);
      return;
    }
    await terminalize({
      error: sent.details, errorCode: "SENDER_NONCE_DUPLICATE", terminalReason: "sender_nonce_duplicate", retryable: true,
    }, "sender_pending_exhausted", "sender");
    return;
  }

  // Sender skipped a nonce — an earlier payment of theirs may still be queued.
  if (sent.senderNonceCode === "SENDER_NONCE_GAP") {
    if (canRetry) {
      await requeue({
        error: `Sender nonce gap: waiting for nonce ${sent.expectedNonce ?? "(unknown)"}`,
        errorCode: undefined,
        terminalReason: undefined,
        retryable: undefined,
        holdReason: "gap",
        ...(sent.expectedNonce !== undefined && { nextExpectedNonce: sent.expectedNonce }),
      }, "sender_nonce_gap_held", "sender", true);
      return;
    }
    await terminalize({
      error: sent.details, errorCode: "SENDER_NONCE_GAP", terminalReason: "sender_nonce_gap", retryable: true,
    }, "sender_nonce_gap_exhausted", "sender");
    return;
  }

  // The sender's nonce is already taken — on chain (STALE) or in the mempool (sender-side
  // conflict). It may be this very payment, so resolve the tx at that nonce before failing.
  const senderNonceTaken =
    sent.senderNonceCode === "SENDER_NONCE_STALE" || (sent.nonceConflict === true && sent.responsible === "sender");
  if (senderNonceTaken) {
    if (await resolveSenderNonceTaken(env, message, logger, record, signerHash)) return;
    if (sent.senderNonceCode !== "SENDER_NONCE_STALE" && canRetry) {
      // Occupant still in the mempool (not mined, so not resolvable yet) — look again later.
      await requeue({ error: `Sender nonce in use: ${sent.error}` }, "queue_retry_nonce_conflict", "sender", true, "warn");
      return;
    }
    const stale = sent.senderNonceCode === "SENDER_NONCE_STALE";
    await terminalize({
      error: stale ? sent.details : sent.error,
      errorCode: stale ? "SENDER_NONCE_STALE" : "SENDER_NONCE_CONFLICT",
      terminalReason: stale ? "sender_nonce_stale" : "sender_nonce_duplicate",
      retryable: false,
    }, "sender_conflict_unresolvable", "sender");
    return;
  }

  if (sent.isOriginChaining) {
    await terminalize({
      error: sent.error, errorCode: "BROADCAST_FAILED", terminalReason: "origin_chaining_limit", retryable: sent.retryable,
    }, "broadcast_failed_terminal", "sender");
    return;
  }

  // Sponsor-side: daily budget, sponsor congestion, sponsor nonce contention, node/network errors.
  const budget = sent.error === "Daily sponsor budget reached";
  const sponsorReason = budget ? "sponsor_exhausted"
    : sent.tooMuchChaining ? "sponsor_failure"
    : sent.nonceConflict ? "sponsor_nonce_conflict"
    : sent.clientRejection ? "broadcast_failure"
    : sent.responsible === "sponsor" ? "sponsor_failure"
    : "broadcast_failure";
  // The daily budget only resets at UTC midnight — retrying in seconds cannot help.
  if (sent.retryable && sent.clientRejection === undefined && !budget && canRetry) {
    await requeue({ error: `Sponsor contention: ${sent.error}` }, "queue_retry_sponsor_contention", "sponsor", false);
    return;
  }
  await terminalize({
    error: sent.error,
    errorCode: sent.clientRejection
      ? `CLIENT_${sent.clientRejection.toUpperCase()}`
      : budget ? "SPONSOR_EXHAUSTED" : "BROADCAST_FAILED",
    terminalReason: sponsorReason,
    retryable: sent.retryable,
  }, sent.clientRejection ? "broadcast_failed_terminal" : "sponsor_failed_terminal",
  sent.clientRejection || sent.responsible === "sender" ? "sender" : "sponsor");
}

/**
 * The sender's nonce is already taken. Resolve the mined tx at (senderAddress, senderNonce) and,
 * if it is a tx that satisfies this payment's settle requirements, wire its txid in so healers
 * finalize the record (#397). A mined tx that does not satisfy them supersedes the payment; an
 * aborted one terminalizes it. Returns false when nothing was resolved (caller decides).
 */
async function resolveSenderNonceTaken(
  env: Env,
  message: Message<PaymentQueueMessage>,
  logger: Logger,
  record: PaymentRecord,
  signerHash: string
): Promise<boolean> {
  const kv = env.RELAY_KV!;
  const { paymentId, settle } = message.body;
  const attempt = message.attempts;
  if (!record.senderAddress || record.senderNonce === undefined) return false;

  // Hiro's address/transactions lists mined txs only — a mempool occupant is not found here.
  const resolved = await lookupTxByAddressNonce(env, record.senderAddress, record.senderNonce);
  if (!resolved) return false;

  const finalize = async (status: "failed" | "replaced", fields: Partial<PaymentRecord>, action: string, extra: Record<string, unknown>) => {
    await clearInFlight(kv, signerHash, record.senderNonce!).catch(
      (e) => logger.warn("Failed to clear in-flight marker on sender conflict", { error: String(e) })
    );
    const updated = transitionPayment(record, status, fields);
    await putPaymentRecord(kv, updated);
    emitPaymentLifecycleEvent(logger, "payment.finalized", {
      route: "PAYMENT_QUEUE",
      paymentId,
      status: updated.status,
      terminalReason: updated.terminalReason,
      action,
      checkStatusUrlPresent: false,
      compatShimUsed: false,
      attempt,
      responsibleParty: "sender",
      ...extra,
    }, "warn");
    message.ack();
    return true;
  };

  if (resolved.txStatus !== "success") {
    // Mined but aborted: it never settles, so do not park the payment in "mempool".
    return finalize("failed", {
      error: `Sender nonce ${record.senderNonce} was used by a tx that aborted on chain`,
      errorCode: "SENDER_NONCE_CONFLICT",
      terminalReason: "sender_nonce_duplicate",
      retryable: false,
    }, "sender_conflict_aborted_onchain", { resolvedTxId: resolved.txId, txStatus: resolved.txStatus });
  }
  if (!settle) return false;

  // Verify the ACTUAL on-chain tx, not the queued txHex: a different tx could hold the nonce.
  const onChainRawHex = await fetchOnChainRawTx(env, resolved.txId);
  if (onChainRawHex === null) {
    logger.warn("Sender nonce taken: raw-tx fetch failed, cannot verify on-chain tx", {
      paymentId, resolvedTxId: resolved.txId, senderAddress: record.senderAddress, senderNonce: record.senderNonce,
    });
    return false;
  }
  const verifyResult = new SettlementService(env, logger).verifyPaymentParams(onChainRawHex, settle);
  if (!verifyResult.valid) {
    return finalize("replaced", {
      error: verifyResult.details ?? verifyResult.error ?? "On-chain tx does not satisfy settle requirements",
      terminalReason: "superseded",
      retryable: false,
    }, "sender_conflict_superseded", { resolvedTxId: resolved.txId });
  }

  // On-chain tx satisfies settle requirements: park in "mempool" with its txid so the
  // chainhook / confirm healers finalize it — do NOT mark confirmed directly.
  const updated = transitionPayment(record, "mempool", { txid: resolved.txId });
  await putPaymentRecord(kv, updated);
  await recordBroadcastBookkeeping(kv, logger, updated, paymentId, resolved.txId, signerHash);
  emitPaymentLifecycleEvent(logger, "payment.retry_decision", {
    route: "PAYMENT_QUEUE",
    paymentId,
    status: updated.status,
    action: "sender_conflict_resolved_txid",
    checkStatusUrlPresent: false,
    compatShimUsed: false,
    attempt,
    txid: resolved.txId,
    responsibleParty: "sender",
  });
  logger.info("Sender nonce taken by this payment's on-chain tx: txid wired for healers", {
    paymentId, txid: resolved.txId, senderAddress: record.senderAddress, senderNonce: record.senderNonce,
  });
  message.ack();
  return true;
}

/**
 * Ensure a payment reaches a terminal state when its queue message is about to
 * be dropped after exhausting retries on an unhandled error.
 *
 * The catch-all below finalizes the message with ack() (it does NOT route to the
 * DLQ — ack marks the message as successfully handled). So if the record is still
 * non-terminal when we drop the message (typically "queued"/"broadcasting", but
 * this guards on any non-terminal status), nothing ever re-drives it: it's
 * stranded forever, and the aibtc inbox dedups future sends onto the stuck record
 * — wedging the sender wallet so it can no longer send any message. Marking it
 * failed+retryable releases that dedup so the agent can cleanly resubmit. (#398)
 *
 * Fail-open: never throws — a bookkeeping failure here must not block the ack.
 */
async function finalizeExhaustedPayment(
  env: Env,
  paymentId: string,
  logger: Logger,
  opts?: { route?: string; error?: string; action?: string },
): Promise<void> {
  try {
    const kv = env.RELAY_KV;
    if (!kv) return;
    const record = await getPaymentRecord(kv, paymentId);
    // Terminalize any non-terminal record — never regress a confirmed/failed/replaced one.
    if (!record || isTerminalPaymentStatus(record.status)) return;
    const updated = transitionPayment(record, "failed", {
      error: opts?.error ?? "Payment processing exhausted retries before broadcast",
      errorCode: "BROADCAST_EXHAUSTED",
      terminalReason: "internal_error",
      retryable: true,
    });
    await putPaymentRecord(kv, updated);
    emitPaymentLifecycleEvent(
      logger,
      "payment.finalized",
      {
        route: opts?.route ?? "PAYMENT_QUEUE",
        paymentId,
        status: updated.status,
        terminalReason: updated.terminalReason,
        action: opts?.action ?? "exhausted_retries_terminalized",
        checkStatusUrlPresent: false,
        compatShimUsed: false,
      },
      "warn",
    );
  } catch (e) {
    logger.warn("Failed to finalize exhausted payment", {
      paymentId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Queue consumer handler — called by the worker's queue() export.
 */
export async function handlePaymentQueue(
  batch: MessageBatch<PaymentQueueMessage>,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  // Process messages serially within each batch for nonce safety
  for (const message of batch.messages) {
    const logger = createWorkerLogger(env.LOGS, ctx, {
      component: "payment_queue",
      queue: "PAYMENT_QUEUE",
      paymentId: message.body.paymentId,
      attempt: message.attempts,
    });
    try {
      await processPaymentMessage(env, message, logger);
    } catch (e) {
      logger.error("Unhandled error processing payment message", {
        error: e instanceof Error ? e.message : String(e),
      });
      // Retry on unexpected errors if under attempt limit
      if (message.attempts < MAX_ATTEMPTS) {
        message.retry({ delaySeconds: 5 });
      } else {
        // Exhausted: guarantee a terminal record before we drop the message, so
        // the payment can't be stranded at "queued". Note ack() finalizes the
        // message — it does NOT route to the DLQ — so this is our only chance to
        // terminalize it on this path. (#398)
        await finalizeExhaustedPayment(env, message.body.paymentId, logger);
        message.ack(); // final ack — drops the message (not dead-lettered)
      }
    }
  }
}

/**
 * Dead-letter queue consumer for x402-payment-dlq-*.
 *
 * A message reaches the DLQ only after exhausting the main queue's retries via
 * message.retry() (e.g. the unbounded capacity-hold retry path), which leaves
 * the payment record non-terminal at "queued". Nothing else re-drives a DLQ'd
 * message, so without this consumer the payment is stranded forever — and the
 * aibtc inbox dedups future sends onto the stuck record, wedging the sender
 * wallet so it can no longer send any message.
 *
 * This consumer enforces the safety-net invariant: no dead-lettered payment is
 * left non-terminal. It marks the record failed + retryable (via
 * finalizeExhaustedPayment), releasing the inbox dedup so the agent can cleanly
 * resubmit. Always acks — never re-throws into an infinite DLQ loop. (#398)
 */
export async function handlePaymentDLQ(
  batch: MessageBatch<PaymentQueueMessage>,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  for (const message of batch.messages) {
    const logger = createWorkerLogger(env.LOGS, ctx, {
      component: "payment_dlq",
      queue: batch.queue,
      paymentId: message.body.paymentId,
      attempt: message.attempts,
    });
    await finalizeExhaustedPayment(env, message.body.paymentId, logger, {
      route: "PAYMENT_DLQ",
      error: "Payment dead-lettered after exhausting queue retries",
      action: "dlq_terminalized",
    });
    message.ack();
  }
}
