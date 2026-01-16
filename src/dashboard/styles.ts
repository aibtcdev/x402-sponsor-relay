/**
 * Dashboard color constants and CSS styles
 */

export const colors = {
  // Token colors (brand colors)
  tokens: {
    STX: "#5546FF", // Stacks purple
    sBTC: "#F7931A", // Bitcoin orange
    USDCx: "#2775CA", // USDC blue
  },

  // AIBTC brand colors
  brand: {
    orange: "#F7931A",
    blue: "#7DA2FF",
    purple: "#A855F7",
  },

  // Status colors
  status: {
    healthy: "#10B981", // Green
    degraded: "#FBBF24", // Yellow
    down: "#F87171", // Red
    unknown: "#6B7280", // Gray
  },

  // Trend colors (for transactions, up = good)
  trend: {
    up: "#10B981", // Green (more transactions)
    down: "#F87171", // Red (fewer transactions)
    stable: "#6B7280", // Gray
  },

  // UI colors
  bg: {
    primary: "#111827", // gray-900
    secondary: "#1F2937", // gray-800
    card: "#374151", // gray-700
  },
  text: {
    primary: "#F9FAFB", // gray-50
    secondary: "#9CA3AF", // gray-400
    muted: "#6B7280", // gray-500
  },
} as const;

/**
 * CSS styles for dashboard
 */
export const dashboardCss = `
  /* Roc Grotesk font */
  @font-face {
    font-family: 'Roc Grotesk';
    src: url('https://aibtc.com/fonts/RocGrotesk-Regular.woff2') format('woff2');
    font-weight: 400;
    font-display: swap;
  }
  @font-face {
    font-family: 'Roc Grotesk';
    src: url('https://aibtc.com/fonts/RocGrotesk-WideMedium.woff2') format('woff2');
    font-weight: 500;
    font-display: swap;
  }

  /* Background pattern */
  body {
    font-family: 'Roc Grotesk', system-ui, sans-serif;
    background: linear-gradient(135deg, #000000, #0a0a0a, #050208);
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: url('https://aibtc.com/Artwork/AIBTC_Pattern1_optimized.jpg') center/cover;
    opacity: 0.12;
    filter: saturate(1.3);
    pointer-events: none;
    z-index: -1;
  }

  /* Token colors */
  .token-STX { color: ${colors.tokens.STX}; }
  .token-sBTC { color: ${colors.tokens.sBTC}; }
  .token-USDCx { color: ${colors.tokens.USDCx}; }

  .bg-token-STX { background-color: ${colors.tokens.STX}; }
  .bg-token-sBTC { background-color: ${colors.tokens.sBTC}; }
  .bg-token-USDCx { background-color: ${colors.tokens.USDCx}; }

  /* Status colors */
  .status-healthy { color: ${colors.status.healthy}; }
  .status-degraded { color: ${colors.status.degraded}; }
  .status-down { color: ${colors.status.down}; }
  .status-unknown { color: ${colors.status.unknown}; }

  /* Trend colors */
  .trend-up { color: ${colors.trend.up}; }
  .trend-down { color: ${colors.trend.down}; }
  .trend-stable { color: ${colors.trend.stable}; }

  /* Custom animations */
  @keyframes pulse-slow {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }
  .animate-pulse-slow {
    animation: pulse-slow 2s ease-in-out infinite;
  }

  /* Card hover effect */
  .stat-card {
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }
  .stat-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }
`;

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Format a number with locale-aware separators
 */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Format a token amount for display
 */
export function formatTokenAmount(amount: string, token: string): string {
  const value = BigInt(amount);
  let divisor: bigint;
  let decimals: number;

  switch (token) {
    case "STX":
      divisor = BigInt(1_000_000); // 6 decimals
      decimals = 6;
      break;
    case "sBTC":
      divisor = BigInt(100_000_000); // 8 decimals
      decimals = 8;
      break;
    case "USDCx":
      divisor = BigInt(1_000_000); // 6 decimals
      decimals = 6;
      break;
    default:
      return amount;
  }

  const whole = value / divisor;
  const fraction = value % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0").slice(0, 2);

  return `${whole.toLocaleString("en-US")}.${fractionStr}`;
}
