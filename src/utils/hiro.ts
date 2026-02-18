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
