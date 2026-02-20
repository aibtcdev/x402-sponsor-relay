import type { DashboardOverview } from "../../types";
import { htmlDocument, header, footer } from "../components/layout";
import {
  statsCard,
  tokenCard,
  healthCard,
  successRateCard,
} from "../components/cards";
import {
  formatTrend,
  transactionChartConfig,
} from "../components/charts";
import { colors, escapeHtml } from "../styles";

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
<div class="h-96 flex items-center justify-center">
  <div class="text-center">
    ${barChartSvg("w-10 h-10")}
    <p class="text-gray-400 mt-2">${escapeHtml(message)}</p>
    <p class="text-sm text-gray-500 mt-1">Charts will appear once transactions are processed</p>
  </div>
</div>`;
}

/**
 * Settlement status badge card — shows status as a small pill badge
 * rather than a large bold headline, to avoid alarming "Down" text.
 */
function settlementCard(
  status: "healthy" | "degraded" | "down" | "unknown",
  uptime24h: number
): string {
  const badgeColor = colors.status[status];
  const label = status.charAt(0).toUpperCase() + status.slice(1);

  return `
<div class="brand-card p-4">
  <div class="flex items-center justify-between">
    <p class="text-sm text-gray-400">Settlement</p>
    <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
  </div>
  <div class="mt-2">
    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
          style="background-color: ${badgeColor}20; color: ${badgeColor}; border: 1px solid ${badgeColor}40">
      ${escapeHtml(label)}
    </span>
  </div>
  <p class="text-xs text-gray-500 mt-2">Uptime 24h: ${uptime24h}%</p>
</div>`;
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
  <!-- Stats Cards Row -->
  <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-6">
    ${statsCard("Transactions (24h)", data.transactions.total, {
      trend: trend.html,
      icon: `<svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
    })}

    ${successRateCard(data.transactions.success, data.transactions.total)}

    ${settlementCard(settlement.status, settlement.uptime24h)}

    ${statsCard("Hiro Latency", `${settlement.avgLatencyMs}ms`, {
      colorClass: settlement.avgLatencyMs > 2000 ? "text-yellow-400" : "text-white",
      icon: `<svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    })}
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
        ? `<div class="h-96 relative">
        <div x-show="loading" class="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-50 rounded z-10">
          <span class="text-gray-400 text-sm">Loading...</span>
        </div>
        <canvas id="transactionChart"></canvas>
      </div>`
        : chartEmptyState("No transaction data yet")}
    </div>
  </div>

  <!-- Token Breakdown Cards -->
  <div class="mb-6">
    <h3 class="text-lg font-semibold text-white mb-4">Token Breakdown</h3>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      ${tokenCard("STX", data.tokens.STX.count, data.tokens.STX.percentage, data.tokens.STX.volume)}
      ${tokenCard("sBTC", data.tokens.sBTC.count, data.tokens.sBTC.percentage, data.tokens.sBTC.volume)}
      ${tokenCard("USDCx", data.tokens.USDCx.count, data.tokens.USDCx.percentage, data.tokens.USDCx.volume)}
    </div>
  </div>

  <!-- Stacks API Section -->
  <div class="mb-6">
    ${healthCard(settlement.status, settlement.avgLatencyMs, settlement.uptime24h, settlement.lastCheck)}
  </div>

  <!-- Sponsor Wallets Section (client-side fetch from /wallets) -->
  <div class="mb-6" x-data="walletApp()" x-init="init()">
    <div class="brand-section p-6">
      <h3 class="text-lg font-semibold text-white mb-4">Sponsor Wallets</h3>
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
          .then(function(r) { return r.json(); })
          .then(function(data) {
            self.wallets = data.wallets || [];
            self.totals = data.totals || null;
          })
          .catch(function() { self.error = 'Wallet status unavailable (sponsor not configured or error)'; })
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
