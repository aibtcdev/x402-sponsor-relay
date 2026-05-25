/**
 * Reconcile sweep for stuck payment records (#398).
 *
 * The forward fixes (#399 terminalize-on-exhaustion, #400 DLQ consumer) stop NEW
 * strands, but they're forward-only: records already stuck non-terminal — and any
 * predating those fixes — stay stuck. The aibtc inbox dedups future sends onto a
 * stuck record, so a wedged wallet can't recover until its record reaches a
 * terminal state. This sweep, run from the cron `scheduled()` handler, recovers
 * those strands.
 *
 * For each payment record stuck non-terminal past a staleness threshold (so we
 * never race in-flight queue processing), it checks the sender's on-chain nonce:
 *   - nonce confirmed via a sponsored tx        -> confirmed (+ txid_map) so aibtc delivers
 *   - nonce taken by a different (self-paid) tx  -> replaced (superseded)
 *   - nonce aborted on-chain                     -> failed (chain_abort)
 *   - nonce still open, never reached the chain  -> failed + retryable (releases inbox dedup)
 *
 * Fail-open throughout; bounded per run to cap cron time and Hiro API usage.
 */
import type { Env, Logger } from "../types";
import {
  getPaymentRecord,
  putPaymentRecord,
  transitionPayment,
  isTerminalPaymentStatus,
  type PaymentRecord,
} from "./payment-status";
import { getHiroBaseUrl, getHiroHeaders } from "../utils";

const PAYMENT_KEY_PREFIX = "payment:";
/** Only act on records older than this — avoids racing in-flight queue processing. */
const STALE_MS = 5 * 60 * 1000;
/** Cap actions (and thus Hiro calls) per cron run. */
const MAX_ACTIONS_PER_RUN = 25;
const TXID_MAP_TTL_S = 86_400;

interface HiroNonces {
  last_executed_tx_nonce: number | null;
  possible_next_nonce: number | null;
  detected_mempool_nonces?: number[];
}

interface HiroTx {
  tx_id: string;
  nonce: number;
  tx_status: string;
  sponsored?: boolean;
  block_height?: number;
}

/**
 * Scan RELAY_KV for non-terminal payment records and resolve the stuck ones.
 * Safe to call on every cron tick — fail-open and bounded.
 */
