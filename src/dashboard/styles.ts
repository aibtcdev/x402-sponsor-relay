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
 *
 * Includes all Tailwind-like utility classes used by the dashboard components.
 * This replaces the Tailwind Play CDN (which is not suitable for production)
 * with a static set of only the classes actually used.
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

  /* ── Reset ─────────────────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* ── Background pattern ────────────────────────────────────── */
  body {
    font-family: 'Roc Grotesk', system-ui, -apple-system, sans-serif;
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

  /* ── Layout ────────────────────────────────────────────────── */
  .flex { display: flex; }
  .inline-flex { display: inline-flex; }
  .inline-block { display: inline-block; }
  .grid { display: grid; }
  .relative { position: relative; }
  .overflow-hidden { overflow: hidden; }
  .overflow-x-auto { overflow-x: auto; }
  .items-center { align-items: center; }
  .justify-between { justify-content: space-between; }
  .justify-center { justify-content: center; }
  .flex-shrink-0 { flex-shrink: 0; }
  .flex-wrap { flex-wrap: wrap; }

  /* Grid columns */
  .grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
  .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }

  /* ── Spacing ───────────────────────────────────────────────── */
  .gap-3 { gap: 0.75rem; }
  .gap-4 { gap: 1rem; }
  .gap-y-2 { row-gap: 0.5rem; }
  .space-x-2 > :not(:first-child) { margin-left: 0.5rem; }
  .space-x-3 > :not(:first-child) { margin-left: 0.75rem; }
  .space-x-4 > :not(:first-child) { margin-left: 1rem; }
  .p-2 { padding: 0.5rem; }
  .p-4 { padding: 1rem; }
  .p-6 { padding: 1.5rem; }
  .p-12 { padding: 3rem; }
  .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
  .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
  .px-4 { padding-left: 1rem; padding-right: 1rem; }
  .px-8 { padding-left: 2rem; padding-right: 2rem; }
  .py-0\\.5 { padding-top: 0.125rem; padding-bottom: 0.125rem; }
  .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
  .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
  .py-4 { padding-top: 1rem; padding-bottom: 1rem; }
  .py-8 { padding-top: 2rem; padding-bottom: 2rem; }
  .pt-2 { padding-top: 0.5rem; }
  .mt-1 { margin-top: 0.25rem; }
  .mt-2 { margin-top: 0.5rem; }
  .mt-3 { margin-top: 0.75rem; }
  .mt-4 { margin-top: 1rem; }
  .mt-6 { margin-top: 1.5rem; }
  .mb-2 { margin-bottom: 0.5rem; }
  .mb-3 { margin-bottom: 0.75rem; }
  .mb-4 { margin-bottom: 1rem; }
  .mb-6 { margin-bottom: 1.5rem; }
  .mb-8 { margin-bottom: 2rem; }
  .ml-1 { margin-left: 0.25rem; }
  .ml-2 { margin-left: 0.5rem; }
  .mr-1 { margin-right: 0.25rem; }
  .mx-auto { margin-left: auto; margin-right: auto; }

  /* ── Sizing ────────────────────────────────────────────────── */
  .w-3 { width: 0.75rem; }
  .w-4 { width: 1rem; }
  .w-5 { width: 1.25rem; }
  .w-6 { width: 1.5rem; }
  .w-10 { width: 2.5rem; }
  .w-11 { width: 2.75rem; }
  .w-12 { width: 3rem; }
  .w-16 { width: 4rem; }
  .w-full { width: 100%; }
  .h-2 { height: 0.5rem; }
  .h-3 { height: 0.75rem; }
  .h-4 { height: 1rem; }
  .h-5 { height: 1.25rem; }
  .h-6 { height: 1.5rem; }
  .h-8 { height: 2rem; }
  .h-10 { height: 2.5rem; }
  .h-16 { height: 4rem; }
  .h-64 { height: 16rem; }
  .h-full { height: 100%; }
  .min-h-screen { min-height: 100vh; }
  .min-h-\\[44px\\] { min-height: 44px; }
  .min-w-\\[44px\\] { min-width: 44px; }
  .max-w-7xl { max-width: 80rem; }

  /* ── Typography ────────────────────────────────────────────── */
  .text-xs { font-size: 0.75rem; line-height: 1rem; }
  .text-sm { font-size: 0.875rem; line-height: 1.25rem; }
  .text-lg { font-size: 1.125rem; line-height: 1.75rem; }
  .text-xl { font-size: 1.25rem; line-height: 1.75rem; }
  .text-2xl { font-size: 1.5rem; line-height: 2rem; }
  .text-4xl { font-size: 2.25rem; line-height: 2.5rem; }
  .font-medium { font-weight: 500; }
  .font-semibold { font-weight: 600; }
  .font-bold { font-weight: 700; }
  .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .text-center { text-align: center; }
  .text-left { text-align: left; }
  .text-right { text-align: right; }

  /* ── Colors ────────────────────────────────────────────────── */
  .text-white { color: #ffffff; }
  .text-gray-100 { color: #f3f4f6; }
  .text-gray-400 { color: #9ca3af; }
  .text-gray-500 { color: #6b7280; }
  .text-gray-600 { color: #4b5563; }
  .text-purple-400 { color: #c084fc; }
  .text-orange-400 { color: #fb923c; }
  .text-yellow-300 { color: #fde047; }
  .bg-white { background-color: #ffffff; }
  .bg-gray-600 { background-color: #4b5563; }
  .bg-green-600 { background-color: #16a34a; }
  .bg-green-900 { background-color: #14532d; }
  .bg-yellow-900 { background-color: #713f12; }
  .border { border-width: 1px; border-style: solid; border-color: #e5e7eb; }
  .border-b { border-bottom-width: 1px; border-bottom-style: solid; border-color: #e5e7eb; }
  .border-t { border-top-width: 1px; border-top-style: solid; border-color: #e5e7eb; }
  .border-green-700 { border-color: #15803d; }
  .border-yellow-700 { border-color: #a16207; }

  /* ── Rounded ───────────────────────────────────────────────── */
  .rounded-sm { border-radius: 0.125rem; }
  .rounded-lg { border-radius: 0.5rem; }
  .rounded-full { border-radius: 9999px; }

  /* ── Opacity ───────────────────────────────────────────────── */
  .opacity-50 { opacity: 0.5; }

  /* ── Transforms ────────────────────────────────────────────── */
  .transform { transform: var(--tw-transform); }
  .translate-x-1 { transform: translateX(0.25rem); }
  .translate-x-6 { transform: translateX(1.5rem); }
  .transition-colors { transition-property: color, background-color, border-color; transition-duration: 150ms; }
  .transition-transform { transition-property: transform; transition-duration: 150ms; }

  /* ── Interactive ───────────────────────────────────────────── */
  .hover\\:text-white:hover { color: #ffffff; }

  /* ── Responsive ────────────────────────────────────────────── */
  @media (min-width: 640px) {
    .sm\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .sm\\:px-6 { padding-left: 1.5rem; padding-right: 1.5rem; }
    .sm\\:py-8 { padding-top: 2rem; padding-bottom: 2rem; }
  }
  @media (min-width: 768px) {
    .md\\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .md\\:grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .lg\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .lg\\:px-8 { padding-left: 2rem; padding-right: 2rem; }
  }

  /* ── Token colors ──────────────────────────────────────────── */
  .token-STX { color: ${colors.tokens.STX}; }
  .token-sBTC { color: ${colors.tokens.sBTC}; }
  .token-USDCx { color: ${colors.tokens.USDCx}; }
  .bg-token-STX { background-color: ${colors.tokens.STX}; }
  .bg-token-sBTC { background-color: ${colors.tokens.sBTC}; }
  .bg-token-USDCx { background-color: ${colors.tokens.USDCx}; }

  /* ── Status colors ─────────────────────────────────────────── */
  .status-healthy { color: ${colors.status.healthy}; }
  .status-degraded { color: ${colors.status.degraded}; }
  .status-down { color: ${colors.status.down}; }
  .status-unknown { color: ${colors.status.unknown}; }

  /* ── Trend colors ──────────────────────────────────────────── */
  .trend-up { color: ${colors.trend.up}; }
  .trend-down { color: ${colors.trend.down}; }
  .trend-stable { color: ${colors.trend.stable}; }

  /* ── Brand animations ──────────────────────────────────────── */
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-float { animation: float 3s ease-in-out infinite; }
  .animate-fade-up { animation: fadeUp 0.4s ease-out; }

  /* ── Brand card styles ─────────────────────────────────────── */
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

  /* Brand CTA button */
  .brand-cta-button { background-color: ${colors.brand.orange}; }
  .brand-cta-button:hover { background-color: #e64500; }

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
 * HTML entity map for escapeHtml (hoisted to module scope to avoid
 * re-allocating the object on every call)
 */
const HTML_ENTITY_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ENTITY_MAP[char]);
}

/**
 * Format a number with locale-aware separators
 */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Format a token amount for display in micro-units
 *
 * Returns the raw integer value with locale-aware thousands separators
 * and the appropriate micro-unit suffix:
 *   STX   → "56,500 μSTX"
 *   sBTC  → "12,300 sats"
 *   USDCx → "1,000,000 μUSDCx"
 */
export function formatTokenAmount(amount: string, token: string): string {
  const value = BigInt(amount);
  const formatted = value.toLocaleString("en-US");

  switch (token) {
    case "STX":
      return `${formatted} μSTX`;
    case "sBTC":
      return `${formatted} sats`;
    case "USDCx":
      return `${formatted} μUSDCx`;
    default:
      return amount;
  }
}
