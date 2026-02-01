/**
 * Response utilities for consistent API responses
 */

/**
 * Build explorer URL for a transaction
 * @param txid - Transaction ID (with or without 0x prefix)
 * @param network - Network ("mainnet" or "testnet")
 * @returns Full explorer URL
 */
export function buildExplorerUrl(
  txid: string,
  network: "mainnet" | "testnet"
): string {
  // Ensure txid has 0x prefix for consistency
  const normalizedTxid = txid.startsWith("0x") ? txid : `0x${txid}`;
  return `https://explorer.hiro.so/txid/${normalizedTxid}?chain=${network}`;
}
