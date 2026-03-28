import type { DashboardOverview, EndpointBreakdown } from "../../types";
import { htmlDocument, header, footer } from "../components/layout";
import {
  statsCard,
  tokenCard,
  healthCard,
  successRateCard,
  statusBannerPlaceholder,
  feesSpentCard,
  settlementTimeCard,
} from "../components/cards";
import {
  formatTrend,
  transactionChartConfig,
} from "../components/charts";
import { colors, escapeHtml, formatNumber } from "../styles";

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
  return new Date().toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }) + " UTC";
}

/**
 * Check whether hourly data has any non-zero transaction counts
 */
function hasTransactionChartData(
  hourlyData: Array<{ hour: string; transactions: number; success: number }>
): boolean {
  return hourlyData.some((h) => h.transactions > 0);
}

/**
 * Empty-state div for charts with no data
 */
function chartEmptyState(message: string): string {
  return `
<div class="h-64 flex items-center justify-center">
  <div class="text-center">
    ${barChartSvg("w-10 h-10")}
    <p class="text-gray-400 mt-2">${escapeHtml(message)}</p>
    <p class="text-sm text-gray-500 mt-1">Charts will appear once transactions are processed</p>
  </div>
</div>`;
}

/**
 * Render just the grid of endpoint cards (no outer wrapper).
 * Used by the collapsible accordion section.
 */
function endpointBreakdownCards(breakdown: EndpointBreakdown): string {
  function endpointCard(
    name: string,
    total: number,
    success?: number,
    failed?: number,
    clientErrors?: number
  ): string {
    const hasDetail = success !== undefined && failed !== undefined;
    const successColor = colors.status.healthy;
    const failColor = colors.status.down;
    const clientColor = colors.status.degraded;

    return `
<div class="brand-card p-4">
  <p class="text-sm text-gray-400 font-medium">${escapeHtml(name)}</p>
  <p class="text-2xl font-bold text-white mt-2">${formatNumber(total)}</p>
  ${hasDetail ? `
  <div class="mt-2">
    <div class="flex items-center justify-between text-xs">
      <span style="color: ${successColor}">Success</span>
      <span style="color: ${successColor}">${formatNumber(success!)}</span>
    </div>
    <div class="flex items-center justify-between text-xs mt-1">
      <span style="color: ${failColor}">Failed</span>
      <span style="color: ${failColor}">${formatNumber(failed!)}</span>
    </div>
    ${clientErrors !== undefined && clientErrors > 0 ? `
    <div class="flex items-center justify-between text-xs mt-1">
      <span style="color: ${clientColor}">Client Err</span>
      <span style="color: ${clientColor}">${formatNumber(clientErrors)}</span>
    </div>` : ""}
  </div>` : `<p class="text-xs text-gray-500 mt-2">verify-only (no settlement)</p>`}
</div>`;
  }

  return `
<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
  ${endpointCard("/relay", breakdown.relay.total, breakdown.relay.success, breakdown.relay.failed)}
  ${endpointCard("/sponsor", breakdown.sponsor.total, breakdown.sponsor.success, breakdown.sponsor.failed)}
  ${endpointCard("/settle", breakdown.settle.total, breakdown.settle.success, breakdown.settle.failed, breakdown.settle.clientErrors)}
  ${endpointCard("/verify", breakdown.verify.total)}
</div>`;
}

/**
 * Check whether the endpoint breakdown section has any data to display
 */
function hasEndpointData(breakdown: EndpointBreakdown | undefined): breakdown is EndpointBreakdown {
  if (!breakdown) return false;
  return (breakdown.relay.total + breakdown.sponsor.total + breakdown.settle.total + breakdown.verify.total) > 0;
}

/**
 * Generate the main dashboard overview page
 * @param data - Dashboard overview data
 * @param network - Optional network context ("testnet" | "mainnet")
 */
