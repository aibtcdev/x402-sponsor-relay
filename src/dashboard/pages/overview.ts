import type { DashboardOverview } from "../../types";
import { htmlDocument, header, footer } from "../components/layout";
import {
  statsCard,
  healthCard,
  successRateCard,
  statusHeroCard,
} from "../components/cards";
import { cssSparkline } from "../components/charts";
import { colors, escapeHtml, formatNumber, formatTokenAmount } from "../styles";
import { VERSION } from "../../version";

/** Bar chart SVG icon (reused in empty states) */
function barChartSvg(sizeClass: string, extraClass = ""): string {
  const cls = `${sizeClass} text-gray-600 mx-auto${extraClass ? ` ${extraClass}` : ""}`;
  return `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
    </svg>`;
}

/** Formatted UTC timestamp for footer display (server-side) */
function utcTimestamp(): string {
  return (
    new Date().toLocaleString("en-US", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    }) + " UTC"
  );
}

/**
 * Fees Collected card — shows total fees sponsored today + trend.
 */
function feesCard(
  total: string,
  average: string,
  trend: "up" | "down" | "stable"
): string {
  const formattedTotal = formatTokenAmount(total, "STX");
  const formattedAvg = formatTokenAmount(average, "STX");
  const trendColor =
    trend === "up"
      ? colors.trend.up
      : trend === "down"
        ? colors.trend.down
        : colors.trend.stable;
  const trendArrow =
    trend === "up" ? "↑" : trend === "down" ? "↓" : "~";

  return `
<div class="brand-card p-6 flex flex-col">
  <p class="text-sm text-gray-400 mb-2">Fees Sponsored</p>
  <p class="text-3xl font-bold text-white leading-none mb-1">${escapeHtml(formattedTotal)}</p>
  <p class="text-xs text-gray-500 mb-3">avg ${escapeHtml(formattedAvg)} per tx</p>
  <div class="mt-auto">
    <span class="text-sm font-medium" style="color:${trendColor}">${trendArrow} vs yesterday</span>
  </div>
</div>`;
}

/**
 * Hiro API status card — latency + uptime in a compact card.
 */
function hiroApiCard(
  status: "healthy" | "degraded" | "down" | "unknown",
  avgLatencyMs: number,
  uptime24h: number,
  lastCheck: string | null
): string {
  const statusColor =
    status === "healthy"
      ? colors.status.healthy
      : status === "degraded"
        ? colors.status.degraded
        : status === "down"
          ? colors.status.down
          : colors.status.unknown;

  const statusLabel =
    status === "healthy"
      ? "Healthy"
      : status === "degraded"
        ? "Degraded"
        : status === "down"
          ? "Down"
          : "Unknown";

  const latencyColor = avgLatencyMs > 2000 ? colors.status.degraded : colors.text?.primary ?? "#F9FAFB";

  // Format last check as relative time
  let lastCheckStr = "Never";
  if (lastCheck) {
    const diffMs = Date.now() - new Date(lastCheck).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) lastCheckStr = "Just now";
    else if (diffMin < 60) lastCheckStr = `${diffMin}m ago`;
    else lastCheckStr = `${Math.floor(diffMin / 60)}h ago`;
  }

  return `
<div class="brand-card p-6 flex flex-col">
  <p class="text-sm text-gray-400 mb-2">Hiro API</p>
  <div class="flex items-center gap-2 mb-3">
    <span class="status-indicator" style="width:0.625rem;height:0.625rem;background-color:${statusColor};color:${statusColor}"></span>
    <span class="text-2xl font-bold" style="color:${statusColor}">${escapeHtml(statusLabel)}</span>
  </div>
  <div class="grid grid-cols-2 gap-3 mt-auto">
    <div>
      <p class="text-xs text-gray-500">Latency</p>
      <p class="text-lg font-bold" style="color:${latencyColor}">${avgLatencyMs}ms</p>
    </div>
    <div>
      <p class="text-xs text-gray-500">Uptime 24h</p>
      <p class="text-lg font-bold text-white">${uptime24h}%</p>
    </div>
  </div>
  <p class="text-xs text-gray-600 mt-2">Last check: ${escapeHtml(lastCheckStr)}</p>
</div>`;
}

/**
 * Transactions card — big number + success rate bar.
 */
