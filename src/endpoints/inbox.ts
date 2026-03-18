import { deserializeTransaction } from "@stacks/transactions";
import { BaseEndpoint } from "./BaseEndpoint";
import {
  SponsorService,
  SettlementService,
  StatsService,
  ReceiptService,
  StxVerifyService,
  extractSponsorNonce,
  recordNonceTxid,
  releaseNonceDO,
} from "../services";
import { InboxService, MIN_PAYMENT_STX, MIN_PAYMENT_SBTC, MAX_CONTENT_LENGTH } from "../services/inbox";
import { checkRateLimit, RATE_LIMIT } from "../middleware";
import { stripHexPrefix } from "../utils";
import type { AppContext, InboxRequest, SettlementResult } from "../types";
import {
  Error400Response,
  Error401Response,
  Error409Response,
  Error429Response,
  Error500Response,
  Error502Response,
  Error503Response,
} from "../schemas";

/**
 * Inbox endpoint — accepts paid messages for on-chain storage via arc-inbox contract.
 *
 * Flow:
 * 1. Validate message content (non-empty, ≤1024 UTF-8 chars)
 * 2. Validate x402 payment (sponsored STX/sBTC transfer, min 1 STX or 1000 sats)
 * 3. Sponsor & broadcast the payment transaction
 * 4. Build & broadcast a contract-call to arc-inbox.post-message
 * 5. Return {txid, inboxTxid, messageId, status}
 *
 * POST /inbox
 */
