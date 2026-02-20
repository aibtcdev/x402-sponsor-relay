/**
 * Shared Stacks transaction helpers.
 */

/**
 * Broadcast error reasons that indicate a nonce conflict.
 * Used by both /sponsor endpoint (direct broadcast) and SettlementService (broadcastAndConfirm).
 */
export const NONCE_CONFLICT_REASONS = ["ConflictingNonceInMempool", "BadNonce"];

/**
 * Strip the "0x" prefix from a hex string if present.
 * Used before deserializing transactions or computing hashes.
 */
export function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}
