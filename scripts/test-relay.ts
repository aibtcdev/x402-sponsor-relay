/**
 * Test script for the sponsor relay endpoint
 *
 * Usage (recommended - use .env file):
 *   npm run test:relay [relay-url]
 *
 * Environment variables (in .env):
 *   AGENT_MNEMONIC      24-word mnemonic phrase (recommended)
 *   AGENT_ACCOUNT_INDEX Account index to derive (default: 0)
 *   AGENT_PRIVATE_KEY   Hex-encoded private key (alternative to mnemonic)
 *   RELAY_URL           Relay endpoint URL (optional)
 *
 * Argument handling:
 *   - If AGENT_MNEMONIC or AGENT_PRIVATE_KEY is set: args[0] = relay URL (optional)
 *   - If neither is set: args[0] = private key, args[1] = relay URL (legacy)
 *
 * Examples:
 *   # Recommended: Set AGENT_MNEMONIC in .env
 *   npm run test:relay
 *
 *   # Override relay URL via argument
 *   npm run test:relay -- https://x402-relay.aibtc.dev
 *
 *   # Use specific account index
 *   AGENT_ACCOUNT_INDEX=1 npm run test:relay
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

const TESTNET_FAUCET = "ST000000000000000000002AMW42H"; // Testnet faucet address

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

  // Handle arg positions based on whether credentials are in env
  const hasEnvCredentials = !!(process.env.AGENT_MNEMONIC || process.env.AGENT_PRIVATE_KEY);
  const relayArg = hasEnvCredentials ? args[0] : args[1];
  const relayUrl = process.env.RELAY_URL || relayArg || "http://localhost:8787";

  // Derive credentials from mnemonic or use private key directly
  let privateKey: string;
  let senderAddress: string;

  if (process.env.AGENT_MNEMONIC) {
    const accountIndex = parseInt(process.env.AGENT_ACCOUNT_INDEX || "0", 10);
    console.log(`Deriving account ${accountIndex} from mnemonic...`);
    const account = await deriveChildAccount(process.env.AGENT_MNEMONIC, accountIndex);
    privateKey = account.key;
    senderAddress = account.address;
  } else if (process.env.AGENT_PRIVATE_KEY) {
    privateKey = process.env.AGENT_PRIVATE_KEY;
    senderAddress = getAddressFromPrivateKey(privateKey, TransactionVersion.Testnet);
  } else if (args[0]) {
    // Legacy: private key as first argument
    privateKey = args[0];
    senderAddress = getAddressFromPrivateKey(privateKey, TransactionVersion.Testnet);
  } else {
    console.error("Error: No credentials provided");
    console.error("");
    console.error("Copy .env.example to .env and fill in your credentials:");
    console.error("  cp .env.example .env");
    console.error("  # Edit .env with your AGENT_MNEMONIC or AGENT_PRIVATE_KEY");
    console.error("  npm run test:relay");
    process.exit(1);
  }

  console.log(`Sender address: ${senderAddress}`);

  // Build a sponsored STX transfer (small amount to faucet)
  console.log("\nBuilding sponsored transaction...");
  const transaction = await makeSTXTokenTransfer({
    recipient: TESTNET_FAUCET,
    amount: 1000n, // 0.001 STX in microSTX
    senderKey: privateKey,
    network: "testnet",
    memo: "test-relay",
    anchorMode: AnchorMode.Any,
    sponsored: true,
    fee: 0n, // Sponsor will pay
  });

  // Serialize to hex
  const txHex = Buffer.from(transaction.serialize()).toString("hex");
  console.log(`Transaction hex: ${txHex.slice(0, 50)}...`);
  console.log(`Transaction length: ${txHex.length} chars`);

  // Build request with settle options
  const requestBody = {
    transaction: txHex,
    settle: {
      expectedRecipient: TESTNET_FAUCET,
      minAmount: "1000", // Same as amount we're sending
      tokenType: "STX" as const,
      expectedSender: senderAddress,
      resource: "/test",
      method: "POST",
    },
  };

  // Send to relay
  console.log(`\nSending to relay: ${relayUrl}/relay`);
  console.log(`Settlement options:`, JSON.stringify(requestBody.settle, null, 2));

  try {
    const response = await fetch(`${relayUrl}/relay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();

    if (response.ok) {
      console.log("\n=== SUCCESS ===");
      console.log(`Transaction ID: ${result.txid}`);
      console.log(`Explorer: https://explorer.stacks.co/txid/${result.txid}?chain=testnet`);
      if (result.settlement) {
        console.log("\n=== SETTLEMENT ===");
        console.log(`Status: ${result.settlement.status}`);
        console.log(`Success: ${result.settlement.success}`);
        console.log(`Sender: ${result.settlement.sender}`);
        console.log(`Recipient: ${result.settlement.recipient}`);
        console.log(`Amount: ${result.settlement.amount}`);
        if (result.settlement.blockHeight) {
          console.log(`Block Height: ${result.settlement.blockHeight}`);
        }
      }
    } else {
      console.error("\n=== ERROR ===");
      console.error(`Status: ${response.status}`);
      console.error(`Error: ${result.error}`);
      if (result.details) {
        console.error(`Details: ${result.details}`);
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
