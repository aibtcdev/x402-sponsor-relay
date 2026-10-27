import { getAddressFromPrivateKey } from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import type { Env, Logger, SponsorStatusReason, SponsorStatusResult } from "../types";
import { DEFAULT_DAILY_BUDGET_USTX } from "../durable-objects/sponsor-wallet-do";
import { SponsorService } from "./sponsor";

/** Inputs that decide whether the x402 payment sponsor can take a payment right now. */
export interface PaymentSponsorState {
  configured: boolean;
  /** Spendable STX (µSTX), or null when Hiro could not be read */
  balance: bigint | null;
  spentToday: bigint;
  dailyBudget: bigint;
}

/**
 * Map the payment sponsor's state onto the SponsorStatusResult contract.
 *
 * x402 payments are sponsored by the single SponsorWalletDO (PAYMENT_SPONSOR_PRIVATE_KEY),
 * which reads its nonce from Hiro per payment — there is no pool, reconciliation or snapshot
 * to go stale. So readiness is just: configured, funded, and under today's budget. An
 * unreadable balance does not block (the sponsor preflight fails open the same way).
 */
export function toPaymentSponsorStatus(s: PaymentSponsorState, nowMs = Date.now()): SponsorStatusResult {
  const reasons: SponsorStatusReason[] = [];
  if (!s.configured) reasons.push("SPONSOR_NOT_CONFIGURED");
  if (s.balance !== null && s.balance < BigInt(SponsorService.DEPLETED_THRESHOLD)) {
    reasons.push("SPONSOR_BALANCE_LOW");
  }
  if (s.spentToday >= s.dailyBudget) reasons.push("DAILY_BUDGET_REACHED");

  const canSponsor = reasons.length === 0;
  const asOf = new Date(nowMs).toISOString();
  return {
    status: canSponsor ? "healthy" : "unavailable",
    canSponsor,
    walletCount: 1,
    recommendation: canSponsor ? null : "fallback_to_direct",
    reasons,
    // Kept for contract compatibility; the payment sponsor reserves nothing ahead of broadcast.
    noncePool: {
      totalAvailable: canSponsor ? 1 : 0,
      totalReserved: 0,
      totalCapacity: 1,
      poolAvailabilityRatio: canSponsor ? 1 : 0,
      conflictsDetected: 0,
      lastConflictAt: null,
      healInProgress: false,
    },
    reconciliation: {
      source: "hiro",
      lastSuccessfulAt: s.balance !== null ? asOf : null,
      freshness: s.balance !== null ? "fresh" : "unavailable",
    },
    snapshot: { asOf, ageMs: 0, freshness: "fresh" },
  };
}

/** Read the payment sponsor's live state (balance is KV-cached for 60s by SponsorService). */
export async function getPaymentSponsorStatus(env: Env, logger: Logger): Promise<SponsorStatusResult> {
  const key = env.PAYMENT_SPONSOR_PRIVATE_KEY;
  const ns = env.SPONSOR_WALLET_DO;
  const dailyBudget = BigInt(env.SPONSOR_DAILY_BUDGET_USTX ?? DEFAULT_DAILY_BUDGET_USTX);
  if (!key || !ns) {
    return toPaymentSponsorStatus({ configured: false, balance: null, spentToday: 0n, dailyBudget });
  }

  const network = env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
  const address = getAddressFromPrivateKey(key, network);
  const [balance, spentToday] = await Promise.all([
    new SponsorService(env, logger).fetchWalletBalanceOrNull(address),
    ns
      .get(ns.idFromName("sponsor"))
      .fetch("https://sponsor-wallet/budget", { method: "GET" })
      .then(async (res) => BigInt(((await res.json()) as { spent: string }).spent)),
  ]);

  return toPaymentSponsorStatus({
    configured: true,
    balance: balance === null ? null : BigInt(balance),
    spentToday,
    dailyBudget,
  });
}
