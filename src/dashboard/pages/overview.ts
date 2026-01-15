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
  tokenPieChartConfig,
} from "../components/charts";
import { formatNumber } from "../styles";

/**
 * Generate the main dashboard overview page
 */
export function overviewPage(data: DashboardOverview): string {
  const now = new Date().toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const trend = formatTrend(
    data.transactions.total,
    data.transactions.previousTotal
  );

  const content = `
${header()}

<main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  <!-- Stats Cards Row -->
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
    ${statsCard("Transactions (24h)", data.transactions.total, {
      trend: trend.html,
      icon: `<svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
    })}

    ${successRateCard(data.transactions.success, data.transactions.total)}

    ${statsCard("Facilitator", data.facilitator.status.charAt(0).toUpperCase() + data.facilitator.status.slice(1), {
      colorClass: `status-${data.facilitator.status}`,
      icon: `<svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>`,
    })}

    ${statsCard("Avg Latency", `${data.facilitator.avgLatencyMs}ms`, {
      colorClass: data.facilitator.avgLatencyMs > 2000 ? "text-yellow-400" : "text-white",
      icon: `<svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    })}
  </div>

  <!-- Charts Row -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
    <!-- Transaction Volume Chart -->
    <div class="bg-gray-800 rounded-lg p-6 border border-gray-700">
      <h3 class="text-lg font-semibold text-white mb-4">Transaction Volume (24h)</h3>
      <div class="h-64">
        <canvas id="transactionChart"></canvas>
      </div>
    </div>

    <!-- Token Distribution Chart -->
    <div class="bg-gray-800 rounded-lg p-6 border border-gray-700">
      <h3 class="text-lg font-semibold text-white mb-4">Token Distribution</h3>
      <div class="h-64">
        <canvas id="tokenChart"></canvas>
      </div>
    </div>
  </div>

  <!-- Token Breakdown Cards -->
  <div class="mb-8">
    <h3 class="text-lg font-semibold text-white mb-4">Token Breakdown</h3>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      ${tokenCard("STX", data.tokens.STX.count, data.tokens.STX.percentage, data.tokens.STX.volume)}
      ${tokenCard("sBTC", data.tokens.sBTC.count, data.tokens.sBTC.percentage, data.tokens.sBTC.volume)}
      ${tokenCard("USDCx", data.tokens.USDCx.count, data.tokens.USDCx.percentage, data.tokens.USDCx.volume)}
    </div>
  </div>

  <!-- Facilitator Health Section -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    ${healthCard(data.facilitator.status, data.facilitator.avgLatencyMs, data.facilitator.uptime24h)}

    <!-- Quick Stats -->
    <div class="bg-gray-800 rounded-lg p-6 border border-gray-700">
      <h3 class="text-lg font-semibold text-white mb-4">Quick Stats</h3>
      <div class="space-y-4">
        <div class="flex justify-between items-center">
          <span class="text-gray-400">Successful Transactions</span>
          <span class="text-green-400 font-medium">${formatNumber(data.transactions.success)}</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-gray-400">Failed Transactions</span>
          <span class="text-red-400 font-medium">${formatNumber(data.transactions.failed)}</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-gray-400">Total Volume (STX)</span>
          <span class="text-purple-400 font-medium">${data.tokens.STX.volume !== "0" ? (BigInt(data.tokens.STX.volume) / BigInt(1_000_000)).toLocaleString() : "0"} STX</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-gray-400">Period</span>
          <span class="text-gray-300">${data.period}</span>
        </div>
      </div>
    </div>
  </div>
</main>

${footer(now + " UTC")}

<script>
  // Initialize charts when DOM is ready
  document.addEventListener('DOMContentLoaded', function() {
    // Transaction volume chart
    const txCtx = document.getElementById('transactionChart');
    if (txCtx) {
      new Chart(txCtx, ${transactionChartConfig(data.hourlyData)});
    }

    // Token distribution chart
    const tokenCtx = document.getElementById('tokenChart');
    if (tokenCtx) {
      new Chart(tokenCtx, ${tokenPieChartConfig(data.tokens)});
    }

    // Auto-refresh every 60 seconds
    setTimeout(() => {
      const autoRefresh = localStorage.getItem('dashboardAutoRefresh') !== 'false';
      if (autoRefresh) {
        location.reload();
      }
    }, 60000);
  });
</script>
`;

  return htmlDocument(content, "x402 Sponsor Relay - Dashboard");
}

/**
 * Generate empty state page when no data is available
 */
export function emptyStatePage(): string {
  const content = `
${header()}

<main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  <div class="bg-gray-800 rounded-lg p-12 border border-gray-700 text-center">
    <svg class="w-16 h-16 text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
    <h2 class="text-xl font-semibold text-white mb-2">No Data Yet</h2>
    <p class="text-gray-400 mb-6">
      The relay hasn't processed any transactions yet. Stats will appear here once transactions are submitted.
    </p>
    <a href="/docs" class="inline-flex items-center px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors">
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
