/**
 * One-time backfill script: migrate stats from KV to StatsDO
 *
 * Reads old stats:daily:*, stats:hourly:*, and tx:log:* keys from RELAY_KV
 * and imports them into the new StatsDO SQLite tables.
 *
 * Safe to run multiple times (uses INSERT OR REPLACE / INSERT OR IGNORE).
 *
 * Usage:
 *   npm run backfill                                    # staging (default)
 *   npm run backfill -- https://x402-relay.aibtc.com    # production
 *
 * Environment variables (in .env):
 *   TEST_API_KEY   API key with admin access (required)
 *   RELAY_URL      Relay endpoint URL (optional, default: staging)
 */

const DEFAULT_URL = "https://x402-relay.aibtc.dev";

async function main() {
  const apiKey = process.env.TEST_API_KEY;
  if (!apiKey) {
    console.error("ERROR: TEST_API_KEY not set in .env");
    process.exit(1);
  }

  const relayUrl = process.argv[2] || process.env.RELAY_URL || DEFAULT_URL;
  const url = `${relayUrl}/admin/backfill`;

  console.log(`Backfilling stats: ${url}`);
  console.log("Sending request (this may take a moment)...\n");

  const start = Date.now();

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: "{}",
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const body = await resp.json();

  if (!resp.ok) {
    console.error(`FAILED (${resp.status}): ${JSON.stringify(body, null, 2)}`);
    process.exit(1);
  }

  console.log(`Completed in ${elapsed}s\n`);
  console.log(JSON.stringify(body, null, 2));
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
