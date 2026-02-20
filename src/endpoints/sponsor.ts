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
} from "../services";
import type { AppContext, SponsorRequest } from "../types";
import { buildExplorerUrl } from "../utils";
import {
  Error400Response,
  Error401Response,
  Error409Response,
  Error429Response,
  Error500Response,
  Error502Response,
} from "../schemas";

const NONCE_CONFLICT_REASONS = ["ConflictingNonceInMempool", "BadNonce"];

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
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Sponsor request received");

    // Initialize stats service for metrics recording
    const statsService = new StatsService(c.env.RELAY_KV, logger);

    try {
      // Auth is guaranteed by requireAuthMiddleware - get the auth context
      const auth = c.get("auth")!;

      // Parse request body
      const body = (await c.req.json()) as SponsorRequest;

      // Validate required fields
      if (!body.transaction) {
        await statsService.recordError("validation");
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
          await statsService.recordError("validation");
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
        await statsService.recordError("validation");
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
        await statsService.recordError("rateLimit");
        logger.warn("Rate limit exceeded", {
          keyId: metadata.keyId,
          tier: metadata.tier,
          code: rateLimitResult.code,
        });
        return this.err(c, {
          error: rateLimitResult.code === "DAILY_LIMIT_EXCEEDED"
            ? "Daily request limit exceeded"
            : "Rate limit exceeded",
          code: rateLimitResult.code,
          status: 429,
          details: rateLimitResult.code === "DAILY_LIMIT_EXCEEDED"
            ? "Your API key has exceeded its daily request limit. Limit resets at midnight UTC."
            : `Too many requests. Please wait before trying again.`,
          retryable: true,
          retryAfter: rateLimitResult.retryAfter,
        });
      }

      // Estimate fee based on transaction size since sponsored tx has fee=0
      // Use conservative size-based estimation for spending cap check
      const txHex = body.transaction;
      const txByteLength = typeof txHex === "string"
        ? Buffer.from(txHex.startsWith("0x") ? txHex.slice(2) : txHex, "hex").length
        : 0;
      const perByteFee = 50n; // microSTX per byte (conservative rate)
      const baseFee = 10000n; // minimum fallback estimate (0.01 STX)
      const sizeBasedEstimate = txByteLength > 0
        ? BigInt(txByteLength) * perByteFee
        : baseFee;
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
        await statsService.recordError("rateLimit");
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
        await statsService.recordError("sponsoring");
        const code = sponsorResult.code === "NONCE_DO_UNAVAILABLE"
          ? "NONCE_DO_UNAVAILABLE"
          : sponsorResult.error === "Service not configured"
            ? "SPONSOR_CONFIG_ERROR"
            : "SPONSOR_FAILED";
        return this.err(c, {
          error: sponsorResult.error,
          code,
          status: code === "NONCE_DO_UNAVAILABLE" ? 503 : 500,
          details: sponsorResult.details,
          retryable: code === "NONCE_DO_UNAVAILABLE" || code === "SPONSOR_FAILED",
          ...(code === "NONCE_DO_UNAVAILABLE" ? { retryAfter: 3 } : {}),
        });
      }

      // Broadcast directly to Stacks node
      const network =
        c.env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;

      // Deserialize the sponsored transaction for broadcast
      const cleanHex = sponsorResult.sponsoredTxHex.startsWith("0x")
        ? sponsorResult.sponsoredTxHex.slice(2)
        : sponsorResult.sponsoredTxHex;
      const sponsoredTx = deserializeTransaction(cleanHex);

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
          await statsService.recordError("sponsoring");

          const isNonceConflict = NONCE_CONFLICT_REASONS.some((reason) =>
            errorReason.includes(reason)
          );

          if (isNonceConflict) {
            // Trigger delayed DO resync so the next request gets a clean nonce.
            // The 2s delay gives Hiro's mempool index time to catch up.
            // Fire-and-forget: does not block the error response.
            c.executionCtx.waitUntil(
              sponsorService.resyncNonceDODelayed().catch((e) => {
                logger.warn("resyncNonceDODelayed failed after nonce conflict", { error: String(e) });
              })
            );
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
        await statsService.recordError("sponsoring");
        return this.err(c, {
          error: "Failed to broadcast transaction",
          code: "BROADCAST_FAILED",
          status: 502,
          details: e instanceof Error ? e.message : "Unknown error",
          retryable: true,
          retryAfter: 5,
        });
      }

      const sponsorNonce = extractSponsorNonce(sponsoredTx);
      if (sponsorNonce !== null) {
        c.executionCtx.waitUntil(
          recordNonceTxid(c.env, logger, txid, sponsorNonce).catch((e) => {
            logger.warn("Failed to record nonce txid", { error: String(e) });
          })
        );
      }

      // Record fee spent against the API key
      const actualFee = BigInt(sponsorResult.fee);
      await authService.recordFeeSpent(metadata.keyId, actualFee);

      // Record successful transaction in global stats
      await statsService.recordTransaction({
        success: true,
        tokenType: "STX", // Default for sponsor endpoint
        amount: "0", // No settlement amount for direct sponsor
        fee: sponsorResult.fee,
      });
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
        })
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
      await statsService.recordError("internal");
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

