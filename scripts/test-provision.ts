/**
 * Test script for the /keys/provision endpoint
 *
 * Tests all three Bitcoin address types:
 * - P2PKH (1...) with BIP-137 signature  — derivation path m/44'/0'/0'/0/{index}
 * - P2WPKH (bc1q...) with BIP-322 signature — derivation path m/84'/0'/0'/0/{index}
 * - P2TR (bc1p...) with BIP-322 signature — derivation path m/86'/0'/0'/0/{index}
 *
 * Usage (recommended - use .env file):
 *   npm run test:provision [relay-url]
 *
 * Environment variables (in .env):
 *   AGENT_MNEMONIC      24-word mnemonic phrase (recommended)
 *   AGENT_ACCOUNT_INDEX Account index to derive (default: 0)
 *   RELAY_URL           Relay endpoint URL (optional)
 *
 * Examples:
 *   # Set AGENT_MNEMONIC in .env
 *   npm run test:provision
 *
 *   # Override relay URL via argument
 *   npm run test:provision -- https://x402-relay.aibtc.dev
 */

import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import {
  Transaction,
  p2wpkh,
  p2pkh,
  p2tr,
  Script,
  SigHash,
  RawWitness,
  RawTx,
  NETWORK as BTC_MAINNET,
} from "@scure/btc-signer";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { hashSha256Sync } from "@stacks/encryption";

/**
 * Standard messages for BTC signature verification
 */
const BTC_MESSAGES = {
  /** Base message for registration path */
  BASE: "Bitcoin will be the currency of AIs",
  /** Format for self-service path with timestamp */
  SELF_SERVICE_PATTERN: /^Bitcoin will be the currency of AIs \| (.+)$/,
} as const;

// ---------------------------------------------------------------------------
// Crypto helpers (shared between BIP-137 and BIP-322)
// ---------------------------------------------------------------------------

const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";

function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd; buf[1] = n & 0xff; buf[2] = (n >> 8) & 0xff;
    return buf;
  }
  const buf = new Uint8Array(5);
  buf[0] = 0xfe; buf[1] = n & 0xff; buf[2] = (n >> 8) & 0xff;
  buf[3] = (n >> 16) & 0xff; buf[4] = (n >> 24) & 0xff;
  return buf;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return hashSha256Sync(hashSha256Sync(data));
}

function formatBitcoinMessage(message: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(BITCOIN_MSG_PREFIX);
  const messageBytes = new TextEncoder().encode(message);
  return concatBytes(prefixBytes, encodeVarInt(messageBytes.length), messageBytes);
}

// ---------------------------------------------------------------------------
// BIP-137 signing (for P2PKH 1... addresses)
// ---------------------------------------------------------------------------

/**
 * Sign a message with BIP-137 format (P2PKH compressed).
 * Returns Base64-encoded 65-byte signature.
 */
function signBip137(message: string, privateKey: Uint8Array): string {
  const formattedMessage = formatBitcoinMessage(message);
  const messageHash = doubleSha256(formattedMessage);

  // Sign and get recovery info
  const sig = secp256k1.sign(messageHash, privateKey, { lowS: true });
  const recoveryId = sig.recovery;

  // BIP-137 header byte for P2PKH compressed = 31 + recoveryId
  const header = 31 + recoveryId;

  const sigBytes = new Uint8Array(65);
  sigBytes[0] = header;
  const rawSig = sig.toCompactRawBytes();
  sigBytes.set(rawSig.slice(0, 32), 1);  // r
  sigBytes.set(rawSig.slice(32, 64), 33); // s

  return Buffer.from(sigBytes).toString("base64");
}

// ---------------------------------------------------------------------------
// BIP-322 signing (for P2WPKH bc1q... and P2TR bc1p... addresses)
// ---------------------------------------------------------------------------

