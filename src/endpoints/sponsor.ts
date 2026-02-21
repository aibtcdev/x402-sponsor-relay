import { broadcastTransaction, deserializeTransaction } from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import { BaseEndpoint } from "./BaseEndpoint";
import {
  SponsorService,
  StatsService,
  AuthService,
  StxVerifyService,
  extractSponsorNonce,
  recordNonceTxid,
  releaseNonceDO,
} from "../services";
import type { AppContext, SponsorRequest } from "../types";
import { buildExplorerUrl, NONCE_CONFLICT_REASONS, stripHexPrefix } from "../utils";
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
      "Accepts a pre-signed sponsored transaction, adds the sponsor signature, and broadcasts directly to the Stacks network. Unlike /relay, this does NOT perform settlement verification. Requires API key authentication.",
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
      "409": { ...Error409Response, description: "Nonce conflict — resubmit with a new transaction" },
      "429": { ...Error429Response, description: "Spending cap exceeded" },
      "500": Error500Response,
      "502": { ...Error502Response, description: "Broadcast failed" },
      "503": { ...Error503Response, description: "Nonce coordinator unavailable — retry after delay" },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Sponsor request received");

    // Initialize stats service for metrics recording
    const statsService = new StatsService(c.env, logger);

    try {
      // Auth is guaranteed by requireAuthMiddleware - get the auth context
      const auth = c.get("auth")!;

      // Parse request body
      const body = (await c.req.json()) as SponsorRequest;

      // Validate required fields
      if (!body.transaction) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
        return this.err(c, {
          error: "Missing transaction field",
          code: "MISSING_TRANSACTION",
          status: 400,
          retryable: false,
        });
      }

      // Optional: Verify SIP-018 auth if provided
      if (body.auth) {
        const stxVerifyService = new StxVerifyService(logger, c.env.STACKS_NETWORK);
        const authError = stxVerifyService.verifySip018Auth(body.auth, "sponsor");
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

      // Initialize sponsor service
      const sponsorService = new SponsorService(c.env, logger);

      // Validate and deserialize transaction
      const validation = sponsorService.validateTransaction(body.transaction);
      if (validation.valid === false) {
        c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
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

      // Initialize auth service and get metadata
      const authService = new AuthService(c.env.API_KEYS_KV, logger);
      const metadata = auth.metadata!;

      // Check rate limits before processing
      const rateLimitResult = await authService.checkRateLimit(metadata.keyId, metadata.tier);
      if (!rateLimitResult.allowed) {
        c.executionCtx.waitUntil(statsService.recordError("rateLimit").catch(() => {}));
        logger.warn("Rate limit exceeded", {
          keyId: metadata.keyId,
          tier: metadata.tier,
          code: rateLimitResult.code,
        });
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
        return this.err(c, {
          error: "Daily spending cap exceeded",
          code: "SPENDING_CAP_EXCEEDED",
          status: 429,
          details: `Your API key has exceeded its daily spending limit. Limit resets at midnight UTC.`,
          retryable: true,
          retryAfter: spendingCapResult.retryAfter,
        });
      }

      // Sponsor the transaction
      const sponsorResult = await sponsorService.sponsorTransaction(
        validation.transaction
      );
      if (sponsorResult.success === false) {
        return this.sponsorFailureResponse(
          c,
          sponsorResult,
          statsService.recordError("sponsoring").catch(() => {})
        );
      }

      // Broadcast directly to Stacks node
      const network =
        c.env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;

      // Deserialize the sponsored transaction for broadcast
      const cleanHex = stripHexPrefix(sponsorResult.sponsoredTxHex);
      const sponsoredTx = deserializeTransaction(cleanHex);

      // Extract nonce before broadcast so it's available in all failure and success paths
      const sponsorNonce = extractSponsorNonce(sponsoredTx);
      // walletIndex from NonceDO assignment — routes release to the correct per-wallet pool
      const sponsorWalletIndex = sponsorResult.walletIndex;

      let txid: string;
      try {
        const result = await broadcastTransaction({
          transaction: sponsoredTx,
          network,
        });

        // Check for broadcast error
        if ("error" in result && result.error) {
          const errorReason =
            typeof result.reason === "string" ? result.reason : "Unknown error";
          logger.error("Broadcast rejected by node", {
            error: result.error,
            reason: errorReason,
          });
          c.executionCtx.waitUntil(statsService.recordError("sponsoring").catch(() => {}));

          // Return nonce to pool — broadcast was rejected, nonce can be reused
          if (sponsorNonce !== null) {
            c.executionCtx.waitUntil(
              releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex).catch((e) => {
                logger.warn("Failed to release nonce after broadcast rejection", { error: String(e) });
              })
            );
          }

          const isNonceConflict = NONCE_CONFLICT_REASONS.some((reason) =>
            errorReason.includes(reason)
          );

          if (isNonceConflict) {
            logger.warn("Nonce conflict returned to agent", {
              sponsorNonce,
              walletIndex: sponsorWalletIndex,
              broadcastDetails: errorReason,
            });
            this.scheduleNonceResync(c, sponsorService.resyncNonceDODelayed(), logger);
            return this.err(c, {
              error: "Nonce conflict — resubmit with a new transaction",
              code: "NONCE_CONFLICT",
              status: 409,
              details: errorReason,
              retryable: true,
              retryAfter: 1,
            });
          }

          return this.err(c, {
            error: "Transaction rejected by network",
            code: "BROADCAST_FAILED",
            status: 502,
            details: errorReason,
            retryable: true,
            retryAfter: 5,
          });
        }

        txid = result.txid;
      } catch (e) {
        logger.error("Broadcast failed", {
          error: e instanceof Error ? e.message : "Unknown error",
        });
        c.executionCtx.waitUntil(statsService.recordError("sponsoring").catch(() => {}));

        // Return nonce to pool — broadcast threw an exception, nonce can be reused
        if (sponsorNonce !== null) {
          c.executionCtx.waitUntil(
            releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex).catch((e2) => {
              logger.warn("Failed to release nonce after broadcast exception", { error: String(e2) });
            })
          );
        }

        return this.err(c, {
          error: "Failed to broadcast transaction",
          code: "BROADCAST_FAILED",
          status: 502,
          details: e instanceof Error ? e.message : "Unknown error",
          retryable: true,
          retryAfter: 5,
        });
      }

      if (sponsorNonce !== null) {
        // Consume the nonce (broadcast succeeded) — removes from reserved, not returned to available
        // Also records the fee in NonceDO's cumulative per-wallet fee stats
        c.executionCtx.waitUntil(
          releaseNonceDO(c.env, logger, sponsorNonce, txid, sponsorWalletIndex, sponsorResult.fee).catch((e) => {
            logger.warn("Failed to consume nonce after broadcast success", { error: String(e) });
          })
        );
        // Also record nonce→txid mapping in NonceDO SQL table for gap detection
        c.executionCtx.waitUntil(
          recordNonceTxid(c.env, logger, txid, sponsorNonce).catch((e) => {
            logger.warn("Failed to record nonce txid", { error: String(e) });
          })
        );
      }

      // Record fee spent against the API key
      const actualFee = BigInt(sponsorResult.fee);
      await authService.recordFeeSpent(metadata.keyId, actualFee);

      // Record successful transaction in global stats (fire-and-forget, never blocks response)
      c.executionCtx.waitUntil(
        statsService.logTransaction({
          timestamp: new Date().toISOString(),
          endpoint: "sponsor",
          success: true,
          tokenType: "STX",
          amount: "0",
          fee: sponsorResult.fee,
          txid,
          sender: validation.senderAddress,
          status: "pending",
        }).catch(() => {})
      );

      // Also record usage for the API key (for volume tracking)
      await authService.recordUsage(metadata.keyId, {
        success: true,
        tokenType: "STX",
        amount: "0",
        fee: sponsorResult.fee,
      });

      logger.info("Transaction sponsored and broadcast", {
        txid,
        sender: validation.senderAddress,
        fee: sponsorResult.fee,
        keyId: metadata.keyId,
      });

      // Return success response
      return this.ok(c, {
        txid,
        explorerUrl: buildExplorerUrl(txid, c.env.STACKS_NETWORK),
        fee: sponsorResult.fee,
      });
    } catch (e) {
      logger.error("Unexpected error", {
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