function transactionsCard(
  total: number,
  success: number,
  clientErrors: number
): string {
  const failed = total - success;
  const relayErrors = Math.max(0, failed - clientErrors);
  const effectiveDenom = success + relayErrors;
  const rate =
    effectiveDenom > 0 ? Math.round((success / effectiveDenom) * 100) : 0;
  const rateColor =
    rate >= 95
      ? colors.status.healthy
      : rate >= 80
        ? colors.status.degraded
        : colors.status.down;

  return `
<div class="brand-card p-6 flex flex-col">
  <p class="text-sm text-gray-400 mb-2">Transactions (24h)</p>
  <p class="text-3xl font-bold text-white leading-none mb-3">${formatNumber(total)}</p>
  <div class="mt-auto">
    <div class="flex items-center justify-between text-xs text-gray-500 mb-1">
      <span>Success rate</span>
      <span style="color:${rateColor}">${rate}%</span>
    </div>
    <div class="capacity-bar">
      <div class="capacity-fill" style="width:${rate}%;background-color:${rateColor}"></div>
    </div>
    <p class="text-xs text-gray-600 mt-2">${formatNumber(success)} ok · ${formatNumber(relayErrors)} relay err · ${formatNumber(clientErrors)} client err</p>
  </div>
</div>`;
}

/**
 * Nonce pool section — Alpine.js component fetching /nonce/state.
 * Renders a 5×2 grid (10 wallets) with color-coded health cells.
 */
function noncePoolSection(): string {
  return `
<!-- Nonce Pool Section (client-side, fetches /nonce/state) -->
<div class="mb-6" x-data="noncePoolApp()" x-init="init()">
  <div class="brand-section p-6">
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-lg font-semibold text-white">Nonce Pool</h3>
      <span x-show="!loading && !error" class="text-xs text-gray-500"
            x-text="state && state.usedCapacity + ' reserved / ' + state.totalCapacity + ' capacity'"></span>
    </div>

    <!-- Loading state -->
    <div x-show="loading" class="text-gray-500 text-sm py-4 text-center">Loading nonce pool...</div>

    <!-- Error state -->
    <div x-show="!loading && error" class="text-gray-500 text-sm py-4 text-center" x-text="error"></div>

    <!-- Data state -->
    <div x-show="!loading && !error && state" x-cloak>

      <!-- Recommendation warning -->
      <div x-show="state && state.recommendation === 'fallback_to_direct'"
           class="mb-4 p-3 rounded-lg text-sm font-medium"
           style="background-color:rgba(248,113,113,0.12);border:1px solid rgba(248,113,113,0.3);color:#F87171">
        Warning: Relay capacity strained — clients should fallback to direct submission
      </div>

      <!-- Wallet grid: 5 cols on md, 2 cols on small -->
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <template x-for="wallet in (state && state.wallets) || []" :key="wallet.index">
          <div class="wallet-cell"
               :class="walletCellClass(wallet)"
               :title="'Wallet ' + wallet.index">
            <span class="text-xs text-gray-400 font-medium" x-text="'W' + wallet.index"></span>
            <span class="text-lg font-bold" :style="'color:' + walletColor(wallet)" x-text="wallet.reserved"></span>
            <span class="text-xs" :style="'color:' + walletColor(wallet) + '99'" x-text="wallet.available + ' free'"></span>
            <span x-show="wallet.gaps && wallet.gaps.length > 0"
                  class="text-xs font-medium"
                  style="color:#F87171"
                  x-text="wallet.gaps.length + ' gap' + (wallet.gaps.length > 1 ? 's' : '')"></span>
            <span x-show="wallet.health === 'degraded'"
                  class="text-xs font-medium"
                  style="color:#FBBF24">CB open</span>
          </div>
        </template>
      </div>

      <!-- Capacity bar -->
      <div>
        <div class="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>Pool utilization</span>
          <span x-text="state ? Math.round((state.usedCapacity / Math.max(state.totalCapacity, 1)) * 100) + '%' : '0%'"></span>
        </div>
        <div class="capacity-bar">
          <div class="capacity-fill"
               :style="'width:' + (state ? Math.round((state.usedCapacity / Math.max(state.totalCapacity, 1)) * 100) : 0) + '%'"></div>
        </div>
        <p class="text-xs text-gray-600 mt-2"
           x-text="state ? (state.totalCapacity - state.usedCapacity) + ' available · ' + (state.healInProgress ? 'Heal in progress' : 'Stable') : ''"></p>
      </div>
    </div>
  </div>
</div>`;
}

