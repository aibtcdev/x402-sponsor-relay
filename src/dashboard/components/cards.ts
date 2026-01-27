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
<div class="stat-card brand-card p-4">
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
<div class="stat-card brand-card p-4">
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
    <p class="text-lg font-medium text-white">${formattedVolume} ${token}</p>
  </div>
</div>`;
}

/**
 * Health status card
 */
export function healthCard(
  status: "healthy" | "degraded" | "down" | "unknown",
  avgLatencyMs: number,
  uptime24h: number
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

  return `
<div class="brand-card p-6">
  <h3 class="text-lg font-semibold text-white mb-4">Facilitator Health</h3>

  <div class="flex items-center space-x-3 mb-4">
    <div class="p-2 rounded-full" style="background-color: ${config.color}20; color: ${config.color}">
      ${config.icon}
    </div>
    <div>
      <p class="font-medium" style="color: ${config.color}">${config.label}</p>
      <p class="text-sm text-gray-400">Current status</p>
    </div>
  </div>

  <div class="grid grid-cols-2 gap-4">
    <div>
      <p class="text-sm text-gray-400">Avg Latency</p>
      <p class="text-xl font-bold text-white">${avgLatencyMs}ms</p>
    </div>
    <div>
      <p class="text-sm text-gray-400">Uptime (24h)</p>
      <p class="text-xl font-bold text-white">${uptime24h}%</p>
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
<div class="stat-card brand-card p-4">
  <p class="text-sm text-gray-400">Success Rate</p>
  <p class="text-2xl font-bold mt-2" style="color: ${color}">${rate}%</p>
  <div class="mt-2 h-2 rounded-full overflow-hidden" style="background-color: ${colors.bg.border}">
    <div class="h-full rounded-full" style="width: ${rate}%; background-color: ${color}"></div>
  </div>
  <p class="text-xs text-gray-500 mt-1">${formatNumber(success)} / ${formatNumber(total)}</p>
</div>`;
}
