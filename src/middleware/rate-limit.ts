/**
 * Simple rate limiting using in-memory map
 * In production, use Durable Objects or KV for distributed rate limiting
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/** Maximum requests per window */
export const RATE_LIMIT = 10;

/** Rate limit window in milliseconds (1 minute) */
const RATE_WINDOW_MS = 60 * 1000;

/**
 * Check if an address is within rate limits
 * @param address - The address to check (typically transaction sender)
 * @returns true if within limits, false if rate limited
 */
export function checkRateLimit(address: string): boolean {
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
