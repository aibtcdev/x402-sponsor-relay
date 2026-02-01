import { broadcastTransaction, deserializeTransaction } from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import { BaseEndpoint } from "./BaseEndpoint";
import { SponsorService, StatsService } from "../services";
import type { AppContext, SponsorRequest } from "../types";
import { buildExplorerUrl } from "../utils";

/**
 * Sponsor endpoint - sponsors and broadcasts transactions directly
 * POST /sponsor
 *
 * Unlike /relay, this endpoint:
 * - Does NOT call the facilitator for settlement
 * - Broadcasts directly to the Stacks node
 * - Requires API key authentication
 */
export class Sponsor extends BaseEndpoint {
  schema = {
    tags: ["Sponsor"],
    summary: "Sponsor and broadcast a transaction",
    description:
      "Accepts a pre-signed sponsored transaction, adds the sponsor signature, and broadcasts directly to the Stacks network. Unlike /relay, this does NOT call the x402 facilitator for settlement verification. Requires API key authentication.",
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
      "400": {
        description: "Invalid request",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: false },
                requestId: { type: "string" as const, format: "uuid" },
                error: { type: "string" as const },
                code: { type: "string" as const },
                details: { type: "string" as const },
                retryable: { type: "boolean" as const },
              },
            },
          },
        },
      },
      "401": {
        description: "Missing or invalid API key",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: false },
                requestId: { type: "string" as const, format: "uuid" },
                error: { type: "string" as const },
                code: { type: "string" as const },
                retryable: { type: "boolean" as const },
              },
            },
          },
        },
      },
      "500": {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: false },
                requestId: { type: "string" as const, format: "uuid" },
                error: { type: "string" as const },
                code: { type: "string" as const },
                details: { type: "string" as const },
                retryable: { type: "boolean" as const },
              },
            },
          },
        },
      },
      "502": {
        description: "Broadcast failed",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: false },
                requestId: { type: "string" as const, format: "uuid" },
                error: { type: "string" as const },
                code: { type: "string" as const },
                details: { type: "string" as const },
                retryable: { type: "boolean" as const },
                retryAfter: { type: "number" as const },
              },
            },
          },
        },
        headers: {
          "Retry-After": {
            description: "Seconds to wait before retrying",
            schema: { type: "string" as const },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Sponsor request received");

    // Initialize stats service for metrics recording
    const statsService = new StatsService(c.env.RELAY_KV, logger);

    try {
      // Check API key authentication
      const auth = c.get("auth");
      if (!auth || auth.gracePeriod) {
        logger.warn("API key required for /sponsor endpoint");
        return this.err(c, {
          error: "API key required",
          code: "MISSING_API_KEY",
          status: 401,
          retryable: false,
        });
      }

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

      // Sponsor the transaction
      const sponsorResult = await sponsorService.sponsorTransaction(
        validation.transaction
      );
      if (sponsorResult.success === false) {
        await statsService.recordError("sponsoring");
        const code =
          sponsorResult.error === "Service not configured"
            ? "SPONSOR_CONFIG_ERROR"
            : "SPONSOR_FAILED";
        return this.err(c, {
          error: sponsorResult.error,
          code,
          status: 500,
          details: sponsorResult.details,
          retryable: code === "SPONSOR_FAILED",
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

      // Record successful transaction
      await statsService.recordTransaction({
        success: true,
        tokenType: "STX", // Default for sponsor endpoint
        amount: "0", // No settlement amount for direct sponsor
        fee: sponsorResult.fee,
      });

      logger.info("Transaction sponsored and broadcast", {
        txid,
        sender: validation.senderAddress,
        fee: sponsorResult.fee,
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
