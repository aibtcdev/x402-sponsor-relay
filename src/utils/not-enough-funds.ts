import { AuthType, PayloadType } from "@stacks/transactions";
import type { StacksTransactionWire } from "@stacks/transactions";

/**
 * Whose balance a node `NotEnoughFunds` rejection refers to.
 *
 * stacks-core's reason_data for NotEnoughFunds is only `{ expected, actual }` (0x-hex u128s),
 * with no `is_origin`. For a sponsored tx, the mempool admission check
 * (`StacksChainState::will_admit_mempool_tx`) raises it from:
 *   - the payer (sponsor) fee check, `expected = fee`, for every payload type, and
 *   - for a token transfer only, the origin (sender) check, `expected = amount`
 *     (the sponsor pays the fee, so the origin needs just the amount).
 * Contract calls never get an origin-side NotEnoughFunds at admission, so on a sponsored
 * contract call it always means the sponsor is short.
 *
 * Returns "sender" when it cannot tell (unsponsored tx, unreadable `expected`, or a token
 * transfer whose amount equals the fee), matching the previous behavior.
 */
export function notEnoughFundsPayer(
  transaction: StacksTransactionWire,
  reasonData: Record<string, unknown> | undefined
): "sender" | "sponsor" {
  if (transaction.auth.authType !== AuthType.Sponsored || !("sponsorSpendingCondition" in transaction.auth)) {
    return "sender";
  }
  if (transaction.payload.payloadType !== PayloadType.TokenTransfer) {
    return "sponsor";
  }

  const fee = BigInt(transaction.auth.sponsorSpendingCondition.fee);
  const amount = BigInt(transaction.payload.amount);
  if (fee === amount) return "sender";

  const expected = parseU128(reasonData?.expected);
  if (expected === fee) return "sponsor";
  return "sender";
}

function parseU128(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value !== "string" || !/^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return null;
  return BigInt(value);
}
