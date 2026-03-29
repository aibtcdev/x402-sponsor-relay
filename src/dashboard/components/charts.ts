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
 * Derive stacked bar chart series from hourly/daily data.
 * Returns { success, relayErrors, clientErrors } arrays.
 */
function deriveChartSeries(
  data: Array<{ transactions: number; success: number; clientErrors?: number }>
): { success: number[]; relayErrors: number[]; clientErrors: number[] } {
  const success: number[] = [];
  const relayErrors: number[] = [];
  const clientErrors: number[] = [];
  for (const d of data) {
    const failed = Math.max(0, d.transactions - d.success);
    const ce = Math.max(0, Math.min(d.clientErrors ?? 0, failed));
    success.push(d.success);
    clientErrors.push(ce);
    relayErrors.push(failed - ce);
  }
  return { success, relayErrors, clientErrors };
}

/**
 * Generate Chart.js config for transaction stacked bar chart.
 * Shows Success, Relay Errors, and Client Errors as stacked segments.
 * Total is implied by the stack height.
 */
export function transactionChartConfig(
  hourlyData: Array<{ hour: string; transactions: number; success: number; clientErrors?: number }>
): string {
  const labels = hourlyData.map((d) => d.hour);
  const { success, relayErrors, clientErrors } = deriveChartSeries(hourlyData);

  return JSON.stringify({
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Success",
          data: success,
          backgroundColor: colors.status.healthy,
        },
        {
          label: "Relay Errors",
          data: relayErrors,
          backgroundColor: colors.status.down,
        },
        {
          label: "Client Errors",
          data: clientErrors,
          backgroundColor: colors.status.degraded,
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
        tooltip: {
          mode: "index",
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { color: "#374151" },
          ticks: { color: "#9CA3AF" },
        },
        y: {
          stacked: true,
          grid: { color: "#374151" },
          ticks: { color: "#9CA3AF" },
          beginAtZero: true,
        },
      },
    },
  });
}