export class Inbox extends BaseEndpoint {
  schema = {
    tags: ["Inbox"],
    summary: "Post a paid message to Arc's on-chain inbox",
    description:
      "Accepts a message and an x402 payment transaction. Validates payment (min 1 STX or 1000 sats sBTC), " +
      "sponsors and broadcasts the payment, then posts the message on-chain via the arc-inbox Clarity contract. " +
      "Returns both the payment txid and the inbox contract-call txid.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["content", "transaction", "settle"],
              properties: {
                content: {
                  type: "string" as const,
                  description: "Message content (max 1024 UTF-8 characters)",
                  maxLength: MAX_CONTENT_LENGTH,
                  example: "Hello Arc, I have a question about x402 integration.",
                },
                transaction: {
                  type: "string" as const,
                  description: "Hex-encoded signed sponsored payment transaction (STX or sBTC transfer)",
                  example: "0x00000001...",
                },
                settle: {
                  type: "object" as const,
                  required: ["expectedRecipient", "minAmount"],
                  properties: {
                    expectedRecipient: {
                      type: "string" as const,
                      description: "Expected payment recipient (Arc's Stacks address)",
                      example: "SP2GHQRCRMYY4S8PMBR49BEKX144VR437YT42SF3B",
                    },
                    minAmount: {
                      type: "string" as const,
                      description: `Minimum payment amount (${MIN_PAYMENT_STX} microSTX or ${MIN_PAYMENT_SBTC} sats sBTC)`,
                      example: MIN_PAYMENT_STX,
                    },
                    tokenType: {
                      type: "string" as const,
                      enum: ["STX", "sBTC"],
                      default: "STX",
                      description: "Payment token type (STX or sBTC only for inbox)",
                    },
                    maxTimeoutSeconds: {
                      type: "number" as const,
                      description: "Maximum timeout for payment settlement polling (optional, default 60s)",
                      example: 30,
                    },
                  },
                },
                auth: {
                  type: "object" as const,
                  description: "Optional SIP-018 structured data signature for authentication",
                  properties: {
                    signature: {
                      type: "string" as const,
                      description: "RSV signature of the structured data",
                    },
                    message: {
                      type: "object" as const,
                      required: ["action", "nonce", "expiry"],
                      properties: {
                        action: { type: "string" as const, example: "relay" },
                        nonce: { type: "string" as const, example: "1708099200000" },
                        expiry: { type: "string" as const, example: "1708185600000" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Message posted to on-chain inbox successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: { type: "string" as const, format: "uuid" },
                txid: {
                  type: "string" as const,
                  description: "Payment transaction ID",
                },
                inboxTxid: {
                  type: "string" as const,
                  description: "Inbox contract-call transaction ID",
                },
                messageId: {
                  type: "number" as const,
                  description: "Estimated on-chain message ID",
                },
                explorerUrl: {
                  type: "string" as const,
                  description: "Explorer link for the inbox transaction",
                },
                settlement: {
                  type: "object" as const,
                  properties: {
                    success: { type: "boolean" as const },
                    status: { type: "string" as const, enum: ["pending", "confirmed", "failed"] },
                    sender: { type: "string" as const },
                    recipient: { type: "string" as const },
                    amount: { type: "string" as const },
                    blockHeight: { type: "number" as const },
                  },
                },
                inboxStatus: {
                  type: "string" as const,
                  enum: ["pending", "confirmed"],
                  description: "Status of the inbox contract-call",
                },
                receiptId: { type: "string" as const, format: "uuid" },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "401": { ...Error401Response, description: "Authentication failed (invalid SIP-018 signature)" },
      "409": { ...Error409Response, description: "Nonce conflict — resubmit with a new transaction" },
      "429": { ...Error429Response, description: "Rate limit exceeded" },
      "500": Error500Response,
      "502": { ...Error502Response, description: "Broadcast or network error" },
      "503": { ...Error503Response, description: "Nonce coordinator unavailable" },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Inbox request received");

    const statsService = new StatsService(c.env, logger);

    try {
      const body = (await c.req.json()) as InboxRequest;

      // ── Step 1: Validate message content ──────────────────────────────
      if (!body.content || typeof body.content !== "string") {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return this.err(c, {
          error: "Missing message content",
          code: "MISSING_CONTENT",
          status: 400,
          retryable: false,
        });
      }

      if (body.content.length === 0) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return this.err(c, {
          error: "Empty message content",
          code: "EMPTY_CONTENT",
          status: 400,
          retryable: false,
        });
      }

      if (body.content.length > MAX_CONTENT_LENGTH) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return this.err(c, {
          error: "Message content too long",
          code: "CONTENT_TOO_LONG",
          status: 400,
          details: `Content length ${body.content.length} exceeds maximum ${MAX_CONTENT_LENGTH} characters`,
          retryable: false,
        });
      }

      if (!body.transaction) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return this.err(c, {
          error: "Missing payment transaction",
          code: "MISSING_TRANSACTION",
          status: 400,
          retryable: false,
        });
      }

      if (!body.settle) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return this.err(c, {
          error: "Missing settle options",
          code: "MISSING_SETTLE_OPTIONS",
          status: 400,
          retryable: false,
        });
      }

      // Enforce token type: only STX and sBTC for inbox
      const tokenType = body.settle.tokenType || "STX";
      if (tokenType !== "STX" && tokenType !== "sBTC") {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return this.err(c, {
          error: "Unsupported payment token for inbox",
          code: "INVALID_SETTLE_OPTIONS",
          status: 400,
          details: `Inbox accepts STX or sBTC only, got ${tokenType}`,
          retryable: false,
        });
      }

      // Enforce minimum payment
      const minRequired = tokenType === "sBTC" ? MIN_PAYMENT_SBTC : MIN_PAYMENT_STX;
      try {
        if (BigInt(body.settle.minAmount) < BigInt(minRequired)) {
          c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
          return this.err(c, {
            error: "Payment below inbox minimum",
            code: "INVALID_SETTLE_OPTIONS",
            status: 400,
            details: `Minimum payment is ${minRequired} ${tokenType === "sBTC" ? "sats" : "microSTX"}`,
            retryable: false,
          });
        }
      } catch {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return this.err(c, {
          error: "Invalid minAmount",
          code: "INVALID_SETTLE_OPTIONS",
          status: 400,
          details: "settle.minAmount must be a numeric string",
          retryable: false,
        });
      }

      // ── Step 2: Optional SIP-018 auth ─────────────────────────────────
      if (body.auth) {
        const stxVerifyService = new StxVerifyService(logger, c.env.STACKS_NETWORK);
        const authError = stxVerifyService.verifySip018Auth(body.auth, "relay");
        if (authError) {
          c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
          return this.err(c, {
            error: authError.error,
            code: authError.code,
            status: 401,
            retryable: false,
          });
        }
      }

      // ── Step 3: Validate & sponsor payment transaction ────────────────
      const sponsorService = new SponsorService(c.env, logger);
      const settlementService = new SettlementService(c.env, logger);

      const settleValidation = settlementService.validateSettleOptions(body.settle);
      if (settleValidation.valid === false) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return this.err(c, {
          error: settleValidation.error,
          code: "INVALID_SETTLE_OPTIONS",
          status: 400,
          details: settleValidation.details,
          retryable: false,
        });
      }

      const validation = sponsorService.validateTransaction(body.transaction);
      if (validation.valid === false) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        const code = validation.error === "Transaction must be sponsored"
          ? "NOT_SPONSORED"
          : "INVALID_TRANSACTION";
        return this.err(c, {
          error: validation.error,
          code,
          status: 400,
          details: validation.details,
          retryable: false,
        });
      }

      if (!checkRateLimit(validation.senderAddress)) {
        c.executionCtx.waitUntil(statsService.recordError("rateLimit").catch(() => {}));
        return this.err(c, {
          error: "Rate limit exceeded",
          code: "RATE_LIMIT_EXCEEDED",
          status: 429,
          details: `Maximum ${RATE_LIMIT} requests per minute`,
          retryable: true,
          retryAfter: 60,
        });
      }

      // Dedup check
      const dedupResult = await settlementService.checkDedup(body.transaction);
      if (dedupResult) {
        logger.info("Inbox dedup hit on payment tx", { txid: dedupResult.txid });
        // Payment already processed — still need to post the message
        // Fall through to inbox posting below with the existing payment data
      }

      let paymentTxid: string;
      let settlement: SettlementResult;
      let sponsoredTxHex: string | undefined;
      let receiptId: string | undefined;

      if (dedupResult) {
        paymentTxid = dedupResult.txid;
        settlement = {
          success: true,
          status: dedupResult.status,
          sender: dedupResult.sender,
          recipient: dedupResult.recipient,
          amount: dedupResult.amount,
          blockHeight: dedupResult.blockHeight,
        };
        sponsoredTxHex = dedupResult.sponsoredTx;
        receiptId = dedupResult.receiptId;
      } else {
        // Sponsor the payment transaction
        const sponsorResult = await sponsorService.sponsorTransaction(validation.transaction);
        if (sponsorResult.success === false) {
          return this.sponsorFailureResponse(
            c,
            sponsorResult,
            statsService.recordError("sponsoring").catch(() => {})
          );
        }

        // Verify payment parameters
        const verifyResult = settlementService.verifyPaymentParams(
          sponsorResult.sponsoredTxHex,
          body.settle
        );

        const sponsoredTx = deserializeTransaction(stripHexPrefix(sponsorResult.sponsoredTxHex));
        const sponsorNonce = extractSponsorNonce(sponsoredTx);
        const sponsorWalletIndex = sponsorResult.walletIndex;

        if (!verifyResult.valid) {
          if (sponsorNonce !== null) {
            c.executionCtx.waitUntil(
              releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex).catch(() => {})
            );
          }
          c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
          return this.err(c, {
            error: verifyResult.error,
            code: "SETTLEMENT_VERIFICATION_FAILED",
            status: 400,
            details: verifyResult.details,
            retryable: false,
          });
        }

        // Broadcast payment
        const RELAY_OVERHEAD_MS = 5_000;
        const maxPollTimeMs =
          body.settle.maxTimeoutSeconds != null && body.settle.maxTimeoutSeconds > 0
            ? Math.max(body.settle.maxTimeoutSeconds * 1000 - RELAY_OVERHEAD_MS, 1_000)
            : undefined;
        const broadcastResult = await settlementService.broadcastAndConfirm(
          verifyResult.data.transaction,
          maxPollTimeMs
        );

        if ("error" in broadcastResult) {
          if (sponsorNonce !== null) {
            c.executionCtx.waitUntil(
              releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex).catch(() => {})
            );
          }
          c.executionCtx.waitUntil(statsService.recordError("internal").catch(() => {}));

          if (broadcastResult.nonceConflict) {
            this.scheduleNonceResync(c, sponsorService.resyncNonceDODelayed(), logger);
            return this.err(c, {
              error: "Nonce conflict — resubmit with a new transaction",
              code: "NONCE_CONFLICT",
              status: 409,
              details: broadcastResult.details,
              retryable: true,
              retryAfter: 1,
            });
          }

          return this.err(c, {
            error: broadcastResult.error,
            code: broadcastResult.retryable ? "SETTLEMENT_BROADCAST_FAILED" : "SETTLEMENT_FAILED",
            status: broadcastResult.retryable ? 502 : 422,
            details: broadcastResult.details,
            retryable: broadcastResult.retryable,
            retryAfter: broadcastResult.retryable ? 5 : undefined,
          });
        }

        // Release nonce
        if (sponsorNonce !== null) {
          c.executionCtx.waitUntil(
            releaseNonceDO(c.env, logger, sponsorNonce, broadcastResult.txid, sponsorWalletIndex, sponsorResult.fee).catch(() => {})
          );
          c.executionCtx.waitUntil(
            recordNonceTxid(c.env, logger, broadcastResult.txid, sponsorNonce).catch(() => {})
          );
        }

        paymentTxid = broadcastResult.txid;
        sponsoredTxHex = sponsorResult.sponsoredTxHex;

        const senderAddress = settlementService.senderToAddress(
          verifyResult.data.transaction,
          c.env.STACKS_NETWORK
        );

        settlement = {
          success: true,
          status: broadcastResult.status,
          sender: senderAddress,
          recipient: verifyResult.data.recipient,
          amount: verifyResult.data.amount,
          blockHeight:
            broadcastResult.status === "confirmed"
              ? broadcastResult.blockHeight
              : undefined,
        };

        // Store receipt + dedup
        const receiptService = new ReceiptService(c.env.RELAY_KV, logger);
        const newReceiptId = crypto.randomUUID();
        const storedReceipt = await receiptService.storeReceipt({
          receiptId: newReceiptId,
          senderAddress: validation.senderAddress,
          sponsoredTx: sponsorResult.sponsoredTxHex,
          fee: sponsorResult.fee,
          txid: broadcastResult.txid,
          settlement,
          settleOptions: body.settle,
        });
        receiptId = storedReceipt ? newReceiptId : undefined;

        await settlementService.recordDedup(body.transaction, {
          txid: broadcastResult.txid,
          receiptId,
          status: broadcastResult.status,
          sender: senderAddress,
          recipient: verifyResult.data.recipient,
          amount: verifyResult.data.amount,
          sponsoredTx: sponsorResult.sponsoredTxHex,
          blockHeight:
            broadcastResult.status === "confirmed"
              ? broadcastResult.blockHeight
              : undefined,
        });

        // Log payment stats
        c.executionCtx.waitUntil(
          statsService.logTransaction({
            timestamp: new Date().toISOString(),
            endpoint: "relay",
            success: true,
            tokenType,
            amount: body.settle.minAmount,
            fee: sponsorResult.fee,
            txid: broadcastResult.txid,
            sender: senderAddress,
            recipient: verifyResult.data.recipient,
            status: broadcastResult.status,
            blockHeight:
              broadcastResult.status === "confirmed"
                ? broadcastResult.blockHeight
                : undefined,
          }).catch(() => {})
        );
      }