export function overviewPage(data: DashboardOverview, network?: string): string {
  const trend = formatTrend(
    data.transactions.total,
    data.transactions.previousTotal
  );

  const settlement = data.settlement ?? {
    status: "unknown" as const,
    avgLatencyMs: 0,
    uptime24h: 0,
    lastCheck: null,
  };

  const showTxChart = hasTransactionChartData(data.hourlyData);

  const content = `
${header(network)}

<main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">
  <!-- Zone A + Zone B: Status banner and metric cards (shared Alpine statusApp component) -->
  <div x-data="statusApp()" x-init="init()">
    <!-- Zone A: Full-width status banner -->
    <div class="mb-4">
      ${statusBannerPlaceholder()}
    </div>

    <!-- Zone B: Redesigned metric cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      ${statsCard("Transactions (24h)", data.transactions.total, {
        trend: trend.html,
        icon: `<svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
      })}

      ${successRateCard(data.transactions.success, data.transactions.total, data.transactions.clientErrors)}

      ${feesSpentCard(data.fees.total, data.fees.average)}

      ${settlementTimeCard()}
    </div>

    <!-- Zone C: Nonce Pool Visualization -->
    <div class="mb-6" x-show="wallets.length > 0">
      <div class="brand-section p-4">
        <!-- Zone C header: title, toggle, capacity label -->
        <div class="flex items-center justify-between mb-3" style="cursor: pointer" @click="poolOpen = !poolOpen">
          <div class="flex items-center gap-3">
            <h3 class="text-lg font-semibold text-white">Nonce Pool</h3>
            <span class="text-sm text-gray-400" x-text="wallets.length + ' wallets · ' + capacityLabel + ' slots'"></span>
          </div>
          <svg class="w-5 h-5 text-gray-400" :style="poolOpen ? 'transform: rotate(180deg)' : ''" style="transition: transform 0.2s ease" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
        </div>

        <!-- Legend row -->
        <div x-show="poolOpen" class="flex flex-wrap gap-3 mb-4" style="font-size: 0.75rem; color: #9ca3af">
          <span class="flex items-center gap-1">
            <span class="nonce-tile nonce-tile--available" style="display: inline-block"></span> available
          </span>
          <span class="flex items-center gap-1">
            <span class="nonce-tile nonce-tile--assigned" style="display: inline-block"></span> assigned
          </span>
          <span class="flex items-center gap-1">
            <span class="nonce-tile nonce-tile--broadcasted" style="display: inline-block"></span> broadcasted
          </span>
          <span class="flex items-center gap-1">
            <span class="nonce-tile nonce-tile--replaced" style="display: inline-block"></span> replaced
          </span>
          <span class="flex items-center gap-1">
            <span class="nonce-tile nonce-tile--gap" style="display: inline-block"></span> gap
          </span>
        </div>

        <!-- Wallet lanes -->
        <div x-show="poolOpen">
          <template x-for="wallet in wallets" :key="wallet.index">
            <div class="nonce-lane" :class="{ 'nonce-lane--cb': wallet.circuitBreaker }">
              <!-- Wallet index badge -->
              <span class="text-xs font-mono text-gray-500" style="min-width: 1.5rem; text-align: right" x-text="'#' + wallet.index"></span>
              <!-- Truncated address -->
              <span class="text-xs font-mono text-purple-400" style="min-width: 8rem" x-text="truncateAddr(wallet.address)"></span>
              <!-- Circuit breaker badge -->
              <template x-if="wallet.circuitBreaker">
                <span class="text-xs rounded circuit-breaker-active" style="padding: 0.125rem 0.375rem; background-color: #F8717120; color: #F87171; border: 1px solid #F8717140; font-size: 0.65rem; white-space: nowrap">CB</span>
              </template>
              <!-- Nonce tile grid (20 tiles per wallet) -->
              <div class="flex flex-wrap gap-1" style="flex: 1">
                <template x-for="slot in wallet.slots" :key="slot.offset">
                  <div
                    :class="tileClass(slot.state)"
                    :title="'nonce ' + slot.nonce + (slot.txid ? ' · ' + slot.txid.slice(0, 10) + '...' : '') + (slot.sender ? ' · ' + truncateAddr(slot.sender) : '')"
                    style="cursor: default">
                  </div>
                </template>
              </div>
            </div>
          </template>
        </div>

        <!-- Sender hands (conditional: only shown when any slot has a sender) -->
        <template x-if="poolOpen && wallets.some(function(w) { return walletSenders(w).length > 0; })">
          <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #1a1a1a">
            <p class="text-xs text-gray-500 mb-2">Active senders</p>
            <div class="flex flex-wrap gap-2">
              <template x-for="wallet in wallets" :key="'s' + wallet.index">
                <template x-for="sender in walletSenders(wallet)" :key="sender">
                  <span class="text-xs font-mono px-2 py-0.5 rounded" style="background-color: #0634D020; color: #a78bfa; border: 1px solid #0634D040">
                    <span x-text="truncateAddr(sender)"></span>
                    <span class="text-gray-600" x-text="' · w' + wallet.index"></span>
                  </span>
                </template>
              </template>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <!-- Transaction Volume Chart (full-width, with 24h/7d toggle) -->
  <div class="mb-6" x-data="txChartApp()">
    <div class="brand-section p-6">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold text-white">Transaction Volume</h3>
        <div class="flex items-center gap-3 text-sm" x-show="${showTxChart ? 'true' : 'false'}">
          <span
            @click="setPeriod('24h')"
            :class="period === '24h' ? 'text-white' : 'text-gray-500 hover:text-gray-300 cursor-pointer'"
            class="font-medium transition-colors select-none">
            24h
          </span>
          <span
            @click="setPeriod('7d')"
            :class="period === '7d' ? 'text-white' : 'text-gray-500 hover:text-gray-300 cursor-pointer'"
            class="font-medium transition-colors select-none">
            7d
          </span>
        </div>
      </div>
      ${showTxChart
        ? `<div class="h-64 relative">
        <div x-show="loading" class="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-50 rounded z-10">
          <span class="text-gray-400 text-sm">Loading...</span>
        </div>
        <canvas id="transactionChart"></canvas>
      </div>`
        : chartEmptyState("No transaction data yet")}
    </div>
  </div>

  <!-- Zone E: Detail Sections (collapsible accordion) -->
  <div class="mb-6">

    <!-- Token Breakdown -->
    <div class="detail-section" x-data="{ open: false }">
      <button class="detail-section__header" @click="open = !open" type="button">
        <span class="text-sm font-semibold text-white">Token Breakdown</span>
        <svg class="detail-section__chevron" :class="{ 'detail-section__chevron--open': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div class="detail-section__body" x-show="open" x-cloak>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          ${tokenCard("STX", data.tokens.STX.count, data.tokens.STX.percentage, data.tokens.STX.volume)}
          ${tokenCard("sBTC", data.tokens.sBTC.count, data.tokens.sBTC.percentage, data.tokens.sBTC.volume)}
          ${tokenCard("USDCx", data.tokens.USDCx.count, data.tokens.USDCx.percentage, data.tokens.USDCx.volume)}
        </div>
      </div>
    </div>

    ${hasEndpointData(data.endpointBreakdown) ? `
    <!-- Endpoint Breakdown -->
    <div class="detail-section" x-data="{ open: false }">
      <button class="detail-section__header" @click="open = !open" type="button">
        <span class="text-sm font-semibold text-white">Endpoint Breakdown (Today)</span>
        <svg class="detail-section__chevron" :class="{ 'detail-section__chevron--open': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div class="detail-section__body" x-show="open" x-cloak>
        ${endpointBreakdownCards(data.endpointBreakdown)}
      </div>
    </div>
    ` : ""}

    <!-- Health / Stacks API -->
    <div class="detail-section" x-data="{ open: false }">
      <button class="detail-section__header" @click="open = !open" type="button">
        <span class="text-sm font-semibold text-white">Stacks API Health</span>
        <svg class="detail-section__chevron" :class="{ 'detail-section__chevron--open': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div class="detail-section__body" x-show="open" x-cloak>
        ${healthCard(settlement.status, settlement.avgLatencyMs, settlement.uptime24h, settlement.lastCheck)}
      </div>
    </div>

    <!-- Sponsor Wallets -->
    <div class="detail-section" x-data="Object.assign({ open: false }, walletApp())" x-init="init()">
      <button class="detail-section__header" @click="open = !open" type="button">
        <span class="text-sm font-semibold text-white">Sponsor Wallets</span>
        <svg class="detail-section__chevron" :class="{ 'detail-section__chevron--open': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div class="detail-section__body" x-show="open" x-cloak>
        <div x-show="loading" class="text-gray-400 text-sm py-4">Loading wallet status...</div>
        <div x-show="!loading && error" class="text-gray-500 text-sm py-4" x-text="error"></div>
        <div x-show="!loading && !error && totals">
          <!-- Summary row -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div class="brand-card p-4">
              <p class="text-sm text-gray-400">Total Balance</p>
              <p class="text-xl font-bold text-white mt-2" x-text="formatSTX(totals && totals.totalBalance)"></p>
            </div>
            <div class="brand-card p-4">
              <p class="text-sm text-gray-400">Total Fees Spent</p>
              <p class="text-xl font-bold text-white mt-2" x-text="formatSTX(totals && totals.totalFeesSpent)"></p>
            </div>
            <div class="brand-card p-4">
              <p class="text-sm text-gray-400">Total Tx Count</p>
              <p class="text-xl font-bold text-white mt-2" x-text="totals && totals.totalTxCount"></p>
            </div>
            <div class="brand-card p-4">
              <p class="text-sm text-gray-400">Wallet Count</p>
              <p class="text-xl font-bold text-white mt-2" x-text="totals && totals.walletCount"></p>
            </div>
          </div>
          <!-- Per-wallet table -->
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead>
                <tr class="text-left text-gray-400 text-sm">
                  <th class="py-2 px-4 font-medium">#</th>
                  <th class="py-2 px-4 font-medium">Address</th>
                  <th class="py-2 px-4 font-medium text-right">Balance</th>
                  <th class="py-2 px-4 font-medium text-right">Fees Spent</th>
                  <th class="py-2 px-4 font-medium text-right">Txs Today</th>
                  <th class="py-2 px-4 font-medium text-right">Pool</th>
                  <th class="py-2 px-4 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                <template x-for="wallet in wallets" :key="wallet.index">
                  <tr class="border-t" style="border-color: #1a1a1a">
                    <td class="py-3 px-4 text-gray-400 text-sm" x-text="wallet.index"></td>
                    <td class="py-3 px-4">
                      <code class="text-sm font-mono text-purple-400" x-text="truncateAddr(wallet.address)"></code>
                    </td>
                    <td class="py-3 px-4 text-right">
                      <span class="text-white font-medium" x-text="formatSTX(wallet.balance)"></span>
                    </td>
                    <td class="py-3 px-4 text-right">
                      <span class="text-gray-400 text-sm" x-text="formatSTX(wallet.totalFeesSpent)"></span>
                    </td>
                    <td class="py-3 px-4 text-right">
                      <span class="text-white" x-text="wallet.txCountToday"></span>
                      <span class="text-gray-500 text-xs ml-1" x-text="'(' + wallet.txCount + ' total)'"></span>
                    </td>
                    <td class="py-3 px-4 text-right text-sm text-gray-400">
                      <span x-text="wallet.pool.available + ' avail / ' + wallet.pool.reserved + ' rsv'"></span>
                    </td>
                    <td class="py-3 px-4 text-right">
                      <span class="px-2 py-0.5 text-xs rounded-full font-medium"
                            :style="'background-color: ' + statusColor(wallet.status) + '20; color: ' + statusColor(wallet.status) + '; border: 1px solid ' + statusColor(wallet.status) + '40'"
                            x-text="statusLabel(wallet.status)"></span>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    ${data.apiKeys ? `
    <!-- API Keys -->
    <div class="detail-section" x-data="{ open: false }">
      <button class="detail-section__header" @click="open = !open" type="button">
        <span class="text-sm font-semibold text-white">API Keys</span>
        <svg class="detail-section__chevron" :class="{ 'detail-section__chevron--open': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div class="detail-section__body" x-show="open" x-cloak>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="brand-card p-4">
            <p class="text-sm text-gray-400">Total Active</p>
            <p class="text-2xl font-bold text-white mt-2">${escapeHtml(String(data.apiKeys.totalActiveKeys))}</p>
          </div>
          <div class="brand-card p-4">
            <p class="text-sm text-gray-400">Registered (7d)</p>
            <p class="text-2xl font-bold text-green-400 mt-2">${escapeHtml(String(data.apiKeys.newKeysLast7Days))}</p>
          </div>
          <div class="brand-card p-4">
            <p class="text-sm text-gray-400">Expired</p>
            <p class="text-2xl font-bold text-yellow-400 mt-2">${escapeHtml(String(data.apiKeys.expiredKeys))}</p>
          </div>
          <div class="brand-card p-4">
            <p class="text-sm text-gray-400">Revoked</p>
            <p class="text-2xl font-bold text-red-400 mt-2">${escapeHtml(String(data.apiKeys.revokedKeys))}</p>
          </div>
        </div>
      </div>
    </div>
    ` : ""}

  </div>
