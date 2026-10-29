import { BaseEndpoint } from "./BaseEndpoint";
import {
  SponsorService,
  StatsService,
  AuthService,
  StxVerifyService,
} from "../services";
import {
  Error400Response,
  Error401Response,
  Error409Response,
  Error429Response,
  Error500Response,
  Error502Response,
  Error503Response,
} from "../schemas";
import { checkAndRecordMalformed, MALFORMED_BLOCK_THRESHOLD } from "../middleware";
import type { AppContext, SponsorRequest } from "../types";
import { buildExplorerUrl, extractTransferDetails, stripHexPrefix } from "../utils";

/**
 * Sponsor endpoint - sponsors and broadcasts transactions directly
 * POST /sponsor
 *
 * Unlike /relay, this endpoint:
 * - Does NOT perform settlement verification
 * - Broadcasts directly to the Stacks node
 * - Requires API key authentication
 */
export class Sponsor extends BaseEndpoint {
  schema = {
    tags: ["Sponsor"],
    summary: "Sponsor and broadcast a transaction",
    description:
      "Accepts a pre-signed sponsored transaction, adds the sponsor signature, and broadcasts directly to the Stacks network. It does not perform settlement verification. Requires API key authentication.",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["transaction"],
              properties: {
                transaction: {
                  type: "string" as const,
                  description: "Hex-encoded signed sponsored transaction",
                  example: "0x00000001...",
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
                          description: "Action being performed (should be 'sponsor')",
                          example: "sponsor",
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
        description: "Transaction sponsored and broadcast successfully",
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
                fee: {
                  type: "string" as const,
                  description: "Fee paid by sponsor in microSTX",
                  example: "1000",
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "401": Error401Response,
      "409": { ...Error409Response, description: "Sender has a pending transaction — wait for it to confirm, then retry" },
      "429": { ...Error429Response, description: "Spending cap exceeded" },
      "500": Error500Response,
      "502": { ...Error502Response, description: "Broadcast failed" },
      "503": { ...Error503Response, description: "Sponsor wallet out of STX or daily budget reached — retry later" },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Sponsor request received");

    const statsService = new StatsService(c.env, logger);

    try {
      const auth = c.get("auth")!;
      const body = (await c.req.json()) as SponsorRequest;

      if (!body.transaction) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("sponsor", true, undefined, "invalid_transaction").catch(() => {}));
        return this.err(c, {
          error: "Missing transaction field",
          code: "MISSING_TRANSACTION",
          status: 400,
          retryable: false,
        });
      }

      if (body.auth) {
        const stxVerifyService = new StxVerifyService(logger, c.env.STACKS_NETWORK);
        const authError = stxVerifyService.verifySip018Auth(body.auth, "sponsor");
        if (authError) {
          c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
          c.executionCtx.waitUntil(statsService.logFailure("sponsor", true, undefined, "invalid_transaction").catch(() => {}));
          return this.err(c, {
            error: authError.error,
            code: authError.code,
            status: 401,
            retryable: false,
          });
        }
      }

      const sponsorService = new SponsorService(c.env, logger);
      const clientIp = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null;

      const validation = sponsorService.validateTransaction(body.transaction);
      if (validation.valid === false) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("sponsor", true, undefined,
          validation.error === "Transaction must be sponsored" ? "not_sponsored" : "invalid_transaction"
        ).catch(() => {}));
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
        const code =
          validation.error === "Transaction must be sponsored"
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

      const paymentSponsorKey = c.env.PAYMENT_SPONSOR_PRIVATE_KEY;
      const preflight = await sponsorService.preflightSponsoredPayment(
        validation.transaction,
        paymentSponsorKey ? [paymentSponsorKey] : []
      );
      if (preflight) {
        return this.preflightRejectionResponse(c, preflight);
      }

      const authService = new AuthService(c.env.API_KEYS_KV, logger);
      const metadata = auth.metadata!;

      const rateLimitResult = await authService.checkRateLimit(metadata.keyId, metadata.tier);
      if (!rateLimitResult.allowed) {
        c.executionCtx.waitUntil(statsService.recordError("rateLimit").catch(() => {}));
        logger.warn("Rate limit exceeded", {
          keyId: metadata.keyId,
          tier: metadata.tier,
          code: rateLimitResult.code,
        });
        c.executionCtx.waitUntil(statsService.logFailure("sponsor", true, undefined, "broadcast_rate_limited").catch(() => {}));
        const isDaily = rateLimitResult.code === "DAILY_LIMIT_EXCEEDED";
        return this.err(c, {
          error: isDaily ? "Daily request limit exceeded" : "Rate limit exceeded",
          code: rateLimitResult.code,
          status: 429,
          details: isDaily
            ? "Your API key has exceeded its daily request limit. Limit resets at midnight UTC."
            : "Too many requests. Please wait before trying again.",
          retryable: true,
          retryAfter: rateLimitResult.retryAfter,
        });
      }

      // Estimate fee based on transaction size for spending cap check.
      // Conservative: 50 microSTX/byte, floor of 10,000 microSTX (0.01 STX).
      const cleanTxHex = stripHexPrefix(body.transaction);
      const txByteLength = Buffer.from(cleanTxHex, "hex").length;
      const baseFee = 10_000n;
      const sizeBasedEstimate = BigInt(txByteLength) * 50n;
      const estimatedFee = sizeBasedEstimate > baseFee ? sizeBasedEstimate : baseFee;

      // Check spending cap before sponsoring
      // Note: There's a small race window between check and record, but spending caps
      // are soft limits with daily reset, so minor overruns are acceptable.
      const spendingCapResult = await authService.checkSpendingCap(
        metadata.keyId,
        metadata.tier,
        estimatedFee
      );

      if (!spendingCapResult.allowed) {
        c.executionCtx.waitUntil(statsService.recordError("rateLimit").catch(() => {}));
        logger.warn("Spending cap exceeded", {
          keyId: metadata.keyId,
          tier: metadata.tier,
          estimatedFee: estimatedFee.toString(),
        });
        c.executionCtx.waitUntil(statsService.logFailure("sponsor", true, undefined, "broadcast_rate_limited").catch(() => {}));
        return this.err(c, {
          error: "Daily spending cap exceeded",
          code: "SPENDING_CAP_EXCEEDED",
          status: 429,
          details: `Your API key has exceeded its daily spending limit. Limit resets at midnight UTC.`,
          retryable: true,
          retryAfter: spendingCapResult.retryAfter,
        });
      }

      // Sponsor with the single payment-sponsor wallet (SponsorWalletDO): it takes the
      // sponsor nonce from the chain at broadcast time, so a failed attempt leaves no gap.
      // /sponsor has its own daily budget so API-key traffic cannot use up the x402 payments' one.
      const sent = await sponsorService.sponsorAndBroadcast(validation.transaction, "budget:sponsor");

      if (!sent.ok) {
        const isClientError = sent.responsible === "sender" || sent.clientRejection !== undefined;
        c.executionCtx.waitUntil(statsService.recordError(isClientError ? "validation" : "sponsoring").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("sponsor", isClientError, undefined, isClientError ? "invalid_transaction" : "broadcast_failure").catch(() => {}));

        if (sent.senderNonceCode === "SENDER_NONCE_DUPLICATE") {
          return this.clientRejectionResponse(c, "ConflictingNonceInMempool", sent.details);
        }
        if (sent.senderNonceCode === "SENDER_NONCE_STALE") {
          return this.clientRejectionResponse(c, "BadNonce", sent.details);
        }
        if (sent.senderNonceCode === "SENDER_NONCE_GAP") {
          return this.err(c, {
            error: sent.error,
            code: "SENDER_NONCE_GAP",
            status: 400,
            details: sent.details,
            retryable: false,
          });
        }
        if (sent.tooMuchChaining && !sent.isOriginChaining) {
          return this.err(c, {
            error: "Sponsor wallet congested — too many pending transactions. Back off and retry",
            code: "TOO_MUCH_CHAINING",
            status: 429,
            details: sent.details,
            retryable: true,
            retryAfter: 30,
          });
        }
        if (sent.tooMuchChaining) {
          return this.clientRejectionResponse(c, "TooMuchChaining", sent.details);
        }
        if (sent.clientRejection) {
          return this.clientRejectionResponse(c, sent.clientRejection, sent.details);
        }
        if (sent.error === "Daily sponsor budget reached") {
          return this.err(c, {
            error: sent.error,
            code: "SPONSOR_EXHAUSTED",
            status: 503,
            details: sent.details,
            retryable: true,
            retryAfter: 3600,
          });
        }
        if (sent.error === "Service not configured") {
          return this.sponsorFailureResponse(c, sent, Promise.resolve());
        }
        return this.err(c, {
          error: sent.error,
          code: "BROADCAST_FAILED",
          status: sent.retryable ? 502 : 400,
          details: sent.details,
          retryable: sent.retryable,
          retryAfter: sent.retryable ? 5 : undefined,
        });
      }

      const { txid, fee } = sent;

      // Token type and transfer amount for stats attribution.
      // Falls back to { tokenType: "STX", amount: "0" } on any error.
      const { tokenType: txTokenType, amount: txAmount } = extractTransferDetails(validation.transaction, c.env.STACKS_NETWORK);

      await authService.recordFeeSpent(metadata.keyId, BigInt(fee));

      // Record successful transaction in global stats (fire-and-forget, never blocks response)
      c.executionCtx.waitUntil(
        statsService.logTransaction({
          timestamp: new Date().toISOString(),
          endpoint: "sponsor",
          success: true,
          tokenType: txTokenType,
          amount: txAmount,
          fee,
          txid,
          sender: validation.senderAddress,
          status: "pending",
        }).catch(() => {})
      );

      // Also record usage for the API key (for volume tracking)
      await authService.recordUsage(metadata.keyId, {
        success: true,
        tokenType: txTokenType,
        amount: txAmount,
        fee,
      });

      logger.info("Transaction sponsored and broadcast", {
        txid,
        sender: validation.senderAddress,
        fee,
        sponsorNonce: sent.sponsorNonce,
        keyId: metadata.keyId,
      });

      return this.ok(c, {
        txid,
        explorerUrl: buildExplorerUrl(txid, c.env.STACKS_NETWORK),
        fee,
      });
    } catch (e) {
      logger.error("Unexpected error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      c.executionCtx.waitUntil(statsService.recordError("internal").catch(() => {}));
      c.executionCtx.waitUntil(statsService.logFailure("sponsor", false, undefined, "internal_error").catch(() => {}));
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
