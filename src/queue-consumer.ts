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

import { deserializeTransaction } from "@stacks/transactions";
import type { Env, Logger } from "./types";
import {
  getPaymentRecord,
  putPaymentRecord,
  transitionPayment,
  type PaymentQueueMessage,
  type PaymentRecord,
} from "./services/payment-status";
import { updateSenderNonceOnBroadcast } from "./services/sender-nonce";
import { SponsorService, extractSponsorNonce, recordNonceTxid, releaseNonceDO, recordBroadcastOutcomeDO, SettlementService } from "./services";

/** Max retries before dead-lettering */
const MAX_ATTEMPTS = 5;

/** Fields set during retryable contention — cleared on next attempt */
const TRANSIENT_ERROR_FIELDS: Partial<PaymentRecord> = {
  error: undefined,
  errorCode: undefined,
  retryable: undefined,
};

/**
 * Create a minimal logger that writes to console (queue context has no LOGS binding easily).
 */
function createQueueLogger(paymentId: string): Logger {
  const prefix = `[queue:${paymentId}]`;
  return {
    info: (msg, ctx) => console.log(prefix, msg, ctx ?? ""),
    warn: (msg, ctx) => console.warn(prefix, msg, ctx ?? ""),
    error: (msg, ctx) => console.error(prefix, msg, ctx ?? ""),
    debug: (msg, ctx) => console.debug(prefix, msg, ctx ?? ""),
  };
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
  if (record.status === "confirmed" || record.status === "failed") {
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
      retryable: false,
    });
    await putPaymentRecord(kv, record);
    message.ack();
    return;
  }

  // Sponsor the transaction (assigns nonce from NonceDO, signs with sponsor key)
  const sponsorService = new SponsorService(env, logger);
  const sponsorResult = await sponsorService.sponsorTransaction(transaction);

  if (!sponsorResult.success) {
    // Check if this is a retryable contention error
    const code = sponsorResult.code;
    const isRetryable =
      code === "RATE_LIMIT_EXCEEDED" ||
      code === "LOW_HEADROOM" ||
      code === "SERVICE_DEGRADED" ||
      code === "NONCE_DO_UNAVAILABLE";

    if (isRetryable && attempt < MAX_ATTEMPTS) {
      // Let the queue retry with backoff
      logger.warn("Sponsor contention, retrying via queue", {
        paymentId,
        code,
        attempt,
      });
      // Update record and move back to queued state for next attempt
      record = transitionPayment(record, "queued", {
        error: `Sponsor contention: ${sponsorResult.error}`,
      });
      await putPaymentRecord(kv, record);
      message.retry({
        delaySeconds: Math.min(30, Math.pow(2, attempt)),
      });
      return;
    }

    // Terminal sponsor failure
    record = transitionPayment(record, "failed", {
      error: sponsorResult.error,
      errorCode: code ?? "SPONSOR_FAILED",
      retryable: false,
    });
    await putPaymentRecord(kv, record);
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

  const settlementService = new SettlementService(env, logger);
  const broadcastResult = await settlementService.broadcastOnly(sponsoredTx);

  if ("error" in broadcastResult) {
    // Check for retryable broadcast errors
    const isNonceConflict = broadcastResult.nonceConflict === true;
    const isTooMuchChaining = broadcastResult.tooMuchChaining === true;

    if ((isNonceConflict || isTooMuchChaining) && attempt < MAX_ATTEMPTS) {
      // Release the sponsor nonce back to pool
      if (sponsorNonce !== null) {
        await releaseNonceDO(env, logger, sponsorNonce, undefined, walletIndex);
      }

      logger.warn("Broadcast contention, retrying via queue", {
        paymentId,
        nonceConflict: isNonceConflict,
        tooMuchChaining: isTooMuchChaining,
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

    // Terminal broadcast failure — release nonce
    if (sponsorNonce !== null) {
      await releaseNonceDO(env, logger, sponsorNonce, undefined, walletIndex);
    }

    record = transitionPayment(record, "failed", {
      error: broadcastResult.error,
      errorCode: broadcastResult.clientRejection
        ? `CLIENT_${broadcastResult.clientRejection.toUpperCase()}`
        : "BROADCAST_FAILED",
      retryable: broadcastResult.retryable,
    });
    await putPaymentRecord(kv, record);
    message.ack();
    return;
  }

  // Broadcast succeeded — tx is in mempool
  const txid = broadcastResult.txid;

  // Record txid with NonceDO and release the reserved nonce slot
  if (sponsorNonce !== null) {
    await Promise.all([
      recordNonceTxid(env, logger, txid, sponsorNonce).catch(
        (e) => logger.warn("Failed to record nonce txid", { error: String(e) })
      ),
      releaseNonceDO(env, logger, sponsorNonce, txid, walletIndex, sponsorResult.fee).catch(
        (e) => logger.warn("Failed to release nonce", { error: String(e) })
      ),
      recordBroadcastOutcomeDO(env, logger, sponsorNonce, walletIndex, txid, 200, undefined, undefined).catch(
        (e) => logger.warn("Failed to record broadcast outcome", { error: String(e) })
      ),
    ]);
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

  // Update sender nonce cache
  const signerHash = transaction.auth.spendingCondition.signer;
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
 * Queue consumer handler — called by the worker's queue() export.
 */
export async function handlePaymentQueue(
  batch: MessageBatch<PaymentQueueMessage>,
  env: Env
): Promise<void> {
  // Process messages serially within each batch for nonce safety
  for (const message of batch.messages) {
    const logger = createQueueLogger(message.body.paymentId);
    try {
      await processPaymentMessage(env, message, logger);
    } catch (e) {
      logger.error("Unhandled error processing payment message", {
        error: e instanceof Error ? e.message : String(e),
        paymentId: message.body.paymentId,
      });
      // Retry on unexpected errors if under attempt limit
      if (message.attempts < MAX_ATTEMPTS) {
        message.retry({ delaySeconds: 5 });
      } else {
        message.ack(); // dead letter
      }
    }
  }
}
