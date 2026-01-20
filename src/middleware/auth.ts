import type { Context, Next } from "hono";
import type { Env, AppVariables, AuthContext, RelayErrorCode } from "../types";
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
  const authHeader = c.req.header("Authorization");
  const apiKey = extractBearerToken(authHeader);

  // No API key provided - grace period
  if (!apiKey) {
    logger.warn("No API key provided (grace period active)", {
      path: c.req.path,
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
      {
        error: result.error,
        code: result.code as RelayErrorCode,
        retryable: false,
      },
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

  if (!auth || auth.gracePeriod) {
    const logger = c.get("logger");
    logger.warn("API key required but not provided");

    return c.json(
      {
        error: "API key required",
        code: "MISSING_API_KEY" as RelayErrorCode,
        retryable: false,
      },
      401
    );
  }

  return next();
}
