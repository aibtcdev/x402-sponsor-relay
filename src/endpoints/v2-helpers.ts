import { SettlementService } from "../services";
import type {
  Env,
  Logger,
  PaymentIdentifierExtension,
  SettleOptions,
  X402SettleRequestV2,
} from "../types";
import { CAIP2_NETWORKS, X402_V2_ERROR_CODES } from "../types";

/** Allowed characters for payment-identifier id: alphanumeric, underscore, hyphen */
const PAYMENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const PAYMENT_ID_MIN_LENGTH = 16;
const PAYMENT_ID_MAX_LENGTH = 128;

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
        extensions: {
          type: "object" as const,
          description: "Optional protocol extensions",
          properties: {
            "payment-identifier": {
              type: "object" as const,
              description: "Client-controlled idempotency key (payment-identifier extension)",
              properties: {
                info: {
                  type: "object" as const,
                  properties: {
                    id: {
                      type: "string" as const,
                      description:
                        "16-128 char idempotency key (pattern: [a-zA-Z0-9_-]+, pay_ prefix recommended)",
                      example: "pay_01JMVP9QE8XA3BDGM5RN7KWTZ4",
                    },
                  },
                },
              },
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
  /** Max settlement timeout in seconds from paymentRequirements (optional) */
  maxTimeoutSeconds?: number;
  /**
   * Extracted payment-identifier extension id, if provided by client.
   * Undefined when the extension is absent (backward compatible).
   * Used for client-controlled idempotency caching in /settle and /verify.
   */
  paymentIdentifier?: string;
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
    logger.warn("Missing required V2 fields", {
      hasPaymentPayload: !!parsed?.paymentPayload,
      hasPaymentRequirements: !!parsed?.paymentRequirements,
    });
    return {
      valid: false,
      error: { errorReason: X402_V2_ERROR_CODES.INVALID_PAYLOAD, status: 400 },
    };
  }

  // Validate paymentRequirements has required fields
  const req = parsed.paymentRequirements;
  if (!req.network || !req.payTo || !req.amount || !req.asset) {
    return {
      valid: false,
      error: {
        errorReason: X402_V2_ERROR_CODES.INVALID_PAYMENT_REQUIREMENTS,
        status: 400,
      },
    };
  }

  // Validate scheme — this relay only supports "exact" (#109)
  // Check early so unsupported schemes get INVALID_SCHEME, not a confusing
  // UNSUPPORTED_SCHEME that looks like an asset mapping failure.
  if (req.scheme && req.scheme !== "exact") {
    logger.warn("Unsupported payment scheme", {
      scheme: req.scheme,
      supportedSchemes: ["exact"],
    });
    return {
      valid: false,
      error: { errorReason: X402_V2_ERROR_CODES.INVALID_SCHEME, status: 400 },
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
  const tokenType = settlementService.mapAssetToTokenType(req.asset);
  if (tokenType === null) {
    logger.warn("Unrecognized asset in paymentRequirements", {
      asset: req.asset,
      supportedAssets: ["STX", "sBTC", "USDCx"],
    });
    return {
      valid: false,
      error: {
        errorReason: X402_V2_ERROR_CODES.UNRECOGNIZED_ASSET,
        status: 400,
      },
    };
  }

  // Extract transaction hex from payload
  const txHex = parsed.paymentPayload?.payload?.transaction;
  if (!txHex) {
    logger.warn("Empty or missing transaction in paymentPayload", {
      hasPayload: !!parsed.paymentPayload?.payload,
    });
    return {
      valid: false,
      error: { errorReason: X402_V2_ERROR_CODES.INVALID_PAYLOAD, status: 400 },
    };
  }

  // Extract maxTimeoutSeconds from payment requirements (positive numbers only)
  const maxTimeoutSeconds =
    typeof req.maxTimeoutSeconds === "number" && req.maxTimeoutSeconds > 0
      ? req.maxTimeoutSeconds
      : undefined;

  // Extract and validate payment-identifier extension (optional)
  const paymentIdResult = validatePaymentIdentifier(
    parsed.paymentPayload.extensions?.["payment-identifier"],
    logger
  );
  if (paymentIdResult !== undefined && typeof paymentIdResult !== "string") {
    return paymentIdResult;
  }
  const paymentIdentifier = paymentIdResult;

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
      maxTimeoutSeconds,
      paymentIdentifier,
    },
  };
}

/**
 * Validate the payment-identifier extension if present.
 *
 * Returns:
 * - `undefined` if the extension is absent (backward compatible, no id)
 * - The validated id string if the extension is present and valid
 * - A V2ValidationResult error if the extension is present but invalid
 */
function validatePaymentIdentifier(
  ext: PaymentIdentifierExtension | undefined,
  logger: Logger
): string | undefined | { valid: false; error: V2ValidationError } {
  if (ext === undefined) {
    return undefined;
  }

  const id = ext?.info?.id;
  const invalidPayload = {
    valid: false as const,
    error: { errorReason: X402_V2_ERROR_CODES.INVALID_PAYLOAD, status: 400 as const },
  };

  if (typeof id !== "string") {
    logger.warn("payment-identifier extension present but id is not a string", { idType: typeof id });
    return invalidPayload;
  }

  if (id.length < PAYMENT_ID_MIN_LENGTH || id.length > PAYMENT_ID_MAX_LENGTH) {
    logger.warn("payment-identifier id length out of range", {
      length: id.length,
      min: PAYMENT_ID_MIN_LENGTH,
      max: PAYMENT_ID_MAX_LENGTH,
    });
    return invalidPayload;
  }

  if (!PAYMENT_ID_PATTERN.test(id)) {
    logger.warn("payment-identifier id contains invalid characters", { id });
    return invalidPayload;
  }

  logger.debug("payment-identifier extracted", { id });
  return id;
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
      return X402_V2_ERROR_CODES.UNSUPPORTED_SCHEME;
    default:
      return X402_V2_ERROR_CODES.INVALID_TRANSACTION_STATE;
  }
}