export async function reconcileStuckPayments(env: Env, logger: Logger): Promise<void> {
  const kv = env.RELAY_KV;
  if (!kv) return;

  const now = Date.now();
  let scanned = 0;
  let acted = 0;

  try {
    const list = await kv.list({ prefix: PAYMENT_KEY_PREFIX, limit: 1000 });
    // At current volumes one page covers all records. If that ever stops being
    // true, surface it — records past page 1 would be silently skipped this tick.
    if (!list.list_complete) {
      logger.warn("reconcile_stuck_payments_truncated", { limit: 1000 });
    }
    for (const key of list.keys) {
      if (acted >= MAX_ACTIONS_PER_RUN) break;

      const paymentId = key.name.slice(PAYMENT_KEY_PREFIX.length);
      // Defensive: only payment records (artifact keys use a disjoint prefix).
      if (!paymentId.startsWith("pay_")) continue;

      const record = await getPaymentRecord(kv, paymentId).catch(() => null);
      if (!record || isTerminalPaymentStatus(record.status)) continue;

      // Skip recent records — they may still be mid-flight in the queue consumer.
      const startedAt = record.queuedAt ?? record.submittedAt;
      if (startedAt && now - new Date(startedAt).getTime() < STALE_MS) continue;

      // Need a sender identity to look up the on-chain nonce (== null covers null + undefined).
      if (!record.senderAddress || record.senderNonce == null) continue;

      scanned++;
      try {
        if (await reconcileOne(env, kv, logger, record)) acted++;
      } catch (e) {
        logger.warn("reconcile_stuck_payment_error", {
          paymentId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    logger.warn("reconcile_stuck_payments_list_error", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (scanned > 0) {
    logger.info("reconcile_stuck_payments_summary", { scanned, acted });
  }
}

/**
 * Resolve a single stuck record against on-chain state.
 * Returns true if it transitioned the record to a terminal state.
 */
async function reconcileOne(
  env: Env,
  kv: KVNamespace,
  logger: Logger,
  record: PaymentRecord,
): Promise<boolean> {
  const sender = record.senderAddress as string;
  const nonce = record.senderNonce as number;
  const baseUrl = getHiroBaseUrl(env.STACKS_NETWORK);
  const headers = getHiroHeaders(env.HIRO_API_KEY);

  const nonceRes = await fetch(`${baseUrl}/extended/v1/address/${sender}/nonces`, { headers });
  if (!nonceRes.ok) return false; // Hiro unavailable — retry next cron
  const nonces = (await nonceRes.json()) as HiroNonces;
  const lastExec = nonces.last_executed_tx_nonce;

  // Case A: the sender nonce has been consumed on-chain.
  if (typeof lastExec === "number" && nonce <= lastExec) {
    const tx = await fetchSenderTxAtNonce(baseUrl, headers, sender, nonce);
    if (!tx) return false; // can't classify yet — retry next cron

    if (tx.tx_status === "success") {
      if (tx.sponsored) {
        // Relay-sponsored success — this payment DID land. Link txid -> paymentId
        // (so chainhook/poll agree) and confirm so aibtc releases the staged message.
        await kv.put(`txid_map:${tx.tx_id}`, record.paymentId, { expirationTtl: TXID_MAP_TTL_S });
        const updated = transitionPayment(record, "confirmed", {
          txid: tx.tx_id,
          ...(typeof tx.block_height === "number" ? { blockHeight: tx.block_height } : {}),
        });
        await putPaymentRecord(kv, updated);
        logger.info("reconcile_confirmed", {
          paymentId: record.paymentId,
          txid: tx.tx_id,
          senderNonce: nonce,
        });
      } else {
        // A different (self-paid) tx took the nonce — the relay payment was superseded.
        const updated = transitionPayment(record, "replaced", {
          txid: tx.tx_id,
          terminalReason: "superseded",
          replacedReason: "sender_nonce_consumed_by_other_tx",
          resubmittable: false,
        });
        await putPaymentRecord(kv, updated);
        logger.info("reconcile_superseded", {
          paymentId: record.paymentId,
          txid: tx.tx_id,
          senderNonce: nonce,
        });
      }
      return true;
    }

    if (tx.tx_status.startsWith("abort")) {
      const updated = transitionPayment(record, "failed", {
        txid: tx.tx_id,
        error: `Transaction aborted on-chain: ${tx.tx_status}`,
        errorCode: "SETTLEMENT_FAILED",
        terminalReason: "chain_abort",
        retryable: false,
      });
      await putPaymentRecord(kv, updated);
      logger.info("reconcile_aborted", {
        paymentId: record.paymentId,
        txid: tx.tx_id,
        txStatus: tx.tx_status,
      });
      return true;
    }

    // dropped/pending at that nonce — leave for a later cycle.
    return false;
  }

  // Case B: nonce not yet executed.
  const mempool = new Set(nonces.detected_mempool_nonces ?? []);
  if (mempool.has(nonce)) return false; // genuinely in flight — leave it

  // Case C: nonce still open, nothing in the mempool, and the record is stale —
  // the tx never reached the chain. Terminalize so the inbox dedup releases and
  // the agent can resubmit. (Policy: terminalize only — no blind re-broadcast.)
  const updated = transitionPayment(record, "failed", {
    error: "Payment stuck queued past timeout without reaching the chain",
    errorCode: "BROADCAST_EXHAUSTED",
    terminalReason: "internal_error",
    retryable: true,
  });
  await putPaymentRecord(kv, updated);
  logger.info("reconcile_terminalized_stale", {
    paymentId: record.paymentId,
    senderNonce: nonce,
  });
  return true;
}

/**
 * Find the sender's transaction occupying a specific nonce (within recent history).
 * For a stuck payment the target nonce sits at/near the chain frontier, so the
 * recent window covers it; a miss returns null (fail-open — retried next cron).
 *
 * Note: this endpoint caps `limit` at 50 (limit=100 → HTTP 400), so 50 is the
 * max single-page window. If a deeper window is ever needed, paginate via offset.
 */
async function fetchSenderTxAtNonce(
  baseUrl: string,
  headers: Record<string, string>,
  sender: string,
  nonce: number,
): Promise<HiroTx | null> {
  const res = await fetch(`${baseUrl}/extended/v1/address/${sender}/transactions?limit=50`, { headers });
  if (!res.ok) return null;
  // The /extended/v1/address/{principal}/transactions endpoint returns flat tx
  // objects in `results` (not the `{ tx: ... }` wrapper some other endpoints use).
  const data = (await res.json()) as { results?: HiroTx[] };
  for (const tx of data.results ?? []) {
    if (tx.nonce === nonce) return tx;
  }
  return null;
}
