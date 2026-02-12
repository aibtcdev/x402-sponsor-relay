/**
 * Test script for the /keys/provision endpoint
 *
 * Usage (recommended - use .env file):
 *   npm run test:provision [relay-url]
 *
 * Environment variables (in .env):
 *   AGENT_MNEMONIC      24-word mnemonic phrase (recommended)
 *   AGENT_ACCOUNT_INDEX Account index to derive (default: 0, used for BTC key derivation)
 *   AGENT_PRIVATE_KEY   Hex-encoded private key (alternative to mnemonic)
 *   RELAY_URL           Relay endpoint URL (optional)
 *
 * Examples:
 *   # Set AGENT_MNEMONIC in .env
 *   npm run test:provision
 *
 *   # Override relay URL via argument
 *   npm run test:provision -- https://x402-relay.aibtc.dev
 *
 *   # Test both registration and self-service paths
 *   npm run test:provision
 */

import * as bitcoinMessage from "bitcoinjs-message";
import * as bitcoin from "bitcoinjs-lib";
import * as bip39 from "bip39";
import { BIP32Factory } from "bip32";
import * as ecc from "tiny-secp256k1";

// Initialize BIP32 with secp256k1
const bip32 = BIP32Factory(ecc);

/**
 * Standard BIP-44 path for Bitcoin mainnet: m/44'/0'/0'/0/0
 * This matches the path used by most wallets for the first receiving address
 */
const BTC_DERIVATION_PATH = "m/44'/0'/0'/0/0";

/**
 * Standard messages for BTC signature verification
 */
const BTC_MESSAGES = {
  /** Base message for registration path */
  BASE: "Bitcoin will be the currency of AIs",
  /** Format for self-service path with timestamp */
  SELF_SERVICE_PATTERN: /^Bitcoin will be the currency of AIs \| (.+)$/,
} as const;

/**
 * Derive a Bitcoin key pair from a mnemonic phrase
 * Uses BIP-44 derivation path: m/44'/0'/0'/0/{index}
 *
 * @param mnemonic - 24-word mnemonic phrase
 * @param index - Account index (default: 0)
 * @returns Bitcoin address and private key
 */
function deriveBtcFromMnemonic(mnemonic: string, index: number = 0) {
  // Validate mnemonic
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("Invalid mnemonic phrase");
  }

  // Convert mnemonic to seed
  const seed = bip39.mnemonicToSeedSync(mnemonic);

  // Derive root key
  const root = bip32.fromSeed(seed);

  // Derive account key using BIP-44 path
  const path = `m/44'/0'/0'/0/${index}`;
  const child = root.derivePath(path);

  if (!child.privateKey) {
    throw new Error("Failed to derive private key");
  }

  // Get Bitcoin address (P2PKH - legacy format starting with '1')
  const { address } = bitcoin.payments.p2pkh({
    pubkey: child.publicKey,
    network: bitcoin.networks.bitcoin,
  });

  if (!address) {
    throw new Error("Failed to derive Bitcoin address");
  }

  return {
    address,
    privateKey: child.privateKey,
    publicKey: child.publicKey,
  };
}

/**
 * Derive a Bitcoin key pair from a hex private key
 * This is a fallback method when no mnemonic is available
 *
 * @param privateKeyHex - Hex-encoded private key
 * @returns Bitcoin address and private key
 */
function deriveBtcFromPrivateKey(privateKeyHex: string) {
  // Convert hex to buffer
  const privateKey = Buffer.from(privateKeyHex, "hex");

  // Create key pair
  const keyPair = bitcoin.ECPair.fromPrivateKey(privateKey, {
    network: bitcoin.networks.bitcoin,
  });

  // Get Bitcoin address (P2PKH - legacy format)
  const { address } = bitcoin.payments.p2pkh({
    pubkey: keyPair.publicKey,
    network: bitcoin.networks.bitcoin,
  });

  if (!address) {
    throw new Error("Failed to derive Bitcoin address from private key");
  }

  return {
    address,
    privateKey,
    publicKey: keyPair.publicKey,
  };
}

/**
 * Sign a message with a Bitcoin private key
 *
 * @param message - Message to sign
 * @param privateKey - Bitcoin private key buffer
 * @returns Base64-encoded signature
 */
function signBtcMessage(message: string, privateKey: Buffer): string {
  const keyPair = bitcoin.ECPair.fromPrivateKey(privateKey, {
    network: bitcoin.networks.bitcoin,
  });

  const signature = bitcoinMessage.sign(
    message,
    keyPair.privateKey!,
    keyPair.compressed
  );

  return signature.toString("base64");
}

/**
 * Generate a self-service message with current timestamp
 *
 * @returns Message string ready for signing
 */
function generateSelfServiceMessage(): string {
  return `${BTC_MESSAGES.BASE} | ${new Date().toISOString()}`;
}

