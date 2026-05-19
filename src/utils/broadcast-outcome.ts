/**
 * Maps raw Stacks node broadcast responses to tx-schemas outcome types
 * and determines the appropriate action for the relay to take.
 *
 * Bridges the gap between Hiro's raw HTTP error format and the
 * NodeBroadcastOutcome / BroadcastResponsibility discriminated unions
 * defined in @aibtc/tx-schemas.
 */
import type {
  NodeBroadcastOutcome,
  BroadcastResponsibility,
} from "@aibtc/tx-schemas/core/nonce-outcome";

/** Raw broadcast error from broadcastRawTx (non-ok path). */
export interface RawBroadcastError {
  status: number;
  reason: string;
  body: string;
  reasonData?: Record<string, unknown>;
}

/**
 * Parse a raw Hiro broadcast error into a typed NodeBroadcastOutcome.
 *
 * Maps stacks-core MemPoolRejection reason strings to the tx-schemas
 * discriminated union, extracting isOrigin and other fields from reason_data.
 *
 * BadNonce routing: stacks-core emits "BadNonce" in two distinct situations:
 *   (a) is_origin === true  → the *sender* used a nonce that is already confirmed
 *       on-chain. Routes to nonce_conflict so decideBroadcastAction returns
 *       responsible:"sender". No sponsor slot should be penalised.
 *   (b) is_origin !== true  → the *sponsor* used a nonce below the sponsor chain
 *       head. Routes to nonce_too_low so decideBroadcastAction returns
 *       responsible:"sponsor" / action:"skip_nonce".
 * This mirrors the ConflictingNonceInMempool routing and is the correct fix for
 * the original bug where all BadNonce cases were attributed to the sponsor.
 */
export function parseBroadcastOutcome(raw: RawBroadcastError): NodeBroadcastOutcome {
  const { reason, status, reasonData } = raw;
  const isOrigin = reasonData?.is_origin === true;

  switch (reason) {
    case "ConflictingNonceInMempool":
      return { outcome: "nonce_conflict", isOrigin };

    case "TooMuchChaining":
      return {
        outcome: "chaining_limit",
        isOrigin,
        principal: typeof reasonData?.principal === "string" ? reasonData.principal : "",
        maxNonce: typeof reasonData?.expected === "number" ? reasonData.expected : 0,
        actualNonce: typeof reasonData?.actual === "number" ? reasonData.actual : 0,
      };

    case "BadNonce":
      // When the origin (sender) caused the bad nonce (is_origin=true), treat it
      // the same as ConflictingNonceInMempool — the sender is responsible.
      // When the sponsor caused it (is_origin=false/undefined), the nonce is simply
      // too low for the sponsor chain — route to nonce_too_low (sponsor responsible).
      if (isOrigin) {
        return { outcome: "nonce_conflict", isOrigin: true };
      }
      return { outcome: "nonce_too_low" };

    case "FeeTooLow":
      return {
        outcome: "fee_too_low",
        required: typeof reasonData?.expected === "number" ? String(reasonData.expected) : "0",
        actual: typeof reasonData?.actual === "number" ? String(reasonData.actual) : "0",
      };

    case "NotEnoughFunds":
      return {
        outcome: "insufficient_funds",
        required: typeof reasonData?.expected === "number" ? String(reasonData.expected) : "0",
        available: typeof reasonData?.actual === "number" ? String(reasonData.actual) : "0",
      };

    case "Deserialization":
    case "SignatureValidation":
    case "BadTransactionVersion":
    case "NetworkVersionMismatch":
    case "NoSuchContract":
    case "ContractAlreadyExists":
    case "TransferAmountMustBePositive":
      return { outcome: "invalid_transaction", reason };

    case "TemporarilyBlacklisted":
      return { outcome: "temporarily_blacklisted" };

    default:
      if (status >= 500) {
        return { outcome: "server_error", reason: `${reason}: ${raw.body}`.slice(0, 200) };
      }
      if (status === 429) {
        return { outcome: "rate_limited" };
      }
      return { outcome: "invalid_transaction", reason: `${reason}: ${raw.body}`.slice(0, 200) };
  }
}

/**
 * Given a NodeBroadcastOutcome, determine who is responsible and what action to take.
 *
 * Responsibility table:
 * - sender → retire entry, report to agent
 * - sponsor → skip nonce, wait for confirmations, or retry with higher fee
 * - network → retry after delay
 */
export function decideBroadcastAction(outcome: NodeBroadcastOutcome): BroadcastResponsibility {
  switch (outcome.outcome) {
    case "accepted":
      return { responsible: "sponsor", action: "skip_nonce" };

    case "nonce_conflict":
      if (outcome.isOrigin) {
        return { responsible: "sender", action: "report_to_agent", agentErrorCode: "sender_nonce_confirmed" };
      }
      return { responsible: "sponsor", action: "skip_nonce" };

    case "chaining_limit":
      if (outcome.isOrigin) {
        return { responsible: "sender", action: "report_to_agent", agentErrorCode: "origin_chaining_limit" };
      }
      return { responsible: "sponsor", action: "wait_for_confirmations" };

    case "nonce_too_low":
      return { responsible: "sponsor", action: "skip_nonce" };

    case "fee_too_low":
      return { responsible: "sponsor", action: "retry_with_higher_fee" };

    case "insufficient_funds":
      return { responsible: "sponsor", action: "skip_nonce" };

    case "invalid_transaction":
      return { responsible: "sender", action: "report_to_agent", agentErrorCode: "invalid_transaction" };

    case "rate_limited":
      return { responsible: "network", action: "retry_after_delay", retryAfterMs: 30_000 };

    case "server_error":
      return { responsible: "network", action: "retry_after_delay", retryAfterMs: 10_000 };

    case "temporarily_blacklisted":
      return { responsible: "network", action: "retry_after_delay", retryAfterMs: 60_000 };

    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
