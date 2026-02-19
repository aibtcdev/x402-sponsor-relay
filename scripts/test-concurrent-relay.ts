/**
 * Concurrent relay test script (fires multiple /relay requests at once)
 *
 * Usage (recommended - use .env file):
 *   tsx scripts/test-concurrent-relay.ts [relay-url]
 *
 * Environment variables (in .env):
 *   AGENT_MNEMONIC      24-word mnemonic phrase (recommended)
 *   AGENT_ACCOUNT_INDEX Account index to derive (default: 0)
 *   AGENT_PRIVATE_KEY   Hex-encoded private key (alternative to mnemonic)
 *   RELAY_URL           Relay endpoint URL (optional)
 *   TEST_RECIPIENT      Recipient address (default: AIBTC testnet server)
 *   STACKS_NETWORK      mainnet | testnet (default: testnet)
 *   HIRO_API_KEY        Optional Hiro API key for nonce lookup
 *
 * Argument handling:
 *   - If AGENT_MNEMONIC or AGENT_PRIVATE_KEY is set: args[0] = relay URL (optional)
 *   - If neither is set: args[0] = private key, args[1] = relay URL (legacy)
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
import { getHiroBaseUrl, getHiroHeaders } from "../src/utils";

const AIBTC_TESTNET = "ST37NMC4HGFQ1H2JSFP4H3TMNQBF4PY0MVSD1GV7Z"; // x402.aibtc.dev
const REQUEST_COUNT = 5;

async function deriveChildAccount(
  mnemonic: string,
  index: number,
  network: "mainnet" | "testnet"
) {
  if (index < 0) {
    throw new Error(`Account index must be non-negative, got ${index}`);
  }

  const wallet = await generateWallet({
    secretKey: mnemonic,
    password: "",
  });

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
      network,
    }),
    key: account.stxPrivateKey,
  };
}

async function fetchPossibleNextNonce(
  address: string,
  network: "mainnet" | "testnet"
): Promise<number> {
  const url = `${getHiroBaseUrl(network)}/extended/v1/address/${address}/nonces`;
  const headers = getHiroHeaders(process.env.HIRO_API_KEY);
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Hiro nonce endpoint responded with ${response.status}`);
  }

  const data = (await response.json()) as { possible_next_nonce?: number };
  if (typeof data?.possible_next_nonce !== "number") {
    throw new Error("Hiro nonce response missing possible_next_nonce");
  }

  return data.possible_next_nonce;
}

async function main() {
  const args = process.argv.slice(2);
  const stacksNetwork =
    process.env.STACKS_NETWORK === "mainnet" ? "mainnet" : "testnet";

  const hasEnvCredentials = !!(
    process.env.AGENT_MNEMONIC || process.env.AGENT_PRIVATE_KEY
  );
  const relayArg = hasEnvCredentials ? args[0] : args[1];
  const relayUrl = process.env.RELAY_URL || relayArg || "http://localhost:8787";

  let privateKey: string;
  let senderAddress: string;

  if (process.env.AGENT_MNEMONIC) {
    const accountIndex = parseInt(process.env.AGENT_ACCOUNT_INDEX || "0", 10);
    console.log(`Deriving account ${accountIndex} from mnemonic...`);
    const account = await deriveChildAccount(
      process.env.AGENT_MNEMONIC,
      accountIndex,
      stacksNetwork
    );
    privateKey = account.key;
    senderAddress = account.address;
  } else if (process.env.AGENT_PRIVATE_KEY) {
    privateKey = process.env.AGENT_PRIVATE_KEY;
    senderAddress = getAddressFromPrivateKey(
      privateKey,
      stacksNetwork === "mainnet"
        ? TransactionVersion.Mainnet
        : TransactionVersion.Testnet
    );
  } else if (args[0]) {
    privateKey = args[0];
    senderAddress = getAddressFromPrivateKey(
      privateKey,
      stacksNetwork === "mainnet"
        ? TransactionVersion.Mainnet
        : TransactionVersion.Testnet
    );
  } else {
    console.error("Error: No credentials provided");
    console.error("");
    console.error("Copy .env.example to .env and fill in your credentials:");
    console.error("  cp .env.example .env");
    console.error("  # Edit .env with your AGENT_MNEMONIC or AGENT_PRIVATE_KEY");
    console.error("  tsx scripts/test-concurrent-relay.ts");
    process.exit(1);
  }

  console.log(`Sender address: ${senderAddress}`);

  const recipient = process.env.TEST_RECIPIENT || AIBTC_TESTNET;
  console.log(`Recipient address: ${recipient}`);

  console.log("\nFetching sender nonce...");
  const baseNonce = await fetchPossibleNextNonce(senderAddress, stacksNetwork);
  console.log(`Base nonce: ${baseNonce}`);

  console.log(`\nBuilding ${REQUEST_COUNT} sponsored transactions...`);
  const transactions = await Promise.all(
    Array.from({ length: REQUEST_COUNT }, async (_, index) => {
      const transaction = await makeSTXTokenTransfer({
        recipient,
        amount: 1000n,
        senderKey: privateKey,
        network: stacksNetwork,
        memo: `test-relay-${index}`,
        anchorMode: AnchorMode.Any,
        sponsored: true,
        fee: 0n,
        nonce: BigInt(baseNonce + index),
      });

      return transaction.serialize();
    })
  );

  const requestBodies = transactions.map((txHex) => ({
    transaction: txHex,
    settle: {
      expectedRecipient: recipient,
      minAmount: "1000",
      tokenType: "STX" as const,
      expectedSender: senderAddress,
      resource: "/test",
      method: "POST",
    },
  }));

  console.log(`\nSending ${REQUEST_COUNT} parallel /relay requests...`);
  const results = await Promise.all(
    requestBodies.map(async (body, index) => {
      const response = await fetch(`${relayUrl}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      let data: any = null;
      try {
        data = await response.json();
      } catch (error) {
        data = { error: "Failed to parse JSON response" };
      }

      return {
        index,
        status: response.status,
        ok: response.ok,
        data,
      };
    })
  );

  const nonceConflicts = results.filter(
    (result) => result.data?.code === "NONCE_CONFLICT"
  );
  const failures = results.filter((result) => !result.ok);

  if (nonceConflicts.length > 0) {
    console.error("\n=== NONCE CONFLICTS DETECTED ===");
    nonceConflicts.forEach((result) => {
      console.error(`Request #${result.index} returned NONCE_CONFLICT`);
    });
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error("\n=== FAILED REQUESTS ===");
    failures.forEach((result) => {
      console.error(`Request #${result.index} failed with ${result.status}`);
      console.error(result.data);
    });
    process.exit(1);
  }

  console.log("\n=== SUCCESS ===");
  console.log(`All ${REQUEST_COUNT} relay requests completed without nonce conflicts.`);
}

main().catch((error) => {
  console.error("\n=== ERROR ===");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
