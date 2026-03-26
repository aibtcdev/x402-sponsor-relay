/**
 * POST /webhook/chainhook — Hiro chainhook webhook endpoint.
 *
 * Receives block-level transaction events from registered chainhooks.
 * On tx confirmation: updates payment status → confirmed, updates sender nonce cache.
 * On tx abort: updates payment status → failed.
 *
 * Authenticated via CHAINHOOK_AUTH_TOKEN env var (Bearer token).
 */

import { BaseEndpoint } from "./BaseEndpoint";
import type { AppContext } from "../types";
import {
  getPaymentRecord,
  putPaymentRecord,
  transitionPayment,
} from "../services/payment-status";
import { updateSenderNonceOnConfirm } from "../services/sender-nonce";

/**
 * Shape of a Hiro chainhook transaction event.
 * Simplified to the fields we need — full spec has more.
 */
interface ChainhookTransaction {
  transaction_identifier: {
    hash: string;
  };
  metadata: {
    success: boolean;
    /** Stacks tx status: "success", "abort_by_response", "abort_by_post_condition", etc. */
    result?: string;
    /** Sender's Stacks address */
    sender?: string;
    /** Sender's nonce */
    nonce?: number;
    /** Block height where the tx was included */
    block_height?: number;
  };
}

/**
 * Shape of the Hiro chainhook payload for Stacks.
 */
interface ChainhookPayload {
  /** Array of "apply" blocks with their transactions */
  apply?: Array<{
    block_identifier?: {
      index?: number;
      hash?: string;
    };
    transactions?: ChainhookTransaction[];
  }>;
  /** Rollback events (not used — we only care about apply) */
  rollback?: unknown[];
}

export class Chainhook extends BaseEndpoint {
  schema = {
    tags: ["Webhook"],
    summary: "Chainhook transaction webhook",
    description:
      "Receives Hiro chainhook events for sponsor wallet transactions. Updates payment status and sender nonce cache on confirmation or abort.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              description: "Hiro chainhook payload",
            },
          },
        },
      },
    },
    responses: {
      "200": { description: "Webhook processed" },
      "401": { description: "Invalid or missing auth token" },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);

    // Authenticate with CHAINHOOK_AUTH_TOKEN
    const authToken = c.env.CHAINHOOK_AUTH_TOKEN;
    if (!authToken) {
      logger.error("CHAINHOOK_AUTH_TOKEN not configured");
      return this.err(c, {
        error: "Webhook not configured",
        code: "INTERNAL_ERROR",
        status: 500,
        retryable: false,
      });
    }

    const authHeader = c.req.header("Authorization");
    const providedToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    if (!providedToken || providedToken !== authToken) {
      return this.err(c, {
        error: "Invalid authentication",
        code: "MISSING_API_KEY",
        status: 401,
        retryable: false,
      });
    }

    const kv = c.env.RELAY_KV;
    if (!kv) {
      logger.error("RELAY_KV not configured for chainhook processing");
      return this.err(c, {
        error: "Storage not configured",
        code: "INTERNAL_ERROR",
        status: 500,
        retryable: true,
      });
    }

    // Parse the chainhook payload
    let payload: ChainhookPayload;
    try {
      payload = await c.req.json<ChainhookPayload>();
    } catch {
      return this.err(c, {
        error: "Invalid JSON payload",
        code: "INVALID_TRANSACTION",
        status: 400,
        retryable: false,
      });
    }

    // Process apply blocks
    let processed = 0;
    let updated = 0;

    if (payload.apply && Array.isArray(payload.apply)) {
      for (const block of payload.apply) {
        if (!block.transactions) continue;

        for (const tx of block.transactions) {
          processed++;
          const txid = tx.transaction_identifier?.hash;
          if (!txid) continue;

          const isSuccess = tx.metadata?.success === true;
          const blockHeight =
            tx.metadata?.block_height ?? block.block_identifier?.index;
          const senderNonce = tx.metadata?.nonce;

          // Look up payment record by txid
          // We search using the KV list prefix — but since KV doesn't support
          // secondary indexes, we use a txid→paymentId mapping KV key
          const paymentId = await kv.get(`txid_map:${txid}`, "text");

          if (paymentId) {
            const record = await getPaymentRecord(kv, paymentId);
            if (record && record.status !== "confirmed" && record.status !== "failed") {
              if (isSuccess) {
                const updatedRecord = transitionPayment(record, "confirmed", {
                  blockHeight: blockHeight ?? undefined,
                });
                await putPaymentRecord(kv, updatedRecord);
                updated++;

                logger.info("Chainhook: payment confirmed", {
                  paymentId,
                  txid,
                  blockHeight,
                });
              } else {
                const updatedRecord = transitionPayment(record, "failed", {
                  error: `Transaction aborted on-chain: ${tx.metadata?.result ?? "unknown"}`,
                  errorCode: "SETTLEMENT_FAILED",
                  retryable: false,
                });
                await putPaymentRecord(kv, updatedRecord);
                updated++;

                logger.warn("Chainhook: payment failed (abort)", {
                  paymentId,
                  txid,
                  result: tx.metadata?.result,
                });
              }
            }
          }

          // Update sender nonce cache on confirmation
          if (isSuccess && senderNonce !== undefined && tx.metadata?.sender) {
            // We need the signer hash, not the address. For chainhook events,
            // we store sender address → signer hash mappings when broadcasting.
            // For now, use the address as-is in the KV lookup.
            const signerHash = await kv.get(
              `sender_addr_map:${tx.metadata.sender}`,
              "text"
            );
            if (signerHash) {
              await updateSenderNonceOnConfirm(kv, signerHash, senderNonce);
            }
          }
        }
      }
    }

    logger.info("Chainhook payload processed", { processed, updated });

    return this.ok(c, {
      processed,
      updated,
    });
  }
}
