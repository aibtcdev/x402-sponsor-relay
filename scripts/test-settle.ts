/**
 * Test script for the x402 V2 facilitator endpoints: /settle, /verify, /supported
 *
 * Usage (recommended - use .env file):
 *   npm run test:settle [relay-url]
 *
 * Environment variables (in .env):
 *   AGENT_MNEMONIC      24-word mnemonic phrase (recommended)
 *   AGENT_ACCOUNT_INDEX Account index to derive (default: 0)
 *   AGENT_PRIVATE_KEY   Hex-encoded private key (alternative to mnemonic)
 *   RELAY_URL           Relay endpoint URL (optional)
 *   TEST_RECIPIENT      Recipient address (default: AIBTC testnet server)
 *
 * Argument handling:
 *   - If AGENT_MNEMONIC or AGENT_PRIVATE_KEY is set: args[0] = relay URL (optional)
 *   - If neither is set: args[0] = private key, args[1] = relay URL (legacy)
 *
 * What this tests:
 *   1. GET  /supported    — relay's supported payment kinds
 *   2. POST /verify       — local validation only (no broadcast)
 *   3. POST /settle       — verify + broadcast (idempotent)
 *   4. Error cases        — wrong network, missing fields
 *
 * Note: POST /settle expects a pre-signed sponsored transaction. This script
 * builds a sponsored tx (sponsored: true) and sends it to /settle. In a real
 * x402 flow, the client builds this tx after seeing a 402 response from a server.
 *
 * Spec reference:
 *   https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
 *
 * Examples:
 *   # Recommended: Set AGENT_MNEMONIC in .env
 *   npm run test:settle
 *
 *   # Override relay URL via argument
 *   npm run test:settle -- https://x402-relay.aibtc.dev
 */

import {
  makeSTXTokenTransfer,
  getAddressFromPrivateKey,
  TransactionVersion,
  AnchorMode,
} from "@stacks/transactions";
import {
  generateNewAccount,
  generateWallet,
  getStxAddress,
} from "@stacks/wallet-sdk";
import type {
  X402SettleRequestV2,
  X402SettlementResponseV2,
  X402VerifyRequestV2,
  X402VerifyResponseV2,
  X402SupportedResponseV2,
} from "../src/types";

// AIBTC server addresses for test transactions
const AIBTC_TESTNET = "ST37NMC4HGFQ1H2JSFP4H3TMNQBF4PY0MVSD1GV7Z"; // x402.aibtc.dev

// CAIP-2 network identifier for testnet
const TESTNET_NETWORK = "stacks:2147483648";
const MAINNET_NETWORK = "stacks:1";

/**
 * Derive a child account from a mnemonic phrase
 */
async function deriveChildAccount(mnemonic: string, index: number) {
  if (index < 0) {
    throw new Error(`Account index must be non-negative, got ${index}`);
  }

  const wallet = await generateWallet({
    secretKey: mnemonic,
    password: "",
  });

  // Only generate accounts up to the needed index
  const currentCount = wallet.accounts.length;
  for (let i = currentCount; i <= index; i++) {
    generateNewAccount(wallet);
  }

  const account = wallet.accounts[index];
  if (!account) {
    throw new Error(`Failed to derive account at index ${index}`);
  }

  return {
    address: getStxAddress({
      account,
      network: "testnet",
    }),
    key: account.stxPrivateKey,
  };
}

/**
 * Print a section header
 */
