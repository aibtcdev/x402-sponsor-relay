import { colors, formatNumber, formatTokenAmount, escapeHtml } from "../styles";
import type { DashboardOverview, WalletThroughputEntry } from "../../types";

/**
 * Stats card component
 */
export function statsCard(
  label: string,
  value: string | number,
  options?: {
    trend?: string;
    colorClass?: string;
    icon?: string;
  }
): string {
  const displayValue =
    typeof value === "number" ? formatNumber(value) : escapeHtml(String(value));
  const color = options?.colorClass || "text-white";

  return `
<div class="brand-card p-4">
  <div class="flex items-center justify-between">
    <p class="text-sm text-gray-400">${escapeHtml(label)}</p>
    ${options?.icon || ""}
  </div>
  <p class="text-2xl font-bold ${color} mt-2">${displayValue}</p>
  ${options?.trend ? `<div class="mt-2 text-sm">${options.trend}</div>` : ""}
</div>`;
}

/**
 * Token breakdown card
 */
export function tokenCard(
  token: "STX" | "sBTC" | "USDCx",
  count: number,
  percentage: number,
  volume: string
): string {
  const tokenColor = colors.tokens[token];
  const formattedVolume = formatTokenAmount(volume, token);

  return `
<div class="brand-card p-4">
  <div class="flex items-center space-x-2">
    <div class="w-3 h-3 rounded-full" style="background-color: ${tokenColor}"></div>
    <span class="font-medium" style="color: ${tokenColor}">${token}</span>
  </div>
  <div class="mt-3">
    <p class="text-2xl font-bold text-white">${formatNumber(count)}</p>
    <p class="text-sm text-gray-400">${percentage}% of transactions</p>
  </div>
  <div class="mt-2 pt-2" style="border-top: 1px solid ${colors.bg.border}">
    <p class="text-sm text-gray-400">Volume</p>
    <p class="text-lg font-medium text-white">${formattedVolume}</p>
  </div>
</div>`;
}

/**
 * Format a timestamp as a relative "X minutes/hours ago" string
 */
