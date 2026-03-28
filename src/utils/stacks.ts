/**
 * Shared Stacks transaction helpers.
 */
import { hexToCV, cvToValue } from "@stacks/transactions";

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
  "TooMuchChaining",
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

/**
 * Decode a Clarity uint value from a hex string returned by Hiro's /v2/accounts endpoint.
 *
 * Hiro returns balance fields as Clarity-encoded hex (e.g. "0x0000000000000000000000001451535f").
 * This function decodes that hex to a decimal string using hexToCV + cvToValue.
 *
 * Falls back to BigInt hex parsing if Clarity decoding fails, and returns "0" on any error.
 * If the input is not hex-prefixed, it is returned unchanged (already decimal).
 */
export function decodeClarityUint(hex: string): string {
  if (!hex.startsWith("0x")) {
    // Already a decimal string — return as-is
    return hex;
  }
  try {
    const cv = hexToCV(stripHexPrefix(hex));
    const value = cvToValue(cv, true);
    // cvToValue returns bigint for uint/int types
    return String(value);
  } catch (_clarityErr) {
    // Fall back to direct BigInt hex parsing
    try {
      return BigInt(hex).toString();
    } catch (_bigintErr) {
      return "0";
    }
  }
}