function section(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

async function main() {
  const args = process.argv.slice(2);

  // Handle arg positions based on whether credentials are in env
  const hasEnvCredentials = !!(
    process.env.AGENT_MNEMONIC || process.env.AGENT_PRIVATE_KEY
  );
  const relayArg = hasEnvCredentials ? args[0] : args[1];
  const relayUrl = process.env.RELAY_URL || relayArg || "http://localhost:8787";

  // Derive credentials from mnemonic or use private key directly
  let privateKey: string;
  let senderAddress: string;

  if (process.env.AGENT_MNEMONIC) {
    const accountIndex = parseInt(process.env.AGENT_ACCOUNT_INDEX || "0", 10);
    console.log(`Deriving account ${accountIndex} from mnemonic...`);
    const account = await deriveChildAccount(
      process.env.AGENT_MNEMONIC,
      accountIndex
    );
    privateKey = account.key;
    senderAddress = account.address;
  } else if (process.env.AGENT_PRIVATE_KEY) {
    privateKey = process.env.AGENT_PRIVATE_KEY;
    senderAddress = getAddressFromPrivateKey(
      privateKey,
      TransactionVersion.Testnet
    );
  } else if (args[0]) {
    // Legacy: private key as first argument
    privateKey = args[0];
    senderAddress = getAddressFromPrivateKey(
      privateKey,
      TransactionVersion.Testnet
    );
  } else {
    console.error("Error: No credentials provided");
    console.error("");
    console.error("Copy .env.example to .env and fill in your credentials:");
    console.error("  cp .env.example .env");
    console.error("  # Edit .env with your AGENT_MNEMONIC or AGENT_PRIVATE_KEY");
    console.error("  npm run test:settle");
    process.exit(1);
  }

  console.log(`Relay URL: ${relayUrl}`);
  console.log(`Sender address: ${senderAddress}`);

  const recipient = process.env.TEST_RECIPIENT || AIBTC_TESTNET;
  console.log(`Recipient address: ${recipient}`);

  // Build a standard (non-sponsored) STX transfer — /settle does NOT sponsor
  console.log("\nBuilding standard transaction...");
  const transaction = await makeSTXTokenTransfer({
    recipient,
    amount: 1000n, // 0.001 STX in microSTX
    senderKey: privateKey,
    network: "testnet",
    memo: "test-settle",
    anchorMode: AnchorMode.Any,
    sponsored: false,
    fee: 1000n, // Sender pays their own fee
  });

  // Serialize to hex (v7: serialize() returns hex string directly)
  const txHex = transaction.serialize();
  console.log(`Transaction hex: ${txHex.slice(0, 50)}...`);
  console.log(`Transaction length: ${txHex.length} chars`);

  // Build the V2 payment requirements
  const paymentRequirements = {
    scheme: "exact",
    network: TESTNET_NETWORK,
    amount: "1000", // Same as amount we're sending
    asset: "STX",
    payTo: recipient,
    maxTimeoutSeconds: 60,
  };

  // Build the V2 payment payload
  const paymentPayload = {
    x402Version: 2,
    payload: {
      transaction: txHex,
    },
    accepted: paymentRequirements,
  };

  // =========================================================================
  // Test 1: GET /supported
  // =========================================================================
  section("Test 1: GET /supported");
  console.log(`GET ${relayUrl}/supported`);

  try {
    const response = await fetch(`${relayUrl}/supported`);
    const result = (await response.json()) as X402SupportedResponseV2;

    if (response.ok) {
      console.log("\n--- SUCCESS ---");
      console.log(`HTTP Status: ${response.status}`);
      console.log(`Supported kinds: ${result.kinds.length}`);
      for (const kind of result.kinds) {
        console.log(`  - x402Version: ${kind.x402Version}, scheme: ${kind.scheme}, network: ${kind.network}`);
      }
      console.log(`Extensions: [${result.extensions.join(", ") || "none"}]`);
      console.log(`Signers: ${JSON.stringify(result.signers)}`);

      // Validate the response has testnet network
      const supportsTestnet = result.kinds.some(
        (k) => k.network === TESTNET_NETWORK
      );
      if (supportsTestnet) {
        console.log(`\n[OK] Relay supports testnet (${TESTNET_NETWORK})`);
      } else {
        console.warn(
          `\n[WARN] Relay does not list testnet network. May be running mainnet config.`
        );
        console.warn(
          `  Available networks: ${result.kinds.map((k) => k.network).join(", ")}`
        );
      }
    } else {
      console.error(`\n--- ERROR ---`);
      console.error(`HTTP Status: ${response.status}`);
      console.error(`Result: ${JSON.stringify(result, null, 2)}`);
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Test 2: POST /verify (local validation, no broadcast)
  // =========================================================================
  section("Test 2: POST /verify (local validation)");

  const verifyRequest: X402VerifyRequestV2 = {
    paymentPayload,
    paymentRequirements,
  };

  console.log(`POST ${relayUrl}/verify`);
  console.log(`Network: ${TESTNET_NETWORK}`);
  console.log(`Amount: ${paymentRequirements.amount} microSTX`);
  console.log(`Asset: ${paymentRequirements.asset}`);
  console.log(`PayTo: ${paymentRequirements.payTo}`);

  try {
    const response = await fetch(`${relayUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyRequest),
    });

    const result = (await response.json()) as X402VerifyResponseV2;

    console.log(`\n--- RESULT (HTTP ${response.status}) ---`);
    console.log(`isValid: ${result.isValid}`);
    if (result.payer) {
      console.log(`payer: ${result.payer}`);
    }
    if (result.invalidReason) {
      console.log(`invalidReason: ${result.invalidReason}`);
    }

    if (result.isValid) {
      console.log(`\n[OK] Payment verified locally`);
    } else {
      console.log(`\n[INFO] Verification failed: ${result.invalidReason}`);
      console.log(`  This may be expected if the relay is on mainnet (wrong network).`);
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Test 3: POST /settle (verify + broadcast)
  // =========================================================================
  section("Test 3: POST /settle (verify + broadcast)");

  const settleRequest: X402SettleRequestV2 = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  };

  console.log(`POST ${relayUrl}/settle`);
  console.log(`Network: ${TESTNET_NETWORK}`);
  console.log(`Amount: ${paymentRequirements.amount} microSTX`);
  console.log(`Asset: ${paymentRequirements.asset}`);
  console.log(`PayTo: ${paymentRequirements.payTo}`);
  console.log(`(This will broadcast the transaction if valid)`);

  try {
    const response = await fetch(`${relayUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settleRequest),
    });

    const result = (await response.json()) as X402SettlementResponseV2;

    console.log(`\n--- RESULT (HTTP ${response.status}) ---`);
    console.log(`success: ${result.success}`);
    console.log(`network: ${result.network}`);
    console.log(`transaction: ${result.transaction || "(empty)"}`);
    if (result.payer) {
      console.log(`payer: ${result.payer}`);
    }
    if (result.errorReason) {
      console.log(`errorReason: ${result.errorReason}`);
    }

    if (result.success && result.transaction) {
      console.log(`\n[OK] Settlement succeeded`);
      console.log(
        `Explorer: https://explorer.hiro.so/txid/${result.transaction}?chain=testnet`
      );
    } else if (!result.success) {
      console.log(`\n[INFO] Settlement failed: ${result.errorReason}`);
      console.log(`  This may be expected if the relay is on mainnet (wrong network).`);
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Test 4: POST /verify with wrong network (error case)
  // =========================================================================
  section("Test 4: Error Case — Wrong Network");

  const wrongNetworkRequest: X402VerifyRequestV2 = {
    paymentPayload,
    paymentRequirements: {
      ...paymentRequirements,
      network: MAINNET_NETWORK, // Wrong — using mainnet on testnet relay
    },
  };

  console.log(`POST ${relayUrl}/verify`);
  console.log(`Network: ${MAINNET_NETWORK} (wrong — relay expects testnet)`);

  try {
    const response = await fetch(`${relayUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wrongNetworkRequest),
    });

    const result = (await response.json()) as X402VerifyResponseV2;

    console.log(`\n--- RESULT (HTTP ${response.status}) ---`);
    console.log(`isValid: ${result.isValid}`);
    if (result.invalidReason) {
      console.log(`invalidReason: ${result.invalidReason}`);
    }

    if (!result.isValid && result.invalidReason === "invalid_network") {
      console.log(`\n[OK] Correct error: invalid_network returned for wrong network`);
    } else if (!result.isValid) {
      // May be a different error if relay is actually mainnet
      console.log(`\n[INFO] Got error: ${result.invalidReason}`);
    } else {
      console.warn(`\n[WARN] Expected isValid: false for wrong network, got isValid: true`);
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Test 5: POST /verify with missing fields (error case)
  // =========================================================================
  section("Test 5: Error Case — Missing Required Fields");

  console.log(`POST ${relayUrl}/verify`);
  console.log(`(Sending empty body — should return invalid_payload)`);

  try {
    const response = await fetch(`${relayUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const result = (await response.json()) as X402VerifyResponseV2;

    console.log(`\n--- RESULT (HTTP ${response.status}) ---`);
    console.log(`isValid: ${result.isValid}`);
    if (result.invalidReason) {
      console.log(`invalidReason: ${result.invalidReason}`);
    }

    if (!result.isValid && result.invalidReason === "invalid_payload") {
      console.log(`\n[OK] Correct error: invalid_payload returned for empty body`);
    } else {
      console.warn(`\n[WARN] Expected invalid_payload, got: ${result.invalidReason}`);
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Summary
  // =========================================================================
  section("Test Summary");
  console.log(`Relay: ${relayUrl}`);
  console.log(`Spec: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md`);
  console.log(`Topic docs: ${relayUrl}/topics/x402-v2-facilitator`);
  console.log(`\nAll tests complete. Check results above for [OK]/[INFO]/[WARN] markers.`);
}

main();
