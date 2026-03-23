/**
 * Shared Stacks transaction helpers.
 */

/**
 * Broadcast error reasons that indicate a nonce conflict.
 * Used by both /sponsor endpoint (direct broadcast) and SettlementService (broadcastAndConfirm).
 */
export const NONCE_CONFLICT_REASONS = ["ConflictingNonceInMempool", "BadNonce"];

/**
 * Broadcast error reasons that indicate the client submitted a bad or invalid transaction.
 * When a Stacks node 4xx rejection matches one of these reasons, the failure is attributed
 * to the client rather than the relay, log severity is downgraded from ERROR to WARN, and
 * the matched reason is surfaced in BroadcastAndConfirmResult.clientRejection so callers
 * can return a distinct, actionable error code to the agent.
 */
export const CLIENT_REJECTION_REASONS = [
  "NotEnoughFunds",
  "FeeTooLow",
  "BadNonce",
  "ConflictingNonceInMempool",
  "TransferAmountMustBePositive",
  "NoSuchContract",
  "ContractAlreadyExists",
  "BadTransactionVersion",
  "NetworkVersionMismatch",
  "Deserialization",
  "SignatureValidation",
];

/**
 * Strip the "0x" prefix from a hex string if present.
 * Used before deserializing transactions or computing hashes.
 */
export function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}
