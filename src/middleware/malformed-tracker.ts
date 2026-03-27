/**
 * IP-based tracking for repeated malformed transaction payloads.
 *
 * Senders who submit 3+ malformed payloads within a 10-minute window
 * are temporarily blocked for the remainder of the window.
 *
 * A single shared map is used across all endpoints so that an attacker
 * cannot bypass the threshold by rotating between /relay, /sponsor, and /settle.
 */

/** Duration of the tracking window in milliseconds (10 minutes). */
export const MALFORMED_BLOCK_WINDOW_MS = 10 * 60 * 1000;

/** Number of malformed attempts before the IP is blocked. */
export const MALFORMED_BLOCK_THRESHOLD = 3;

const trackerMap = new Map<string, { count: number; firstSeen: number }>();

/**
 * Remove entries whose window has expired so the map does not grow unbounded.
 */
function pruneExpired(): void {
  const cutoff = Date.now() - MALFORMED_BLOCK_WINDOW_MS;
  for (const [ip, entry] of trackerMap) {
    if (entry.firstSeen < cutoff) trackerMap.delete(ip);
  }
}

/**
 * Record a malformed-payload attempt for the given IP.
 *
 * @returns `true` if the IP has reached or exceeded the block threshold
 *          within the current window and should be rejected.
 */
export function checkAndRecordMalformed(ip: string): boolean {
  pruneExpired();

  const now = Date.now();
  const entry = trackerMap.get(ip);

  if (!entry) {
    trackerMap.set(ip, { count: 1, firstSeen: now });
    return false;
  }

  // After pruning, any remaining entry is still within the window.
  entry.count += 1;
  return entry.count >= MALFORMED_BLOCK_THRESHOLD;
}
