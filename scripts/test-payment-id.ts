/**
 * Test script for the payment-identifier extension (x402 V2)
 *
 * Usage (recommended - use .env file):
 *   npm run test:payment-id [relay-url]
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
 *   1. GET  /supported    — "payment-identifier" appears in extensions array
 *   2. POST /verify       — extension accepted and echoed back in response
 *   3. POST /verify       — backward compat: no extension field, request still valid
 *   4. POST /settle       — extension accepted and echoed back (settlement may fail for
 *                           other reasons such as stale nonce; that is expected)
 *   5. POST /verify       — invalid id (too short) rejected with invalid_payload
 *   6. (documented) Dedup-on-retry and 409-conflict scenarios require a real funded
 *                          wallet and are described in the notes section below.
 *
 * Note: Tests 2–4 build a minimal signed sponsored transaction. The transaction may fail
 * settlement for reasons unrelated to the extension (e.g., stale nonce, insufficient
 * balance) — what we verify is that the extension plumbing is wired correctly: the id is
 * parsed, validated, and echoed back in the response.
 *
 * Spec reference:
 *   https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
 *
 * Payment-identifier extension:
 *   id pattern: [a-zA-Z0-9_-]+, length 16-128, pay_ prefix recommended.
 *
 * Examples:
 *   # Recommended: Set AGENT_MNEMONIC in .env
 *   npm run test:payment-id
 *
 *   # Override relay URL via argument
 *   npm run test:payment-id -- https://x402-relay.aibtc.dev
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

// Payment-identifier IDs used in tests (must be 16-128 chars, [a-zA-Z0-9_-]+)
const VERIFY_PAYMENT_ID = "pay_test_verify_001_abc";    // 22 chars
const SETTLE_PAYMENT_ID = "pay_test_settle_001_xyz";    // 22 chars
const SHORT_PAYMENT_ID = "short";                       // 5 chars — intentionally invalid

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
  const relayUrl =
    process.env.RELAY_URL || relayArg || "https://x402-relay.aibtc.dev";

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
    console.error("  npm run test:payment-id");
    process.exit(1);
  }

  console.log(`Relay URL: ${relayUrl}`);
  console.log(`Sender address: ${senderAddress}`);

  const recipient = process.env.TEST_RECIPIENT || AIBTC_TESTNET;
  console.log(`Recipient address: ${recipient}`);

  // Build a minimal sponsored STX transfer for use in verify/settle tests.
  // The transaction may fail on the relay for reasons unrelated to the extension
  // (stale nonce, insufficient balance, etc.) — that is expected and noted as [INFO].
  console.log("\nBuilding sponsored transaction for extension tests...");
  const transaction = await makeSTXTokenTransfer({
    recipient,
    amount: 1n, // 1 microSTX (minimal)
    senderKey: privateKey,
    network: "testnet",
    memo: "test-payment-id",
    anchorMode: AnchorMode.Any,
    sponsored: true,
    fee: 0n, // Sponsor pays
  });

  const txHex = transaction.serialize();
  console.log(`Transaction hex: ${txHex.slice(0, 50)}...`);
  console.log(`Transaction length: ${txHex.length} chars`);

  // Shared payment requirements for all tests
  const paymentRequirements = {
    scheme: "exact",
    network: TESTNET_NETWORK,
    amount: "1", // Matches amount above
    asset: "STX",
    payTo: recipient,
    maxTimeoutSeconds: 60,
  };

  // =========================================================================
  // Test 1: GET /supported — "payment-identifier" in extensions
  // =========================================================================
  section("Test 1: GET /supported — payment-identifier in extensions");
  console.log(`GET ${relayUrl}/supported`);

  try {
    const response = await fetch(`${relayUrl}/supported`);
    const result = (await response.json()) as X402SupportedResponseV2;

    console.log(`\n--- RESULT (HTTP ${response.status}) ---`);
    console.log(`extensions: [${result.extensions?.join(", ") || "none"}]`);
    console.log(
      `kinds: ${result.kinds?.map((k) => `${k.scheme}@${k.network}`).join(", ") || "none"}`
    );

    if (result.extensions?.includes("payment-identifier")) {
      console.log(
        `\n[OK] "payment-identifier" is listed in /supported extensions`
      );
    } else {
      console.warn(
        `\n[WARN] "payment-identifier" NOT found in extensions array`
      );
      console.warn(
        `  Actual extensions: [${result.extensions?.join(", ") || "none"}]`
      );
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Test 2: POST /verify with payment-identifier extension — extension echoed
  // =========================================================================
  section("Test 2: POST /verify with payment-identifier extension");

  const verifyWithIdRequest: X402VerifyRequestV2 = {
    paymentPayload: {
      x402Version: 2,
      payload: { transaction: txHex },
      accepted: paymentRequirements,
      extensions: {
        "payment-identifier": {
          info: { id: VERIFY_PAYMENT_ID },
        },
      },
    },
    paymentRequirements,
  };

  console.log(`POST ${relayUrl}/verify`);
  console.log(`payment-identifier id: "${VERIFY_PAYMENT_ID}"`);
  console.log(`Network: ${TESTNET_NETWORK}`);

  try {
    const response = await fetch(`${relayUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyWithIdRequest),
    });

    const result = (await response.json()) as X402VerifyResponseV2;

    console.log(`\n--- RESULT (HTTP ${response.status}) ---`);
    console.log(`isValid: ${result.isValid}`);
    if (result.payer) console.log(`payer: ${result.payer}`);
    if (result.invalidReason) console.log(`invalidReason: ${result.invalidReason}`);
    if (result.extensions) {
      console.log(`extensions: ${JSON.stringify(result.extensions)}`);
    }

    const echoedId = (result.extensions as Record<string, { info?: { id?: string } } | undefined> | undefined)?.["payment-identifier"]?.info?.id;

    if (echoedId === VERIFY_PAYMENT_ID) {
      console.log(
        `\n[OK] Extension echoed back correctly: id="${echoedId}"`
      );
    } else if (result.isValid && !result.invalidReason) {
      console.log(
        `\n[OK] Verification succeeded (extension accepted, no echo in this response shape)`
      );
    } else if (
      result.invalidReason &&
      result.invalidReason !== "invalid_payload"
    ) {
      console.log(
        `\n[INFO] Verification failed for non-extension reason: ${result.invalidReason}`
      );
      console.log(`  Extension was accepted (not rejected). Failure is unrelated.`);
    } else if (result.invalidReason === "invalid_payload") {
      console.warn(
        `\n[WARN] invalidReason=invalid_payload — extension may have been rejected`
      );
      console.warn(`  Check that the payment-identifier extension is wired in /verify.`);
    } else {
      console.log(
        `\n[INFO] Response did not echo extension id but did not reject it either.`
      );
      console.log(`  Full response: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Test 3: POST /verify WITHOUT extension — backward compat
  // =========================================================================
  section("Test 3: POST /verify without extension (backward compat)");

  const verifyNoExtRequest: X402VerifyRequestV2 = {
    paymentPayload: {
      x402Version: 2,
      payload: { transaction: txHex },
      accepted: paymentRequirements,
      // No extensions field
    },
    paymentRequirements,
  };

  console.log(`POST ${relayUrl}/verify`);
  console.log(`(No extensions field in paymentPayload)`);
  console.log(`Network: ${TESTNET_NETWORK}`);

  try {
    const response = await fetch(`${relayUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyNoExtRequest),
    });

    const result = (await response.json()) as X402VerifyResponseV2;

    console.log(`\n--- RESULT (HTTP ${response.status}) ---`);
    console.log(`isValid: ${result.isValid}`);
    if (result.payer) console.log(`payer: ${result.payer}`);
    if (result.invalidReason) console.log(`invalidReason: ${result.invalidReason}`);

    if (result.isValid) {
      console.log(`\n[OK] Backward compat confirmed: no extension = valid verification`);
    } else if (result.invalidReason && result.invalidReason !== "invalid_payload") {
      console.log(
        `\n[OK] Backward compat confirmed: absence of extension did not cause invalid_payload`
      );
      console.log(`  (Failed for unrelated reason: ${result.invalidReason})`);
    } else if (result.invalidReason === "invalid_payload") {
      console.warn(
        `\n[WARN] invalid_payload without extension field — backward compat may be broken`
      );
    } else {
      console.log(
        `\n[INFO] Unexpected response shape: ${JSON.stringify(result)}`
      );
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Test 4: POST /settle with payment-identifier extension
  // =========================================================================
  section("Test 4: POST /settle with payment-identifier extension");

  const settleWithIdRequest: X402SettleRequestV2 = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      payload: { transaction: txHex },
      accepted: paymentRequirements,
      extensions: {
        "payment-identifier": {
          info: { id: SETTLE_PAYMENT_ID },
        },
      },
    },
    paymentRequirements,
  };

  console.log(`POST ${relayUrl}/settle`);
  console.log(`payment-identifier id: "${SETTLE_PAYMENT_ID}"`);
  console.log(`Network: ${TESTNET_NETWORK}`);
  console.log(`(This will attempt broadcast — settlement may fail for non-extension reasons)`);

  try {
    const response = await fetch(`${relayUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settleWithIdRequest),
    });

    const result = (await response.json()) as X402SettlementResponseV2;

    console.log(`\n--- RESULT (HTTP ${response.status}) ---`);
    console.log(`success: ${result.success}`);
    console.log(`network: ${result.network}`);
    console.log(`transaction: ${result.transaction || "(empty)"}`);
    if (result.payer) console.log(`payer: ${result.payer}`);
    if (result.errorReason) console.log(`errorReason: ${result.errorReason}`);
    if (result.extensions) {
      console.log(`extensions: ${JSON.stringify(result.extensions)}`);
    }

    const echoedId = (result.extensions as Record<string, { info?: { id?: string } } | undefined> | undefined)?.["payment-identifier"]?.info?.id;

    if (result.success && echoedId === SETTLE_PAYMENT_ID) {
      console.log(
        `\n[OK] Settlement succeeded and extension echoed back: id="${echoedId}"`
      );
      if (result.transaction) {
        console.log(
          `Explorer: https://explorer.hiro.so/txid/${result.transaction}?chain=testnet`
        );
      }
    } else if (result.success) {
      console.log(
        `\n[OK] Settlement succeeded (extension accepted)`
      );
      if (result.transaction) {
        console.log(
          `Explorer: https://explorer.hiro.so/txid/${result.transaction}?chain=testnet`
        );
      }
    } else if (
      result.errorReason &&
      result.errorReason !== "invalid_payload"
    ) {
      console.log(
        `\n[INFO] Settlement failed for non-extension reason: ${result.errorReason}`
      );
      console.log(`  Extension was accepted (not rejected). Failure is unrelated to extension.`);
      console.log(`  This is expected when testing with a stale nonce or zero-balance wallet.`);
    } else if (result.errorReason === "invalid_payload") {
      console.warn(
        `\n[WARN] errorReason=invalid_payload — extension may have been rejected`
      );
      console.warn(`  Check that the payment-identifier extension is wired in /settle.`);
    } else {
      console.log(
        `\n[INFO] Unexpected response shape: ${JSON.stringify(result)}`
      );
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Test 5: POST /verify with too-short payment-identifier — rejected
  // =========================================================================
  section("Test 5: POST /verify with invalid id (too short — rejected)");

  const verifyShortIdRequest: X402VerifyRequestV2 = {
    paymentPayload: {
      x402Version: 2,
      payload: { transaction: txHex },
      accepted: paymentRequirements,
      extensions: {
        "payment-identifier": {
          info: { id: SHORT_PAYMENT_ID }, // 5 chars — below the 16-char minimum
        },
      },
    },
    paymentRequirements,
  };

  console.log(`POST ${relayUrl}/verify`);
  console.log(`payment-identifier id: "${SHORT_PAYMENT_ID}" (${SHORT_PAYMENT_ID.length} chars — min is 16)`);

  try {
    const response = await fetch(`${relayUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyShortIdRequest),
    });

    const result = (await response.json()) as X402VerifyResponseV2;

    console.log(`\n--- RESULT (HTTP ${response.status}) ---`);
    console.log(`isValid: ${result.isValid}`);
    if (result.invalidReason) console.log(`invalidReason: ${result.invalidReason}`);

    if (!result.isValid && result.invalidReason === "invalid_payload") {
      console.log(
        `\n[OK] Correctly rejected too-short id: invalidReason=invalid_payload`
      );
    } else if (!result.isValid) {
      console.warn(
        `\n[WARN] Request was invalid but got unexpected reason: ${result.invalidReason}`
      );
      console.warn(`  Expected invalid_payload for too-short id.`);
    } else {
      console.warn(
        `\n[WARN] Expected isValid=false for too-short id, got isValid=true`
      );
      console.warn(`  The id length validation may not be enforced.`);
    }
  } catch (e) {
    console.error("\n--- NETWORK ERROR ---");
    console.error(e instanceof Error ? e.message : e);
  }

  // =========================================================================
  // Test 6: Notes on dedup-on-retry and 409-conflict scenarios
  // =========================================================================
  section("Test 6: Notes — Dedup-on-retry and 409-conflict scenarios");

  console.log(`
These scenarios require a real funded wallet to fully exercise:

Dedup on retry (same id + same payload → cached response):
  1. POST /settle with a valid funded tx and a payment-identifier id
  2. Save the response (txid, payer, etc.)
  3. POST /settle again with the EXACT same payload and the SAME id
  4. Expect HTTP 200 with success=true and the cached txid (not a new broadcast)
  5. [OK] if second response txid === first response txid

409 conflict (same id + different payload → conflict):
  1. POST /settle with a valid funded tx and a payment-identifier id
  2. Build a DIFFERENT tx (different nonce or amount)
  3. POST /settle with the same id but the new tx
  4. Expect HTTP 409 with errorReason="payment_identifier_conflict"
  5. [OK] if HTTP status is 409

To run these tests:
  - Fund a testnet wallet (AGENT_MNEMONIC in .env)
  - Use the Hiro testnet faucet: https://explorer.hiro.so/sandbox/faucet?chain=testnet
  - Run the test script and compare the first and second responses manually

KV TTL note:
  The payment-identifier cache has a 300-second (5-minute) TTL.
  Wait >5 minutes between different test runs to avoid cached state from prior tests.
`);

  // =========================================================================
  // Summary
  // =========================================================================
  section("Test Summary");
  console.log(`Relay: ${relayUrl}`);
  console.log(
    `Spec: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md`
  );
  console.log(`Extension docs: ${relayUrl}/topics/x402-v2-facilitator`);
  console.log(
    `\nAll tests complete. Check results above for [OK]/[INFO]/[WARN] markers.`
  );
}

main();
