import { SettlementService } from "../services";
import type {
  Env,
  Logger,
  SettleOptions,
  X402SettleRequestV2,
} from "../types";
import { CAIP2_NETWORKS, X402_V2_ERROR_CODES } from "../types";

// =============================================================================
// Shared OpenAPI Schema Definitions for V2 Endpoints
// =============================================================================

/**
 * OpenAPI schema for x402 V2 request body (used by /settle and /verify).
 * Both endpoints accept the same wire format per the x402 V2 spec.
 *
 * Note: No `as const` assertion -- Chanfana requires mutable `string[]` for `required` arrays.
 */
export const V2_REQUEST_BODY_SCHEMA = {
  type: "object" as const,
  required: ["paymentPayload", "paymentRequirements"],
  properties: {
    x402Version: {
      type: "number" as const,
      description: "x402 protocol version (optional at top level, library compat)",
      example: 2,
    },
    paymentPayload: {
      type: "object" as const,
      description: "Client payment authorization",
      required: ["payload"],
      properties: {
        x402Version: { type: "number" as const },
        payload: {
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
    paymentRequirements: {
      type: "object" as const,
      description: "Server payment requirements to validate against",
      required: ["network", "payTo", "amount", "asset"],
      properties: {
        scheme: { type: "string" as const, example: "exact" },
        network: { type: "string" as const, description: "CAIP-2 network identifier", example: "stacks:2147483648" },
        amount: { type: "string" as const, description: "Required amount in smallest unit", example: "1000000" },
        asset: { type: "string" as const, description: "Asset identifier (STX, sBTC, or CAIP-19 contract address)", example: "STX" },
        payTo: { type: "string" as const, description: "Recipient Stacks address", example: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE" },
        maxTimeoutSeconds: { type: "number" as const, example: 60 },
      },
    },
  },
};

/**
 * OpenAPI error response schema shared by V2 /settle 400 and 500 responses.
 */
export const V2_ERROR_RESPONSE_SCHEMA = {
  type: "object" as const,
  required: ["success", "errorReason", "transaction", "network"],
  properties: {
    success: { type: "boolean" as const, example: false },
    errorReason: { type: "string" as const, example: "invalid_payload" },
    transaction: { type: "string" as const, example: "" },
    network: { type: "string" as const, example: "stacks:2147483648" },
  },
};

/**
 * Parsed and validated V2 request data, ready for verify or settle operations.
 */
export interface V2ValidatedRequest {
  /** Internal settle options derived from paymentRequirements */
  settleOptions: SettleOptions;
  /** Raw transaction hex from paymentPayload */
  txHex: string;
  /** CAIP-2 network identifier for the relay's configured network */
  network: string;
  /** SettlementService instance (reuse for verify/broadcast/dedup) */
  settlementService: SettlementService;
}

/**
 * V2 validation failure with a spec error code and HTTP status.
 */
export interface V2ValidationError {
  errorReason: string;
  status: 200 | 400;
}

/**
 * Result of V2 request validation: either validated data or an error.
 */
export type V2ValidationResult =
  | { valid: true; data: V2ValidatedRequest }
  | { valid: false; error: V2ValidationError };

/**
 * Validate an x402 V2 request body (shared between /settle and /verify).
 *
 * Performs all common checks:
 * - Parses and validates top-level paymentPayload/paymentRequirements
 * - Validates paymentRequirements has network, payTo, amount
 * - Validates network matches relay configuration
 * - Maps asset to internal token type
 * - Extracts transaction hex from payload
 *
 * Returns validated data ready for verifyPaymentParams or broadcastAndConfirm,
 * or a V2-shaped error with the appropriate HTTP status.
 */
export function validateV2Request(
  body: unknown,
  env: Env,
  logger: Logger
): V2ValidationResult {
  const network = CAIP2_NETWORKS[env.STACKS_NETWORK];

  // Validate top-level fields exist
  const parsed = body as X402SettleRequestV2 | null;
  if (!parsed?.paymentPayload || !parsed?.paymentRequirements) {
    return {
      valid: false,
      error: { errorReason: X402_V2_ERROR_CODES.INVALID_PAYLOAD, status: 400 },
    };
  }

  // Validate paymentRequirements has required fields
  const req = parsed.paymentRequirements;
  if (!req.network || !req.payTo || !req.amount) {
    return {
      valid: false,
      error: {
        errorReason: X402_V2_ERROR_CODES.INVALID_PAYMENT_REQUIREMENTS,
        status: 400,
      },
    };
  }

  // Validate network matches relay's configured network
  if (req.network !== network) {
    logger.warn("Network mismatch", {
      expected: network,
      received: req.network,
    });
    return {
      valid: false,
      error: { errorReason: X402_V2_ERROR_CODES.INVALID_NETWORK, status: 400 },
    };
  }

  // Map asset to internal token type
  const settlementService = new SettlementService(env, logger);
  const tokenType = settlementService.mapAssetToTokenType(req.asset || "STX");
  if (tokenType === null) {
    logger.warn("Unsupported asset", { asset: req.asset });
    return {
      valid: false,
      error: {
        errorReason: X402_V2_ERROR_CODES.UNSUPPORTED_SCHEME,
        status: 400,
      },
    };
  }

  // Extract transaction hex from payload
  const txHex = parsed.paymentPayload?.payload?.transaction;
  if (!txHex) {
    return {
      valid: false,
      error: { errorReason: X402_V2_ERROR_CODES.INVALID_PAYLOAD, status: 400 },
    };
  }

  return {
    valid: true,
    data: {
      settleOptions: {
        expectedRecipient: req.payTo,
        minAmount: req.amount,
        tokenType,
      },
      txHex,
      network,
      settlementService,
    },
  };
}

/**
 * Map an internal verifyPaymentParams error message to a V2 spec error code.
 *
 * Used by both /settle (errorReason) and /verify (invalidReason) since
 * the error mapping is identical per the x402 V2 spec.
 */
export function mapVerifyErrorToV2Code(errorMessage: string): string {
  switch (errorMessage) {
    case "Recipient mismatch":
      return X402_V2_ERROR_CODES.RECIPIENT_MISMATCH;
    case "Insufficient payment amount":
      return X402_V2_ERROR_CODES.AMOUNT_INSUFFICIENT;
    case "Token type mismatch":
      return X402_V2_ERROR_CODES.SENDER_MISMATCH;
    default:
      return X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE;
  }
}

