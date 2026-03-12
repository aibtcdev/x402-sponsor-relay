/**
 * Shared Hiro API helpers.
 *
 * Previously duplicated across SettlementHealthService, SettlementService,
 * SponsorService, and FeeService.
 */

/**
 * Get the Hiro API base URL for the given network.
 */
export function getHiroBaseUrl(network: "mainnet" | "testnet"): string {
  return network === "mainnet"
    ? "https://api.hiro.so"
    : "https://api.testnet.hiro.so";
}

/**
 * Build headers for Hiro API requests, including optional API key.
 */
export function getHiroHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["x-hiro-api-key"] = apiKey;
  }
  return headers;
}

/**
 * An ordered list of broadcast targets: { baseUrl, headers } objects.
 * The first entry is the primary Hiro node (with API key if provided).
 * Subsequent entries are fallback nodes (no API key headers).
 */
export interface BroadcastTarget {
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * Build an ordered list of broadcast targets for /v2/transactions.
 *
 * @param network - "mainnet" | "testnet"
 * @param apiKey - Optional Hiro API key (only sent to the primary Hiro node)
 * @param fallbackUrlsCsv - Optional comma-separated list of fallback node base URLs
 *   from env.BROADCAST_NODE_URLS. These nodes receive no API key header.
 *
 * Returns an array of targets tried in order. Primary Hiro is always first.
 * If fallbackUrlsCsv is absent or empty, only the primary node is returned.
 */
export function getBroadcastTargets(
  network: "mainnet" | "testnet",
  apiKey?: string,
  fallbackUrlsCsv?: string
): BroadcastTarget[] {
  const primary: BroadcastTarget = {
    baseUrl: getHiroBaseUrl(network),
    headers: getHiroHeaders(apiKey),
  };

  if (!fallbackUrlsCsv || fallbackUrlsCsv.trim() === "") {
    return [primary];
  }

  const fallbacks: BroadcastTarget[] = fallbackUrlsCsv
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .map((baseUrl) => ({ baseUrl, headers: {} }));

  return [primary, ...fallbacks];
}
