/**
 * Test script for SIP-018 authentication on /sponsor and /relay endpoints
 *
 * Usage (recommended - use .env file):
 *   npm run test:sip018-auth [relay-url]
 *
 * Environment variables (in .env):
 *   AGENT_MNEMONIC      24-word mnemonic phrase (required)
 *   AGENT_ACCOUNT_INDEX Account index to derive (default: 0)
 *   AGENT_PRIVATE_KEY   Hex-encoded private key (alternative to mnemonic)
 *   TEST_API_KEY        API key for /sponsor endpoint (required)
 *   RELAY_URL           Relay endpoint URL (optional)
 *
 * Examples:
 *   # Set TEST_API_KEY and AGENT_MNEMONIC in .env
 *   npm run test:sip018-auth
 *
 *   # Override relay URL via argument
 *   npm run test:sip018-auth -- https://x402-relay.aibtc.dev
 */

import {
  makeSTXTokenTransfer,
  getAddressFromPrivateKey,
  TransactionVersion,
  AnchorMode,
  tupleCV,
  uintCV,
  stringAsciiCV,
  encodeStructuredDataBytes,
} from "@stacks/transactions";
import {
  generateNewAccount,
  generateWallet,
  getStxAddress,
} from "@stacks/wallet-sdk";
import { signMessageHashRsv } from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";
import { sha256 } from "@noble/hashes/sha256";

// AIBTC server addresses for test transactions
const AIBTC_TESTNET = "ST37NMC4HGFQ1H2JSFP4H3TMNQBF4PY0MVSD1GV7Z"; // x402.aibtc.dev

/**
 * SIP-018 domain constants for x402-sponsor-relay
 * Must match constants in src/types.ts
 */
const SIP018_DOMAIN = {
  /** Mainnet domain: chain-id u1 */
  mainnet: {
    name: "x402-sponsor-relay",
    version: "1",
    chainId: 1,
  },
  /** Testnet domain: chain-id u2147483648 */
  testnet: {
    name: "x402-sponsor-relay",
    version: "1",
    chainId: 2147483648,
  },
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
 * Create a SIP-018 structured data signature
 *
 * @param action - Action being performed ("relay" or "sponsor")
 * @param privateKey - Stacks private key (hex string)
 * @param network - Network ("mainnet" or "testnet")
 * @returns Signature and message for SIP-018 auth
 */
function createSip018Auth(
  action: "relay" | "sponsor",
  privateKey: string,
  network: "mainnet" | "testnet" = "testnet"
) {
  // Create message structure
  const nonce = Date.now().toString();
  const expiry = (Date.now() + 5 * 60 * 1000).toString(); // 5 minutes from now

  const message = {
    action,
    nonce,
    expiry,
  };

  // Get domain for network
  const domain = SIP018_DOMAIN[network];

  // Encode domain as ClarityValue
  const domainCV = tupleCV({
    name: stringAsciiCV(domain.name),
    version: stringAsciiCV(domain.version),
    "chain-id": uintCV(domain.chainId),
  });

  // Encode message as ClarityValue
  const messageCV = tupleCV({
    action: stringAsciiCV(action),
    nonce: uintCV(BigInt(nonce)),
    expiry: uintCV(BigInt(expiry)),
  });

  // Encode structured data according to SIP-018
  const encodedBytes = encodeStructuredDataBytes({
    message: messageCV,
    domain: domainCV,
  });

  // Hash the encoded bytes
  const hash = sha256(encodedBytes);
  const hashHex = bytesToHex(hash);

  // Sign the hash
  const signature = signMessageHashRsv({
    messageHash: hashHex,
    privateKey,
  });

  return {
    signature: signature.data,
    message,
  };
}

/**
 * Test /sponsor endpoint with SIP-018 authentication
 */
async function testSponsorWithAuth(
  relayUrl: string,
  apiKey: string,
  senderAddress: string,
  privateKey: string
) {
  console.log("\n=== Testing /sponsor with SIP-018 Auth ===");
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
    memo: "test-sip018-sponsor",
    anchorMode: AnchorMode.Any,
    sponsored: true,
    fee: 0n, // Sponsor will pay
  });

  // Serialize to hex
  const txHex = transaction.serialize();
  console.log(`Transaction hex: ${txHex.slice(0, 50)}...`);

  // Create SIP-018 auth
  console.log("\nCreating SIP-018 authentication...");
  const auth = createSip018Auth("sponsor", privateKey, "testnet");
  console.log(`Action: ${auth.message.action}`);
  console.log(`Nonce: ${auth.message.nonce}`);
  console.log(`Expiry: ${auth.message.expiry}`);
  console.log(`Signature: ${auth.signature.slice(0, 50)}...`);

  // Build request body with SIP-018 auth
  const requestBody = {
    transaction: txHex,
    auth,
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
      console.log("\nSIP-018 auth verified successfully!");
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

/**
 * Test /relay endpoint with SIP-018 authentication
 */
async function testRelayWithAuth(
  relayUrl: string,
  senderAddress: string,
  privateKey: string
) {
  console.log("\n=== Testing /relay with SIP-018 Auth ===");
  console.log(`Sender address: ${senderAddress}`);

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
    memo: "test-sip018-relay",
    anchorMode: AnchorMode.Any,
    sponsored: true,
    fee: 0n, // Sponsor will pay
  });

  // Serialize to hex
  const txHex = transaction.serialize();
  console.log(`Transaction hex: ${txHex.slice(0, 50)}...`);

  // Create SIP-018 auth
  console.log("\nCreating SIP-018 authentication...");
  const auth = createSip018Auth("relay", privateKey, "testnet");
  console.log(`Action: ${auth.message.action}`);
  console.log(`Nonce: ${auth.message.nonce}`);
  console.log(`Expiry: ${auth.message.expiry}`);
  console.log(`Signature: ${auth.signature.slice(0, 50)}...`);

  // Build request with settle options and SIP-018 auth
  const requestBody = {
    transaction: txHex,
    settle: {
      expectedRecipient: recipient,
      minAmount: "1000", // Same as amount we're sending
      tokenType: "STX" as const,
      expectedSender: senderAddress,
      resource: "/test",
      method: "POST",
    },
    auth,
  };

  // Send to relay endpoint
  console.log(`\nSending to relay endpoint: ${relayUrl}/relay`);
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
      console.log(`Explorer: https://explorer.hiro.so/txid/${result.txid}?chain=testnet`);
      console.log("\nSIP-018 auth verified successfully!");
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

  console.log("=== SIP-018 Authentication Test ===");
  console.log(`Relay URL: ${relayUrl}`);

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
    console.error("  npm run test:sip018-auth");
    process.exit(1);
  }

  // Test /sponsor endpoint with SIP-018 auth
  await testSponsorWithAuth(relayUrl, apiKey, senderAddress, privateKey);

  console.log("\n" + "=".repeat(60));

  // Test /relay endpoint with SIP-018 auth
  await testRelayWithAuth(relayUrl, senderAddress, privateKey);

  console.log("\n" + "=".repeat(60));
  console.log("Test completed successfully!");
}

main();
