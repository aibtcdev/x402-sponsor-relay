import { BaseEndpoint } from "./BaseEndpoint";
import { AuthService, BtcVerifyService } from "../services";
import type { AppContext, ProvisionRequest } from "../types";
import {
  Error400Response,
  Error500Response,
} from "../schemas";

/**
 * Provision endpoint - programmatic API key provisioning via BTC signature
 * POST /keys/provision
 *
 * Accepts btcAddress + signature + message, verifies BIP-137 signature,
 * and provisions a free-tier API key with 30-day expiration.
 *
 * Two paths:
 * 1. Registration: message = "Bitcoin will be the currency of AIs" (no timestamp)
 * 2. Self-service: message = "Bitcoin will be the currency of AIs | {ISO-timestamp}" (must be within 5 min)
 *
 * Returns HTTP 409 if BTC address already has a key.
 */
export class Provision extends BaseEndpoint {
  schema = {
    tags: ["Provision"],
    summary: "Provision an API key via Bitcoin signature",
    description:
      "Self-provision a free-tier API key by proving Bitcoin address ownership via BIP-137 signature verification. " +
      "Supports two paths: Registration (bare message 'Bitcoin will be the currency of AIs') and Self-service " +
      "(message with timestamp within 5 minutes). Returns HTTP 409 if BTC address already has a provisioned key.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["btcAddress", "signature", "message"],
              properties: {
                btcAddress: {
                  type: "string" as const,
                  description: "Bitcoin address used to sign the message (any format: P2PKH, P2SH, Bech32, etc.)",
                  example: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
                },
                signature: {
                  type: "string" as const,
                  description: "Base64-encoded BIP-137 signature of the message",
                  example: "H9L5yLFjti0QTHhPyFrZCT1V/MMnBtXKmoiKDZ78NDBjERki6ZTQZdSMCtkgoNmp17By9ItJr8o7ChX0XxY91nk=",
                },
                message: {
                  type: "string" as const,
                  description:
                    "Message that was signed. Either bare message 'Bitcoin will be the currency of AIs' (registration path) " +
                    "or message with timestamp 'Bitcoin will be the currency of AIs | {ISO-timestamp}' (self-service path, must be within 5 minutes)",
                  example: "Bitcoin will be the currency of AIs | 2026-02-12T12:00:00.000Z",
                },
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "API key provisioned successfully",
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
                apiKey: {
                  type: "string" as const,
                  description: "The generated API key (only shown once, store securely)",
                  example: "x402_sk_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
                },
                metadata: {
                  type: "object" as const,
                  properties: {
                    keyId: {
                      type: "string" as const,
                      description: "Key identifier for internal reference",
                      example: "a1b2c3d4",
                    },
                    appName: {
                      type: "string" as const,
                      description: "Application name (BTC address prefix)",
                      example: "btc:1A1zP1eP",
                    },
                    contactEmail: {
                      type: "string" as const,
                      description: "System-generated contact email",
                      example: "btc+1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa@x402relay.system",
                    },
                    tier: {
                      type: "string" as const,
                      enum: ["free"],
                      description: "Rate limit tier",
                    },
                    createdAt: {
                      type: "string" as const,
                      format: "date-time",
                      description: "Key creation timestamp",
                    },
                    expiresAt: {
                      type: "string" as const,
                      format: "date-time",
                      description: "Key expiration timestamp (30 days from creation)",
                    },
                    active: {
                      type: "boolean" as const,
                      description: "Whether the key is active",
                      example: true,
                    },
                    btcAddress: {
                      type: "string" as const,
                      description: "Bitcoin address that proved ownership",
                      example: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
                    },
                  },
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "409": {
        description: "BTC address already has a provisioned key",
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              properties: {
                success: { type: "boolean" as const, example: false },
                requestId: { type: "string" as const, format: "uuid" },
                error: { type: "string" as const, example: "Bitcoin address already has a provisioned API key" },
                code: { type: "string" as const, example: "ALREADY_PROVISIONED" },
                retryable: { type: "boolean" as const, example: false },
              },
            },
          },
        },
      },
      "500": Error500Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("Provision request received");

