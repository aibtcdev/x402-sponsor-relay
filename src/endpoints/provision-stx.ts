import { BaseEndpoint } from "./BaseEndpoint";
import { AuthService, DuplicateStxAddressError, KVNotConfiguredError, StxVerifyService } from "../services";
import type { AppContext, ApiKeyMetadata, ProvisionStxRequest, RelayErrorCode } from "../types";
import {
  Error400Response,
  Error409Response,
  Error500Response,
} from "../schemas";

/**
 * ProvisionStx endpoint - programmatic API key provisioning via Stacks signature
 * POST /keys/provision-stx
 *
 * Accepts stxAddress + signature + message, verifies Stacks message signature,
 * and provisions a free-tier API key with 30-day expiration.
 *
 * Two paths:
 * 1. Registration: message = "Bitcoin will be the currency of AIs" (no timestamp)
 * 2. Self-service: message = "Bitcoin will be the currency of AIs | {ISO-timestamp}" (must be within 5 min)
 *
 * Returns HTTP 409 if Stacks address already has a key.
 */
export class ProvisionStx extends BaseEndpoint {
  schema = {
    tags: ["Provision"],
    summary: "Provision an API key via Stacks signature",
    description:
      "Self-provision a free-tier API key by proving Stacks address ownership via message signature verification. " +
      "Supports two paths: Registration (bare message 'Bitcoin will be the currency of AIs') and Self-service " +
      "(message with timestamp within 5 minutes). Returns HTTP 409 if Stacks address already has a provisioned key.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: {
              type: "object" as const,
              required: ["stxAddress", "signature", "message"],
              properties: {
                stxAddress: {
                  type: "string" as const,
                  description: "Stacks address used to sign the message (mainnet: SP..., testnet: ST...)",
                  example: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
                },
                signature: {
                  type: "string" as const,
                  description: "RSV signature of the message (hex-encoded)",
                  example: "0x01234567890abcdef...",
                },
                message: {
                  type: "string" as const,
                  description:
                    "Message that was signed. Either bare message 'Bitcoin will be the currency of AIs' (registration path) " +
                    "or message with timestamp 'Bitcoin will be the currency of AIs | {ISO-timestamp}' (self-service path, must be within 5 minutes)",
                  example: "Bitcoin will be the currency of AIs | 2026-02-16T12:00:00.000Z",
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
                    keyId: { type: "string" as const, example: "a1b2c3d4" },
                    appName: { type: "string" as const, example: "stx:SP2J6ZY4" },
                    contactEmail: { type: "string" as const, example: "stx+SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7@x402relay.system" },
                    tier: { type: "string" as const, enum: ["free"] },
                    createdAt: { type: "string" as const, format: "date-time" },
                    expiresAt: { type: "string" as const, format: "date-time" },
                    active: { type: "boolean" as const, example: true },
                    stxAddress: { type: "string" as const, example: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7" },
                  },
                },
              },
            },
          },
        },
      },
      "400": Error400Response,
      "409": Error409Response,
      "500": Error500Response,
    },
  };

  async handle(c: AppContext) {
    const logger = this.getLogger(c);
    logger.info("ProvisionStx request received");

    try {
      const body = (await c.req.json()) as ProvisionStxRequest;

      // Validate required fields
      if (!body.stxAddress) {
        return this.err(c, {
          error: "Missing stxAddress field",
          code: "MISSING_STX_ADDRESS",
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

      // Validate STX address format (SP/ST prefix, 40-42 chars)
      const STX_ADDRESS_REGEX = /^S[PT][0-9A-HJKMNP-Z]{38,40}$/;
      if (!STX_ADDRESS_REGEX.test(body.stxAddress)) {
        return this.err(c, {
          error: "Invalid Stacks address format",
          code: "MISSING_STX_ADDRESS",
          status: 400,
          retryable: false,
        });
      }

      // Verify STX signature
      const network = c.env.STACKS_NETWORK;
      const stxVerifyService = new StxVerifyService(logger, network);
      const verifyResult = stxVerifyService.verifyProvisionMessage(
        body.signature,
        body.message
      );

      if (!verifyResult.valid) {
        logger.warn("STX signature verification failed", {
          stxAddress: body.stxAddress,
          code: verifyResult.code,
          error: verifyResult.error,
        });

        // Map VERIFICATION_ERROR (internal) to INTERNAL_ERROR; others pass through directly
        if (verifyResult.code === "VERIFICATION_ERROR") {
          return this.err(c, {
            error: verifyResult.error,
            code: "INTERNAL_ERROR",
            status: 500,
            retryable: true,
          });
        }

        // Map StxVerifyErrorCode to RelayErrorCode
        let errorCode: RelayErrorCode;
        if (verifyResult.code === "INVALID_SIGNATURE") {
          errorCode = "INVALID_STX_SIGNATURE";
        } else {
          errorCode = verifyResult.code satisfies RelayErrorCode;
        }

        return this.err(c, {
          error: verifyResult.error,
          code: errorCode,
          status: 400,
          retryable: false,
        });
      }

      logger.info("STX signature verified", {
        stxAddress: verifyResult.stxAddress,
        path: verifyResult.path,
      });

      // Provision API key
      const authService = new AuthService(c.env.API_KEYS_KV, logger);

      let apiKey: string;
      let metadata: ApiKeyMetadata;

      try {
        const result = await authService.provisionKeyByStx(body.stxAddress);
        apiKey = result.apiKey;
        metadata = result.metadata;
      } catch (e) {
        if (e instanceof DuplicateStxAddressError) {
          logger.warn("STX address already provisioned", { stxAddress: body.stxAddress });
          return this.err(c, {
            error: "Stacks address already has a provisioned API key",
            code: "ALREADY_PROVISIONED",
            status: 409,
            retryable: false,
          });
        }

        if (e instanceof KVNotConfiguredError) {
          logger.error("API_KEYS_KV not configured");
          return this.err(c, {
            error: "Service configuration error",
            code: "INTERNAL_ERROR",
            status: 500,
            details: "API key storage not configured",
            retryable: false,
          });
        }

        const errorMessage = e instanceof Error ? e.message : "Unknown error";
        logger.error("Failed to provision key", { error: errorMessage, stxAddress: body.stxAddress });
        return this.err(c, {
          error: "Failed to provision API key",
          code: "INTERNAL_ERROR",
          status: 500,
          details: errorMessage,
          retryable: true,
        });
      }

      logger.info("API key provisioned", {
        stxAddress: body.stxAddress,
        keyId: metadata.keyId,
        tier: metadata.tier,
      });

      return this.ok(c, { apiKey, metadata });
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
