/**
 * Test script for the /keys/provision-stx endpoint
 *
 * Usage (recommended - use .env file):
 *   npm run test:provision-stx [relay-url]
 *
 * Environment variables (in .env):
 *   AGENT_MNEMONIC      24-word mnemonic phrase (recommended)
 *   AGENT_ACCOUNT_INDEX Account index to derive (default: 0, used for Stacks key derivation)
 *   AGENT_PRIVATE_KEY   Hex-encoded private key (alternative to mnemonic)
 *   RELAY_URL           Relay endpoint URL (optional)
 *
 * Examples:
 *   # Set AGENT_MNEMONIC in .env
 *   npm run test:provision-stx
 *
 *   # Override relay URL via argument
 *   npm run test:provision-stx -- https://x402-relay.aibtc.dev
 *
 *   # Test both registration and self-service paths
 *   npm run test:provision-stx
 */

import {
  generateNewAccount,
  generateWallet,
  getStxAddress,
} from "@stacks/wallet-sdk";
import {
  getAddressFromPrivateKey,
  TransactionVersion,
} from "@stacks/transactions";
import { hashMessage, signMessageHashRsv } from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";

/**
 * Standard messages for STX signature verification
 */
const STX_MESSAGES = {
  /** Base message for registration path */
  BASE: "Bitcoin will be the currency of AIs",
  /** Format for self-service path with timestamp */
  SELF_SERVICE_PATTERN: /^Bitcoin will be the currency of AIs \| (.+)$/,
} as const;

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
 * Sign a message with a Stacks private key
 *
 * @param message - Message to sign
 * @param privateKey - Stacks private key (hex string)
 * @returns Hex-encoded RSV signature
 */
function signStxMessage(message: string, privateKey: string): string {
  const messageHash = hashMessage(message);
  const messageHashHex = bytesToHex(messageHash);
  const signature = signMessageHashRsv({
    messageHash: messageHashHex,
    privateKey,
  });
  return signature.data;
}

/**
 * Generate a self-service message with current timestamp
 *
 * @returns Message string ready for signing
 */
function generateSelfServiceMessage(): string {
  return `${STX_MESSAGES.BASE} | ${new Date().toISOString()}`;
}

/**
 * Test the /keys/provision-stx endpoint with both registration and self-service paths
 */
async function testProvision(
  relayUrl: string,
  stxAddress: string,
  privateKey: string,
  testBothPaths: boolean = true
) {
  console.log("\n=== Testing Registration Path ===");

  // Test 1: Registration path (bare message)
  const registrationMessage = STX_MESSAGES.BASE;
  const registrationSignature = signStxMessage(registrationMessage, privateKey);

  console.log(`Message: ${registrationMessage}`);
  console.log(`Signature: ${registrationSignature.slice(0, 50)}...`);

  const registrationBody = {
    stxAddress,
    signature: registrationSignature,
    message: registrationMessage,
  };

  try {
    const response = await fetch(`${relayUrl}/keys/provision-stx`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(registrationBody),
    });

    const result = await response.json();

    if (response.ok && result.success) {
      console.log("\n=== SUCCESS (Registration) ===");
      console.log(`Request ID: ${result.requestId}`);
      console.log(`API Key: ${result.apiKey}`);
      console.log("\nMetadata:");
      console.log(`  Key ID: ${result.metadata.keyId}`);
      console.log(`  App Name: ${result.metadata.appName}`);
      console.log(`  Contact Email: ${result.metadata.contactEmail}`);
      console.log(`  Tier: ${result.metadata.tier}`);
      console.log(`  Created At: ${result.metadata.createdAt}`);
      console.log(`  Expires At: ${result.metadata.expiresAt}`);
      console.log(`  Active: ${result.metadata.active}`);
      console.log(`  STX Address: ${result.metadata.stxAddress}`);

      console.log("\nIMPORTANT: Save this API key! It will not be shown again.");
      console.log(`Add to your .env file:`);
      console.log(`TEST_API_KEY=${result.apiKey}`);

      return result.apiKey;
    } else if (response.status === 409 && result.code === "ALREADY_PROVISIONED") {
      console.log("\n=== ALREADY PROVISIONED ===");
      console.log(`Status: ${response.status}`);
      console.log(`Code: ${result.code}`);
      console.log(`Error: ${result.error}`);
      console.log(`Retryable: ${result.retryable}`);

      if (!testBothPaths) {
        console.log(
          "\nThis STX address already has an API key. To test again, use a different mnemonic or account index."
        );
        return null;
      }

      console.log(
        "\nSTX address already provisioned (expected). Skipping self-service test since duplicate."
      );
      return null;
    } else {
      console.error("\n=== ERROR (Registration) ===");
      console.error(`Status: ${response.status}`);
      console.error(`Request ID: ${result.requestId || "N/A"}`);
      console.error(`Code: ${result.code || "UNKNOWN"}`);
      console.error(`Error: ${result.error}`);
      if (result.details) {
        console.error(`Details: ${result.details}`);
      }
      if (result.retryable !== undefined) {
        console.error(`Retryable: ${result.retryable}`);
      }
      process.exit(1);
    }
  } catch (e) {
    console.error("\n=== NETWORK ERROR (Registration) ===");
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  // If we successfully provisioned, don't test self-service (would be duplicate)
  // Self-service test would need a different STX address
}