/**
 * Test the /keys/provision endpoint with both registration and self-service paths
 */
async function testProvision(
  relayUrl: string,
  btcAddress: string,
  privateKey: Buffer,
  testBothPaths: boolean = true
) {
  console.log("\n=== Testing Registration Path ===");

  // Test 1: Registration path (bare message)
  const registrationMessage = BTC_MESSAGES.BASE;
  const registrationSignature = signBtcMessage(registrationMessage, privateKey);

  console.log(`Message: ${registrationMessage}`);
  console.log(`Signature: ${registrationSignature.slice(0, 50)}...`);

  const registrationBody = {
    btcAddress,
    signature: registrationSignature,
    message: registrationMessage,
  };

  try {
    const response = await fetch(`${relayUrl}/keys/provision`, {
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
      console.log(`  BTC Address: ${result.metadata.btcAddress}`);

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
          "\nThis BTC address already has an API key. To test again, use a different mnemonic or account index."
        );
        return null;
      }

      console.log(
        "\nBTC address already provisioned (expected). Skipping self-service test since duplicate."
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
  // Self-service test would need a different BTC address
}

/**
 * Test the self-service path (message with timestamp)
 * This requires a different BTC address than the registration test
 */
async function testSelfService(
  relayUrl: string,
  btcAddress: string,
  privateKey: Buffer
) {
  console.log("\n=== Testing Self-Service Path ===");
  console.log("NOTE: Using account index 1 to avoid duplicate BTC address");

  const selfServiceMessage = generateSelfServiceMessage();
  const selfServiceSignature = signBtcMessage(selfServiceMessage, privateKey);

  console.log(`Message: ${selfServiceMessage}`);
  console.log(`Signature: ${selfServiceSignature.slice(0, 50)}...`);

  const selfServiceBody = {
    btcAddress,
    signature: selfServiceSignature,
    message: selfServiceMessage,
  };

  try {
    const response = await fetch(`${relayUrl}/keys/provision`, {
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
      console.log(`  BTC Address: ${result.metadata.btcAddress}`);
    } else if (response.status === 409 && result.code === "ALREADY_PROVISIONED") {
      console.log("\n=== ALREADY PROVISIONED (Self-Service) ===");
      console.log(`Code: ${result.code}`);
      console.log(`Error: ${result.error}`);
      console.log(
        "\nThis BTC address already has an API key. To test again, use a different account index."
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

  console.log("=== BTC API Key Provisioning Test ===");
  console.log(`Relay URL: ${relayUrl}`);

  // Derive BTC credentials from mnemonic or use private key directly
  let btcAddress: string;
  let privateKey: Buffer;

  if (process.env.AGENT_MNEMONIC) {
    const accountIndex = parseInt(process.env.AGENT_ACCOUNT_INDEX || "0", 10);
    console.log(`Deriving BTC key from mnemonic (account ${accountIndex})...`);

    const btcKey = deriveBtcFromMnemonic(process.env.AGENT_MNEMONIC, accountIndex);
    btcAddress = btcKey.address;
    privateKey = btcKey.privateKey;

    console.log(`Derivation path: m/44'/0'/0'/0/${accountIndex}`);
  } else if (process.env.AGENT_PRIVATE_KEY) {
    console.log("Deriving BTC key from private key...");
    const btcKey = deriveBtcFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
    btcAddress = btcKey.address;
    privateKey = btcKey.privateKey;
  } else if (args[0] && !args[0].startsWith("http")) {
    // Legacy: private key as first argument
    console.log("Deriving BTC key from private key argument...");
    const btcKey = deriveBtcFromPrivateKey(args[0]);
    btcAddress = btcKey.address;
    privateKey = btcKey.privateKey;
  } else {
    console.error("Error: No credentials provided");
    console.error("");
    console.error("Copy .env.example to .env and fill in your credentials:");
    console.error("  cp .env.example .env");
    console.error("  # Edit .env with your AGENT_MNEMONIC or AGENT_PRIVATE_KEY");
    console.error("  npm run test:provision");
    process.exit(1);
  }

  console.log(`BTC Address: ${btcAddress}`);

  // Test registration path first
  await testProvision(relayUrl, btcAddress, privateKey, false);

  // If mnemonic is available, test self-service path with account index 1
  if (process.env.AGENT_MNEMONIC) {
    console.log("\n" + "=".repeat(60));
    const btcKey2 = deriveBtcFromMnemonic(process.env.AGENT_MNEMONIC, 1);
    await testSelfService(relayUrl, btcKey2.address, btcKey2.privateKey);
  } else {
    console.log(
      "\nSkipping self-service test (requires AGENT_MNEMONIC to derive second address)"
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("Test completed successfully!");
}

main();