function formatRelativeTime(isoTimestamp: string | null): string {
  if (!isoTimestamp) return "Never";
  const then = new Date(isoTimestamp).getTime();
  const nowMs = Date.now();
  const diffMs = nowMs - then;
  if (diffMs < 0) return "Just now";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Health status card
 */
export function healthCard(
  status: "healthy" | "degraded" | "down" | "unknown",
  avgLatencyMs: number,
  uptime24h: number,
  lastCheck: string | null
): string {
  const statusConfig = {
    healthy: {
      label: "Healthy",
      color: colors.status.healthy,
      icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
    },
    degraded: {
      label: "Degraded",
      color: colors.status.degraded,
      icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`,
    },
    down: {
      label: "Down",
      color: colors.status.down,
      icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`,
    },
    unknown: {
      label: "Unknown",
      color: colors.status.unknown,
      icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    },
  };

  const config = statusConfig[status];
  const lastCheckLabel = formatRelativeTime(lastCheck);

  return `
<div class="brand-card p-6">
  <h3 class="text-lg font-semibold text-white mb-4">Stacks API</h3>

  <div class="flex items-center space-x-3 mb-4">
    <div class="p-2 rounded-full" style="background-color: ${config.color}20; color: ${config.color}">
      ${config.icon}
    </div>
    <div>
      <p class="font-medium" style="color: ${config.color}">${config.label}</p>
      <p class="text-sm text-gray-400">Current status</p>
    </div>
  </div>

  <div class="grid grid-cols-3 gap-4">
    <div>
      <p class="text-sm text-gray-400">Avg Latency</p>
      <p class="text-xl font-bold text-white">${avgLatencyMs}ms</p>
    </div>
    <div>
      <p class="text-sm text-gray-400">Uptime (24h)</p>
      <p class="text-xl font-bold text-white">${uptime24h}%</p>
    </div>
    <div>
      <p class="text-sm text-gray-400">Last Check</p>
      <p class="text-xl font-bold text-white">${escapeHtml(lastCheckLabel)}</p>
    </div>
  </div>
</div>`;
}

/**
 * Success rate card with visual indicator showing both effective and raw rates.
 *
 * When precomputed rates are provided (effectiveRateOverride / rawRateOverride, 0-100),
 * they are used directly. Otherwise rates are computed from success/total/clientErrors.
 *
 * Effective rate formula: success / (success + relayErrors)
 *   where relayErrors = (total - success) - clientErrors
 *
 * Displays effective rate as primary metric and raw rate as a secondary metric below.
 * When both rates are equal (no client errors), only the effective rate is shown.
 */
export function successRateCard(
  success: number,
  total: number,
  clientErrors?: number,
  options?: { effectiveRateOverride?: number; rawRateOverride?: number }
): string {
  let effectiveRate: number;
  let rawRate: number;

  if (options?.effectiveRateOverride !== undefined) {
    effectiveRate = Math.round(options.effectiveRateOverride * 100);
    rawRate = options?.rawRateOverride !== undefined
      ? Math.round(options.rawRateOverride * 100)
      : effectiveRate;
  } else {
    const failed = total - success;
    const relayErrors = Math.max(0, failed - (clientErrors ?? 0));
    const effectiveDenominator = success + relayErrors;
    effectiveRate = effectiveDenominator > 0 ? Math.round((success / effectiveDenominator) * 100) : 0;
    rawRate = total > 0 ? Math.round((success / total) * 100) : 0;
  }

  const hasClientErrors = (clientErrors ?? 0) > 0 || rawRate !== effectiveRate;

  let color: string;
  if (effectiveRate >= 95) {
    color = colors.status.healthy;
  } else if (effectiveRate >= 80) {
    color = colors.status.degraded;
  } else {
    color = colors.status.down;
  }

  const rawColor = rawRate >= 95 ? colors.status.healthy
    : rawRate >= 80 ? colors.status.degraded
    : colors.status.down;

  return `
<div class="brand-card p-4">
  <p class="text-sm text-gray-400">Success Rate</p>
  <p class="text-2xl font-bold mt-2" style="color: ${color}">${effectiveRate}%</p>
  <div class="mt-2 h-2 rounded-full overflow-hidden" style="background-color: ${colors.bg.border}">
    <div class="h-full rounded-full" style="width: ${effectiveRate}%; background-color: ${color}"></div>
  </div>
  <p class="text-xs text-gray-500 mt-1">effective (relay errors only)</p>
  ${hasClientErrors ? `
  <div class="mt-2 pt-2" style="border-top: 1px solid ${colors.bg.border}">
    <p class="text-xs text-gray-400">raw: <span style="color: ${rawColor}">${rawRate}%</span></p>
    <p class="text-xs text-gray-600">includes client errors</p>
  </div>` : ""}
</div>`;
}

/**
 * Status banner placeholder — server-rendered shell hydrated by Alpine.js statusApp().
 * Renders a full-width banner with health dot and capacity gauge.
 * The Alpine.js component fetches /nonce/state on 10s intervals and fills in health/capacity values.
 */
export function statusBannerPlaceholder(): string {
  return `
<div class="status-banner">
  <div class="flex items-center gap-3">
    <span class="status-dot" :style="'background-color: ' + statusColor"></span>
    <span class="font-medium" :style="'color: ' + statusColor" x-text="statusLabel">Loading...</span>
  </div>
  <div class="flex items-center gap-3">
    <span class="text-sm text-gray-400">Capacity</span>
    <div class="capacity-gauge">
      <div class="capacity-gauge__fill" :style="'width: ' + capacityPct + '%; background-color: ' + capacityColor"></div>
    </div>
    <span class="text-sm font-mono text-gray-400" x-text="capacityLabel">--/--</span>
  </div>
</div>
<template x-if="showWarning">
  <div class="status-banner status-banner--warning mt-2">
    <span class="text-sm" style="color: ${colors.status.degraded}">Nonce pool unhealthy — agents should consider direct submission</span>
  </div>
</template>`;
}

/**
 * Settlement time card — Alpine.js-hydrated card showing p50/p95/avg latency and sample count.
 * Data is populated from the /nonce/state response via the statusApp() component.
 * The card is hidden when no settlement data exists (count === 0).
 */
export function settlementTimeCard(): string {
  return `
<div class="brand-card p-4" x-show="settlementTimes && settlementTimes.count > 0" x-cloak>
  <p class="text-sm text-gray-400">Settlement Time (24h)</p>
  <p class="text-2xl font-bold text-white mt-2" x-text="formatMs(settlementTimes.p50)"></p>
  <p class="text-xs text-gray-500 mt-1">p50 median</p>
  <div class="grid grid-cols-3 gap-2 mt-3 pt-2" style="border-top: 1px solid #1a1a1a">
    <div>
      <p class="text-xs text-gray-500">p95</p>
      <p class="text-sm font-medium text-white" x-text="formatMs(settlementTimes.p95)"></p>
    </div>
    <div>
      <p class="text-xs text-gray-500">avg</p>
      <p class="text-sm font-medium text-white" x-text="formatMs(settlementTimes.avg)"></p>
    </div>
    <div>
      <p class="text-xs text-gray-500">txs</p>
      <p class="text-sm font-medium text-white" x-text="settlementTimes.count"></p>
    </div>
  </div>
</div>`;
}

/**
 * Fees detail card — server-rendered card showing total, avg, min, and max STX fees.
 * Uses rolling 24h data from DashboardOverview.fees (Phases 1-2 data sources).
 *
 * @param fees - Fee stats object with total, average, min, max in microSTX strings
 */
export function feesDetailCard(fees: { total: string; average: string; min: string; max: string }): string {
  const formattedTotal = formatTokenAmount(fees.total, "STX");
  const avgFeeNum = parseInt(fees.average || "0", 10);
  const minFeeNum = parseInt(fees.min || "0", 10);
  const maxFeeNum = parseInt(fees.max || "0", 10);

  return `
<div class="brand-card p-4">
  <div class="flex items-center justify-between">
    <p class="text-sm text-gray-400">Fees Sponsored (24h)</p>
    <svg class="w-5 h-5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
  </div>
  <p class="text-2xl font-bold mt-2" style="color: ${colors.brand.orange}">${escapeHtml(formattedTotal)}</p>
  <div class="grid grid-cols-3 gap-2 mt-2 pt-2" style="border-top: 1px solid ${colors.bg.border}">
    <div>
      <p class="text-xs text-gray-500">avg</p>
      <p class="text-sm font-medium text-white">${formatNumber(avgFeeNum)}</p>
    </div>
    <div>
      <p class="text-xs text-gray-500">min</p>
      <p class="text-sm font-medium text-white">${formatNumber(minFeeNum)}</p>
    </div>
    <div>
      <p class="text-xs text-gray-500">max</p>
      <p class="text-sm font-medium text-white">${formatNumber(maxFeeNum)}</p>
    </div>
  </div>
  <p class="text-xs text-gray-600 mt-1">uSTX per tx</p>
</div>`;
}

/**
 * Terminal reason breakdown card — server-rendered breakdown of error counts
 * grouped by tx-schemas terminal reason category (today, calendar day UTC).
 *
 * Categories: validation, sender, relay, settlement, replacement, identity
 * Returns null-safe HTML: shows "No errors" when all counts are zero or data is missing.
 */
export function terminalReasonsCard(reasons: DashboardOverview["terminalReasons"]): string {
  const categories: Array<{ key: keyof NonNullable<typeof reasons>; label: string }> = [
    { key: "validation", label: "Validation" },
    { key: "sender", label: "Sender" },
    { key: "relay", label: "Relay" },
    { key: "settlement", label: "Settlement" },
    { key: "replacement", label: "Replacement" },
    { key: "identity", label: "Identity" },
  ];

  const hasErrors = reasons && Object.values(reasons).some((v) => v > 0);

  const rows = hasErrors
    ? categories.map(({ key, label }) => {
        const count = reasons![key];
        const dotColor = colors.terminalReasons[key];
        return `
  <div class="flex items-center justify-between py-1" style="border-bottom: 1px solid ${colors.bg.border}">
    <div class="flex items-center gap-2">
      <div class="w-3 h-3 rounded-full flex-shrink-0" style="background-color: ${dotColor}"></div>
      <span class="text-sm text-gray-400">${escapeHtml(label)}</span>
    </div>
    <span class="text-sm font-medium ${count > 0 ? "text-white" : "text-gray-600"}">${formatNumber(count)}</span>
  </div>`;
      }).join("")
    : `<p class="text-sm text-gray-500 py-2">No errors today</p>`;

  return `
<div class="brand-card p-4">
  <p class="text-sm text-gray-400 mb-3">Error Breakdown (Today)</p>
  ${rows}
</div>`;
}

/**
 * Wallet throughput card — server-rendered per-wallet 24h throughput with sparklines.
 *
 * Shows a row per active wallet with: index, 24h total, success rate bar, sparkline.
 * Sparkline: 24 hourly bars scaled to the wallet's own max hourly total.
 * Empty state shown when wallets array is empty or undefined.
 */
export function walletThroughputCard(wallets: WalletThroughputEntry[] | undefined): string {
  if (!wallets || wallets.length === 0) {
    return `
<div class="brand-card p-4">
  <p class="text-sm text-gray-400 mb-2">Wallet Throughput (24h)</p>
  <p class="text-sm text-gray-500">No wallet activity in last 24h</p>
</div>`;
  }

  const walletRows = wallets.map((w) => {
    const successRate = w.total24h > 0 ? Math.round((w.success24h / w.total24h) * 100) : 0;
    const rateColor = successRate >= 95 ? colors.status.healthy
      : successRate >= 80 ? colors.status.degraded
      : colors.status.down;

    // Build sparkline: 24 hourly bars
    const maxHourly = Math.max(1, ...w.hourly.map((h) => h.total));
    const sparkBars = w.hourly.map((h) => {
      const heightPct = Math.round((h.total / maxHourly) * 100);
      const barColor = h.failed > 0 ? colors.status.degraded : colors.status.healthy;
      return `<div class="sparkline-bar" style="height: ${Math.max(4, heightPct)}%; background-color: ${barColor}"></div>`;
    }).join("");

    return `
<div class="flex items-center gap-3 py-2" style="border-bottom: 1px solid ${colors.bg.border}">
  <span class="text-xs font-mono text-gray-500" style="min-width: 1.5rem; text-align: right">#${w.walletIndex}</span>
  <span class="text-sm font-bold text-white" style="min-width: 2.5rem">${formatNumber(w.total24h)}</span>
  <div class="flex-1" style="max-width: 80px">
    <div class="h-2 rounded-full overflow-hidden" style="background-color: ${colors.bg.border}">
      <div class="h-full rounded-full" style="width: ${successRate}%; background-color: ${rateColor}"></div>
    </div>
    <p class="text-xs mt-0.5" style="color: ${rateColor}">${successRate}%</p>
  </div>
  <div class="sparkline flex-1">${sparkBars}</div>
</div>`;
  }).join("");

  return `
<div class="brand-card p-4">
  <div class="flex items-center justify-between mb-3">
    <p class="text-sm text-gray-400">Wallet Throughput (24h)</p>
    <div class="flex items-center gap-3 text-xs text-gray-500">
      <span class="flex items-center gap-1">
        <span class="sparkline-bar" style="display: inline-block; width: 8px; height: 10px; background-color: ${colors.status.healthy}"></span> success
      </span>
      <span class="flex items-center gap-1">
        <span class="sparkline-bar" style="display: inline-block; width: 8px; height: 10px; background-color: ${colors.status.degraded}"></span> w/ errors
      </span>
    </div>
  </div>
  <div class="flex items-center gap-3 mb-1" style="padding-left: 0.25rem">
    <span class="text-xs text-gray-600" style="min-width: 1.5rem"></span>
    <span class="text-xs text-gray-600" style="min-width: 2.5rem">txs</span>
    <span class="text-xs text-gray-600" style="max-width: 80px; flex: 1">rate</span>
    <span class="text-xs text-gray-600 flex-1">24h (hourly)</span>
  </div>
  ${walletRows}
</div>`;
}