</main>

${footer(utcTimestamp())}

<script>
  // Server-rendered 24h chart config (used by Alpine init)
  var _chartConfig = ${transactionChartConfig(data.hourlyData)};

  // Module-scoped reference for auto-refresh interval
  var _txChartInstance = null;

  // Convert UTC hour label ("HH:00") to visitor's local timezone.
  // For non-hour labels (e.g. "Feb 12" from 7d view), return as-is.
  function toLocalHour(utcLabel) {
    var m = utcLabel.match(/^(\\d{2}):00$/);
    if (!m) return utcLabel;
    var now = new Date();
    var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), parseInt(m[1], 10)));
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Convert all labels in a chart config to local timezone
  function localizeLabels(labels) {
    return labels.map(toLocalHour);
  }

  // Localize the server-rendered config labels before first render
  _chartConfig.data.labels = localizeLabels(_chartConfig.data.labels);

  // Alpine.js component for the transaction volume chart with period toggle
  function txChartApp() {
    return {
      period: '24h',
      loading: false,
      chartInstance: null,

      init: function() {
        var canvas = document.getElementById('transactionChart');
        if (canvas && typeof Chart !== 'undefined') {
          this.chartInstance = new Chart(canvas, _chartConfig);
        }
        _txChartInstance = this;
      },

      setPeriod: function(p) {
        if (this.period === p || this.loading) return;
        this.period = p;
        this.loading = true;

        var self = this;
        fetch('/dashboard/api/stats?period=' + p)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var hourlyData = data.hourlyData || [];
            self.rebuildChart(hourlyData);
          })
          .catch(function() { /* silently ignore fetch errors */ })
          .finally(function() { self.loading = false; });
      },

      rebuildChart: function(hourlyData) {
        // Destroy and recreate the chart to handle label count changes (24 → 7)
        if (this.chartInstance) {
          this.chartInstance.destroy();
        }
        var canvas = document.getElementById('transactionChart');
        if (!canvas || typeof Chart === 'undefined') return;
        var config = JSON.parse(JSON.stringify(_chartConfig));
        config.data.labels = localizeLabels(hourlyData.map(function(d) { return d.hour; }));
        config.data.datasets[0].data = hourlyData.map(function(d) { return d.transactions; });
        config.data.datasets[1].data = hourlyData.map(function(d) { return d.success; });
        this.chartInstance = new Chart(canvas, config);
      }
    };
  }

  // Auto-refresh chart every 60 seconds via AJAX (no page reload)
  setInterval(function() {
    var autoRefresh = localStorage.getItem('dashboardAutoRefresh') !== 'false';
    if (!autoRefresh || !_txChartInstance || !_txChartInstance.chartInstance) return;
    var period = _txChartInstance.period || '24h';
    fetch('/dashboard/api/stats?period=' + period)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.hourlyData) _txChartInstance.rebuildChart(data.hourlyData);
      })
      .catch(function() {});
  }, 60000);

  // Status banner Alpine.js component — fetches /nonce/state on init and every 10s.
  // Also stores wallet data for Zone C nonce pool visualization (shared fetch).
  function statusApp() {
    return {
      statusColor: '#6B7280',
      statusLabel: 'Loading...',
      capacityPct: 0,
      capacityColor: '#6B7280',
      capacityLabel: '--/--',
      showWarning: false,
      wallets: [],
      settlementTimes: null,
      poolOpen: true,
      _interval: null,

      init: function() {
        var self = this;
        self.refresh();
        self._interval = setInterval(function() { self.refresh(); }, 10000);
      },

      refresh: function() {
        var self = this;
        fetch('/nonce/state')
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(data) {
            if (!data || !data.state) return;
            var state = data.state;
            var healthy = state.healthy;
            var hasRecommendation = state.recommendation === 'fallback_to_direct';
            var totalReserved = state.totalReserved || 0;
            var totalCapacity = state.totalCapacity || 1;
            var pct = Math.round((totalReserved / totalCapacity) * 100);

            if (healthy && !hasRecommendation) {
              self.statusColor = '#10B981';
              self.statusLabel = 'Healthy';
            } else {
              self.statusColor = '#FBBF24';
              self.statusLabel = hasRecommendation ? 'Degraded — fallback to direct' : 'Degraded';
            }

            self.capacityPct = Math.min(pct, 100);
            self.capacityColor = pct < 70 ? '#10B981' : pct < 90 ? '#FBBF24' : '#F87171';
            self.capacityLabel = totalReserved + '/' + totalCapacity;
            self.showWarning = !healthy || hasRecommendation;

            // Store global settlement time percentiles for Zone B settlement card
            self.settlementTimes = (state.settlementTimes && state.settlementTimes.count > 0)
              ? state.settlementTimes : null;

            // Store wallet data for Zone C nonce pool visualization
            // Map /nonce/state response shape to view-model expected by the template
            var rawWallets = (state && state.wallets) || [];
            var CHAINING_LIMIT = 20;
            self.wallets = rawWallets.map(function(w) {
              // Build 20-tile slots array from chainFrontier + pendingTxs + gaps
              var frontier = w.chainFrontier || 0;
              var gapSet = {};
              (w.gaps || []).forEach(function(g) { gapSet[g] = true; });
              // Index pending txs by nonce for quick lookup
              var pendingByNonce = {};
              (w.pendingTxs || []).forEach(function(tx) { pendingByNonce[tx.sponsorNonce] = tx; });
              var slots = [];
              for (var i = 0; i < CHAINING_LIMIT; i++) {
                var nonce = frontier + i;
                var pending = pendingByNonce[nonce];
                var slotState = 'available';
                var txid = '';
                var sender = '';
                if (gapSet[nonce]) {
                  slotState = 'gap';
                } else if (pending) {
                  slotState = pending.state || 'assigned';
                  txid = pending.txid || '';
                  sender = pending.senderAddress || '';
                }
                slots.push({ offset: i, state: slotState, nonce: nonce, txid: txid, sender: sender });
              }
              return {
                index: w.walletIndex,
                address: w.sponsorAddress || '',
                circuitBreaker: !!w.circuitBreakerOpen,
                slots: slots
              };
            });
          })
          .catch(function() { /* silently ignore network errors */ });
      },

      // Truncate a Stacks address for display (first 6 + last 4 chars)
      truncateAddr: function(addr) {
        if (!addr || addr.length < 12) return addr || '';
        return addr.slice(0, 6) + '...' + addr.slice(-4);
      },

      // Map a nonce slot state to its CSS tile class
      tileClass: function(state) {
        var valid = ['available', 'assigned', 'broadcasted', 'replaced', 'gap'];
        return 'nonce-tile nonce-tile--' + (valid.indexOf(state) >= 0 ? state : 'available');
      },

      // Get unique senders from a wallet's slots
      walletSenders: function(wallet) {
        var senders = [];
        var seen = {};
        for (var i = 0; i < wallet.slots.length; i++) {
          var slot = wallet.slots[i];
          if (slot.sender && !seen[slot.sender]) {
            seen[slot.sender] = true;
            senders.push(slot.sender);
          }
        }
        return senders;
      },

      // Format milliseconds as a human-readable latency string
      formatMs: function(ms) {
        if (!ms) return '--';
        return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
      }
    };
  }

  // Wallet status Alpine.js component — fetches /wallets on init
  function walletApp() {
    return {
      loading: true,
      error: null,
      wallets: [],
      totals: null,
      init: function() {
        var self = this;
        fetch('/wallets')
          .then(function(r) {
            if (!r.ok) throw new Error('Failed to load wallets: ' + r.status);
            return r.json();
          })
          .then(function(data) {
            if (data && data.success === false) {
              self.error = data.error || 'Wallet status unavailable (sponsor not configured or error)';
              self.wallets = [];
              self.totals = null;
              return;
            }
            self.wallets = (data && data.wallets) || [];
            self.totals = (data && data.totals) || null;
          })
          .catch(function(e) { self.error = e.message || 'Wallet status unavailable (sponsor not configured or error)'; })
          .finally(function() { self.loading = false; });
      },
      formatSTX: function(microSTX) {
        if (!microSTX) return '0 STX';
        try {
          var n = BigInt(microSTX);
          var whole = n / BigInt(1000000);
          var frac = n % BigInt(1000000);
          return whole.toLocaleString() + '.' + frac.toString().padStart(6, '0') + ' STX';
        } catch(e) {
          return microSTX + ' uSTX';
        }
      },
      truncateAddr: function(addr) {
        if (!addr || addr.length < 12) return addr || '';
        return addr.slice(0, 8) + '...' + addr.slice(-6);
      },
      statusColor: function(status) {
        if (status === 'healthy') return '#10B981';
        if (status === 'low_balance') return '#FBBF24';
        return '#F87171';
      },
      statusLabel: function(status) {
        if (status === 'healthy') return 'Healthy';
        if (status === 'low_balance') return 'Low Balance';
        return 'Depleted';
      }
    };
  }
</script>
`;

  return htmlDocument(content, "x402 Sponsor Relay - Dashboard", {
    includeChartJs: showTxChart,
  });
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
