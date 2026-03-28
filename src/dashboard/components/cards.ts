import { colors, formatNumber, formatTokenAmount, escapeHtml } from "../styles";

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
 * Success rate card with visual indicator.
 *
 * When clientErrors is provided and > 0, shows the effective success rate
 * (excluding client errors from the denominator) as the primary metric,
 * with the raw success rate as secondary subtext. This surfaces the relay's
 * actual reliability independent of client-caused failures.
 *
 * Effective rate formula: success / (success + relayErrors)
 *   where relayErrors = (total - success) - clientErrors
 */
export function successRateCard(success: number, total: number, clientErrors?: number): string {
  const failed = total - success;
  const relayErrors = Math.max(0, failed - (clientErrors ?? 0));
  const effectiveDenominator = success + relayErrors;

  // Effective rate excludes client errors from denominator
  const effectiveRate = effectiveDenominator > 0 ? Math.round((success / effectiveDenominator) * 100) : 0;
  // Raw rate includes all requests
  const rawRate = total > 0 ? Math.round((success / total) * 100) : 0;

  const hasClientErrors = (clientErrors ?? 0) > 0;

  let color: string;
  if (effectiveRate >= 95) {
    color = colors.status.healthy;
  } else if (effectiveRate >= 80) {
    color = colors.status.degraded;
  } else {
    color = colors.status.down;
  }

  return `
<div class="brand-card p-4">
  <p class="text-sm text-gray-400">Success Rate</p>
  <p class="text-2xl font-bold mt-2" style="color: ${color}">${effectiveRate}%</p>
  <div class="mt-2 h-2 rounded-full overflow-hidden" style="background-color: ${colors.bg.border}">
    <div class="h-full rounded-full" style="width: ${effectiveRate}%; background-color: ${color}"></div>
  </div>
  <p class="text-xs text-gray-500 mt-1">${formatNumber(success)} / ${formatNumber(effectiveDenominator)} (relay)</p>
  ${hasClientErrors ? `<p class="text-xs text-gray-600 mt-0.5">raw: ${rawRate}% (${formatNumber(total)} total)</p>` : ""}
</div>`;
}

/**
 * Status banner placeholder — server-rendered shell hydrated by Alpine.js statusApp().
 * Renders a full-width banner with health dot, capacity gauge, and static p50 placeholder.
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
  <div class="flex items-center gap-3">
    <span class="text-sm text-gray-400">p50</span>
    <span class="text-sm font-mono text-white">N/A</span>
  </div>
</div>
<template x-if="showWarning">
  <div class="status-banner status-banner--warning mt-2">
    <span class="text-sm" style="color: ${colors.status.degraded}">Nonce pool unhealthy — agents should consider direct submission</span>
  </div>
</template>`;
}

/**
 * Settlement time card — metric card showing median (p50) settlement time.
 * Currently renders static "N/A" placeholders since settlement latency data
 * is not yet available from the /nonce/state API.
 */
export function settlementTimeCard(): string {
  return `
<div class="brand-card p-4">
  <div class="flex items-center justify-between">
    <p class="text-sm text-gray-400">Settlement Time</p>
    <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
  </div>
  <p class="text-2xl font-bold text-white mt-2">N/A</p>
  <p class="text-xs text-gray-500 mt-1">p95: N/A</p>
</div>`;
}

/**
 * Fees spent card — server-rendered card showing total STX fees sponsored.
 *
 * @param totalFees - Total fees in microSTX as a string (e.g. "1234567890")
 * @param avgFee - Average fee per transaction in microSTX as a string (e.g. "12345")
 */
export function feesSpentCard(totalFees: string, avgFee: string): string {
  const formattedTotal = formatTokenAmount(totalFees, "STX");
  const avgFeeNum = parseInt(avgFee || "0", 10);

  return `
<div class="brand-card p-4">
  <div class="flex items-center justify-between">
    <p class="text-sm text-gray-400">Fees Sponsored</p>
    <svg class="w-5 h-5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
  </div>
  <p class="text-2xl font-bold mt-2" style="color: ${colors.brand.orange}">${escapeHtml(formattedTotal)}</p>
  <p class="text-xs text-gray-500 mt-1">avg: ${formatNumber(avgFeeNum)} uSTX / tx</p>
</div>`;
}
