import { deserializeTransaction } from "@stacks/transactions";
import { BaseEndpoint } from "./BaseEndpoint";
import {
  SponsorService,
  StatsService,
  AuthService,
  StxVerifyService,
  extractSponsorNonce,
  releaseNonceDO,
  recordBroadcastOutcomeDO,
  nonceLifecycleOnBroadcastSuccess,
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
import type { AppContext, Env, Logger, SponsorRequest } from "../types";
import { buildQueueInfo } from "../types";
import { buildExplorerUrl, CLIENT_REJECTION_REASONS, getBroadcastTargets, NONCE_CONFLICT_REASONS, stripHexPrefix, extractTransferDetails } from "../utils";
import type { BroadcastTarget } from "../utils";

const BROADCAST_MAX_ATTEMPTS = 3;
const BROADCAST_RETRY_BASE_DELAY_MS = 1_000;
const BROADCAST_RETRY_MAX_DELAY_MS = 2_000;
const BROADCAST_TIMEOUT_MS = 12_000;

type BroadcastResult =
  | { success: true; txid: string }
  | {
      success: false;
      errorMessage: string;
      errorDetails: string;
      httpStatus: number;
      isNonceConflict: boolean;
      clientRejection?: string;
      nodeUrl?: string;
    };

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

    // Capture HTTP request arrival time for user-perceived settlement latency measurement.
    const submittedAt = new Date().toISOString();

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

      // mode:"immediate" — reject without queuing if a gap exists.
      // POST /sponsor must remain synchronous (200 with txid or error, NEVER 202).
      // MCP server and skills expect either txid or a 4xx error; they cannot handle 202.
      const sponsorResult = await sponsorService.sponsorTransaction(
        validation.transaction,
        body.transaction, // pass original hex for hand-submit sender nonce tracking
        "immediate"
      );
      if (sponsorResult.success === false) {
        // Gin rummy: nonce gap detected — reject immediately with actionable error.
        // The tx was NOT added to sender_hand (mode:"immediate" prevents insertion on gap).
        if ("held" in sponsorResult && sponsorResult.held) {
          c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
          c.executionCtx.waitUntil(statsService.logFailure("sponsor", true, undefined, "sender_nonce_gap").catch(() => {}));
          const senderNonce = Number(validation.transaction.auth.spendingCondition.nonce);
          const queue = buildQueueInfo(sponsorResult, senderNonce);
          logger.warn("Sender nonce gap — rejecting /sponsor request", {
            senderNonce,
            missingNonces: sponsorResult.missingNonces,
            nextExpected: sponsorResult.nextExpected,
          });
          return c.json({
            success: false,
            requestId: crypto.randomUUID(),
            code: "SENDER_NONCE_GAP",
            error: `Sender nonce ${senderNonce} cannot be sponsored — verify your account nonce via the Stacks API, then submit nonces ${sponsorResult.missingNonces.join(", ")} to unblock dispatch`,
            missingNonces: sponsorResult.missingNonces,
            nextExpectedNonce: sponsorResult.nextExpected,
            retryable: false,
            queue,
          }, 400);
        }
        c.executionCtx.waitUntil(statsService.logFailure("sponsor", false, undefined, "sponsor_failure").catch(() => {}));
        return this.sponsorFailureResponse(
          c,
          sponsorResult as { error: string; details: string; code?: string; retryAfter?: number },
          statsService.recordError("sponsoring").catch(() => {})
        );
      }

      const cleanHex = stripHexPrefix(sponsorResult.sponsoredTxHex);
      const sponsoredTx = deserializeTransaction(cleanHex);

      // Extract token type and transfer amount from the sponsored transaction for accurate
      // stats attribution. Falls back to { tokenType: "STX", amount: "0" } on any error.
      const { tokenType: txTokenType, amount: txAmount } = extractTransferDetails(sponsoredTx, c.env.STACKS_NETWORK);

      // Extract nonce before broadcast so it's available in all failure and success paths
      const sponsorNonce = extractSponsorNonce(sponsoredTx);
      // walletIndex from NonceDO assignment — routes release to the correct per-wallet pool
      const sponsorWalletIndex = sponsorResult.walletIndex;

      // Broadcast with retry: raw fetch to /v2/transactions instead of library
      // broadcastTransaction() which swallows response bodies and has no retry.
      // Retry on 5xx/network errors with backoff; fail fast on 4xx.
      // Pass cleanHex directly — it's already stripped hex from sponsoredTxHex.
      // Avoids a deserialize→re-serialize round-trip through sponsoredTx.serialize().
      const broadcastResult = await this.broadcastWithRetry(
        cleanHex, c.env, logger
      );

      if (!broadcastResult.success) {
        const { errorMessage, errorDetails, httpStatus, isNonceConflict, clientRejection, nodeUrl } = broadcastResult;
        const isClientError = clientRejection !== undefined;

        c.executionCtx.waitUntil(statsService.recordError(isClientError ? "validation" : "sponsoring").catch(() => {}));
        c.executionCtx.waitUntil(statsService.logFailure("sponsor", isClientError, undefined, isClientError ? "invalid_transaction" : "broadcast_failure").catch(() => {}));

        // Record broadcast outcome in the intent ledger.
        // httpStatus 0 = network/timeout exception (no HTTP response received).
        if (sponsorNonce !== null) {
          c.executionCtx.waitUntil(
            recordBroadcastOutcomeDO(
              c.env, logger, sponsorNonce, sponsorWalletIndex,
              undefined, httpStatus, nodeUrl, errorDetails
            ).catch((e) => {
              logger.warn("Failed to record broadcast outcome", { error: String(e) });
            })
          );
          c.executionCtx.waitUntil(
            releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex).catch((e) => {
              logger.warn("Failed to release nonce after broadcast rejection", { error: String(e) });
            })
          );
        }

        // Nonce conflicts: trigger resync and return 409
        if (isNonceConflict) {
          logger.warn("Nonce conflict returned to agent", {
            sponsorNonce,
            walletIndex: sponsorWalletIndex,
            broadcastDetails: errorDetails,
          });
          this.scheduleNonceResync(c, sponsorService.resyncNonceDODelayed(), logger);
          return this.err(c, {
            error: "Nonce conflict — back off and retry. Check GET /nonce/stats for nonce pool state",
            code: "NONCE_CONFLICT",
            status: 409,
            details: errorDetails,
            retryable: true,
            retryAfter: 30,
          });
        }

        // TooMuchChaining: sponsor wallet congested — relay-side, not a client error.
        // Trigger resync and return a dedicated 429 so stats don't misattribute.
        if (clientRejection === "TooMuchChaining") {
          this.scheduleNonceResync(c, sponsorService.resyncNonceDODelayed(), logger);
          return this.err(c, {
            error: "Sponsor wallet congested — too many pending transactions. Back off and retry",
            code: "TOO_MUCH_CHAINING",
            status: 429,
            details: errorDetails,
            retryable: true,
            retryAfter: 30,
          });
        }

        // Client rejections (NotEnoughFunds, FeeTooLow, etc.)
        if (clientRejection) {
          return this.clientRejectionResponse(c, clientRejection, errorDetails);
        }

        // Generic 4xx = non-retryable transaction rejection; 5xx/network = retryable
        const is4xx = httpStatus >= 400 && httpStatus < 500;
        return this.err(c, {
          error: errorMessage,
          code: "BROADCAST_FAILED",
          status: is4xx ? 400 : 502,
          details: errorDetails,
          retryable: !is4xx,
          retryAfter: is4xx ? undefined : 5,
        });
      }

      const txid = broadcastResult.txid;

      if (sponsorNonce !== null) {
        c.executionCtx.waitUntil(
          nonceLifecycleOnBroadcastSuccess(c.env, logger, {
            sponsorNonce,
            walletIndex: sponsorWalletIndex,
            txid,
            fee: sponsorResult.fee,
            senderTxHex: body.transaction,
            senderAddress: validation.senderAddress,
            senderNonce: Number(validation.transaction.auth.spendingCondition.nonce),
            submittedAt,
          })
        );
      }

      const actualFee = BigInt(sponsorResult.fee);
      await authService.recordFeeSpent(metadata.keyId, actualFee);

      // Record successful transaction in global stats (fire-and-forget, never blocks response)
      c.executionCtx.waitUntil(
        statsService.logTransaction({
          timestamp: new Date().toISOString(),
          endpoint: "sponsor",
          success: true,
          tokenType: txTokenType,
          amount: txAmount,
          fee: sponsorResult.fee,
          txid,
          sender: validation.senderAddress,
          status: "pending",
          walletIndex: sponsorWalletIndex,
        }).catch(() => {})
      );

      // Also record usage for the API key (for volume tracking)
      await authService.recordUsage(metadata.keyId, {
        success: true,
        tokenType: txTokenType,
        amount: txAmount,
        fee: sponsorResult.fee,
      });

      logger.info("Transaction sponsored and broadcast", {
        txid,
        sender: validation.senderAddress,
        fee: sponsorResult.fee,
        keyId: metadata.keyId,
      });

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

  /**
   * Broadcast a serialized transaction with retry and node failover.
   *
   * Uses raw fetch to /v2/transactions instead of the library broadcastTransaction()
   * to get full control over retry behaviour and to log raw response bodies when
   * Hiro returns unparseable responses (fixes #211).
   *
   * Retry strategy (same as SettlementService):
   * - Up to BROADCAST_MAX_ATTEMPTS per node with fixed backoff (1s then 2s)
   * - Fail over to next node after exhausting attempts
   * - Immediate return on 4xx (transaction-level rejection)
   * - Retry on 5xx and network/timeout errors
   */
  private async broadcastWithRetry(
    txHex: string,
    env: Env,
    logger: Logger
  ): Promise<BroadcastResult> {
    const txBytes = Buffer.from(stripHexPrefix(txHex), "hex");
    if (txBytes.length === 0) {
      return {
        success: false,
        errorMessage: "Failed to broadcast transaction",
        errorDetails: "Serialized transaction hex could not be converted to bytes",
        httpStatus: 0,
        isNonceConflict: false,
      };
    }

    const broadcastTargets: BroadcastTarget[] = getBroadcastTargets(
      env.STACKS_NETWORK, env.HIRO_API_KEY, env.BROADCAST_NODE_URLS
    );

    let lastError: BroadcastResult & { success: false } | undefined;
    let totalAttempt = 0;

    for (let nodeIndex = 0; nodeIndex < broadcastTargets.length; nodeIndex++) {
      const target = broadcastTargets[nodeIndex];
      const broadcastUrl = `${target.baseUrl}/v2/transactions`;
      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        ...target.headers,
      };

      for (let attempt = 1; attempt <= BROADCAST_MAX_ATTEMPTS; attempt++) {
        totalAttempt++;
        try {
          const response = await fetch(broadcastUrl, {
            method: "POST",
            headers,
            body: txBytes,
            signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
          });

          const responseText = await response.text();

          if (response.ok) {
            const parsedTxid = this.parseTxid(responseText);
            if (!parsedTxid) {
              logger.error("Broadcast returned OK but unparseable txid", {
                responseText: responseText.slice(0, 500),
                contentType: response.headers.get("content-type"),
                nodeUrl: target.baseUrl,
              });
              throw new Error("Node returned OK but txid could not be parsed");
            }
            return { success: true, txid: parsedTxid };
          }

          const { errorMessage, errorDetails } = this.parseErrorBody(responseText, response.status);

          if (!response.headers.get("content-type")?.includes("json")) {
            logger.warn("Broadcast returned non-JSON error response", {
              status: response.status,
              contentType: response.headers.get("content-type"),
              bodyPreview: responseText.slice(0, 500),
              nodeUrl: target.baseUrl,
            });
          }

          const conflictDetails = `${errorMessage}: ${errorDetails}`;

          if (response.status >= 400 && response.status < 500) {
            return this.handle4xxRejection(logger, response.status, errorMessage, errorDetails, conflictDetails, target.baseUrl);
          }

          if (response.status >= 500) {
            this.logRetriableFailure(logger, totalAttempt, conflictDetails, attempt, nodeIndex, broadcastTargets.length, target.baseUrl);
            lastError = {
              success: false,
              errorMessage: "Failed to broadcast transaction",
              errorDetails: conflictDetails,
              httpStatus: response.status,
              isNonceConflict: false,
              nodeUrl: target.baseUrl,
            };
            if (attempt < BROADCAST_MAX_ATTEMPTS) {
              await this.retryDelay(attempt);
            }
            continue;
          }

          logger.error("Broadcast failed with unexpected status", {
            status: response.status,
            bodyPreview: responseText.slice(0, 500),
            nodeUrl: target.baseUrl,
          });
          return {
            success: false,
            errorMessage: "Failed to broadcast transaction",
            errorDetails,
            httpStatus: response.status,
            isNonceConflict: false,
            nodeUrl: target.baseUrl,
          };
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.logRetriableFailure(logger, totalAttempt, errMsg, attempt, nodeIndex, broadcastTargets.length, target.baseUrl);
          lastError = {
            success: false,
            errorMessage: "Failed to broadcast transaction",
            errorDetails: errMsg,
            httpStatus: 0,
            isNonceConflict: false,
            nodeUrl: target.baseUrl,
          };
          if (attempt < BROADCAST_MAX_ATTEMPTS) {
            await this.retryDelay(attempt);
          }
        }
      }
    }

    logger.error("Broadcast failed after all nodes and attempts", {
      totalAttempts: totalAttempt,
    });

    return lastError ?? {
      success: false,
      errorMessage: "Failed to broadcast transaction",
      errorDetails: "All broadcast targets exhausted",
      httpStatus: 0,
      isNonceConflict: false,
    };
  }

  private parseTxid(responseText: string): string | null {
    try {
      const parsed: unknown = JSON.parse(responseText);
      if (typeof parsed === "string" && parsed) return parsed;
    } catch {
      const trimmed = responseText.trim().replace(/^"|"$/g, "");
      if (trimmed) return trimmed;
    }
    return null;
  }

  private parseErrorBody(
    responseText: string,
    status: number
  ): { errorMessage: string; errorDetails: string } {
    let errorMessage = `HTTP ${status}`;
    let errorDetails = responseText.slice(0, 500);
    try {
      const json = JSON.parse(responseText) as { error?: string; reason?: string; message?: string };
      if (json.error || json.reason || json.message) {
        errorMessage = json.error ?? json.message ?? errorMessage;
        errorDetails = json.reason ?? errorDetails;
      }
    } catch {
      // Not JSON — use raw text
    }
    return { errorMessage, errorDetails };
  }

  private handle4xxRejection(
    logger: Logger,
    status: number,
    errorMessage: string,
    errorDetails: string,
    conflictDetails: string,
    nodeUrl: string
  ): BroadcastResult & { success: false } {
    const isNonceConflict = NONCE_CONFLICT_REASONS.some((r) => conflictDetails.includes(r));
    const clientRejection = CLIENT_REJECTION_REASONS.find((r) => conflictDetails.includes(r));

    const logMethod = clientRejection ? "warn" : "error";
    const logLabel = clientRejection ? "Broadcast rejected by node (client error)" : "Broadcast rejected by node";
    logger[logMethod](logLabel, {
      status,
      error: errorMessage,
      reason: errorDetails,
      ...(clientRejection && { clientRejection }),
      nodeUrl,
    });

    return { success: false, errorMessage, errorDetails, httpStatus: status, isNonceConflict, clientRejection, nodeUrl };
  }

  private logRetriableFailure(
    logger: Logger,
    totalAttempt: number,
    details: string,
    attempt: number,
    nodeIndex: number,
    nodeCount: number,
    nodeUrl: string
  ): void {
    const hasMoreAttempts = attempt < BROADCAST_MAX_ATTEMPTS;
    const hasMoreNodes = nodeIndex < nodeCount - 1;
    const retryDelay = attempt === 1 ? BROADCAST_RETRY_BASE_DELAY_MS : BROADCAST_RETRY_MAX_DELAY_MS;

    let retryMsg: string;
    if (hasMoreAttempts) {
      retryMsg = `retrying same node in ${retryDelay}ms`;
    } else if (hasMoreNodes) {
      retryMsg = "moving to next node";
    } else {
      retryMsg = "no retries remaining";
    }

    logger.warn(`Broadcast attempt ${totalAttempt} failed: ${details}, ${retryMsg}`, {
      attempt,
      maxAttempts: BROADCAST_MAX_ATTEMPTS,
      nodeUrl,
    });
  }

  private retryDelay(attempt: number): Promise<void> {
    const delay = attempt === 1 ? BROADCAST_RETRY_BASE_DELAY_MS : BROADCAST_RETRY_MAX_DELAY_MS;
    return new Promise((r) => setTimeout(r, delay));
  }
}

