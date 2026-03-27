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
  recordBroadcastOutcomeDO,
  queueDispatchDO,
} from "../services";
import { checkRateLimit, RATE_LIMIT, checkAndRecordMalformed, MALFORMED_BLOCK_THRESHOLD } from "../middleware";
import { stripHexPrefix } from "../utils";
import type { AppContext, RelayRequest, SettlementResult, Logger } from "../types";
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
 * Relay endpoint - sponsors and settles transactions
 * POST /relay
 */
export class Relay extends BaseEndpoint {
  schema = {
    tags: ["Relay"],
    summary: "Submit sponsored transaction for settlement",
    description:
      "Accepts a pre-signed sponsored transaction, sponsors it with the relay's key, verifies payment locally, and broadcasts directly to the Stacks network.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["transaction", "settle"],
              properties: {
                transaction: {
                  type: "string" as const,
                  description: "Hex-encoded signed sponsored transaction",
                  example: "0x00000001...",
                },
                settle: {
                  type: "object" as const,
                  required: ["expectedRecipient", "minAmount"],
                  properties: {
                    expectedRecipient: {
                      type: "string" as const,
                      description: "Expected recipient address",
                      example: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
                    },
                    minAmount: {
                      type: "string" as const,
                      description:
                        "Minimum amount required (in smallest unit - microSTX, sats, etc.)",
                      example: "1000000",
                    },
                    tokenType: {
                      type: "string" as const,
                      enum: ["STX", "sBTC", "USDCx"],
                      default: "STX",
                      description: "Token type for payment",
                    },
                    expectedSender: {
                      type: "string" as const,
                      description: "Expected sender address (optional)",
                    },
                    resource: {
                      type: "string" as const,
                      description: "API resource being accessed (optional)",
                    },
                    method: {
                      type: "string" as const,
                      description: "HTTP method being used (optional)",
                    },
                    maxTimeoutSeconds: {
                      type: "number" as const,
                      description:
                        "Maximum timeout in seconds for settlement polling (optional, caps broadcastAndConfirm; default 60s)",
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
                      example: "0x1234...",
                    },
                    message: {
                      type: "object" as const,
                      required: ["action", "nonce", "expiry"],
                      properties: {
                        action: {
                          type: "string" as const,
                          description: "Action being performed (should be 'relay')",
                          example: "relay",
                        },
                        nonce: {
                          type: "string" as const,
                          description: "Unix timestamp ms for replay protection",
                          example: "1708099200000",
                        },
                        expiry: {
                          type: "string" as const,
                          description: "Expiry timestamp (unix ms) for time-bound authorization",
                          example: "1708185600000",
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
    },
    responses: {
      "200": {
        description: "Transaction sponsored and settled successfully",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: true },
                requestId: {
                  type: "string" as const,
                  format: "uuid",
                  description: "Unique request identifier for tracking",
                  example: "550e8400-e29b-41d4-a716-446655440000",
                },
                txid: {
                  type: "string" as const,
                  description: "Transaction ID",
                  example: "0x1234...",
                },
                explorerUrl: {
                  type: "string" as const,
                  description: "Link to view transaction on Hiro Explorer",
                  example: "https://explorer.hiro.so/txid/0x1234...?chain=testnet",
                },
                settlement: {
                  type: "object" as const,
                  properties: {
                    success: { type: "boolean" as const },
                    status: {
                      type: "string" as const,
                      enum: ["pending", "confirmed", "failed"],
                    },
                    sender: { type: "string" as const, description: "Sender Stacks address (c32check-encoded, human-readable)" },
                    recipient: { type: "string" as const },
                    amount: { type: "string" as const },
                    blockHeight: { type: "number" as const },
                  },
                },
                sponsoredTx: {
                  type: "string" as const,
                  description: "Hex-encoded fully-sponsored transaction (can be used as X-PAYMENT header value)",
                  example: "0x00000001...",
                },
                receiptId: {
                  type: "string" as const,
                  format: "uuid",
                  description: "Receipt token for verifying payment via GET /verify/:receiptId",
                  example: "550e8400-e29b-41d4-a716-446655440000",
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "401": { ...Error401Response, description: "Authentication failed (invalid or expired SIP-018 signature)" },
      "409": { ...Error409Response, description: "Nonce conflict — resubmit with a new transaction" },
      "429": { ...Error429Response, description: "Rate limit exceeded" },
      "500": Error500Response,
      "502": { ...Error502Response, description: "Broadcast or network error" },
      "503": { ...Error503Response, description: "Nonce coordinator unavailable — retry after delay" },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Relay request received");

    const statsService = new StatsService(c.env, logger);

    try {
      const body = (await c.req.json()) as RelayRequest;

      if (!body.transaction) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("relay", true).catch(() => {}));
        return this.err(c, {
          error: "Missing transaction field",
          code: "MISSING_TRANSACTION",
          status: 400,
          retryable: false,
        });
      }

      if (!body.settle) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("relay", true).catch(() => {}));
        return this.err(c, {
          error: "Missing settle options",
          code: "MISSING_SETTLE_OPTIONS",
          status: 400,
          retryable: false,
        });
      }

      if (body.auth) {
        const stxVerifyService = new StxVerifyService(logger, c.env.STACKS_NETWORK);
        const authError = stxVerifyService.verifySip018Auth(body.auth, "relay");
        if (authError) {
          c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
          c.executionCtx.waitUntil(statsService.logFailure("relay", true).catch(() => {}));
          return this.err(c, {
            error: authError.error,
            code: authError.code,
            status: 401,
            retryable: false,
          });
        }
      }

      const sponsorService = new SponsorService(c.env, logger);
      const settlementService = new SettlementService(c.env, logger);

      const settleValidation = settlementService.validateSettleOptions(
        body.settle
      );
      if (settleValidation.valid === false) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("relay", true, { tokenType: body.settle.tokenType, amount: body.settle.minAmount ?? "0" }).catch(() => {}));
        return this.err(c, {
          error: settleValidation.error,
          code: "INVALID_SETTLE_OPTIONS",
          status: 400,
          details: settleValidation.details,
          retryable: false,
        });
      }

      // Detect self-pay mode: X-Settlement: self-pay bypasses sponsoring entirely.
      // The caller provides a pre-signed standard (non-sponsored) transaction and
      // covers their own fees. The relay only verifies payment params and broadcasts.
      const settlementHeader = c.req.header("X-Settlement");
      if (settlementHeader?.toLowerCase() === "self-pay") {
        return this.handleSelfPay(c, body, sponsorService, settlementService, statsService, logger);
      }

      const clientIp = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null;
      const validation = sponsorService.validateTransaction(body.transaction);
      if (validation.valid === false) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("relay", true, { tokenType: body.settle.tokenType, amount: body.settle.minAmount }).catch(() => {}));
        if (validation.error === "Malformed transaction payload") {
          const blocked = clientIp ? checkAndRecordMalformed(clientIp) : false;
          if (blocked) {
            logger.warn("IP blocked for repeated malformed payloads", { ip: clientIp });
            return this.err(c, {
              error: "Too many malformed transaction payloads — try again later",
              code: "RATE_LIMIT_EXCEEDED",
              status: 429,
              details: `Submitted ${MALFORMED_BLOCK_THRESHOLD}+ malformed payloads within 10 minutes`,
              retryable: true,
              retryAfter: 600,
            });
          }
          return this.err(c, {
            error: validation.error,
            code: "MALFORMED_PAYLOAD",
            status: 400,
            details: validation.details,
            retryable: false,
          });
        }
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
        logger.warn("Rate limit exceeded", { sender: validation.senderAddress });
        c.executionCtx.waitUntil(statsService.recordError("rateLimit").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("relay", true, { tokenType: body.settle.tokenType, amount: body.settle.minAmount }).catch(() => {}));
        return this.err(c, {
          error: "Rate limit exceeded",
          code: "RATE_LIMIT_EXCEEDED",
          status: 429,
          details: `Maximum ${RATE_LIMIT} requests per minute`,
          retryable: true,
          retryAfter: 60,
        });
      }

      // Step A — Dedup check on original tx (stable across retries with different sponsor nonces).
      // Runs before the conflict cooldown so that idempotent retries of already-succeeded
      // transactions return the cached success even if the sender is in a conflict window.
      const dedupResult = await settlementService.checkDedup(body.transaction);
      if (dedupResult) {
        logger.info("Dedup hit, returning cached result", {
          txid: dedupResult.txid,
          status: dedupResult.status,
        });
        return this.okWithTx(c, {
          txid: dedupResult.txid,
          settlement: {
            success: true,
            status: dedupResult.status,
            sender: dedupResult.sender,
            recipient: dedupResult.recipient,
            amount: dedupResult.amount,
            blockHeight: dedupResult.blockHeight,
          },
          sponsoredTx: dedupResult.sponsoredTx,
          receiptId: dedupResult.receiptId,
        });
      }

      // Step A1 — Sender conflict cooldown: short-circuit if sender recently hit a nonce
      // conflict or too-much-chaining error. Prevents the assign→broadcast→conflict→quarantine
      // cycle from repeating on every agent retry during a nonce storm.
      const senderConflictKey = `conflict:${validation.senderAddress}`;
      const cachedConflict = c.env.RELAY_KV ? await c.env.RELAY_KV.get(senderConflictKey, "text") : null;
      if (cachedConflict) {
        try {
          const conflict = JSON.parse(cachedConflict) as { code: "NONCE_CONFLICT" | "TOO_MUCH_CHAINING"; retryAfter: number; setAt: number };
          const remainingMs = conflict.retryAfter * 1000 - (Date.now() - conflict.setAt);
          const remainingS = Math.ceil(remainingMs / 1000);
          if (remainingS > 0) {
            logger.warn("Sender in conflict cooldown — short-circuiting request", {
              sender: validation.senderAddress,
              code: conflict.code,
              remainingS,
            });
            const isConflict = conflict.code === "NONCE_CONFLICT";
            return this.err(c, {
              error: isConflict
                ? "Nonce conflict — back off and retry. Check GET /nonce/stats for nonce pool state"
                : "Sponsor wallet congested — too many pending transactions. Back off and retry",
              code: conflict.code,
              status: isConflict ? 409 : 429,
              details: `Sender is in a ${conflict.retryAfter}s conflict cooldown. Remaining: ${remainingS}s`,
              retryable: true,
              retryAfter: remainingS,
            });
          }
        } catch {
          // Malformed KV value — ignore and proceed normally
        }
      }

      // Step B — Sponsor the transaction (routes through gin rummy hand-submit when NONCE_DO configured)
      const sponsorResult = await sponsorService.sponsorTransaction(
        validation.transaction,
        body.transaction  // pass original hex for hand-submit sender nonce tracking
      );
      if (sponsorResult.success === false) {
        // Gin rummy: tx held in sender hand — nonce gap exists, agent must submit missing nonces
        if ("held" in sponsorResult && sponsorResult.held) {
          return c.json({
            success: false,
            held: true,
            nextExpected: sponsorResult.nextExpected,
            missingNonces: sponsorResult.missingNonces,
            expiresAt: sponsorResult.expiresAt,
            message: "Transaction held pending nonce gap fill. Submit the missing nonces to dispatch.",
          }, 202);
        }
        return this.sponsorFailureResponse(
          c,
          sponsorResult as { error: string; details: string; code?: string; retryAfter?: number },
          statsService.recordError("sponsoring").catch(() => {})
        );
      }

      // Step C — Verify payment parameters locally
      const verifyResult = settlementService.verifyPaymentParams(
        sponsorResult.sponsoredTxHex,
        body.settle
      );

      // Deserialize early so we can extract the nonce before broadcast —
      // needed to release on verify failure (nonce leak fix, see #95)
      const sponsoredTx = deserializeTransaction(stripHexPrefix(sponsorResult.sponsoredTxHex));
      const sponsorNonce = extractSponsorNonce(sponsoredTx);
      // walletIndex from NonceDO assignment — routes release to the correct per-wallet pool
      const sponsorWalletIndex = sponsorResult.walletIndex;

      if (!verifyResult.valid) {
        // Release the nonce back to the pool — verify failed before broadcast
        if (sponsorNonce !== null) {
          c.executionCtx.waitUntil(
            releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex).catch((e) => {
              logger.warn("Failed to release nonce after verify failure", { error: String(e) });
            })
          );
        }
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("relay", true, { tokenType: body.settle.tokenType, amount: body.settle.minAmount }).catch(() => {}));
        return this.err(c, {
          error: verifyResult.error,
          code: "SETTLEMENT_VERIFICATION_FAILED",
          status: 400,
          details: verifyResult.details,
          retryable: false,
        });
      }

      // Step D — Broadcast and poll for confirmation.
      // Cap poll time to caller's maxTimeoutSeconds so the relay responds
      // before the caller's own timeout fires (avoids 500 empty-body errors).
      // Reserve 5s for broadcast overhead, sponsoring, and response serialization.
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
        // Record broadcast outcome in the intent ledger — this is the authoritative
        // record of what happened. releaseNonceDO() handles pool-maintenance (expiry
        // for unused nonces). Never pass synthetic txids — txid is reserved for real txids.
        if (sponsorNonce !== null) {
          c.executionCtx.waitUntil(
            recordBroadcastOutcomeDO(
              c.env, logger, sponsorNonce, sponsorWalletIndex,
              undefined, broadcastResult.httpStatus, broadcastResult.nodeUrl, broadcastResult.details
            ).catch((e) => {
              logger.warn("Failed to record broadcast outcome", { error: String(e) });
            })
          );
          // Release nonce without txid — ledgerBroadcastOutcome already set the correct
          // state (conflict/failed). releaseNonce sees non-assigned state and no-ops.
          c.executionCtx.waitUntil(
            releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex).catch((e) => {
              logger.warn("Failed to release nonce after broadcast failure", { error: String(e) });
            })
          );
        }

        const clientRejection = broadcastResult.clientRejection;
        const isClientError = clientRejection !== undefined;

        c.executionCtx.waitUntil(statsService.recordError(isClientError ? "validation" : "internal").catch(() => {}));
        c.executionCtx.waitUntil(
          statsService.logFailure("relay", isClientError, {
            tokenType: body.settle.tokenType || "STX",
            amount: body.settle.minAmount,
            fee: sponsorResult.fee,
            sender: validation.senderAddress,
            recipient: body.settle.expectedRecipient,
          }).catch(() => {})
        );

        // On the sponsored path, nonce conflicts are ambiguous — the Stacks node doesn't
        // say whose nonce conflicted (client vs sponsor). Since the relay has a sponsor
        // nonce pool that needs resync on conflict, check nonceConflict FIRST to ensure
        // the pool gets resynced. For non-nonce client rejections (NotEnoughFunds, etc.),
        // return actionable error codes via clientRejectionResponse.
        //
        // Sponsor-side issues (nonce conflict or TooMuchChaining) → inline resync + single retry.
        // Mirror the pattern in settle.ts:494-583: await resync, re-sponsor, re-verify, re-broadcast.
        // Only fall back to 409/429 if the retry also fails.
        if (broadcastResult.nonceConflict || broadcastResult.tooMuchChaining) {
          const retryReason = broadcastResult.nonceConflict ? "nonce_conflict" : "too_much_chaining";
          logger.warn("Sponsor wallet issue on relay — attempting inline resync + retry", {
            reason: retryReason,
            sponsorNonce,
            walletIndex: sponsorWalletIndex,
          });

          // Inline resync: await directly so the DO is consistent before we re-sponsor.
          // No delay needed — the conflicting tx was already broadcast before this error,
          // so Hiro's mempool index has already indexed it.
          await sponsorService.resyncNonceDO();

          const retrySponsorResult = await sponsorService.sponsorTransaction(validation.transaction);
          if (retrySponsorResult.success) {
            const retryTx = deserializeTransaction(stripHexPrefix(retrySponsorResult.sponsoredTxHex));
            const retryNonce = extractSponsorNonce(retryTx);
            const retryWalletIndex = retrySponsorResult.walletIndex;
            const retryFee = retrySponsorResult.fee;

            const retryVerifyResult = settlementService.verifyPaymentParams(retrySponsorResult.sponsoredTxHex, body.settle);
            if (retryVerifyResult.valid) {
              const retryBroadcastResult = await settlementService.broadcastAndConfirm(
                retryVerifyResult.data.transaction,
                maxPollTimeMs
              );
              if (!("error" in retryBroadcastResult)) {
                logger.info("Retry after inline resync succeeded", {
                  txid: retryBroadcastResult.txid,
                  retryNonce,
                  retryWalletIndex,
                });

                if (retryNonce !== null) {
                  c.executionCtx.waitUntil(
                    releaseNonceDO(c.env, logger, retryNonce, retryBroadcastResult.txid, retryWalletIndex, retryFee).catch((e) => {
                      logger.warn("Failed to consume retry nonce after broadcast success", { error: String(e) });
                    })
                  );
                  c.executionCtx.waitUntil(
                    recordNonceTxid(c.env, logger, retryBroadcastResult.txid, retryNonce).catch((e) => {
                      logger.warn("Failed to record retry nonce txid", { error: String(e) });
                    })
                  );
                  c.executionCtx.waitUntil(
                    recordBroadcastOutcomeDO(
                      c.env, logger, retryNonce, retryWalletIndex,
                      retryBroadcastResult.txid, 200, undefined, undefined
                    ).catch((e) => {
                      logger.warn("Failed to record retry broadcast outcome", { error: String(e) });
                    })
                  );
                  c.executionCtx.waitUntil(
                    queueDispatchDO(
                      c.env, logger, retryWalletIndex,
                      body.transaction, validation.senderAddress,
                      Number(validation.transaction.auth.spendingCondition.nonce),
                      retryNonce,
                      retryFee
                    ).catch((e) => {
                      logger.warn("Failed to record retry queue dispatch", { error: String(e) });
                    })
                  );
                }

                const retryTokenType = body.settle.tokenType || "STX";
                const retrySenderAddress = settlementService.senderToAddress(
                  retryVerifyResult.data.transaction,
                  c.env.STACKS_NETWORK
                );
                const retryConfirmedBlockHeight =
                  retryBroadcastResult.status === "confirmed"
                    ? retryBroadcastResult.blockHeight
                    : undefined;

                c.executionCtx.waitUntil(
                  statsService.logTransaction({
                    timestamp: new Date().toISOString(),
                    endpoint: "relay",
                    success: true,
                    tokenType: retryTokenType,
                    amount: body.settle.minAmount,
                    fee: retryFee,
                    txid: retryBroadcastResult.txid,
                    sender: retrySenderAddress,
                    recipient: retryVerifyResult.data.recipient,
                    status: retryBroadcastResult.status,
                    blockHeight: retryConfirmedBlockHeight,
                  }).catch(() => {})
                );

                const retrySettlement: SettlementResult = {
                  success: true,
                  status: retryBroadcastResult.status,
                  sender: retrySenderAddress,
                  recipient: retryVerifyResult.data.recipient,
                  amount: retryVerifyResult.data.amount,
                  blockHeight: retryConfirmedBlockHeight,
                };

                const retryReceiptService = new ReceiptService(c.env.RELAY_KV, logger);
                const retryReceiptId = crypto.randomUUID();
                const retryStoredReceipt = await retryReceiptService.storeReceipt({
                  receiptId: retryReceiptId,
                  senderAddress: validation.senderAddress,
                  sponsoredTx: retrySponsorResult.sponsoredTxHex,
                  fee: retryFee,
                  txid: retryBroadcastResult.txid,
                  settlement: retrySettlement,
                  settleOptions: body.settle,
                });

                await settlementService.recordDedup(body.transaction, {
                  txid: retryBroadcastResult.txid,
                  receiptId: retryStoredReceipt ? retryReceiptId : undefined,
                  status: retryBroadcastResult.status,
                  sender: retrySenderAddress,
                  recipient: retryVerifyResult.data.recipient,
                  amount: retryVerifyResult.data.amount,
                  sponsoredTx: retrySponsorResult.sponsoredTxHex,
                  blockHeight: retryConfirmedBlockHeight,
                });

                logger.info("Transaction sponsored and settled (after inline resync retry)", {
                  txid: retryBroadcastResult.txid,
                  sender: retrySenderAddress,
                  settlement_status: retryBroadcastResult.status,
                  receiptId: retryStoredReceipt ? retryReceiptId : undefined,
                });

                return this.okWithTx(c, {
                  txid: retryBroadcastResult.txid,
                  settlement: retrySettlement,
                  sponsoredTx: retrySponsorResult.sponsoredTxHex,
                  receiptId: retryStoredReceipt ? retryReceiptId : undefined,
                });
              } else {
                // Retry broadcast also failed — release retry nonce, fall through to error
                logger.warn("Retry broadcast after inline resync also failed", {
                  error: retryBroadcastResult.error,
                });
                if (retryNonce !== null) {
                  c.executionCtx.waitUntil(
                    Promise.all([
                      recordBroadcastOutcomeDO(
                        c.env, logger, retryNonce, retryWalletIndex,
                        undefined, retryBroadcastResult.httpStatus, retryBroadcastResult.nodeUrl, retryBroadcastResult.details
                      ),
                      releaseNonceDO(c.env, logger, retryNonce, undefined, retryWalletIndex),
                    ]).catch((e) => {
                      logger.warn("Failed nonce lifecycle after retry broadcast failure", { error: String(e) });
                    })
                  );
                }
              }
            } else {
              // Retry verify failed — release retry nonce, fall through to error
              logger.warn("Retry verify failed after inline resync", { error: retryVerifyResult.error });
              if (retryNonce !== null) {
                c.executionCtx.waitUntil(
                  releaseNonceDO(c.env, logger, retryNonce, undefined, retryWalletIndex).catch((e) => {
                    logger.warn("Failed to release retry nonce after verify failure", { error: String(e) });
                  })
                );
              }
            }
          } else if (!("held" in retrySponsorResult && retrySponsorResult.held)) {
            logger.warn("Retry sponsor failed after inline resync", {
              error: (retrySponsorResult as { error: string }).error,
              code: (retrySponsorResult as { code?: string }).code,
            });
          }

          // Retry did not succeed — schedule a delayed resync so the pool self-heals,
          // then return the appropriate error code.
          this.scheduleNonceResync(c, sponsorService.resyncNonceDODelayed(), logger);
          const conflictTtl = await this.getPoolPressureRetryAfter(c.env);
          const conflictCode = broadcastResult.nonceConflict ? "NONCE_CONFLICT" as const : "TOO_MUCH_CHAINING" as const;
          this.writeSenderConflict(c, validation.senderAddress, conflictCode, conflictTtl, logger);
          const isConflict = conflictCode === "NONCE_CONFLICT";
          return this.err(c, {
            error: isConflict
              ? "Nonce conflict — back off and retry. Check GET /nonce/stats for nonce pool state"
              : "Sponsor wallet congested — too many pending transactions. Back off and retry",
            code: conflictCode,
            status: isConflict ? 409 : 429,
            details: broadcastResult.details,
            retryable: true,
            retryAfter: conflictTtl,
          });
        }

        // Client rejections (NotEnoughFunds, FeeTooLow, TooMuchChaining on self-pay, etc.)
        if (clientRejection) {
          logger.warn("Broadcast rejected by node (client error)", {
            clientRejection,
            details: broadcastResult.details,
          });
          return this.clientRejectionResponse(c, clientRejection, broadcastResult.details);
        }

        // Distinguish retryable broadcast failures from non-retryable on-chain failures
        return this.err(c, {
          error: broadcastResult.error,
          code: broadcastResult.retryable ? "SETTLEMENT_BROADCAST_FAILED" : "SETTLEMENT_FAILED",
          status: broadcastResult.retryable ? 502 : 422,
          details: broadcastResult.details,
          retryable: broadcastResult.retryable,
          retryAfter: broadcastResult.retryable ? 5 : undefined,
        });
      }

      if (sponsorNonce !== null) {
        // Consume the nonce (broadcast succeeded) — removes from reserved, not returned to available
        // Also records the fee in NonceDO's cumulative per-wallet fee stats
        c.executionCtx.waitUntil(
          releaseNonceDO(c.env, logger, sponsorNonce, broadcastResult.txid, sponsorWalletIndex, sponsorResult.fee).catch((e) => {
            logger.warn("Failed to consume nonce after broadcast success", { error: String(e) });
          })
        );
        // Also record nonce→txid mapping in NonceDO SQL table for gap detection
        c.executionCtx.waitUntil(
          recordNonceTxid(c.env, logger, broadcastResult.txid, sponsorNonce).catch((e) => {
            logger.warn("Failed to record nonce txid", { error: String(e) });
          })
        );
        // Record broadcast outcome for ledger fidelity (state='broadcasted', http_status=200, txid)
        c.executionCtx.waitUntil(
          recordBroadcastOutcomeDO(
            c.env, logger, sponsorNonce, sponsorWalletIndex,
            broadcastResult.txid, 200, undefined, undefined  // success path — no nodeUrl available from polling result
          ).catch((e) => {
            logger.warn("Failed to record broadcast outcome", { error: String(e) });
          })
        );
        // Record in dispatch queue for stuck-tx flush and replay tracking
        c.executionCtx.waitUntil(
          queueDispatchDO(
            c.env, logger, sponsorWalletIndex,
            body.transaction, validation.senderAddress,
            Number(validation.transaction.auth.spendingCondition.nonce),
            sponsorNonce,
            sponsorResult.fee
          ).catch((e) => {
            logger.warn("Failed to record queue dispatch", { error: String(e) });
          })
        );
      }

      // Step E — Derive common fields (reused for stats, settlement, dedup)
      const tokenType = body.settle.tokenType || "STX";
      const senderAddress = settlementService.senderToAddress(
        verifyResult.data.transaction,
        c.env.STACKS_NETWORK
      );
      const confirmedBlockHeight =
        broadcastResult.status === "confirmed"
          ? broadcastResult.blockHeight
          : undefined;

      // Record successful transaction stats (fire-and-forget, never blocks response)
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
          blockHeight: confirmedBlockHeight,
        }).catch(() => {})
      );

      // Step F — Build settlement result and store payment receipt
      const settlement: SettlementResult = {
        success: true,
        status: broadcastResult.status,
        sender: senderAddress,
        recipient: verifyResult.data.recipient,
        amount: verifyResult.data.amount,
        blockHeight: confirmedBlockHeight,
      };

      const receiptService = new ReceiptService(c.env.RELAY_KV, logger);
      const receiptId = crypto.randomUUID();
      const storedReceipt = await receiptService.storeReceipt({
        receiptId,
        senderAddress: validation.senderAddress,
        sponsoredTx: sponsorResult.sponsoredTxHex,
        fee: sponsorResult.fee,
        txid: broadcastResult.txid,
        settlement,
        settleOptions: body.settle,
      });

      // Step G — Record dedup entry keyed on original tx for idempotent retries
      await settlementService.recordDedup(body.transaction, {
        txid: broadcastResult.txid,
        receiptId: storedReceipt ? receiptId : undefined,
        status: broadcastResult.status,
        sender: senderAddress,
        recipient: verifyResult.data.recipient,
        amount: verifyResult.data.amount,
        sponsoredTx: sponsorResult.sponsoredTxHex,
        blockHeight: confirmedBlockHeight,
      });

      // Step H — Log and return
      logger.info("Transaction sponsored and settled", {
        txid: broadcastResult.txid,
        sender: senderAddress,
        settlement_status: broadcastResult.status,
        receiptId: storedReceipt ? receiptId : undefined,
      });

      return this.okWithTx(c, {
        txid: broadcastResult.txid,
        settlement,
        sponsoredTx: sponsorResult.sponsoredTxHex,
        receiptId: storedReceipt ? receiptId : undefined,
      });
    } catch (e) {
      logger.error("Unexpected error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      c.executionCtx.waitUntil(statsService.recordError("internal").catch(() => {}));
      c.executionCtx.waitUntil(statsService.logFailure("relay", false).catch(() => {}));
      return this.err(c, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true, // Unexpected errors might be transient
        retryAfter: 5,
      });
    }
  }

  /**
   * Write a sender conflict record to KV so subsequent retries from the same sender
   * short-circuit without assigning a nonce or hitting the mempool.
   */
  private writeSenderConflict(
    c: AppContext,
    senderAddress: string,
    code: "NONCE_CONFLICT" | "TOO_MUCH_CHAINING",
    retryAfter: number,
    logger: Logger
  ): void {
    if (!c.env.RELAY_KV) return;
    c.executionCtx.waitUntil(
      c.env.RELAY_KV.put(
        `conflict:${senderAddress}`,
        JSON.stringify({ code, retryAfter, setAt: Date.now() }),
        { expirationTtl: retryAfter }
      ).catch((e) => {
        logger.warn("Failed to write sender conflict record", { error: String(e) });
      })
    );
  }

  /**
   * Handle self-pay settlement (X-Settlement: self-pay).
   *
   * The caller provides a fully-signed standard (non-sponsored) transaction and
   * covers their own network fees. The relay skips sponsoring and only:
   *   1. Validates and deserializes the transaction (must NOT be sponsored)
   *   2. Applies rate limiting by sender
   *   3. Checks the dedup cache for idempotent retries
   *   4. Verifies payment parameters (recipient, amount, token type)
   *   5. Broadcasts and polls for confirmation
   *   6. Records stats and dedup entry
   *
   * Response format is identical to the sponsored path. sponsoredTx is null
   * since no sponsor signature was applied.
   */
  private async handleSelfPay(
    c: AppContext,
    body: RelayRequest,
    sponsorService: SponsorService,
    settlementService: SettlementService,
    statsService: StatsService,
    logger: Logger
  ): Promise<Response> {
    logger.info("Self-pay settlement requested");

    // Step SP-A — Validate transaction (standard auth only; reject sponsored)
    const validation = sponsorService.validateNonSponsoredTransaction(body.transaction);
    if (validation.valid === false) {
      c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
      c.executionCtx.waitUntil(statsService.logFailure("relay", true, { tokenType: body.settle.tokenType, amount: body.settle.minAmount }).catch(() => {}));
      return this.err(c, {
        error: validation.error,
        code: "INVALID_TRANSACTION",
        status: 400,
        details: validation.details,
        retryable: false,
      });
    }

    // Step SP-B — Rate limit by sender (same policy as sponsored path)
    if (!checkRateLimit(validation.senderAddress)) {
      logger.warn("Rate limit exceeded (self-pay)", { sender: validation.senderAddress });
      c.executionCtx.waitUntil(statsService.recordError("rateLimit").catch(() => {}));
      c.executionCtx.waitUntil(statsService.logFailure("relay", true, { tokenType: body.settle.tokenType, amount: body.settle.minAmount }).catch(() => {}));
      return this.err(c, {
        error: "Rate limit exceeded",
        code: "RATE_LIMIT_EXCEEDED",
        status: 429,
        details: `Maximum ${RATE_LIMIT} requests per minute`,
        retryable: true,
        retryAfter: 60,
      });
    }

    // Step SP-C — Dedup check (keyed on original tx hex for idempotent retries)
    const dedupResult = await settlementService.checkDedup(body.transaction);
    if (dedupResult) {
      logger.info("Self-pay dedup hit, returning cached result", {
        txid: dedupResult.txid,
        status: dedupResult.status,
      });
      return this.okWithTx(c, {
        txid: dedupResult.txid,
        settlement: {
          success: true,
          status: dedupResult.status,
          sender: dedupResult.sender,
          recipient: dedupResult.recipient,
          amount: dedupResult.amount,
          blockHeight: dedupResult.blockHeight,
        },
        sponsoredTx: undefined,
        receiptId: dedupResult.receiptId,
      });
    }

    // Step SP-D — Verify payment parameters (recipient, amount, token type)
    // verifyPaymentParams is auth-agnostic — it works on any deserialized tx
    const verifyResult = settlementService.verifyPaymentParams(
      body.transaction,
      body.settle
    );
    if (!verifyResult.valid) {
      c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
      c.executionCtx.waitUntil(statsService.logFailure("relay", true, { tokenType: body.settle.tokenType, amount: body.settle.minAmount }).catch(() => {}));
      return this.err(c, {
        error: verifyResult.error,
        code: "SETTLEMENT_VERIFICATION_FAILED",
        status: 400,
        details: verifyResult.details,
        retryable: false,
      });
    }

    // Step SP-E — Broadcast and poll for confirmation
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
      const clientRejection = broadcastResult.clientRejection;
      const isClientError = clientRejection !== undefined;

      c.executionCtx.waitUntil(statsService.recordError(isClientError ? "validation" : "internal").catch(() => {}));
      c.executionCtx.waitUntil(
        statsService.logFailure("relay", isClientError, {
          tokenType: body.settle.tokenType || "STX",
          amount: body.settle.minAmount,
          fee: "0",
          sender: validation.senderAddress,
          recipient: body.settle.expectedRecipient,
        }).catch(() => {})
      );

      // Map client-caused Stacks node rejections to distinct actionable error codes.
      // Self-pay has no sponsor nonce pool, so nonce errors are always client errors.
      // clientRejection covers nonce errors too (BadNonce, ConflictingNonceInMempool).
      if (clientRejection) {
        logger.warn("Self-pay broadcast rejected by node (client error)", {
          clientRejection,
          details: broadcastResult.details,
        });
        return this.clientRejectionResponse(c, clientRejection, broadcastResult.details);
      }

      // Safety net: nonceConflict without clientRejection should not happen after the
      // settlement.ts fix, but handle defensively in case of future changes.
      if (broadcastResult.nonceConflict) {
        logger.warn("Self-pay nonce conflict (no clientRejection matched)", {
          details: broadcastResult.details,
        });
        return this.err(c, {
          error: "Sender nonce conflict — re-sign the transaction with the correct account nonce",
          code: "CLIENT_BAD_NONCE",
          status: 422,
          details: broadcastResult.details,
          retryable: true,
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

    // Step SP-F — Derive common fields
    const tokenType = body.settle.tokenType || "STX";
    const senderAddress = settlementService.senderToAddress(
      verifyResult.data.transaction,
      c.env.STACKS_NETWORK
    );
    const confirmedBlockHeight =
      broadcastResult.status === "confirmed" ? broadcastResult.blockHeight : undefined;

    // Record stats (fire-and-forget)
    c.executionCtx.waitUntil(
      statsService.logTransaction({
        timestamp: new Date().toISOString(),
        endpoint: "relay",
        success: true,
        tokenType,
        amount: body.settle.minAmount,
        fee: "0",
        txid: broadcastResult.txid,
        sender: senderAddress,
        recipient: verifyResult.data.recipient,
        status: broadcastResult.status,
        blockHeight: confirmedBlockHeight,
      }).catch(() => {})
    );

    // Step SP-G — Build settlement result and store receipt
    const settlement: SettlementResult = {
      success: true,
      status: broadcastResult.status,
      sender: senderAddress,
      recipient: verifyResult.data.recipient,
      amount: verifyResult.data.amount,
      blockHeight: confirmedBlockHeight,
    };

    const receiptService = new ReceiptService(c.env.RELAY_KV, logger);
    const receiptId = crypto.randomUUID();
    const storedReceipt = await receiptService.storeReceipt({
      receiptId,
      senderAddress: validation.senderAddress,
      // No sponsor tx for self-pay — sponsoredTx is intentionally undefined.
      // The original transaction hex is available in the request log if needed.
      sponsoredTx: undefined,
      fee: "0",
      txid: broadcastResult.txid,
      settlement,
      settleOptions: body.settle,
    });

    // Step SP-H — Record dedup entry for idempotent retries
    await settlementService.recordDedup(body.transaction, {
      txid: broadcastResult.txid,
      receiptId: storedReceipt ? receiptId : undefined,
      status: broadcastResult.status,
      sender: senderAddress,
      recipient: verifyResult.data.recipient,
      amount: verifyResult.data.amount,
      sponsoredTx: undefined,
      blockHeight: confirmedBlockHeight,
    });

    logger.info("Self-pay transaction settled", {
      txid: broadcastResult.txid,
      sender: senderAddress,
      settlement_status: broadcastResult.status,
      receiptId: storedReceipt ? receiptId : undefined,
    });

    return this.okWithTx(c, {
      txid: broadcastResult.txid,
      settlement,
      // sponsoredTx omitted (undefined not null): okWithTx's conditional spread skips
      // falsy values so this field is absent from the JSON response — self-pay callers
      // already have their tx and don't need it echoed back. Using undefined (not null)
      // matches the optional field type and keeps JSON output consistent with omission.
      sponsoredTx: undefined,
      receiptId: storedReceipt ? receiptId : undefined,
    });
  }
}

