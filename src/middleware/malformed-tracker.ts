/**
 * IP-based tracking for repeated malformed transaction payloads.
 *
 * Senders who submit 3+ malformed payloads within a 10-minute window
 * are temporarily blocked for the remainder of the window.
 *
 * can be temporarily blocked for the remainder of the window by callers that
 * enforce the result of this tracker.
 *
 * A single shared map is used so that any endpoints that consult this tracker
 * share the same malformed-attempt counts for a given IP.
 */

/** Duration of the tracking window in milliseconds (10 minutes). */
export const MALFORMED_BLOCK_WINDOW_MS = 10 * 60 * 1000;

/** Number of malformed attempts before the IP is blocked. */
export const MALFORMED_BLOCK_THRESHOLD = 3;

/** Maximum number of tracked IPs to prevent unbounded growth under high-cardinality traffic. */
const MAX_TRACKED_IPS = 10_000;

const trackerMap = new Map<string, { count: number; firstSeen: number }>();

/**
 * Remove entries whose window has expired so the map does not grow unbounded.
 * Also enforces a hard cap: if the map exceeds MAX_TRACKED_IPS after pruning,
 * evict the oldest entries until it fits.
 */
function pruneExpired(): void {
  const cutoff = Date.now() - MALFORMED_BLOCK_WINDOW_MS;
  for (const [ip, entry] of trackerMap) {
    if (entry.firstSeen < cutoff) trackerMap.delete(ip);
  }
  // Hard cap: evict oldest entries if map is still too large
  if (trackerMap.size > MAX_TRACKED_IPS) {
    const sorted = [...trackerMap.entries()].sort((a, b) => a[1].firstSeen - b[1].firstSeen);
    const toEvict = sorted.slice(0, trackerMap.size - MAX_TRACKED_IPS);
    for (const [ip] of toEvict) trackerMap.delete(ip);
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