      // ── Step 4: Post message to arc-inbox contract ────────────────────
      const inboxService = new InboxService(c.env, logger);
      const inboxResult = await inboxService.postMessage(body.content);

      if (!inboxResult.success) {
        // Payment succeeded but inbox posting failed — return partial success
        // The payment is already broadcast, so we return the payment data
        // along with the inbox error
        logger.warn("Payment succeeded but inbox posting failed", {
          paymentTxid,
          inboxError: inboxResult.error,
        });
        return this.ok(c, {
          txid: paymentTxid,
          inboxTxid: null,
          messageId: null,
          settlement,
          inboxStatus: "failed",
          inboxError: inboxResult.error,
          inboxDetails: inboxResult.details,
          receiptId,
        });
      }

      // ── Step 5: Return combined result ────────────────────────────────
      logger.info("Inbox message posted successfully", {
        paymentTxid,
        inboxTxid: inboxResult.inboxTxid,
        messageId: inboxResult.messageId,
      });

      return this.ok(c, {
        txid: paymentTxid,
        inboxTxid: inboxResult.inboxTxid,
        messageId: inboxResult.messageId,
        explorerUrl: `https://explorer.hiro.so/txid/${inboxResult.inboxTxid}?chain=${c.env.STACKS_NETWORK}`,
        settlement,
        inboxStatus: inboxResult.status,
        ...(inboxResult.blockHeight !== undefined && {
          inboxBlockHeight: inboxResult.blockHeight,
        }),
        receiptId,
      });
    } catch (e) {
      logger.error("Unexpected error in inbox handler", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      c.executionCtx.waitUntil(statsService.recordError("internal").catch(() => {}));
      return this.err(c, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
        retryAfter: 5,
      });
    }
  }
}
