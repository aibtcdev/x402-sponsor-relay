type LogLevel = "info" | "warn" | "error" | "debug";

const INFO_SAMPLE_RATES: Record<string, number> = {
  "payment.poll": 0.01,
  settlement_confirmed: 0.05,
};

function stableSampleKey(
  message: string,
  context?: Record<string, unknown>
): string {
  if (!context) return message;

  const keyParts = [
    context.paymentId,
    context.txid,
    context.walletIndex,
    context.sponsorNonce,
    context.senderAddress,
    context.route,
  ].filter((part) => part !== undefined && part !== null);

  return keyParts.length > 0
    ? `${message}:${keyParts.map(String).join(":")}`
    : message;
}

function hashToUnitInterval(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

export function shouldEmitLog(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): boolean {
  if (level !== "info") return true;

  const rate = INFO_SAMPLE_RATES[message];
  if (rate === undefined) return true;
  if (rate <= 0) return false;
  if (rate >= 1) return true;

  return hashToUnitInterval(stableSampleKey(message, context)) < rate;
}