/**
 * Test the self-service path (message with timestamp)
 * This requires a different STX address than the registration test
 */
async function testSelfService(
  relayUrl: string,
  stxAddress: string,
  privateKey: string
) {
  console.log("\n=== Testing Self-Service Path ===");
  console.log("NOTE: Using account index 1 to avoid duplicate STX address");

  const selfServiceMessage = generateSelfServiceMessage();
  const selfServiceSignature = signStxMessage(selfServiceMessage, privateKey);

  console.log(`Message: ${selfServiceMessage}`);
  console.log(`Signature: ${selfServiceSignature.slice(0, 50)}...`);

  const selfServiceBody = {
    stxAddress,
    signature: selfServiceSignature,
    message: selfServiceMessage,
  };

  try {
    const response = await fetch(`${relayUrl}/keys/provision-stx`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(selfServiceBody),
    });

    const result = await response.json();

    if (response.ok && result.success) {
      console.log("\n=== SUCCESS (Self-Service) ===");
      console.log(`Request ID: ${result.requestId}`);
      console.log(`API Key: ${result.apiKey}`);
      console.log("\nMetadata:");
      console.log(`  Key ID: ${result.metadata.keyId}`);
      console.log(`  App Name: ${result.metadata.appName}`);
      console.log(`  Tier: ${result.metadata.tier}`);
      console.log(`  STX Address: ${result.metadata.stxAddress}`);
    } else if (response.status === 409 && result.code === "ALREADY_PROVISIONED") {
      console.log("\n=== ALREADY PROVISIONED (Self-Service) ===");
      console.log(`Code: ${result.code}`);
      console.log(`Error: ${result.error}`);
      console.log(
        "\nThis STX address already has an API key. To test again, use a different account index."
      );
    } else {
      console.error("\n=== ERROR (Self-Service) ===");
      console.error(`Status: ${response.status}`);
      console.error(`Code: ${result.code || "UNKNOWN"}`);
      console.error(`Error: ${result.error}`);
    }
  } catch (e) {
    console.error("\n=== NETWORK ERROR (Self-Service) ===");
    console.error(e instanceof Error ? e.message : e);
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Handle arg positions based on whether credentials are in env
  const hasEnvCredentials = !!(
    process.env.AGENT_MNEMONIC || process.env.AGENT_PRIVATE_KEY
  );
  const relayArg = hasEnvCredentials ? args[0] : args[1];
  const relayUrl = process.env.RELAY_URL || relayArg || "http://localhost:8787";

  console.log("=== STX API Key Provisioning Test ===");
  console.log(`Relay URL: ${relayUrl}`);

  // Derive STX credentials from mnemonic or use private key directly
  let stxAddress: string;
  let privateKey: string;

  if (process.env.AGENT_MNEMONIC) {
    const accountIndex = parseInt(process.env.AGENT_ACCOUNT_INDEX || "0", 10);
    console.log(`Deriving STX key from mnemonic (account ${accountIndex})...`);

    const stxKey = await deriveChildAccount(process.env.AGENT_MNEMONIC, accountIndex);
    stxAddress = stxKey.address;
    privateKey = stxKey.key;

    console.log(`Derivation path: m/44'/5757'/0'/0/${accountIndex}`);
  } else if (process.env.AGENT_PRIVATE_KEY) {
    console.log("Deriving STX key from private key...");
    privateKey = process.env.AGENT_PRIVATE_KEY;
    stxAddress = getAddressFromPrivateKey(privateKey, TransactionVersion.Testnet);
  } else if (args[0] && !args[0].startsWith("http")) {
    // Legacy: private key as first argument
    console.log("Deriving STX key from private key argument...");
    privateKey = args[0];
    stxAddress = getAddressFromPrivateKey(privateKey, TransactionVersion.Testnet);
  } else {
    console.error("Error: No credentials provided");
    console.error("");
    console.error("Copy .env.example to .env and fill in your credentials:");
    console.error("  cp .env.example .env");
    console.error("  # Edit .env with your AGENT_MNEMONIC or AGENT_PRIVATE_KEY");
    console.error("  npm run test:provision-stx");
    process.exit(1);
  }

  console.log(`STX Address: ${stxAddress}`);

  // Test registration path first
  await testProvision(relayUrl, stxAddress, privateKey, false);

  // If mnemonic is available, test self-service path with account index 1
  if (process.env.AGENT_MNEMONIC) {
    console.log("\n" + "=".repeat(60));
    const stxKey2 = await deriveChildAccount(process.env.AGENT_MNEMONIC, 1);
    await testSelfService(relayUrl, stxKey2.address, stxKey2.key);
  } else {
    console.log(
      "\nSkipping self-service test (requires AGENT_MNEMONIC to derive second address)"
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("Test completed successfully!");
}

main();
