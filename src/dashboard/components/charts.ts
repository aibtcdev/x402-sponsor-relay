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
 * Generate a CSS-only sparkline bar chart from hourly transaction data.
 * Returns an HTML string with flexbox bars, height proportional to max value.
 * No canvas, no Chart.js — pure CSS.
 */
export function cssSparkline(
  hourlyData: Array<{ hour: string; transactions: number; success: number }>
): string {
  if (!hourlyData || hourlyData.length === 0) {
    return `<div class="sparkline-container" style="align-items:center;justify-content:center;">
      <span class="text-gray-600 text-xs">No activity data</span>
    </div>`;
  }

  const maxVal = Math.max(...hourlyData.map((d) => d.transactions), 1);

  const bars = hourlyData
    .map((d) => {
      const heightPct = Math.max(
        (d.transactions / maxVal) * 100,
        d.transactions > 0 ? 6 : 2
      );
      const color =
        d.transactions === 0
          ? colors.bg.border
          : colors.brand.orange;
      const label = `${d.hour}: ${d.transactions} tx (${d.success} ok)`;
      return `<div class="sparkline-bar" title="${label}" style="height:${heightPct}%;background-color:${color};${d.transactions === 0 ? "opacity:0.3;" : ""}"></div>`;
    })
    .join("");

  return `<div class="sparkline-container">${bars}</div>`;
}
