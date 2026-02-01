import type { Context, Next } from "hono";
import type {
  Env,
  AppVariables,
  AuthContext,
  RelayErrorCode,
  RelayErrorResponse,
} from "../types";
import { AuthService } from "../services/auth";

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Build a structured error response
 * Uses the standardized error format with success, code, and requestId
 */
function buildErrorResponse(
  requestId: string,
  error: string,
  code: RelayErrorCode,
  retryable: boolean
): RelayErrorResponse {
  return {
    success: false,
    error,
    code,
    retryable,
    requestId,
  };
}

/**
 * Auth middleware - validates API keys and stores auth context
 *
 * Grace period behavior:
 * - If no Authorization header is provided, continues with warning (grace period)
 * - Once grace period ends, missing keys will be rejected
 */
export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
) {
  const logger = c.get("logger");
  const requestId = c.get("requestId") || "unknown";
  const authHeader = c.req.header("Authorization");
  const apiKey = extractBearerToken(authHeader);

  // No API key provided - grace period
  if (!apiKey) {
    // Sanitize path to avoid logging query parameters
    const sanitizedPath = c.req.path.split("?")[0];
    logger.warn("No API key provided (grace period active)", {
      path: sanitizedPath,
      method: c.req.method,
    });

    const authContext: AuthContext = {
      metadata: null,
      gracePeriod: true,
    };
    c.set("auth", authContext);
    return next();
  }

  // Validate API key
  const authService = new AuthService(c.env.API_KEYS_KV, logger);
  const result = await authService.validateKey(apiKey);

  if (!result.valid) {
    // Determine HTTP status based on error code
    let status: 401 | 403;
    if (result.code === "EXPIRED_API_KEY" || result.code === "REVOKED_API_KEY") {
      status = 403;
    } else {
      status = 401;
    }

    logger.warn("API key validation failed", {
      code: result.code,
      error: result.error,
    });

    return c.json(
      buildErrorResponse(requestId, result.error, result.code, false),
      status
    );
  }

  // Valid key - store auth context
  const authContext: AuthContext = {
    metadata: result.metadata,
    gracePeriod: false,
  };
  c.set("auth", authContext);

  logger.debug("API key validated", {
    keyId: result.metadata.keyId,
    appName: result.metadata.appName,
    tier: result.metadata.tier,
  });

  return next();
}

/**
 * Require auth middleware - rejects requests without valid API key
 * Use this after grace period ends
 */
export async function requireAuthMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
) {
  const auth = c.get("auth");
  const requestId = c.get("requestId") || "unknown";

  if (!auth || auth.gracePeriod) {
    const logger = c.get("logger");
    logger.warn("API key required but not provided");

    return c.json(
      buildErrorResponse(
        requestId,
        "API key required",
        "MISSING_API_KEY",
        false
      ),
      401
    );
  }

  return next();
}