    try {
      // Parse request body
      const body = (await c.req.json()) as ProvisionRequest;

      // Validate required fields
      if (!body.btcAddress) {
        return this.err(c, {
          error: "Missing btcAddress field",
          code: "MISSING_BTC_ADDRESS",
          status: 400,
          retryable: false,
        });
      }

      if (!body.signature) {
        return this.err(c, {
          error: "Missing signature field",
          code: "MISSING_SIGNATURE",
          status: 400,
          retryable: false,
        });
      }

      if (!body.message) {
        return this.err(c, {
          error: "Missing message field",
          code: "INVALID_MESSAGE_FORMAT",
          status: 400,
          retryable: false,
        });
      }

      // Initialize BTC verification service
      const btcVerifyService = new BtcVerifyService(logger);

      // Verify BTC signature
      const verifyResult = await btcVerifyService.verify(
        body.btcAddress,
        body.message,
        body.signature
      );

      if (!verifyResult.valid) {
        logger.warn("BTC signature verification failed", {
          btcAddress: body.btcAddress,
          code: verifyResult.code,
          error: verifyResult.error,
        });

        // Map BtcVerifyService error codes to RelayErrorCode
        // VERIFICATION_ERROR is an internal error, map it to INTERNAL_ERROR
        const errorCode = verifyResult.code === "VERIFICATION_ERROR"
          ? "INTERNAL_ERROR"
          : verifyResult.code;

        return this.err(c, {
          error: verifyResult.error,
          code: errorCode,
          status: verifyResult.code === "VERIFICATION_ERROR" ? 500 : 400,
          retryable: verifyResult.code === "VERIFICATION_ERROR",
        });
      }

      logger.info("BTC signature verified", {
        btcAddress: body.btcAddress,
        path: verifyResult.path,
      });

      // Initialize auth service and provision key
      const authService = new AuthService(c.env.API_KEYS_KV, logger);

      let apiKey: string;
      let metadata: any;

      try {
        const result = await authService.provisionKey(body.btcAddress);
        apiKey = result.apiKey;
        metadata = result.metadata;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : "Unknown error";

        // Check if this is a duplicate BTC address error
        if (errorMessage.includes("already has a provisioned API key")) {
          logger.warn("BTC address already provisioned", {
            btcAddress: body.btcAddress,
          });
          return this.err(c, {
            error: "Bitcoin address already has a provisioned API key",
            code: "ALREADY_PROVISIONED",
            status: 409,
            retryable: false,
          });
        }

        // Check if KV is not configured
        if (errorMessage.includes("not configured")) {
          logger.error("API_KEYS_KV not configured", { error: errorMessage });
          return this.err(c, {
            error: "Service configuration error",
            code: "INTERNAL_ERROR",
            status: 500,
            details: "API key storage not configured",
            retryable: false,
          });
        }

        // Other errors are internal
        logger.error("Failed to provision key", {
          error: errorMessage,
          btcAddress: body.btcAddress,
        });
        return this.err(c, {
          error: "Failed to provision API key",
          code: "INTERNAL_ERROR",
          status: 500,
          details: errorMessage,
          retryable: true,
        });
      }

      logger.info("API key provisioned", {
        btcAddress: body.btcAddress,
        keyId: metadata.keyId,
        tier: metadata.tier,
      });

      // Return success response
      return this.ok(c, {
        apiKey,
        metadata,
      });
    } catch (e) {
      logger.error("Unexpected error", {
        error: e instanceof Error ? e.message : "Unknown error",
      });
      return this.err(c, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        status: 500,
        details: e instanceof Error ? e.message : "Unknown error",
        retryable: true,
      });
    }
  }
}
