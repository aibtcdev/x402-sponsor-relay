import type { Context, Next } from "hono";
import type { Env, AppVariables } from "../types";

/**
 * Simple rate limiting using in-memory map
 * In production, use Durable Objects or KV for distributed rate limiting
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // requests per window
const RATE_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * Check if an address is within rate limits
 */
function checkRateLimit(address: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(address);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(address, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

/**
 * Rate limit middleware factory
 * Returns middleware that rate limits based on a key extractor function
 */
export function rateLimitMiddleware(
  getKey: (c: Context<{ Bindings: Env; Variables: AppVariables }>) => string | null
) {
  return async (
    c: Context<{ Bindings: Env; Variables: AppVariables }>,
    next: Next
  ) => {
    const key = getKey(c);

    // Skip rate limiting if no key provided
    if (!key) {
      return next();
    }

    const logger = c.get("logger");

    if (!checkRateLimit(key)) {
      logger.warn("Rate limit exceeded", { key });
      return c.json(
        {
          error: "Rate limit exceeded",
          details: `Maximum ${RATE_LIMIT} requests per minute`,
        },
        429
      );
    }

    return next();
  };
}

export { RATE_LIMIT, RATE_WINDOW_MS };
