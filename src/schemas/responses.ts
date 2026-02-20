/**
 * Shared OpenAPI response schemas for error responses
 * These schemas are used across multiple endpoints to ensure consistency
 */

/**
 * Base error response schema with common fields
 */
export const BaseErrorSchema = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" as const, example: false },
    requestId: { type: "string" as const, format: "uuid" },
    error: { type: "string" as const },
    code: { type: "string" as const },
    details: { type: "string" as const },
    retryable: { type: "boolean" as const },
  },
};

/**
 * Error response with retry guidance (includes retryAfter field)
 */
export const RetryableErrorSchema = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" as const, example: false },
    requestId: { type: "string" as const, format: "uuid" },
    error: { type: "string" as const },
    code: { type: "string" as const },
    details: { type: "string" as const },
    retryable: { type: "boolean" as const },
    retryAfter: {
      type: "number" as const,
      description: "Seconds to wait before retrying",
    },
  },
};

/**
 * Retry-After header definition
 */
export const RetryAfterHeader = {
  "Retry-After": {
    description: "Seconds to wait before retrying",
    schema: { type: "string" as const },
  },
};

/**
 * 400 Bad Request - Invalid request
 */
export const Error400Response = {
  description: "Invalid request",
  content: {
    "application/json": {
      schema: BaseErrorSchema,
    },
  },
};

/**
 * 401 Unauthorized - Missing or invalid API key
 */
export const Error401Response = {
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
};

/**
 * 409 Conflict - Resource already exists
 */
export const Error409Response = {
  description: "Resource already exists",
  content: {
    "application/json": {
      schema: BaseErrorSchema,
    },
  },
};

/**
 * 404 Not Found - Resource not found
 */
export const Error404Response = {
  description: "Resource not found",
  content: {
    "application/json": {
      schema: BaseErrorSchema,
    },
  },
};

/**
 * 429 Too Many Requests - Rate limit or spending cap exceeded
 */
export const Error429Response = {
  description: "Rate limit or spending cap exceeded",
  content: {
    "application/json": {
      schema: RetryableErrorSchema,
    },
  },
  headers: RetryAfterHeader,
};

/**
 * 500 Internal Server Error
 */
export const Error500Response = {
  description: "Internal server error",
  content: {
    "application/json": {
      schema: BaseErrorSchema,
    },
  },
};

/**
 * 503 Service Unavailable - Nonce coordinator unavailable
 */
export const Error503Response = {
  description: "Service temporarily unavailable (e.g. nonce coordinator unreachable)",
  content: {
    "application/json": {
      schema: RetryableErrorSchema,
    },
  },
  headers: RetryAfterHeader,
};

/**
 * 502 Bad Gateway - Broadcast or settlement failed
 */
export const Error502Response = {
  description: "Broadcast or settlement error",
  content: {
    "application/json": {
      schema: RetryableErrorSchema,
    },
  },
  headers: RetryAfterHeader,
};

/**
 * 504 Gateway Timeout - Settlement timeout
 */
export const Error504Response = {
  description: "Settlement timeout",
  content: {
    "application/json": {
      schema: RetryableErrorSchema,
    },
  },
  headers: RetryAfterHeader,
};
