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
    orange: "#FF4F03",
    blue: "#0634D0",
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
    primary: "#000000", // brand black
    secondary: "#0a0a0a", // brand near-black
    card: "#0a0a0a", // brand near-black
    border: "#1a1a1a", // subtle border
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

  /* Brand animations */
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-float {
    animation: float 3s ease-in-out infinite;
  }
  .animate-fade-up {
    animation: fadeUp 0.4s ease-out;
  }

  /* Brand card styles */
  .brand-card {
    background-color: ${colors.bg.card};
    border: 1px solid ${colors.bg.border};
    border-radius: 0.5rem;
    transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
  }
  .brand-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(255, 79, 3, 0.08);
    border-color: rgba(255, 79, 3, 0.3);
  }

  /* Brand focus ring */
  .brand-card:focus-within,
  a:focus-visible,
  button:focus-visible {
    outline: 2px solid ${colors.brand.orange};
    outline-offset: 2px;
  }

  /* Brand layout bar (header/footer) */
  .brand-bar {
    background-color: ${colors.bg.secondary};
    border-color: ${colors.bg.border};
  }

  /* Brand section background */
  .brand-section {
    background-color: ${colors.bg.card};
    border: 1px solid ${colors.bg.border};
    border-radius: 0.5rem;
  }

  /* Legacy compat: stat-card maps to brand-card */
  .stat-card {
    transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
  }
  .stat-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(255, 79, 3, 0.08);
    border-color: rgba(255, 79, 3, 0.3);
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
