/**
 * Simple in-memory rate limiting for unauthenticated requests (grace period)
 * For authenticated requests, use AuthService.checkRateLimit directly
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/** Maximum requests per window for unauthenticated requests */
export const RATE_LIMIT = 10;

/** Rate limit window in milliseconds (1 minute) */
const RATE_WINDOW_MS = 60 * 1000;

/**
 * Rate limit check result for unauthenticated requests
 */
export interface SenderRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
}

/**
 * Check if an address is within rate limits (in-memory, for unauthenticated requests)
 * @param address - The address to check (typically transaction sender)
 * @returns Object with allowed status, remaining requests, and retryAfter if limited
 */
export function checkSenderRateLimit(address: string): SenderRateLimitResult {
  const now = Date.now();
  const entry = rateLimitMap.get(address);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(address, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  if (entry.count >= RATE_LIMIT) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use checkSenderRateLimit instead
 */
export function checkRateLimit(address: string): boolean {
  return checkSenderRateLimit(address).allowed;
}
