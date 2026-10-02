import { getAddressFromPrivateKey } from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import type { Env, Logger } from "../types";
import { getHiroBaseUrl, getHiroHeaders } from "../utils";
import { DEFAULT_DAILY_BUDGET_USTX } from "../durable-objects/sponsor-wallet-do";

/** Alert when the payment sponsor's balance drops below this (µSTX) — override with SPONSOR_ALERT_MIN_USTX */
const DEFAULT_MIN_BALANCE_USTX = 10_000_000n;
/** Alert when today's sponsor spend reaches this share of the daily budget */
const BUDGET_ALERT_RATIO = 0.8;
/** While a condition stays true, repeat the alert at most this often */
const REPEAT_MS = 60 * 60_000;

export type AlertCondition = "low_balance" | "budget_high";

export interface SponsorSnapshot {
  address: string;
  balance: bigint;
  minBalance: bigint;
  spentToday: bigint;
  dailyBudget: bigint;
}

/** Which alert conditions hold for a snapshot. */
export function firingConditions(s: SponsorSnapshot): Set<AlertCondition> {
  const firing = new Set<AlertCondition>();
  if (s.balance < s.minBalance) firing.add("low_balance");
  if (Number(s.spentToday) >= Number(s.dailyBudget) * BUDGET_ALERT_RATIO) firing.add("budget_high");
  return firing;
}

/**
 * Decide what to send given the previous state ({condition: lastSentAt ms}).
 * Alerts on a new condition, repeats hourly while it holds, and sends one recovery when it clears.
 */
export function decideAlerts(
  firing: Set<AlertCondition>,
  previous: Partial<Record<AlertCondition, number>>,
  now: number
): { send: Array<{ condition: AlertCondition; recovered: boolean }>; next: Partial<Record<AlertCondition, number>> } {
  const send: Array<{ condition: AlertCondition; recovered: boolean }> = [];
  const next: Partial<Record<AlertCondition, number>> = {};
  for (const condition of ["low_balance", "budget_high"] as const) {
    const last = previous[condition];
    if (firing.has(condition)) {
      if (last === undefined || now - last >= REPEAT_MS) {
        send.push({ condition, recovered: false });
        next[condition] = now;
      } else {
        next[condition] = last;
      }
    } else if (last !== undefined) {
      send.push({ condition, recovered: true });
    }
  }
  return { send, next };
}

const stx = (ustx: bigint) => (Number(ustx) / 1e6).toFixed(2);

function messageFor(condition: AlertCondition, recovered: boolean, s: SponsorSnapshot): string {
  if (condition === "low_balance") {
    return recovered
      ? `✅ x402 payment sponsor balance recovered: ${stx(s.balance)} STX (${s.address})`
      : `⚠️ x402 payment sponsor is low: ${stx(s.balance)} STX left (alert below ${stx(s.minBalance)}). ` +
        `Top up ${s.address} — when it runs out, gasless inbox sends fail.`;
  }
  return recovered
    ? `✅ x402 sponsor daily spend back under ${BUDGET_ALERT_RATIO * 100}% of budget`
    : `⚠️ x402 sponsor has spent ${stx(s.spentToday)} of its ${stx(s.dailyBudget)} STX daily budget today (UTC). ` +
      `At the cap, gasless inbox sends fail until midnight UTC. Raise SPONSOR_DAILY_BUDGET_USTX if this is real traffic.`;
}

async function sendTelegram(env: Env, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage responded ${res.status}: ${await res.text()}`);
}

const STATE_KEY = "sponsor_alerts:state";

/**
 * Cron task: check the payment sponsor's STX balance and today's spend, and post to Telegram
 * when either needs attention. No-op unless PAYMENT_SPONSOR_PRIVATE_KEY, TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID are all set. Alert state (last sent per condition) is kept in RELAY_KV.
 */
export async function checkSponsorAlerts(env: Env, logger: Logger): Promise<void> {
  const key = env.PAYMENT_SPONSOR_PRIVATE_KEY;
  if (!key || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.RELAY_KV || !env.SPONSOR_WALLET_DO) return;

  const network = env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
  const address = getAddressFromPrivateKey(key, network);

  const balRes = await fetch(`${getHiroBaseUrl(env.STACKS_NETWORK)}/extended/v1/address/${address}/stx`, {
    headers: getHiroHeaders(env.HIRO_API_KEY),
    signal: AbortSignal.timeout(10_000),
  });
  if (!balRes.ok) throw new Error(`Hiro balance responded ${balRes.status}`);
  const bal = (await balRes.json()) as { balance: string; locked?: string };

  const ns = env.SPONSOR_WALLET_DO;
  const budgetRes = await ns.get(ns.idFromName("sponsor")).fetch("https://sponsor-wallet/budget", { method: "GET" });
  const { spent } = (await budgetRes.json()) as { spent: string };

  const snapshot: SponsorSnapshot = {
    address,
    balance: BigInt(bal.balance) - BigInt(bal.locked ?? "0"),
    minBalance: BigInt(env.SPONSOR_ALERT_MIN_USTX ?? DEFAULT_MIN_BALANCE_USTX),
    spentToday: BigInt(spent),
    dailyBudget: BigInt(env.SPONSOR_DAILY_BUDGET_USTX ?? DEFAULT_DAILY_BUDGET_USTX),
  };

  const previous = JSON.parse((await env.RELAY_KV.get(STATE_KEY)) ?? "{}") as Partial<Record<AlertCondition, number>>;
  const { send, next } = decideAlerts(firingConditions(snapshot), previous, Date.now());
  for (const { condition, recovered } of send) {
    await sendTelegram(env, messageFor(condition, recovered, snapshot));
    logger.warn("sponsor_alert_sent", { condition, recovered, balance: snapshot.balance.toString() });
  }
  await env.RELAY_KV.put(STATE_KEY, JSON.stringify(next));
}