function bip322TaggedHash(message: string): Uint8Array {
  const tagBytes = new TextEncoder().encode("BIP0322-signed-message");
  const tagHash = hashSha256Sync(tagBytes);
  const msgBytes = new TextEncoder().encode(message);
  const msgPart = concatBytes(encodeVarInt(msgBytes.length), msgBytes);
  return hashSha256Sync(concatBytes(tagHash, tagHash, msgPart));
}

function bip322BuildToSpendTxId(message: string, scriptPubKey: Uint8Array): Uint8Array {
  const msgHash = bip322TaggedHash(message);
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);

  const rawTx = RawTx.encode({
    version: 0,
    inputs: [{
      txid: new Uint8Array(32),
      index: 0xffffffff,
      finalScriptSig: scriptSig,
      sequence: 0,
    }],
    outputs: [{ amount: 0n, script: scriptPubKey }],
    lockTime: 0,
  });

  return doubleSha256(rawTx).reverse();
}

/**
 * Sign a message with BIP-322 format for P2WPKH or P2TR addresses.
 * Returns Base64-encoded BIP-322 "simple" signature (serialized witness).
 */
function signBip322(message: string, privateKey: Uint8Array, scriptPubKey: Uint8Array): string {
  const toSpendTxid = bip322BuildToSpendTxId(message, scriptPubKey);

  const toSignTx = new Transaction({ version: 0, lockTime: 0 });
  toSignTx.addInput({
    txid: toSpendTxid,
    index: 0,
    sequence: 0,
    witnessUtxo: { amount: 0n, script: scriptPubKey },
  });
  toSignTx.addOutput({ script: Script.encode(["RETURN"]), amount: 0n });

  toSignTx.signIdx(privateKey, 0);
  toSignTx.finalizeIdx(0);

  const input = toSignTx.getInput(0);
  if (!input.finalScriptWitness) {
    throw new Error("BIP-322 signing failed: no witness produced");
  }

  const encodedWitness = RawWitness.encode(input.finalScriptWitness);
  return Buffer.from(encodedWitness).toString("base64");
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

interface BtcKeyInfo {
  address: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  type: "P2PKH" | "P2WPKH" | "P2TR";
  path: string;
}

/**
 * Derive a P2PKH (1...) key from mnemonic using BIP-44 path.
 */
function deriveP2PKH(mnemonic: string, index: number = 0): BtcKeyInfo {
  const seed = mnemonicToSeedSync(mnemonic);
  const masterKey = HDKey.fromMasterSeed(seed);
  const path = `m/44'/0'/0'/0/${index}`;
  const child = masterKey.derive(path);

  if (!child.privateKey || !child.publicKey) {
    throw new Error("Failed to derive P2PKH key");
  }

  const address = p2pkh(child.publicKey, BTC_MAINNET).address;
  if (!address) throw new Error("Failed to derive P2PKH address");

  return {
    address,
    privateKey: child.privateKey,
    publicKey: child.publicKey,
    type: "P2PKH",
    path,
  };
}

/**
 * Derive a P2WPKH (bc1q...) key from mnemonic using BIP-84 path.
 */
function deriveP2WPKH(mnemonic: string, index: number = 0): BtcKeyInfo {
  const seed = mnemonicToSeedSync(mnemonic);
  const masterKey = HDKey.fromMasterSeed(seed);
  const path = `m/84'/0'/0'/0/${index}`;
  const child = masterKey.derive(path);

  if (!child.privateKey || !child.publicKey) {
    throw new Error("Failed to derive P2WPKH key");
  }

  const address = p2wpkh(child.publicKey, BTC_MAINNET).address;
  if (!address) throw new Error("Failed to derive P2WPKH address");

  return {
    address,
    privateKey: child.privateKey,
    publicKey: child.publicKey,
    type: "P2WPKH",
    path,
  };
}

/**
 * Derive a P2TR (bc1p...) key from mnemonic using BIP-86 path.
 */
function deriveP2TR(mnemonic: string, index: number = 0): BtcKeyInfo {
  const seed = mnemonicToSeedSync(mnemonic);
  const masterKey = HDKey.fromMasterSeed(seed);
  const path = `m/86'/0'/0'/0/${index}`;
  const child = masterKey.derive(path);

  if (!child.privateKey || !child.publicKey) {
    throw new Error("Failed to derive P2TR key");
  }

  // P2TR uses x-only pubkey (32 bytes from the 33-byte compressed pubkey)
  const xOnlyPubkey = child.publicKey.slice(1); // strip the 0x02/0x03 prefix
  const address = p2tr(xOnlyPubkey, undefined, BTC_MAINNET).address;
  if (!address) throw new Error("Failed to derive P2TR address");

  return {
    address,
    privateKey: child.privateKey,
    publicKey: child.publicKey,
    type: "P2TR",
    path,
  };
}

/**
 * Derive BTC credentials from a hex private key (P2PKH only).
 */
function deriveFromPrivateKey(privateKeyHex: string): BtcKeyInfo {
  const privateKey = new Uint8Array(Buffer.from(privateKeyHex, "hex"));
  const pubkeyPoint = secp256k1.getPublicKey(privateKey, true);
  const address = p2pkh(pubkeyPoint, BTC_MAINNET).address;
  if (!address) throw new Error("Failed to derive P2PKH address from private key");

  return {
    address,
    privateKey,
    publicKey: pubkeyPoint,
    type: "P2PKH",
    path: "private-key",
  };
}

// ---------------------------------------------------------------------------
// Signing dispatcher
// ---------------------------------------------------------------------------

function generateSelfServiceMessage(): string {
  return `${BTC_MESSAGES.BASE} | ${new Date().toISOString()}`;
}

function signMessage(keyInfo: BtcKeyInfo, message: string): string {
  if (keyInfo.type === "P2PKH") {
    return signBip137(message, keyInfo.privateKey);
  } else if (keyInfo.type === "P2WPKH") {
    const scriptPubKey = p2wpkh(keyInfo.publicKey, BTC_MAINNET).script;
    return signBip322(message, keyInfo.privateKey, scriptPubKey);
  } else {
    // P2TR: use x-only pubkey (strip the 0x02/0x03 prefix)
    const xOnlyPubkey = keyInfo.publicKey.slice(1);
    const scriptPubKey = p2tr(xOnlyPubkey, undefined, BTC_MAINNET).script;
    return signBip322(message, keyInfo.privateKey, scriptPubKey);
  }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function testProvision(
  relayUrl: string,
  keyInfo: BtcKeyInfo,
  message: string,
  label: string
): Promise<boolean> {
  const signature = signMessage(keyInfo, message);

  console.log(`\n=== Testing ${label} (${keyInfo.type}) ===`);
  console.log(`  Address: ${keyInfo.address}`);
  console.log(`  Path: ${keyInfo.path}`);
  console.log(`  Message: ${message.slice(0, 60)}${message.length > 60 ? "..." : ""}`);
  console.log(`  Signature (first 50): ${signature.slice(0, 50)}...`);

  const body = {
    btcAddress: keyInfo.address,
    signature,
    message,
  };

  try {
    const response = await fetch(`${relayUrl}/keys/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await response.json() as Record<string, unknown>;

    if (response.ok && result.success) {
      console.log("\n  [SUCCESS]");
      console.log(`  API Key: ${result.apiKey}`);
      console.log(`  Key ID: ${(result.metadata as Record<string, unknown>)?.keyId}`);
      console.log(`  Tier: ${(result.metadata as Record<string, unknown>)?.tier}`);
      console.log("\n  IMPORTANT: Save this API key! It will not be shown again.");
      console.log(`  Add to your .env file: TEST_API_KEY=${result.apiKey}`);
      return true;
    } else if (response.status === 409 && result.code === "ALREADY_PROVISIONED") {
      console.log("\n  [ALREADY PROVISIONED] — Address already has a key (expected on re-run)");
      return true; // Not a failure for test purposes
    } else {
      console.error("\n  [FAILED]");
      console.error(`  Status: ${response.status}`);
      console.error(`  Code: ${result.code || "UNKNOWN"}`);
      console.error(`  Error: ${result.error}`);
      if (result.details) console.error(`  Details: ${result.details}`);
      return false;
    }
  } catch (e) {
    console.error("\n  [NETWORK ERROR]");
    console.error(e instanceof Error ? e.message : e);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const hasEnvCredentials = !!(process.env.AGENT_MNEMONIC || process.env.AGENT_PRIVATE_KEY);
  const relayArg = hasEnvCredentials ? args[0] : args[1];
  const relayUrl = process.env.RELAY_URL || relayArg || "http://localhost:8787";

  console.log("=== BTC API Key Provisioning Test (BIP-137 + BIP-322) ===");
  console.log(`Relay URL: ${relayUrl}`);

  const accountIndex = parseInt(process.env.AGENT_ACCOUNT_INDEX || "0", 10);
  let failures = 0;

  if (process.env.AGENT_MNEMONIC) {
    const mnemonic = process.env.AGENT_MNEMONIC;

    // Validate mnemonic
    if (!validateMnemonic(mnemonic, wordlist)) {
      console.error("Error: Invalid mnemonic phrase");
      process.exit(1);
    }

    console.log(`\nDeriving keys from mnemonic (account index: ${accountIndex})...`);

    // Test 1: P2PKH (BIP-44, BIP-137 signature)
    const p2pkhKey = deriveP2PKH(mnemonic, accountIndex);
    const p2pkhMessage = BTC_MESSAGES.BASE;
    const ok1 = await testProvision(relayUrl, p2pkhKey, p2pkhMessage, "Registration (P2PKH)");
    if (!ok1) failures++;

    // Test 2: P2WPKH bc1q (BIP-84, BIP-322 signature) — use index+1 to avoid duplicate
    const p2wpkhKey = deriveP2WPKH(mnemonic, accountIndex + 1);
    const p2wpkhMessage = generateSelfServiceMessage();
    const ok2 = await testProvision(relayUrl, p2wpkhKey, p2wpkhMessage, "Self-service (P2WPKH bc1q)");
    if (!ok2) failures++;

    // Test 3: P2TR bc1p (BIP-86, BIP-322 signature) — use index+2 to avoid duplicate
    const p2trKey = deriveP2TR(mnemonic, accountIndex + 2);
    const p2trMessage = generateSelfServiceMessage();
    const ok3 = await testProvision(relayUrl, p2trKey, p2trMessage, "Self-service (P2TR bc1p)");
    if (!ok3) failures++;

  } else if (process.env.AGENT_PRIVATE_KEY) {
    console.log("Deriving P2PKH key from AGENT_PRIVATE_KEY (BIP-137 only)...");
    const keyInfo = deriveFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
    const message = BTC_MESSAGES.BASE;
    const ok = await testProvision(relayUrl, keyInfo, message, "Registration (P2PKH)");
    if (!ok) failures++;
    console.log("\nNote: P2WPKH and P2TR tests require AGENT_MNEMONIC");

  } else if (args[0] && !args[0].startsWith("http")) {
    // Legacy: private key as first argument
    console.log("Deriving P2PKH key from private key argument (BIP-137 only)...");
    const keyInfo = deriveFromPrivateKey(args[0]);
    const message = BTC_MESSAGES.BASE;
    const ok = await testProvision(relayUrl, keyInfo, message, "Registration (P2PKH)");
    if (!ok) failures++;
    console.log("\nNote: P2WPKH and P2TR tests require AGENT_MNEMONIC");

  } else {
    console.error("Error: No credentials provided");
    console.error("");
    console.error("Copy .env.example to .env and fill in your credentials:");
    console.error("  cp .env.example .env");
    console.error("  # Edit .env with your AGENT_MNEMONIC or AGENT_PRIVATE_KEY");
    console.error("  npm run test:provision");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(60));
  if (failures === 0) {
    console.log("All provision tests passed!");
  } else {
    console.error(`${failures} test(s) failed.`);
    process.exit(1);
  }
}

main();
