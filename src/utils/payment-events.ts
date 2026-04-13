import type { Env, Logger } from "../types";
import type { PublicPaymentRecord } from "../services/payment-status";
import { VERSION } from "../version";

export type PaymentLifecycleEvent =
  | "payment.accepted"
  | "payment.poll"
  | "payment.finalized"
  | "payment.retry_decision"
  | "payment.fallback_used"
  | "payment.self_healed";

type PaymentLogLevel = "info" | "warn" | "error" | "debug";

export interface PaymentLifecycleLogContext {
  route: string;
  paymentId: string;
  status?: string;
  terminalReason?: string;
  action?: string;
  checkStatusUrlPresent: boolean;
  compatShimUsed: boolean;
  [key: string]: unknown;
}

export function getRelayBaseUrl(
  env: Pick<Env, "RELAY_BASE_URL" | "STACKS_NETWORK">
): string {
  return (
    env.RELAY_BASE_URL ??
    (env.STACKS_NETWORK === "mainnet"
      ? "https://x402-relay.aibtc.com"
      : "https://x402-relay.aibtc.dev")
  );
}

export function buildPaymentCheckStatusUrl(
  env: Pick<Env, "RELAY_BASE_URL" | "STACKS_NETWORK">,
  paymentId: string
): string {
  return `${getRelayBaseUrl(env)}/payment/${paymentId}`;
}

export function emitPaymentLifecycleEvent(
  logger: Logger,
  event: PaymentLifecycleEvent,
  context: PaymentLifecycleLogContext,
  level: PaymentLogLevel = "info"
): void {
  const {
    route,
    paymentId,
    status,
    terminalReason,
    action,
    checkStatusUrlPresent,
    compatShimUsed,
    ...extra
  } = context;
  logger[level](event, {
    ...extra,
    service: "relay",
    route,
    paymentId,
    status: status ?? null,
    terminalReason: terminalReason ?? null,
    action: action ?? null,
    checkStatusUrl_present: checkStatusUrlPresent,
    compat_shim_used: compatShimUsed,
    repo_version: VERSION,
  });
}

export function emitProjectedPaymentPollEvents(
  logger: Logger,
  route: string,
  record: PublicPaymentRecord,
  compatShimUsed: boolean
): void {
  emitPaymentLifecycleEvent(logger, "payment.poll", {
    route,
    paymentId: record.paymentId,
    status: record.status,
    terminalReason: record.terminalReason,
    action: compatShimUsed ? "project_submitted_to_queued" : "return_payment_status",
    checkStatusUrlPresent: true,
    compatShimUsed,
  });

  if (compatShimUsed) {
    emitPaymentLifecycleEvent(
      logger,
      "payment.fallback_used",
      {
        route,
        paymentId: record.paymentId,
        status: record.status,
        action: "submitted_projection",
        checkStatusUrlPresent: true,
        compatShimUsed: true,
      },
      "warn"
    );
  }
}
