/**
 * Test script for the /queue/:senderAddress and /queue/:senderAddress/:walletIndex/:sponsorNonce endpoints
 *
 * Usage (recommended - use .env file):
 *   npm run test:queue [relay-url]
 *
 * Environment variables (in .env):
 *   AGENT_MNEMONIC      24-word mnemonic phrase (required, or AGENT_PRIVATE_KEY)
 *   AGENT_ACCOUNT_INDEX Account index to derive (default: 0)
 *   AGENT_PRIVATE_KEY   Hex-encoded private key (alternative to mnemonic)
 *   RELAY_URL           Relay endpoint URL (optional)
 *
 * Flags:
 *   --cancel            Also test DELETE /queue/:address/:walletIndex/:sponsorNonce
 *                       with walletIndex=0 and sponsorNonce=0 (expected: 404 NOT_FOUND)
 *
 * Examples:
 *   npm run test:queue
 *   npm run test:queue -- https://x402-relay.aibtc.dev
 *   npm run test:queue -- --cancel
 */

import {
  getAddressFromPrivateKey,
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

/**
 * SIP-018 domain constants for x402-sponsor-relay
 * Must match constants in src/types.ts
 */
const SIP018_DOMAIN = {
  mainnet: { name: "x402-sponsor-relay", version: "1", chainId: 1 },
  testnet: { name: "x402-sponsor-relay", version: "1", chainId: 2147483648 },
} as const;

/**
 * Create a SIP-018 structured data signature for queue endpoints.
 */
function createQueueAuth(
  action: "queue-read" | "queue-cancel",
  privateKey: string,
  network: "mainnet" | "testnet" = "testnet"
) {
  const nonce = Date.now().toString();
  const expiry = (Date.now() + 5 * 60 * 1000).toString(); // 5 minutes

  const message = { action, nonce, expiry };
  const domain = SIP018_DOMAIN[network];

  const domainCV = tupleCV({
    name: stringAsciiCV(domain.name),
    version: stringAsciiCV(domain.version),
    "chain-id": uintCV(domain.chainId),
  });

  const messageCV = tupleCV({
    action: stringAsciiCV(action),
    nonce: uintCV(BigInt(nonce)),
    expiry: uintCV(BigInt(expiry)),
  });

  const encodedBytes = encodeStructuredDataBytes({ message: messageCV, domain: domainCV });
  const hash = sha256(encodedBytes);
  const hashHex = bytesToHex(hash);
  const signature = signMessageHashRsv({ messageHash: hashHex, privateKey });

  return { signature: signature.data, message };
}

/**
 * Derive a child account from a mnemonic phrase
 */
async function deriveChildAccount(mnemonic: string, index: number) {
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const currentCount = wallet.accounts.length;
  for (let i = currentCount; i <= index; i++) {
    generateNewAccount(wallet);
  }
  const account = wallet.accounts[index];
  if (!account) throw new Error(`Failed to derive account at index ${index}`);
  return {
    address: getStxAddress({ account, network: "testnet" }),
    key: account.stxPrivateKey,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const testCancel = args.includes("--cancel");
  const relayArg = args.find((a) => !a.startsWith("--"));
  const relayUrl = process.env.RELAY_URL || relayArg || "http://localhost:8787";

  console.log(`Testing queue endpoints at: ${relayUrl}`);
  console.log(`Cancel test: ${testCancel}`);
  console.log("");

  // Resolve private key
  let privateKey: string | null = null;
  let senderAddress: string | null = null;

  if (process.env.AGENT_MNEMONIC) {
    const accountIndex = parseInt(process.env.AGENT_ACCOUNT_INDEX || "0", 10);
    console.log(`Deriving account at index ${accountIndex} from mnemonic...`);
    const account = await deriveChildAccount(process.env.AGENT_MNEMONIC, accountIndex);
    privateKey = account.key;
    senderAddress = account.address;
  } else if (process.env.AGENT_PRIVATE_KEY) {
    privateKey = process.env.AGENT_PRIVATE_KEY;
    senderAddress = getAddressFromPrivateKey(privateKey, "testnet");
  } else {
    console.error("Error: AGENT_MNEMONIC or AGENT_PRIVATE_KEY must be set in .env");
    process.exit(1);
  }

  console.log(`Sender address: ${senderAddress}`);
  console.log("");

  let passed = 0;
  let failed = 0;

  // Test 1: GET /queue/:senderAddress — should return empty queue (or current state)
  console.log(`Test 1: GET /queue/${senderAddress}...`);
  try {
    const auth = createQueueAuth("queue-read", privateKey);
    const response = await fetch(`${relayUrl}/queue/${senderAddress}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-SIP018-Auth": JSON.stringify(auth),
      },
    });

    const result = (await response.json()) as Record<string, unknown>;

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
      const queue = result.queue as Record<string, unknown>;
      if (!queue || typeof queue.total !== "number") {
        console.error(`  FAIL: Invalid queue shape`);
        console.error(`  Response:`, result);
        failed++;
      } else {
        console.log(`  PASS`);
        console.log(`  Queue total: ${queue.total}`);
        console.log(
          `  queued: ${(queue.queued as unknown[]).length}, ` +
          `dispatched: ${(queue.dispatched as unknown[]).length}, ` +
          `replaying: ${(queue.replaying as unknown[]).length}, ` +
          `replayBuffer: ${(queue.replayBuffer as unknown[]).length}`
        );
        passed++;
      }
    }
  } catch (e) {
    console.error(`  FAIL: Network error`);
    console.error(`  ${e instanceof Error ? e.message : e}`);
    failed++;
  }

  console.log("");

  // Test 2: GET /queue/:senderAddress with wrong action — should return 401
  console.log("Test 2: GET /queue with wrong SIP-018 action (expected 401)...");
  try {
    // Deliberately use wrong action to test auth scoping
    const auth = createQueueAuth("queue-cancel", privateKey); // wrong action for GET
    const response = await fetch(`${relayUrl}/queue/${senderAddress}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-SIP018-Auth": JSON.stringify(auth),
      },
    });

    const result = (await response.json()) as Record<string, unknown>;

    if (response.status === 401) {
      console.log(`  PASS — rejected with 401 (action mismatch detected)`);
      console.log(`  Code: ${result.code}`);
      passed++;
    } else {
      console.error(`  FAIL: Expected 401, got ${response.status}`);
      console.error(`  Response:`, result);
      failed++;
    }
  } catch (e) {
    console.error(`  FAIL: Network error`);
    console.error(`  ${e instanceof Error ? e.message : e}`);
    failed++;
  }

  console.log("");

  if (testCancel) {
    // Test 3: DELETE /queue/:senderAddress/0/0 — should return 404 (nothing queued)
    console.log(`Test 3: DELETE /queue/${senderAddress}/0/0 (expected 404 — nothing queued)...`);
    try {
      const auth = createQueueAuth("queue-cancel", privateKey);
      const response = await fetch(`${relayUrl}/queue/${senderAddress}/0/0`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auth }),
      });

      const result = (await response.json()) as Record<string, unknown>;

      if (response.status === 404) {
        console.log(`  PASS — 404 as expected (no entry at walletIndex=0, sponsorNonce=0)`);
        console.log(`  Code: ${result.code}`);
        passed++;
      } else if (response.status === 200 && result.success) {
        // If something was actually queued, that's also a pass
        const cancelled = result.cancelled as Record<string, unknown>;
        console.log(`  PASS — cancelled an entry (queue was non-empty)`);
        console.log(`  previousState: ${cancelled?.previousState}`);
        passed++;
      } else {
        console.error(`  FAIL: Unexpected response ${response.status}`);
        console.error(`  Response:`, result);
        failed++;
      }
    } catch (e) {
      console.error(`  FAIL: Network error`);
      console.error(`  ${e instanceof Error ? e.message : e}`);
      failed++;
    }
    console.log("");
  }

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
