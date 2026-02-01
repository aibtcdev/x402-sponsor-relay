/**
 * Test script for the /sponsor endpoint (API key authenticated)
 *
 * Usage (recommended - use .env file):
 *   npm run test:sponsor [relay-url]
 *
 * Environment variables (in .env):
 *   AGENT_MNEMONIC      24-word mnemonic phrase (recommended)
 *   AGENT_ACCOUNT_INDEX Account index to derive (default: 0)
 *   AGENT_PRIVATE_KEY   Hex-encoded private key (alternative to mnemonic)
 *   TEST_API_KEY        API key for /sponsor endpoint (required)
 *   RELAY_URL           Relay endpoint URL (optional)
 *
 * Examples:
 *   # Set TEST_API_KEY and AGENT_MNEMONIC in .env
 *   npm run test:sponsor
 *
 *   # Override relay URL via argument
 *   npm run test:sponsor -- https://x402-relay.aibtc.dev
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

// AIBTC server addresses for test transactions
const AIBTC_TESTNET = "ST37NMC4HGFQ1H2JSFP4H3TMNQBF4PY0MVSD1GV7Z"; // x402.aibtc.dev

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

async function main() {
  const args = process.argv.slice(2);

  // Get API key from environment (required for /sponsor)
  const apiKey = process.env.TEST_API_KEY;
  if (!apiKey) {
    console.error("Error: TEST_API_KEY environment variable is required");
    console.error("");
    console.error("Set your API key in .env:");
    console.error("  TEST_API_KEY=x402_sk_test_...");
    console.error("");
    console.error("To obtain an API key, use the keys CLI:");
    console.error(
      '  WRANGLER_ENV=staging npm run keys -- create --app "My App" --email "email@example.com"'
    );
    process.exit(1);
  }

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
  } else if (args[0] && !args[0].startsWith("http")) {
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
    console.error("  npm run test:sponsor");
    process.exit(1);
  }

  console.log(`Sender address: ${senderAddress}`);
  console.log(`API Key: ${apiKey.slice(0, 20)}...`);

  // Use AIBTC server as recipient for testing
  const recipient = process.env.TEST_RECIPIENT || AIBTC_TESTNET;
  console.log(`Recipient address: ${recipient}`);

  // Build a sponsored STX transfer
  console.log("\nBuilding sponsored transaction...");
  const transaction = await makeSTXTokenTransfer({
    recipient,
    amount: 1000n, // 0.001 STX in microSTX
    senderKey: privateKey,
    network: "testnet",
    memo: "test-sponsor",
    anchorMode: AnchorMode.Any,
    sponsored: true,
    fee: 0n, // Sponsor will pay
  });

  // Serialize to hex (v7: serialize() returns hex string directly)
  const txHex = transaction.serialize();
  console.log(`Transaction hex: ${txHex.slice(0, 50)}...`);
  console.log(`Transaction length: ${txHex.length} chars`);

  // Build request body (simpler than /relay - no settle options)
  const requestBody = {
    transaction: txHex,
  };

  // Send to sponsor endpoint
  console.log(`\nSending to sponsor endpoint: ${relayUrl}/sponsor`);

  try {
    const response = await fetch(`${relayUrl}/sponsor`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();

    if (response.ok && result.success) {
      console.log("\n=== SUCCESS ===");
      console.log(`Request ID: ${result.requestId}`);
      console.log(`Transaction ID: ${result.txid}`);
      console.log(`Explorer: ${result.explorerUrl}`);
      console.log(`Sponsor Fee: ${result.fee} microSTX`);
    } else {
      console.error("\n=== ERROR ===");
      console.error(`Status: ${response.status}`);
      console.error(`Request ID: ${result.requestId || "N/A"}`);
      console.error(`Code: ${result.code || "UNKNOWN"}`);
      console.error(`Error: ${result.error}`);
      if (result.details) {
        console.error(`Details: ${result.details}`);
      }
      if (result.retryable) {
        console.error(`Retryable: ${result.retryable}`);
        if (result.retryAfter) {
          console.error(`Retry After: ${result.retryAfter} seconds`);
        }
      }
      process.exit(1);
    }
  } catch (e) {
    console.error("\n=== NETWORK ERROR ===");
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

main();
