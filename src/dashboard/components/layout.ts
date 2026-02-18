import { dashboardCss, escapeHtml } from "../styles";
import { VERSION } from "../../version";

/**
 * Generate full HTML document wrapper
 */
export function htmlDocument(content: string, title: string, options?: { includeChartJs?: boolean }): string {
  const chartJsTag = options?.includeChartJs
    ? `\n  <script defer src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js" integrity="sha384-vsrfeLOOY6KuIYKDlmVH5UiBmgIdB1oEf7p01YgWHuqmOHfZr374+odEv96n9tNC" crossorigin="anonymous"></script>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/png" sizes="32x32" href="https://aibtc.com/favicon-32x32.png">
  <link rel="preconnect" href="https://aibtc.com" crossorigin>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.8/dist/cdn.min.js" integrity="sha384-X9kJyAubVxnP0hcA+AMMs21U445qsnqhnUF8EBlEpP3a42Kh/JwWjlv2ZcvGfphb" crossorigin="anonymous"></script>${chartJsTag}
  <style>
    ${dashboardCss}
    [x-cloak] { display: none !important; }
  </style>
</head>
<body class="text-gray-100 min-h-screen">
  ${content}
</body>
</html>`;
}

/**
 * Dashboard header component
 * @param network - Optional network indicator ("testnet" | "mainnet")
 */
export function header(network?: string): string {
  const networkBadge = network
    ? `<span class="ml-2 px-2 py-0.5 text-xs font-medium rounded-full ${
        network === "mainnet"
          ? "bg-green-900 text-green-300 border border-green-700"
          : "bg-yellow-900 text-yellow-300 border border-yellow-700"
      }">${escapeHtml(network)}</span>`
    : "";

  return `
<header class="brand-bar border-b">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
    <div class="flex items-center justify-between">
      <div class="flex-shrink-0 flex items-center space-x-3">
        <img src="https://aibtc.com/Primary_Logo/SVG/AIBTC_PrimaryLogo_KO.svg" alt="AIBTC" class="h-8" width="32" height="32">
        <div>
          <div class="flex items-center">
            <h1 class="text-xl font-bold text-white">x402 Sponsor Relay</h1>
            ${networkBadge}
          </div>
          <p class="text-sm text-gray-400">Dashboard</p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <a href="/docs"
           class="inline-flex items-center justify-center min-h-[44px] px-3 text-gray-400 hover:text-white transition-colors text-sm">
          API Docs
        </a>
        <a href="https://github.com/aibtcdev/x402-sponsor-relay"
           target="_blank" rel="noopener"
           class="inline-flex items-center justify-center min-h-[44px] min-w-[44px] text-gray-400 hover:text-white transition-colors">
          <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path fill-rule="evenodd" clip-rule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
          </svg>
        </a>
      </div>
    </div>
  </div>
</header>`;
}

/**
 * Dashboard footer component
 */
export function footer(lastUpdated: string): string {
  return `
<footer class="brand-bar border-t mt-6">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
    <div class="flex flex-wrap items-center justify-between gap-y-2 text-sm text-gray-400">
      <div class="flex items-center space-x-4">
        <span>v${VERSION}</span>
        <span class="text-gray-600">|</span>
        <span>Last updated: ${escapeHtml(lastUpdated)}</span>
      </div>
      <div x-data="{ autoRefresh: localStorage.getItem('dashboardAutoRefresh') !== 'false' }" class="flex items-center space-x-2">
        <span>Auto-refresh:</span>
        <button
          @click="autoRefresh = !autoRefresh; localStorage.setItem('dashboardAutoRefresh', autoRefresh.toString()); if(autoRefresh) location.reload()"
          :class="autoRefresh ? 'bg-green-600' : 'bg-gray-600'"
          class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors min-w-[44px] min-h-[44px]">
          <span
            :class="autoRefresh ? 'translate-x-6' : 'translate-x-1'"
            class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform">
          </span>
        </button>
      </div>
    </div>
  </div>
</footer>`;
}
