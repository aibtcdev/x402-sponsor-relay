import type { DashboardOverview } from "../../types";
import { htmlDocument, header, footer } from "../components/layout";
import {
  statsCard,
  tokenCard,
  healthCard,
  successRateCard,
  apiKeysSection,
} from "../components/cards";
import {
  formatTrend,
  transactionChartConfig,
} from "../components/charts";
import { colors, formatNumber, formatTokenAmount, escapeHtml } from "../styles";

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
    <svg class="w-10 h-10 text-gray-600 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
    </svg>
    <p class="text-gray-400 mt-2">${escapeHtml(message)}</p>
    <p class="text-sm text-gray-500 mt-1">Charts will appear once transactions are processed</p>
  </div>
</div>`;
}

/**
 * Generate the main dashboard overview page
 * @param data - Dashboard overview data
 * @param network - Optional network context ("testnet" | "mainnet")
 */
export function overviewPage(data: DashboardOverview, network?: string): string {
  const now = new Date().toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });

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

    ${statsCard("Settlement", settlement.status.charAt(0).toUpperCase() + settlement.status.slice(1), {
      colorClass: `status-${settlement.status}`,
      icon: `<svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>`,
    })}

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
        <div class="flex items-center gap-1 bg-gray-800 rounded-lg p-1" x-show="${showTxChart ? 'true' : 'false'}">
          <button
            @click="setPeriod('24h')"
            :class="period === '24h' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white'"
            class="px-3 py-1 rounded text-sm font-medium transition-colors min-h-[32px]">
            24h
          </button>
          <button
            @click="setPeriod('7d')"
            :class="period === '7d' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white'"
            class="px-3 py-1 rounded text-sm font-medium transition-colors min-h-[32px]">
            7d
          </button>
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

  <!-- API Key Usage Section -->
  ${data.apiKeys ? apiKeysSection(data.apiKeys) : ""}

  <!-- Stacks API Section -->
  <div class="mb-6">
    ${healthCard(settlement.status, settlement.avgLatencyMs, settlement.uptime24h, settlement.lastCheck)}
  </div>
</main>

${footer(now + " UTC")}

<script>
  // Brand colors for chart datasets (single source of truth from styles.ts)
  var _brandColors = { total: '${colors.brand.orange}', success: '${colors.status.healthy}' };

  // Server-rendered 24h chart config (used by Alpine init)
  var _chartConfig = ${transactionChartConfig(data.hourlyData)};

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
        var canvas = document.getElementById('transactionChart');
        if (!canvas || typeof Chart === 'undefined') return;

        if (this.chartInstance) {
          this.chartInstance.destroy();
          this.chartInstance = null;
        }

        var labels = hourlyData.map(function(d) { return d.hour; });
        var transactions = hourlyData.map(function(d) { return d.transactions; });
        var success = hourlyData.map(function(d) { return d.success; });

        this.chartInstance = new Chart(canvas, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Total',
                data: transactions,
                borderColor: _brandColors.total,
                backgroundColor: _brandColors.total + '20',
                fill: true,
                tension: 0.3
              },
              {
                label: 'Success',
                data: success,
                borderColor: _brandColors.success,
                backgroundColor: _brandColors.success + '20',
                fill: true,
                tension: 0.3
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top', labels: { color: '#9CA3AF' } } },
            scales: {
              x: { grid: { color: '#374151' }, ticks: { color: '#9CA3AF' } },
              y: { grid: { color: '#374151' }, ticks: { color: '#9CA3AF' }, beginAtZero: true }
            }
          }
        });
      }
    };
  }

  // Auto-refresh every 60 seconds (pre-validate network before reload)
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() {
      var autoRefresh = localStorage.getItem('dashboardAutoRefresh') !== 'false';
      if (autoRefresh) {
        fetch(location.pathname + '/api/stats', { method: 'HEAD' })
          .then(function(r) { if (r.ok) location.reload(); })
          .catch(function() { /* network error — skip reload */ });
      }
    }, 60000);
  });
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
    <svg class="w-16 h-16 text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
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

${footer(new Date().toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC")}
`;

  return htmlDocument(content, "x402 Sponsor Relay - Dashboard");
}
