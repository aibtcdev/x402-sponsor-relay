import { colors } from "../styles";
import { calculateTrend } from "../../services/stats";

/**
 * Format trend indicator with arrow and percentage
 */
export function formatTrend(
  current: number,
  previous: number
): { html: string; trend: "up" | "down" | "stable" } {
  const trend = calculateTrend(current, previous);

  if (previous === 0) {
    if (trend === "up") {
      return {
        html: `<span class="trend-up flex items-center"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"/></svg>New</span>`,
        trend: "up",
      };
    }
    return {
      html: `<span class="trend-stable text-gray-500">-</span>`,
      trend: "stable",
    };
  }

  const change = ((current - previous) / previous) * 100;
  const absChange = Math.abs(change).toFixed(0);

  if (trend === "up") {
    return {
      html: `<span class="trend-up flex items-center"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"/></svg>${absChange}%</span>`,
      trend: "up",
    };
  }
  if (trend === "down") {
    return {
      html: `<span class="trend-down flex items-center"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"/></svg>${absChange}%</span>`,
      trend: "down",
    };
  }

  return {
    html: `<span class="trend-stable text-gray-500">~${absChange}%</span>`,
    trend: "stable",
  };
}

/**
 * Generate Chart.js config for transaction line chart
 */
export function transactionChartConfig(
  hourlyData: Array<{ hour: string; transactions: number; success: number }>
): string {
  const labels = hourlyData.map((d) => d.hour);
  const transactions = hourlyData.map((d) => d.transactions);
  const success = hourlyData.map((d) => d.success);

  return JSON.stringify({
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Total",
          data: transactions,
          borderColor: colors.brand.orange,
          backgroundColor: `${colors.brand.orange}20`,
          fill: true,
          tension: 0.3,
        },
        {
          label: "Success",
          data: success,
          borderColor: colors.status.healthy,
          backgroundColor: `${colors.status.healthy}20`,
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
          labels: { color: "#9CA3AF" },
        },
      },
      scales: {
        x: {
          grid: { color: "#374151" },
          ticks: { color: "#9CA3AF" },
        },
        y: {
          grid: { color: "#374151" },
          ticks: { color: "#9CA3AF" },
          beginAtZero: true,
        },
      },
    },
  });
}

