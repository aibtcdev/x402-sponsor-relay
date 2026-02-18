import { colors, formatNumber, formatTokenAmount, escapeHtml } from "../styles";
import type { AggregateKeyStats, ApiKeyStatus } from "../../types";

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
 * Success rate card with visual indicator
 */
export function successRateCard(success: number, total: number): string {
  const rate = total > 0 ? Math.round((success / total) * 100) : 0;
  const color = rate >= 95 ? colors.status.healthy : rate >= 80 ? colors.status.degraded : colors.status.down;

  return `
<div class="brand-card p-4">
  <p class="text-sm text-gray-400">Success Rate</p>
  <p class="text-2xl font-bold mt-2" style="color: ${color}">${rate}%</p>
  <div class="mt-2 h-2 rounded-full overflow-hidden" style="background-color: ${colors.bg.border}">
    <div class="h-full rounded-full" style="width: ${rate}%; background-color: ${color}"></div>
  </div>
  <p class="text-xs text-gray-500 mt-1">${formatNumber(success)} / ${formatNumber(total)}</p>
</div>`;
}

// =============================================================================
// API Key Stats Components
// =============================================================================

/**
 * Get status badge HTML for an API key status
 */
function getStatusBadge(status: ApiKeyStatus): string {
  const statusConfig = {
    active: {
      label: "Active",
      color: colors.status.healthy,
      bgColor: `${colors.status.healthy}20`,
    },
    rate_limited: {
      label: "Rate Limited",
      color: colors.status.degraded,
      bgColor: `${colors.status.degraded}20`,
    },
    capped: {
      label: "Cap Reached",
      color: colors.status.down,
      bgColor: `${colors.status.down}20`,
    },
  };

  const config = statusConfig[status];

  return `<span class="px-2 py-0.5 text-xs rounded-full" style="background-color: ${config.bgColor}; color: ${config.color}">${config.label}</span>`;
}

/**
 * API key summary cards (active keys count + fees today)
 */
export function apiKeySummaryCards(stats: AggregateKeyStats): string {
  const formattedFees = formatTokenAmount(stats.totalFeesToday, "STX");

  return `
<div class="grid grid-cols-2 gap-4">
  ${statsCard("Active API Keys", stats.totalActiveKeys, {
    icon: `<svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>`,
  })}

  ${statsCard("Fees Sponsored Today", formattedFees, {
    icon: `<svg class="w-5 h-5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  })}
</div>`;
}

/**
 * Top API keys table showing usage breakdown
 */
export function topKeysTable(stats: AggregateKeyStats): string {
  if (stats.topKeys.length === 0) {
    return `
<div class="brand-section p-6">
  <h3 class="text-lg font-semibold text-white mb-4">Top Keys by Usage (Today)</h3>
  <div class="text-center py-8">
    <svg class="w-12 h-12 text-gray-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
    </svg>
    <p class="text-gray-400">No API key activity today</p>
    <p class="text-sm text-gray-500 mt-1">Usage stats will appear here once API keys are used</p>
  </div>
</div>`;
  }

  const rows = stats.topKeys
    .map((key) => {
      const formattedFees = formatTokenAmount(key.feesToday, "STX");

      return `
    <tr class="border-t" style="border-color: ${colors.bg.border}">
      <td class="py-3 px-4">
        <code class="text-sm font-mono text-purple-400">${escapeHtml(key.keyPrefix)}...</code>
      </td>
      <td class="py-3 px-4 text-right">
        <span class="text-white font-medium">${formatNumber(key.requestsToday)}</span>
        <span class="text-gray-500 text-sm ml-1">req</span>
      </td>
      <td class="py-3 px-4 text-right">
        <span class="text-white font-medium">${formattedFees}</span>
      </td>
      <td class="py-3 px-4 text-right">
        ${getStatusBadge(key.status)}
      </td>
    </tr>`;
    })
    .join("");

  return `
<div class="brand-section p-6">
  <h3 class="text-lg font-semibold text-white mb-4">Top Keys by Usage (Today)</h3>
  <div class="overflow-x-auto">
    <table class="w-full">
      <thead>
        <tr class="text-left text-gray-400 text-sm">
          <th class="py-2 px-4 font-medium">Key ID</th>
          <th class="py-2 px-4 font-medium text-right">Requests</th>
          <th class="py-2 px-4 font-medium text-right">Fees</th>
          <th class="py-2 px-4 font-medium text-right">Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</div>`;
}

/**
 * Complete API keys section for the dashboard
 */
export function apiKeysSection(stats: AggregateKeyStats): string {
  return `
<div class="mb-8">
  <h3 class="text-lg font-semibold text-white mb-4">API Key Usage</h3>
  ${apiKeySummaryCards(stats)}
  <div class="mt-4">
    ${topKeysTable(stats)}
  </div>
</div>`;
}