/**
 * Generate the main dashboard overview page
 * @param data - Dashboard overview data
 * @param network - Optional network context ("testnet" | "mainnet")
 */
export function overviewPage(data: DashboardOverview, network?: string): string {
  const settlement = data.settlement ?? {
    status: "unknown" as const,
    avgLatencyMs: 0,
    uptime24h: 0,
    lastCheck: null,
  };

  const content = `
${header(network)}

<main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">

  <!-- Section 1: Status Hero -->
  ${statusHeroCard(settlement.status, network, VERSION, settlement.uptime24h)}

  <!-- Section 2: Key Metrics — 3 cards -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
    ${transactionsCard(data.transactions.total, data.transactions.success, data.transactions.clientErrors ?? 0)}
    ${feesCard(data.fees.total, data.fees.average, data.fees.trend)}
    ${hiroApiCard(settlement.status, settlement.avgLatencyMs, settlement.uptime24h, settlement.lastCheck)}
  </div>

  <!-- Section 3: Activity Sparkline (24h) -->
  <div class="mb-6">
    <div class="brand-section p-6">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-lg font-semibold text-white">Activity (24h)</h3>
        <span class="text-xs text-gray-500">${data.hourlyData.reduce((s, h) => s + h.transactions, 0)} total transactions</span>
      </div>
      ${cssSparkline(data.hourlyData)}
      <div class="flex justify-between text-xs text-gray-600 mt-1">
        <span>${data.hourlyData[0]?.hour ?? ""}</span>
        <span>${data.hourlyData[data.hourlyData.length - 1]?.hour ?? ""}</span>
      </div>
    </div>
  </div>

  <!-- Section 4: Nonce Pool -->
  ${noncePoolSection()}

</main>

${footer(utcTimestamp())}

<script>
  // Alpine.js component for nonce pool — fetches /dashboard/api/nonce on init
  function noncePoolApp() {
    return {
      loading: true,
      error: null,
      state: null,

      init: function() {
        var self = this;
        fetch('/dashboard/api/nonce')
          .then(function(r) {
            if (!r.ok) throw new Error('Nonce state unavailable (' + r.status + ')');
            return r.json();
          })
          .then(function(data) {
            if (data && data.healthStatus === 'unavailable' && data.wallets.length === 0) {
              self.error = 'Nonce pool unavailable';
            } else {
              self.state = data || null;
            }
          })
          .catch(function(e) {
            self.error = e.message || 'Nonce pool unavailable';
          })
          .finally(function() {
            self.loading = false;
          });
      },

      walletColor: function(wallet) {
        if (wallet.health === 'down') return '#F87171';
        if (wallet.health === 'degraded') return '#FBBF24';
        return '#10B981';
      },

      walletCellClass: function(wallet) {
        if (wallet.health === 'down') return 'wallet-cell-down';
        if (wallet.health === 'degraded') return 'wallet-cell-degraded';
        return 'wallet-cell-healthy';
      }
    };
  }

  // Auto-refresh page every 60 seconds (if enabled)
  setInterval(function() {
    var autoRefresh = localStorage.getItem('dashboardAutoRefresh') !== 'false';
    if (!autoRefresh) return;
    location.reload();
  }, 60000);
</script>
`;

  return htmlDocument(content, "x402 Sponsor Relay - Dashboard");
}

/**
 * Generate empty state page when no data is available
 * @param network - Optional network context ("testnet" | "mainnet")
 */
export function emptyStatePage(network?: string): string {
  const content = `
${header(network)}

<main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">
  <div class="brand-section p-12 text-center">
    ${barChartSvg("w-16 h-16", "mb-4")}
    <h2 class="text-xl font-semibold text-white mb-2">No Data Yet</h2>
    <p class="text-gray-400 mb-6">
      The relay hasn't processed any transactions yet. Stats will appear here once transactions are submitted.
    </p>
    <a href="/docs" class="brand-cta-button inline-flex items-center min-h-[44px] px-4 py-2 text-white rounded-lg transition-colors">
      View API Docs
      <svg class="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
      </svg>
    </a>
  </div>
</main>

${footer(utcTimestamp())}
`;

  return htmlDocument(content, "x402 Sponsor Relay - Dashboard");
}
