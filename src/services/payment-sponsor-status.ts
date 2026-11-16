import { getAddressFromPrivateKey } from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import type { Env, Logger, PaymentSponsorWalletInfo, SponsorStatusReason, SponsorStatusResult } from "../types";
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
 * to go stale. So readiness is: configured, readable, funded, and under today's budget.
 *
 * An unreadable balance blocks (SPONSOR_STATE_UNREADABLE). The payment path needs the same
 * Hiro read: SponsorWalletDO refuses with "Could not read sender/sponsor nonce" and broadcasts
 * nothing, so reporting healthy here would steer clients onto a path that cannot succeed.
 */
export function toPaymentSponsorStatus(
  s: PaymentSponsorState,
  nowMs = Date.now(),
  wallet: PaymentSponsorWalletInfo | null = null
): SponsorStatusResult {
  const reasons: SponsorStatusReason[] = [];
  if (!s.configured) {
    reasons.push("SPONSOR_NOT_CONFIGURED");
  } else if (s.balance === null) {
    reasons.push("SPONSOR_STATE_UNREADABLE");
  } else if (s.balance < BigInt(SponsorService.DEPLETED_THRESHOLD)) {
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
    snapshot: { asOf, ageMs: 0, freshness: s.balance !== null ? "fresh" : "unavailable" },
    ...(wallet ? { wallet } : {}),
  };
}

/** Raw reads behind the payment sponsor's status and wallet info. */
export interface PaymentSponsorSnapshot {
  /** Sponsor address; null when PAYMENT_SPONSOR_PRIVATE_KEY / SPONSOR_WALLET_DO are not configured */
  address: string | null;
  balance: bigint | null;
  /** Today's spend per budget; null when the SponsorWalletDO could not be read */
  spent: { payments: bigint; sponsor: bigint } | null;
  dailyBudget: bigint;
}

async function readBudgets(
  ns: DurableObjectNamespace,
  logger: Logger
): Promise<PaymentSponsorSnapshot["spent"]> {
  try {
    const res = await ns.get(ns.idFromName("sponsor")).fetch("https://sponsor-wallet/budget", { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { spent: string; sponsorSpent?: string };
    return { payments: BigInt(body.spent), sponsor: BigInt(body.sponsorSpent ?? "0") };
  } catch (e) {
    logger.warn("Sponsor budget read failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Read the payment sponsor's live state (balance is KV-cached for 60s by SponsorService). */
export async function readPaymentSponsorSnapshot(env: Env, logger: Logger): Promise<PaymentSponsorSnapshot> {
  const key = env.PAYMENT_SPONSOR_PRIVATE_KEY;
  const ns = env.SPONSOR_WALLET_DO;
  const dailyBudget = BigInt(env.SPONSOR_DAILY_BUDGET_USTX ?? DEFAULT_DAILY_BUDGET_USTX);
  if (!key || !ns) return { address: null, balance: null, spent: null, dailyBudget };

  const network = env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
  const address = getAddressFromPrivateKey(key, network);
  const [balance, spent] = await Promise.all([
    new SponsorService(env, logger).fetchWalletBalanceOrNull(address),
    readBudgets(ns, logger),
  ]);
  return { address, balance: balance === null ? null : BigInt(balance), spent, dailyBudget };
}

/** Public wallet info, or null when the payment sponsor is not configured. */
export function toWalletInfo(snap: PaymentSponsorSnapshot): PaymentSponsorWalletInfo | null {
  if (snap.address === null) return null;
  return {
    address: snap.address,
    balance: snap.balance === null ? null : snap.balance.toString(),
    spentToday: snap.spent && {
      payments: snap.spent.payments.toString(),
      sponsor: snap.spent.sponsor.toString(),
    },
    dailyBudgetPerPath: snap.dailyBudget.toString(),
  };
}

export async function getPaymentSponsorStatus(env: Env, logger: Logger): Promise<SponsorStatusResult> {
  const snap = await readPaymentSponsorSnapshot(env, logger);
  // Readiness needs today's x402 spend; an unreadable budget is an error, not "under budget".
  if (snap.address !== null && snap.spent === null) {
    throw new Error("Could not read the sponsor's daily budget");
  }
  return toPaymentSponsorStatus(
    {
      configured: snap.address !== null,
      balance: snap.balance,
      spentToday: snap.spent?.payments ?? 0n,
      dailyBudget: snap.dailyBudget,
    },
    Date.now(),
    toWalletInfo(snap)
  );
}

/** Wallet info for GET /wallets; null when the payment sponsor is not configured. */
export async function getPaymentSponsorWallet(
  env: Env,
  logger: Logger
): Promise<PaymentSponsorWalletInfo | null> {
  return toWalletInfo(await readPaymentSponsorSnapshot(env, logger));
}
