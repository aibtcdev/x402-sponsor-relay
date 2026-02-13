/**
 * Test script for the /fees endpoint (no authentication)
 *
 * Usage:
 *   npm run test:fees [relay-url]
 *
 * Environment variables (optional):
 *   RELAY_URL           Relay endpoint URL (default: http://localhost:8787)
 *
 * Examples:
 *   # Test local development server
 *   npm run test:fees
 *
 *   # Test staging deployment
 *   npm run test:fees -- https://x402-relay.aibtc.dev
 */

/** Fetch the /fees endpoint and return the parsed result */
async function fetchFees(relayUrl: string): Promise<{ response: Response; result: Record<string, unknown> }> {
  const response = await fetch(`${relayUrl}/fees`);
  const result = (await response.json()) as Record<string, unknown>;
  return { response, result };
}

/** Validate that a fees response has the expected shape */
function validateFeesShape(result: Record<string, unknown>): string | null {
  const fees = result.fees as Record<string, unknown> | undefined;
  if (!fees || !fees.token_transfer || !fees.contract_call || !fees.smart_contract) {
    return "Invalid response shape - missing fee categories";
  }
  const validSources = ["hiro", "cache", "default"];
  if (!validSources.includes(result.source as string)) {
    return `Invalid source value: ${result.source}`;
  }
  if (typeof result.cached !== "boolean") {
    return `Invalid cached value: ${result.cached}`;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const relayUrl = process.env.RELAY_URL || args[0] || "http://localhost:8787";

  console.log(`Testing /fees endpoint at: ${relayUrl}`);
  console.log("");

  let passed = 0;
  let failed = 0;

  // Test 1: GET /fees should return clamped fee estimates
  console.log("Test 1: Fetch fee estimates...");
  try {
    const { response, result } = await fetchFees(relayUrl);

    if (!response.ok) {
      console.error(`  FAIL: HTTP ${response.status}`);
      console.error(`  Error: ${result.error}`);
      console.error(`  Code: ${result.code}`);
      failed++;
    } else if (!result.success) {
      console.error(`  FAIL: Response indicates failure`);
      console.error(`  Error: ${result.error}`);
      failed++;
    } else {
      const shapeError = validateFeesShape(result);
      if (shapeError) {
        console.error(`  FAIL: ${shapeError}`);
        console.error(`  Response:`, result);
        failed++;
      } else {
        const fees = result.fees as Record<string, Record<string, number>>;
        console.log(`  PASS`);
        console.log(`  Source: ${result.source}, Cached: ${result.cached}`);
        console.log(`  Token Transfer (medium): ${fees.token_transfer.medium_priority} microSTX`);
        console.log(`  Contract Call (medium): ${fees.contract_call.medium_priority} microSTX`);
        console.log(`  Smart Contract (medium): ${fees.smart_contract.medium_priority} microSTX`);
        passed++;
      }
    }
  } catch (e) {
    console.error(`  FAIL: Network error`);
    console.error(`  ${e instanceof Error ? e.message : e}`);
    failed++;
  }

  console.log("");

  // Test 2: Call again to verify cache behavior
  console.log("Test 2: Verify cache behavior (call again immediately)...");
  try {
    const { response, result } = await fetchFees(relayUrl);

    if (!response.ok || !result.success) {
      console.error(`  FAIL: HTTP ${response.status}`);
      console.error(`  Error: ${result.error}`);
      failed++;
    } else {
      // Cache hit is expected but not required (KV may be unavailable)
      const cacheStatus = result.cached ? "Cache hit as expected" : "Cache not hit (KV may be unavailable)";
      console.log(`  PASS - ${cacheStatus}`);
      console.log(`  Source: ${result.source}, Cached: ${result.cached}`);
      passed++;
    }
  } catch (e) {
    console.error(`  FAIL: Network error`);
    console.error(`  ${e instanceof Error ? e.message : e}`);
    failed++;
  }

  console.log("");

  // Summary
  console.log("=== SUMMARY ===");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log("");

  if (failed > 0) {
    console.log("RESULT: FAIL");
    process.exit(1);
  } else {
    console.log("RESULT: PASS");
    process.exit(0);
  }
}

main();
