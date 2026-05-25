/**
 * Queue consumer for PAYMENT_QUEUE.
 *
 * Processes payment messages serially — each message:
 * 1. Reads payment record from KV
 * 2. Sponsors the transaction (assigns nonce via NonceDO)
 * 3. Broadcasts via SettlementService
 * 4. Updates payment status in KV
 * 5. Updates sender nonce cache
 *
 * On contention errors (ConflictingNonceInMempool, TooMuchChaining),
 * the message is retried by the queue with backoff.
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
import {
  SponsorService,
  extractSponsorNonce,
  releaseNonceDO,
  SettlementService,
  nonceLifecycleOnBroadcastSuccess,
  repairSenderWedgeDO,
} from "./services";

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

  // Sponsor the transaction (assigns nonce from NonceDO, signs with sponsor key)
  const sponsorService = new SponsorService(env, logger);
  const sponsorResult = await sponsorService.sponsorTransaction(
    transaction,
    txHex,
    "hold",
    paymentId
  );

  if (!sponsorResult.success) {
    if ("held" in sponsorResult && sponsorResult.held) {
      logger.info("Transaction held in sender hand (queue consumer)", {
        paymentId,
        holdReason: sponsorResult.holdReason,
        nextExpected: sponsorResult.nextExpected,
        missingNonces: sponsorResult.missingNonces,
      });
      if (sponsorResult.holdReason === "gap") {
        record = transitionPayment(record, "queued", {
          error: `Sender nonce gap: waiting for nonce ${sponsorResult.nextExpected}`,
          errorCode: undefined,
          terminalReason: undefined,
          retryable: undefined,
          holdReason: "gap",
          nextExpectedNonce: sponsorResult.nextExpected,
          missingNonces: sponsorResult.missingNonces,
          holdExpiresAt: sponsorResult.expiresAt,
        });
        await putPaymentRecord(kv, record);
        if (record.senderAddress) {
          await repairSenderWedgeDO(env, logger, record.senderAddress);
        }
        // #327: a nonce-gap hold is normal sender-side handling, not an
        // unresolved incident — emit at info level.
        // #328: attribute to sender so dashboards can split sender-vs-sponsor.
        emitPaymentLifecycleEvent(logger, "payment.retry_decision", {
          route: "PAYMENT_QUEUE",
          paymentId,
          status: record.status,
          action: "sender_nonce_gap_held",
          checkStatusUrlPresent: false,
          compatShimUsed: false,
          attempt,
          responsibleParty: "sender",
        });
        message.ack();
        return;
      }

      record = transitionPayment(record, "queued", {
        error: "Sponsor pool temporarily has no dispatch capacity",
        holdReason: "capacity",
        nextExpectedNonce: sponsorResult.nextExpected,
        missingNonces: sponsorResult.missingNonces,
        holdExpiresAt: sponsorResult.expiresAt,
      });
      await putPaymentRecord(kv, record);
      emitPaymentLifecycleEvent(logger, "payment.retry_decision", {
        route: "PAYMENT_QUEUE",
        paymentId,
        status: record.status,
        action: "queue_retry_capacity_hold",
        checkStatusUrlPresent: false,
        compatShimUsed: false,
        attempt,
      }, "warn");
      message.retry({
        delaySeconds: Math.min(30, Math.pow(2, attempt)),
      });
      return;
    }

    // Check if this is a retryable contention error
    const failResult = sponsorResult as { code?: string; error: string };
    const code = failResult.code;
    const isRetryable =
      code === "RATE_LIMIT_EXCEEDED" ||
      code === "LOW_HEADROOM" ||
      code === "SERVICE_DEGRADED" ||
      code === "NONCE_DO_UNAVAILABLE";

    if (isRetryable && attempt < MAX_ATTEMPTS) {
      // Let the queue retry with backoff
      // #328: sponsor-side contention (rate limit / capacity / DO unavailable).
      emitPaymentLifecycleEvent(logger, "payment.retry_decision", {
        route: "PAYMENT_QUEUE",
        paymentId,
        status: "queued",
        action: "queue_retry_sponsor_contention",
        checkStatusUrlPresent: false,
        compatShimUsed: false,
        terminalReason: undefined,
        attempt,
        code,
        responsibleParty: "sponsor",
      }, "warn");
      logger.warn("Sponsor contention, retrying via queue", {
        paymentId,
        code,
        attempt,
      });
      // Update record and move back to queued state for next attempt
      record = transitionPayment(record, "queued", {
        error: `Sponsor contention: ${failResult.error}`,
      });
      await putPaymentRecord(kv, record);
      message.retry({
        delaySeconds: Math.min(30, Math.pow(2, attempt)),
      });
      return;
    }

    // Terminal sponsor failure — clear in-flight marker so the sender can retry
    if (record.senderNonce !== undefined) {
      await clearInFlight(kv, signerHash, record.senderNonce).catch(
        (e) => logger.warn("Failed to clear in-flight marker on sponsor fail", { error: String(e) })
      );
    }

    record = transitionPayment(record, "failed", {
      error: failResult.error,
      errorCode: code ?? "SPONSOR_FAILED",
      terminalReason:
        code === "STALE_SENDER_NONCE" ? "sender_nonce_stale" : "sponsor_failure",
      retryable: false,
    });
    await putPaymentRecord(kv, record);
    emitPaymentLifecycleEvent(logger, "payment.finalized", {
      route: "PAYMENT_QUEUE",
      paymentId,
      status: record.status,
      terminalReason: record.terminalReason,
      action: "sponsor_failed_terminal",
      checkStatusUrlPresent: false,
      compatShimUsed: false,
      attempt,
      code,
    }, "warn");
    message.ack();
    return;
  }

  // Sponsor succeeded — now broadcast
  const sponsoredTx = deserializeTransaction(sponsorResult.sponsoredTxHex);
  const walletIndex = sponsorResult.walletIndex;
  const sponsorNonce = extractSponsorNonce(sponsoredTx);

  record.sponsorWalletIndex = walletIndex;
  record.sponsorNonce = sponsorNonce !== null ? sponsorNonce : undefined;
  record.sponsorFee = sponsorResult.fee;
  record.holdReason = undefined;
  record.nextExpectedNonce = undefined;
  record.missingNonces = undefined;
  record.holdExpiresAt = undefined;

  const settlementService = new SettlementService(env, logger);
  const broadcastResult = await settlementService.broadcastOnly(sponsoredTx);

  if ("error" in broadcastResult) {
    // Check for retryable broadcast errors
    const isNonceConflict = broadcastResult.nonceConflict === true;
    const isTooMuchChaining = broadcastResult.tooMuchChaining === true;
    const isOriginChaining = broadcastResult.isOriginChaining === true;

    if ((isNonceConflict || (isTooMuchChaining && !isOriginChaining)) && attempt < MAX_ATTEMPTS) {
      // Release the sponsor nonce back to pool — no errorReason here so the nonce
      // expires cleanly without penalizing sponsor wallets on every retry attempt.
      if (sponsorNonce !== null) {
        await releaseNonceDO(env, logger, sponsorNonce, undefined, walletIndex);
      }

      // #328: attribute contention to the responsible wallet so operators
      // can tell sender-side congestion (origin chaining / nonce conflicts) from
      // sponsor-side contention (chaining limits on sponsor wallets).
      // ConflictingNonceInMempool (isNonceConflict) is sender-origin: the sender's
      // own in-flight tx already occupied the nonce before the relay could sponsor.
      emitPaymentLifecycleEvent(logger, "payment.retry_decision", {
        route: "PAYMENT_QUEUE",
        paymentId,
        status: "queued",
        action: isOriginChaining
          ? "queue_retry_origin_chaining"
          : isTooMuchChaining
            ? "queue_retry_too_much_chaining"
            : "queue_retry_nonce_conflict",
        checkStatusUrlPresent: false,
        compatShimUsed: false,
        attempt,
        responsibleParty: (isOriginChaining || isNonceConflict) ? "sender" : "sponsor",
      }, "warn");
      logger.warn("Broadcast contention, retrying via queue", {
        paymentId,
        nonceConflict: isNonceConflict,
        tooMuchChaining: isTooMuchChaining,
        isOriginChaining,
        attempt,
      });

      record = transitionPayment(record, "queued", {
        error: `Broadcast contention: ${broadcastResult.error}`,
      });
      await putPaymentRecord(kv, record);
      message.retry({
        delaySeconds: isTooMuchChaining ? 15 : Math.min(10, Math.pow(2, attempt)),
      });
      return;
    }

    // Terminal broadcast failure.
    // Origin-side TooMuchChaining: release cleanly — the agent's address is congested, not the sponsor.
    // Sponsor-side TooMuchChaining or nonce conflict: release with error reason for tracking.
    // Generic failures (node 500, timeout): release cleanly to avoid penalizing healthy wallets.
    if (sponsorNonce !== null) {
      const reason = isOriginChaining ? undefined
        : isTooMuchChaining ? "TooMuchChaining"
        : isNonceConflict ? "nonce_conflict"
        : undefined;
      await releaseNonceDO(env, logger, sponsorNonce, undefined, walletIndex, undefined, reason);
    }

    if (record.senderNonce !== undefined) {
      await clearInFlight(kv, signerHash, record.senderNonce).catch(
        (e) => logger.warn("Failed to clear in-flight marker on broadcast fail", { error: String(e) })
      );
    }

    // Sender-origin nonce conflict: the sender's own in-flight tx already occupied
    // the nonce before the relay could sponsor this payment. Resolve the actual
    // on-chain txid and verify settle requirements so healers can finalize the record
    // rather than leaving it falsely reported as sponsor_failure. (#397)
    if (isNonceConflict && record.senderAddress && record.senderNonce !== undefined) {
      const resolved = await lookupTxByAddressNonce(env, record.senderAddress, record.senderNonce);
      const settle = message.body.settle;

      if (resolved) {
        if (resolved.txStatus === "success" && settle) {
          // P1: Verify the ACTUAL on-chain tx (not the queued txHex) satisfies settle
          // requirements. A different sender tx could have taken the nonce — verifying
          // our queued txHex would pass even though resolved.txId points to an unrelated
          // tx with a different recipient/amount/token.
          //
          // Fetch the raw on-chain tx hex via Hiro GET /extended/v1/tx/{txId}/raw and
          // run verifyPaymentParams against it. On fetch failure or timeout: fail safe —
          // do NOT write txid_map for an unverified txid; fall through to the
          // not-resolvable / sender_nonce_duplicate path.
          const onChainRawHex = await fetchOnChainRawTx(env, resolved.txId);
          if (onChainRawHex === null) {
            // Hiro raw-tx fetch failed or timed out — cannot verify; fall through to sender_nonce_duplicate.
            logger.warn("Sender-origin nonce conflict: raw-tx fetch failed, cannot verify on-chain tx", {
              paymentId,
              resolvedTxId: resolved.txId,
              senderAddress: record.senderAddress,
              senderNonce: record.senderNonce,
            });
          } else {
            // Reuse the SettlementService instance that was already created for broadcastOnly above.
            const verifyResult = settlementService.verifyPaymentParams(onChainRawHex, settle);
            if (verifyResult.valid) {
              // On-chain tx satisfies settle requirements. Wire in the txid so healers can confirm.
              // Mirror the normal broadcast-success bookkeeping so chainhook/confirm-reconcile
              // can finalize the record and keep the sender nonce cache current:
              //   1. Update sender nonce cache (lastSeen)
              //   2. Write sender_addr_map so the chainhook healer can look up signerHash
              //   3. Write txid_map so chainhook can find the paymentId
              // Transition to mempool — do NOT mark confirmed directly.
              record = transitionPayment(record, "mempool", { txid: resolved.txId });
              await putPaymentRecord(kv, record);
              await kv
                .put(`txid_map:${resolved.txId}`, paymentId, { expirationTtl: 86_400 })
                .catch((e) => logger.warn("Failed to write txid mapping on sender conflict resolve", { error: String(e) }));
              // Mirror updateSenderNonceOnBroadcast + sender_addr_map from the happy broadcast path
              if (record.senderNonce !== undefined && record.senderAddress) {
                await updateSenderNonceOnBroadcast(
                  kv,
                  signerHash,
                  record.senderNonce,
                  resolved.txId
                ).catch((e) => logger.warn("Failed to update sender nonce cache on conflict resolve", { error: String(e) }));
                await kv
                  .put(`sender_addr_map:${record.senderAddress}`, signerHash, { expirationTtl: 86_400 })
                  .catch((e) => logger.warn("Failed to write sender address mapping on conflict resolve", { error: String(e) }));
              }
              emitPaymentLifecycleEvent(logger, "payment.retry_decision", {
                route: "PAYMENT_QUEUE",
                paymentId,
                status: record.status,
                action: "sender_conflict_resolved_txid",
                checkStatusUrlPresent: false,
                compatShimUsed: false,
                attempt,
                txid: resolved.txId,
                responsibleParty: "sender",
              });
              logger.info("Sender-origin nonce conflict resolved: txid wired for healers", {
                paymentId,
                txid: resolved.txId,
                senderAddress: record.senderAddress,
                senderNonce: record.senderNonce,
              });
              message.ack();
              return;
            } else {
              // On-chain tx does not match settle requirements — a different/unrelated tx
              // occupied this nonce (e.g. a different recipient, different amount, or a
              // non-payment tx). Do NOT write txid_map for an unverified txid.
              record = transitionPayment(record, "replaced", {
                error: verifyResult.details ?? verifyResult.error ?? "On-chain tx does not satisfy settle requirements",
                terminalReason: "superseded",
                retryable: false,
              });
              await putPaymentRecord(kv, record);
              emitPaymentLifecycleEvent(logger, "payment.finalized", {
                route: "PAYMENT_QUEUE",
                paymentId,
                status: record.status,
                terminalReason: record.terminalReason,
                action: "sender_conflict_superseded",
                checkStatusUrlPresent: false,
                compatShimUsed: false,
                attempt,
                responsibleParty: "sender",
              }, "warn");
              logger.warn("Sender-origin nonce conflict: on-chain tx does not satisfy settle requirements", {
                paymentId,
                resolvedTxId: resolved.txId,
                senderAddress: record.senderAddress,
                senderNonce: record.senderNonce,
                verifyError: verifyResult.error,
              });
              message.ack();
              return;
            }
          }
        } else if (resolved.txStatus !== "success") {
          // NOTE: lookupTxByAddressNonce queries Hiro GET /extended/v1/address/{sender}/transactions,
          // which returns ONLY mined (anchored) transactions — NOT mempool txs.
          // Therefore a non-"success" tx_status here is an aborted on-chain status
          // (abort_by_response / abort_by_post_condition), NOT a pending/mempool tx.
          //
          // Do NOT wire txid_map or park in "mempool": an aborted tx never confirms, so
          // chainhook/confirm-reconcile healers would never finalize the record, creating
          // a stuck-forever payment. Terminalize as sender_nonce_duplicate instead.
          //
          // Self-contained terminalization: persist the failed state BEFORE emitting the
          // single payment.finalized event (so a transient KV failure cannot report the
          // payment finalized while the message is retried), then ack and return — do NOT
          // fall through to the unresolvable block below, which would emit a second
          // payment.finalized for the same payment.
          record = transitionPayment(record, "failed", {
            error: broadcastResult.error,
            errorCode: "SENDER_NONCE_CONFLICT",
            terminalReason: "sender_nonce_duplicate",
            retryable: false,
          });
          await putPaymentRecord(kv, record);
          emitPaymentLifecycleEvent(logger, "payment.finalized", {
            route: "PAYMENT_QUEUE",
            paymentId,
            status: record.status,
            terminalReason: record.terminalReason,
            action: "sender_conflict_aborted_onchain",
            checkStatusUrlPresent: false,
            compatShimUsed: false,
            attempt,
            resolvedTxId: resolved.txId,
            txStatus: resolved.txStatus,
            responsibleParty: "sender",
          }, "warn");
          logger.warn("Sender-origin nonce conflict: resolved tx is aborted on-chain, terminalizing", {
            paymentId,
            resolvedTxId: resolved.txId,
            txStatus: resolved.txStatus,
            senderAddress: record.senderAddress,
            senderNonce: record.senderNonce,
          });
          message.ack();
          return;
        }
        // resolved exists but txStatus=success with no settle, or raw-tx fetch failed
        // — fall through to sender_nonce_duplicate
      }
      // Lookup returned null or unresolvable — fall through to sender_nonce_duplicate
      record = transitionPayment(record, "failed", {
        error: broadcastResult.error,
        errorCode: "SENDER_NONCE_CONFLICT",
        terminalReason: "sender_nonce_duplicate",
        retryable: false,
      });
      await putPaymentRecord(kv, record);
      emitPaymentLifecycleEvent(logger, "payment.finalized", {
        route: "PAYMENT_QUEUE",
        paymentId,
        status: record.status,
        terminalReason: record.terminalReason,
        action: "sender_conflict_unresolvable",
        checkStatusUrlPresent: false,
        compatShimUsed: false,
        attempt,
        responsibleParty: "sender",
      }, "warn");
      message.ack();
      return;
    }

    record = transitionPayment(record, "failed", {
      error: broadcastResult.error,
      errorCode: broadcastResult.clientRejection
        ? `CLIENT_${broadcastResult.clientRejection.toUpperCase()}`
        : "BROADCAST_FAILED",
      terminalReason: isOriginChaining
        ? "origin_chaining_limit"
        : isTooMuchChaining
          ? "sponsor_failure"
          : "broadcast_failure",
      retryable: broadcastResult.retryable,
    });
    await putPaymentRecord(kv, record);
    emitPaymentLifecycleEvent(logger, "payment.finalized", {
      route: "PAYMENT_QUEUE",
      paymentId,
      status: record.status,
      terminalReason: record.terminalReason,
      action: "broadcast_failed_terminal",
      checkStatusUrlPresent: false,
      compatShimUsed: false,
      attempt,
    }, "warn");
    message.ack();
    return;
  }

  // Broadcast succeeded — tx is in mempool
  const txid = broadcastResult.txid;

  // Record txid with NonceDO and release the reserved nonce slot
  if (sponsorNonce !== null) {
    await nonceLifecycleOnBroadcastSuccess(env, logger, {
      sponsorNonce,
      walletIndex,
      txid,
      fee: sponsorResult.fee,
      paymentId,
      senderTxHex: txHex,
      senderAddress: record.senderAddress,
      senderNonce: record.senderNonce,
      submittedAt: record.submittedAt,
    });
  }

  // Update payment record
  record = transitionPayment(record, "mempool", {
    txid,
  });
  await putPaymentRecord(kv, record);

  // Write txid → paymentId mapping for chainhook lookup (24h TTL)
  await kv
    .put(`txid_map:${txid}`, paymentId, { expirationTtl: 86_400 })
    .catch((e) =>
      logger.warn("Failed to write txid mapping", { error: String(e) })
    );

  // Clear in-flight marker unconditionally when senderNonce is set — the marker
  // key only depends on signerHash + nonce, not senderAddress. Clearing here
  // prevents stuck markers if senderAddress is missing for any reason.
  if (record.senderNonce !== undefined) {
    await clearInFlight(kv, signerHash, record.senderNonce).catch((e) =>
      logger.warn("Failed to clear in-flight marker on broadcast success", { error: String(e) })
    );
  }

  // Update sender nonce cache (requires senderAddress for the cache key)
  if (record.senderNonce !== undefined && record.senderAddress) {
    await updateSenderNonceOnBroadcast(
      kv,
      signerHash,
      record.senderNonce,
      txid
    ).catch((e) =>
      logger.warn("Failed to update sender nonce cache", { error: String(e) })
    );

    // Write sender address → signer hash mapping for chainhook lookup (24h TTL)
    await kv
      .put(`sender_addr_map:${record.senderAddress}`, signerHash, {
        expirationTtl: 86_400,
      })
      .catch((e) =>
        logger.warn("Failed to write sender address mapping", {
          error: String(e),
        })
      );
  }

  logger.info("Payment broadcast successful", {
    paymentId,
    txid,
    walletIndex,
    sponsorNonce,
    fee: sponsorResult.fee,
  });

  message.ack();
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
