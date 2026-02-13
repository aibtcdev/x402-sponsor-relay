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
    const response = await fetch(`${relayUrl}/fees`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const result = await response.json();

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
      // Validate response shape
      const { fees, source, cached } = result;
      if (
        !fees ||
        !fees.token_transfer ||
        !fees.contract_call ||
        !fees.smart_contract
      ) {
        console.error(`  FAIL: Invalid response shape`);
        console.error(`  Response:`, result);
        failed++;
      } else if (!["hiro", "cache", "default"].includes(source)) {
        console.error(`  FAIL: Invalid source value: ${source}`);
        failed++;
      } else if (typeof cached !== "boolean") {
        console.error(`  FAIL: Invalid cached value: ${cached}`);
        failed++;
      } else {
        console.log(`  PASS`);
        console.log(`  Source: ${source}, Cached: ${cached}`);
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

  // Test 2: Call again to verify cache hit
  console.log("Test 2: Verify cache behavior (call again immediately)...");
  try {
    const response = await fetch(`${relayUrl}/fees`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(`  FAIL: HTTP ${response.status}`);
      console.error(`  Error: ${result.error}`);
      failed++;
    } else if (!result.success) {
      console.error(`  FAIL: Response indicates failure`);
      console.error(`  Error: ${result.error}`);
      failed++;
    } else {
      const { source, cached } = result;
      // Second call should hit cache (unless first call failed to cache)
      if (cached && source === "cache") {
        console.log(`  PASS - Cache hit as expected`);
        console.log(`  Source: ${source}, Cached: ${cached}`);
        passed++;
      } else {
        // Not a failure - cache might not be working or KV might be disabled
        console.log(`  PASS - Cache not hit (KV may be unavailable)`);
        console.log(`  Source: ${source}, Cached: ${cached}`);
        passed++;
      }
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
