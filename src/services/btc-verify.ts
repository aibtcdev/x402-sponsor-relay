import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import {
  Transaction,
  p2wpkh,
  p2pkh,
  p2sh,
  p2tr,
  Script,
  SigHash,
  RawWitness,
  RawTx,
  Address,
  NETWORK as BTC_MAINNET,
  TEST_NETWORK as BTC_TESTNET,
} from "@scure/btc-signer";
import type { BTC_NETWORK } from "@scure/btc-signer/utils.js";
import { hashSha256Sync } from "@stacks/encryption";
import type { Logger } from "../types";

/**
 * Standard messages for BTC signature verification
 */
export const BTC_MESSAGES = {
  /** Base message for registration and self-service paths */
  BASE: "Bitcoin will be the currency of AIs",
  /** Format for self-service path with timestamp: "Bitcoin will be the currency of AIs | {ISO-timestamp}" */
  SELF_SERVICE_PATTERN: /^Bitcoin will be the currency of AIs \| ([0-9T:.Z-]+)$/,
} as const;

/** Maximum age for timestamp in self-service messages (5 minutes) */
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

/** Maximum clock skew tolerance for future timestamps (1 minute) */
const MAX_FUTURE_TOLERANCE_MS = 60 * 1000;

/**
 * Bitcoin message signing prefix (BIP-137)
 * '\x18Bitcoin Signed Message:\n' where 0x18 = 24 (length of "Bitcoin Signed Message:\n")
 */
const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";

/**
 * Bitcoin address type classification based on address prefix
 */
export type BtcAddressType = "P2PKH" | "P2SH" | "P2WPKH" | "P2TR" | "unknown";

/**
 * Classify a Bitcoin address by its prefix/format
 * - P2PKH: starts with "1" (legacy, BIP-137)
 * - P2SH: starts with "3" (includes P2SH-P2WPKH wrapped SegWit, BIP-137)
 * - P2WPKH: starts with "bc1q" or "tb1q" (native SegWit, BIP-322)
 * - P2TR: starts with "bc1p" or "tb1p" (Taproot, BIP-322)
 */
export function detectAddressType(address: string): BtcAddressType {
  if (address.startsWith("1")) return "P2PKH";
  if (address.startsWith("3")) return "P2SH";
  if (address.startsWith("bc1q") || address.startsWith("tb1q")) return "P2WPKH";
  if (address.startsWith("bc1p") || address.startsWith("tb1p")) return "P2TR";
  return "unknown";
}

/**
 * Detect the Bitcoin network from an address prefix.
 * - bc1q, bc1p, 1, 3 → mainnet
 * - tb1q, tb1p, m, n, 2 → testnet
 */
function detectBtcNetwork(address: string): BTC_NETWORK {
  if (
    address.startsWith("tb1q") ||
    address.startsWith("tb1p") ||
    address.startsWith("m") ||
    address.startsWith("n") ||
    address.startsWith("2")
  ) {
    return BTC_TESTNET;
  }
  return BTC_MAINNET;
}

/**
 * Result of BTC signature verification
 */
export type BtcVerifyResult =
  | { valid: true; path: "registration" | "self-service"; timestamp?: string }
  | { valid: false; error: string; code: BtcVerifyErrorCode };

/**
 * Error codes for BTC verification failures
 */
export type BtcVerifyErrorCode =
  | "INVALID_SIGNATURE"
  | "STALE_TIMESTAMP"
  | "INVALID_MESSAGE_FORMAT"
  | "UNSUPPORTED_ADDRESS_TYPE"
  | "VERIFICATION_ERROR";

// ---------------------------------------------------------------------------
// Low-level helpers (pure, no deps on Logger)
// ---------------------------------------------------------------------------

/**
 * Encode a variable-length integer (Bitcoin varint format).
 */
function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) {
    return new Uint8Array([n]);
  } else if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    return buf;
  } else if (n <= 0xffffffff) {
    const buf = new Uint8Array(5);
    buf[0] = 0xfe;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    buf[3] = (n >> 16) & 0xff;
    buf[4] = (n >> 24) & 0xff;
    return buf;
  } else {
    throw new Error("Message too long for varint encoding");
  }
}

/**
 * Concatenate multiple Uint8Arrays into one.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * Write a 32-bit little-endian integer into a buffer.
 */
function writeUint32LE(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = n & 0xff;
  buf[1] = (n >> 8) & 0xff;
  buf[2] = (n >> 16) & 0xff;
  buf[3] = (n >> 24) & 0xff;
  return buf;
}

/**
 * Write a 64-bit little-endian BigInt into a buffer.
 */
function writeUint64LE(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Convert a DER-encoded ECDSA signature to compact (64-byte) format.
 *
 * Bitcoin witness stacks store ECDSA signatures in DER format with a hashtype byte appended.
 * @noble/curves secp256k1.verify() requires compact (64-byte r||s) format in v2.
 *
 * DER format: 30 <total_len> 02 <r_len> [00?] <r_bytes> 02 <s_len> [00?] <s_bytes>
 * The leading 0x00 is padding for high-bit integers (to keep the sign positive).
 */
function parseDERSignature(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("parseDERSignature: expected 0x30 header");
  let pos = 2; // skip 0x30 and total length byte
  if (der[pos] !== 0x02) throw new Error("parseDERSignature: expected 0x02 for r");
  pos++;
  const rLen = der[pos++];
  if (pos + rLen > der.length) throw new Error("parseDERSignature: r extends beyond signature");
  // Strip optional leading 0x00 padding byte (added when high bit is set)
  const rBytes = der.slice(rLen === 33 ? pos + 1 : pos, pos + rLen);
  pos += rLen;
  if (der[pos] !== 0x02) throw new Error("parseDERSignature: expected 0x02 for s");
  pos++;
  const sLen = der[pos++];
  if (pos + sLen > der.length) throw new Error("parseDERSignature: s extends beyond signature");
  const sBytes = der.slice(sLen === 33 ? pos + 1 : pos, pos + sLen);

  const compact = new Uint8Array(64);
  compact.set(rBytes, 32 - rBytes.length);  // left-pad r
  compact.set(sBytes, 64 - sBytes.length);  // left-pad s
  return compact;
}

/**
 * Double SHA-256 hash (Bitcoin standard).
 */
function doubleSha256(data: Uint8Array): Uint8Array {
  return hashSha256Sync(hashSha256Sync(data));
}

/**
 * Format a message for Bitcoin signing (BIP-137).
 * Returns: prefix || varint(message.length) || message
 */
function formatBitcoinMessage(message: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(BITCOIN_MSG_PREFIX);
  const messageBytes = new TextEncoder().encode(message);
  const lengthBytes = encodeVarInt(messageBytes.length);
  return concatBytes(prefixBytes, lengthBytes, messageBytes);
}

/**
 * Extract recovery ID from a BIP-137 header byte.
 * Header ranges: 27-30 (P2PKH uncomp), 31-34 (P2PKH comp), 35-38 (P2SH-P2WPKH), 39-42 (P2WPKH)
 */
function bip137RecoveryId(header: number): number {
  if (header >= 27 && header <= 30) return header - 27;
  if (header >= 31 && header <= 34) return header - 31;
  if (header >= 35 && header <= 38) return header - 35;
  if (header >= 39 && header <= 42) return header - 39;
  throw new Error(`Invalid BIP-137 header byte: ${header}`);
}

/**
 * Detect whether a decoded signature is BIP-137 (65 bytes, header 27-42) or BIP-322.
 */
function isBip137Signature(sigBytes: Uint8Array): boolean {
  return sigBytes.length === 65 && sigBytes[0] >= 27 && sigBytes[0] <= 42;
}

// ---------------------------------------------------------------------------
// BIP-137 verification (pure JS via @noble/curves)
// ---------------------------------------------------------------------------

/**
 * Verify a BIP-137 signature for legacy (P2PKH / P2SH) Bitcoin addresses.
 *
 * Algorithm:
 * 1. Decode base64 → 65 bytes: [header, r(32), s(32)]
 * 2. Build double-SHA256 of the bitcoin-prefixed message
 * 3. Recover the public key using the recovery ID embedded in header
 * 4. Derive the expected address from the recovered pubkey (type inferred from header)
 * 5. Compare derived address to the provided address
 */
function verifyBip137(address: string, message: string, signatureBase64: string): boolean {
  const sigBytes = new Uint8Array(Buffer.from(signatureBase64, "base64"));
  if (sigBytes.length !== 65) return false;

  const header = sigBytes[0];
  const rBytes = sigBytes.slice(1, 33);
  const sBytes = sigBytes.slice(33, 65);

  let recoveryId: number;
  try {
    recoveryId = bip137RecoveryId(header);
  } catch {
    return false;
  }

  // Compute message hash
  const formattedMessage = formatBitcoinMessage(message);
  const messageHash = doubleSha256(formattedMessage);

  // Recover public key from signature
  let recoveredPubKey: Uint8Array;
  try {
    const r = BigInt("0x" + Buffer.from(rBytes).toString("hex"));
    const s = BigInt("0x" + Buffer.from(sBytes).toString("hex"));
    const sig = new secp256k1.Signature(r, s, recoveryId);
    const recoveredPoint = sig.recoverPublicKey(messageHash);
    recoveredPubKey = recoveredPoint.toBytes(true); // compressed
  } catch {
    return false;
  }

  // Derive address from recovered pubkey, matching the type indicated by header
  // 27-30: P2PKH uncompressed  → compressed pubkey still used for address derivation
  // 31-34: P2PKH compressed
  // 35-38: P2SH-P2WPKH (wrapped SegWit) → p2sh(p2wpkh(...))
  // 39-42: P2WPKH native SegWit
  try {
    const network = detectBtcNetwork(address);
    let derivedAddress: string | undefined;
    if (header >= 27 && header <= 34) {
      // P2PKH
      derivedAddress = p2pkh(recoveredPubKey, network).address;
    } else if (header >= 35 && header <= 38) {
      // P2SH-P2WPKH (wrapped SegWit)
      const inner = p2wpkh(recoveredPubKey, network);
      derivedAddress = p2sh(inner, network).address;
    } else if (header >= 39 && header <= 42) {
      // P2WPKH (native SegWit)
      derivedAddress = p2wpkh(recoveredPubKey, network).address;
    }
    return derivedAddress === address;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// BIP-322 helper functions (ported from aibtc-mcp-server/signing.tools.ts)
// ---------------------------------------------------------------------------

/**
 * BIP-322 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || varint(msg.len) || msg)
 * where tag = "BIP0322-signed-message"
 */
function bip322TaggedHash(message: string): Uint8Array {
  const tagBytes = new TextEncoder().encode("BIP0322-signed-message");
  const tagHash = hashSha256Sync(tagBytes);
  const msgBytes = new TextEncoder().encode(message);
  const varint = encodeVarInt(msgBytes.length);
  const msgPart = concatBytes(varint, msgBytes);
  return hashSha256Sync(concatBytes(tagHash, tagHash, msgPart));
}

/**
 * Build the BIP-322 to_spend virtual transaction and return its txid (32 bytes, LE).
 */
function bip322BuildToSpendTxId(message: string, scriptPubKey: Uint8Array): Uint8Array {
  const msgHash = bip322TaggedHash(message);
  // scriptSig: OP_0 (0x00) push32 (0x20) <32-byte hash>
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);

  const rawTx = RawTx.encode({
    version: 0,
    inputs: [
      {
        txid: new Uint8Array(32),
        index: 0xffffffff,
        finalScriptSig: scriptSig,
        sequence: 0,
      },
    ],
    outputs: [
      {
        amount: 0n,
        script: scriptPubKey,
      },
    ],
    lockTime: 0,
  });

  // txid is double-SHA256 of the serialized tx, returned in little-endian byte order
  return doubleSha256(rawTx).reverse();
}

/**
 * BIP-322 "simple" verification for P2WPKH (bc1q/tb1q) addresses.
 */
function bip322VerifyP2WPKH(
  message: string,
  signatureBase64: string,
  address: string
): boolean {
  const sigBytes = new Uint8Array(Buffer.from(signatureBase64, "base64"));
  const witnessItems = RawWitness.decode(sigBytes);

  if (witnessItems.length !== 2) {
    throw new Error(`P2WPKH BIP-322: expected 2 witness items, got ${witnessItems.length}`);
  }

  const ecdsaSigWithHashtype = witnessItems[0];
  const pubkeyBytes = witnessItems[1];

  if (pubkeyBytes.length !== 33) {
    throw new Error(`P2WPKH BIP-322: expected 33-byte compressed pubkey, got ${pubkeyBytes.length}`);
  }

  // Derive scriptPubKey from witness pubkey
  const network = detectBtcNetwork(address);
  const scriptPubKey = p2wpkh(pubkeyBytes, network).script;

  // Build to_spend txid
  const toSpendTxid = bip322BuildToSpendTxId(message, scriptPubKey);

  // Build (unsigned) to_sign transaction for sighash computation.
  // allowUnknownOutputs: true is required for the OP_RETURN output in BIP-322 virtual transactions.
  const toSignTx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  toSignTx.addInput({
    txid: toSpendTxid,
    index: 0,
    sequence: 0,
    witnessUtxo: { amount: 0n, script: scriptPubKey },
  });
  toSignTx.addOutput({ script: Script.encode(["RETURN"]), amount: 0n });

  // Compute BIP143 witness-v0 sighash
  // scriptCode for P2WPKH is the P2PKH script: OP_DUP OP_HASH160 <hash160(pubkey)> OP_EQUALVERIFY OP_CHECKSIG
  const scriptCode = p2pkh(pubkeyBytes).script;
  const sighash = toSignTx.preimageWitnessV0(0, scriptCode, SigHash.ALL, 0n);

  // Strip hashtype byte from DER signature.
  // @noble/curves secp256k1.verify() in v2 requires compact (64-byte) format, not DER.
  const derSig = ecdsaSigWithHashtype.slice(0, -1);
  const compactSig = parseDERSignature(derSig);

  // Verify ECDSA signature
  const sigValid = secp256k1.verify(compactSig, sighash, pubkeyBytes, { prehash: false });
  if (!sigValid) return false;

  // Confirm derived address matches claimed address
  const derivedAddress = p2wpkh(pubkeyBytes, network).address;
  return derivedAddress === address;
}

/**
 * BIP-322 "simple" verification for P2TR (bc1p/tb1p) addresses.
 *
 * Reconstructs the to_sign transaction, computes the BIP341 tapscript sighash manually,
 * verifies the Schnorr signature, and checks the pubkey matches the address.
 */
function bip322VerifyP2TR(
  message: string,
  signatureBase64: string,
  address: string
): boolean {
  const sigBytes = new Uint8Array(Buffer.from(signatureBase64, "base64"));
  const witnessItems = RawWitness.decode(sigBytes);

  if (witnessItems.length !== 1) {
    throw new Error(`P2TR BIP-322: expected 1 witness item, got ${witnessItems.length}`);
  }

  const schnorrSig = witnessItems[0];
  if (schnorrSig.length !== 64) {
    throw new Error(`P2TR BIP-322: expected 64-byte Schnorr sig, got ${schnorrSig.length}`);
  }

  // Extract the tweaked output key from the P2TR address.
  // Address().decode() returns decoded.pubkey = the TWEAKED key embedded in the bech32 data.
  // We must NOT call p2tr(decoded.pubkey, ...) — that would apply another TapTweak.
  // Instead, build the scriptPubKey directly: OP_1 (0x51) OP_PUSH32 (0x20) <tweakedKey>
  const network = detectBtcNetwork(address);
  const decoded = Address(network).decode(address);
  if (decoded.type !== "tr") {
    throw new Error(`P2TR BIP-322: address does not decode to P2TR type`);
  }
  const tweakedKey = decoded.pubkey;
  const scriptPubKey = new Uint8Array([0x51, 0x20, ...tweakedKey]);

  // Build to_spend txid
  const toSpendTxid = bip322BuildToSpendTxId(message, scriptPubKey);

  // Compute BIP341 sighash manually for SIGHASH_DEFAULT (0x00) key-path spending.
  // hashPrevouts = SHA256(txid_wire_bytes || vout(4LE))
  //
  // @scure/btc-signer stores txid as-is but applies P.bytes(32, true) (reversing) when
  // encoding TxHashIdx for the BIP341 sighash computation. This means the wire-format txid
  // used in hashPrevouts is the reverse of what bip322BuildToSpendTxId returns.
  // We must re-reverse to produce the same bytes that btc-signer uses when signing.
  const txidForHashPrevouts = toSpendTxid.slice().reverse();
  const prevouts = concatBytes(txidForHashPrevouts, writeUint32LE(0));
  const hashPrevouts = hashSha256Sync(prevouts);

  // hashAmounts = SHA256(amount_8LE)  [amount = 0n for virtual input]
  const amounts = writeUint64LE(0n);
  const hashAmounts = hashSha256Sync(amounts);

  // hashScriptPubkeys = SHA256(varint(scriptPubKey.length) || scriptPubKey)
  const scriptPubKeyWithLen = concatBytes(encodeVarInt(scriptPubKey.length), scriptPubKey);
  const hashScriptPubkeys = hashSha256Sync(scriptPubKeyWithLen);

  // hashSequences = SHA256(sequence_4LE)  [sequence = 0]
  const sequences = writeUint32LE(0);
  const hashSequences = hashSha256Sync(sequences);

  // hashOutputs = SHA256(amount_8LE || varint(script.length) || script)
  // Output: amount=0n, script=OP_RETURN
  const opReturnScript = Script.encode(["RETURN"]);
  const outputBytes = concatBytes(
    writeUint64LE(0n),
    encodeVarInt(opReturnScript.length),
    opReturnScript
  );
  const hashOutputs = hashSha256Sync(outputBytes);

  // sigMsg assembly (BIP341)
  const sigMsg = concatBytes(
    new Uint8Array([0x00]),     // epoch
    new Uint8Array([0x00]),     // hashType = SIGHASH_DEFAULT
    writeUint32LE(0),           // nVersion = 0
    writeUint32LE(0),           // nLockTime = 0
    hashPrevouts,               // 32 bytes
    hashAmounts,                // 32 bytes
    hashScriptPubkeys,          // 32 bytes
    hashSequences,              // 32 bytes
    hashOutputs,                // 32 bytes
    new Uint8Array([0x00]),     // spend_type = 0 (key-path, no annex)
    writeUint32LE(0)            // input_index = 0
  );

  // tagged_hash("TapSighash", sigMsg) = SHA256(SHA256(tag) || SHA256(tag) || sigMsg)
  const tagBytes = new TextEncoder().encode("TapSighash");
  const tagHash = hashSha256Sync(tagBytes);
  const sighash = hashSha256Sync(concatBytes(tagHash, tagHash, sigMsg));

  return schnorr.verify(schnorrSig, sighash, tweakedKey);
}

// ---------------------------------------------------------------------------
// BtcVerifyService
// ---------------------------------------------------------------------------

/**
 * BtcVerifyService handles Bitcoin signature verification using BIP-137 and BIP-322.
 *
 * Address routing:
 * - P2PKH (1...) and P2SH (3...): BIP-137 verification via @noble/curves (secp256k1 key recovery)
 * - P2WPKH (bc1q...): BIP-322 "simple" verification (ECDSA + witness)
 * - P2TR (bc1p...): BIP-322 "simple" verification (Schnorr + witness)
 *
 * Supports two signing paths:
 * 1. Registration: bare message "Bitcoin will be the currency of AIs"
 * 2. Self-service: message with timestamp "Bitcoin will be the currency of AIs | {ISO-timestamp}"
 */
export class BtcVerifyService {
  constructor(private logger: Logger) {}

  /**
   * Verify a Bitcoin signature (BIP-137 or BIP-322) against a Bitcoin address and message.
   * Routes to the correct verification path based on address type and signature format.
   */
  verify(
    btcAddress: string,
    message: string,
    signature: string
  ): BtcVerifyResult {
    let addressType: BtcAddressType = "unknown";
    try {
      addressType = detectAddressType(btcAddress);

      // Determine path: registration (bare message) or self-service (with timestamp)
      if (message === BTC_MESSAGES.BASE) {
        return this.verifyAndReturn(btcAddress, message, signature, "registration", undefined, addressType);
      }

      // Check for self-service path (message with timestamp)
      const timestampMatch = message.match(BTC_MESSAGES.SELF_SERVICE_PATTERN);
      if (!timestampMatch) {
        this.logger.warn("Invalid message format", { message });
        return {
          valid: false,
          error: `Message must be either "${BTC_MESSAGES.BASE}" or "${BTC_MESSAGES.BASE} | {ISO-timestamp}"`,
          code: "INVALID_MESSAGE_FORMAT",
        };
      }

      // Validate timestamp freshness
      const timestamp = timestampMatch[1];
      const timestampError = this.validateTimestamp(timestamp);
      if (timestampError) {
        return timestampError;
      }

      return this.verifyAndReturn(btcAddress, message, signature, "self-service", timestamp, addressType);
    } catch (error) {
      this.logger.warn("BTC verification error", {
        error: error instanceof Error ? error.message : "Unknown error",
        btcAddress,
        addressType,
      });
      return {
        valid: false,
        error: "Signature verification failed due to internal error",
        code: "VERIFICATION_ERROR",
      };
    }
  }

  /**
   * Verify signature and return a typed result for the given path.
   */
  private verifyAndReturn(
    btcAddress: string,
    message: string,
    signature: string,
    path: "registration" | "self-service",
    timestamp?: string,
    addressType?: BtcAddressType
  ): BtcVerifyResult {
    const { verified, reason } = this.verifySignatureWithReason(btcAddress, message, signature);

    if (!verified) {
      this.logger.warn(`${path} signature verification failed`, { btcAddress, message, addressType, reason });
      return {
        valid: false,
        error: `Invalid signature for ${path} message`,
        code: "INVALID_SIGNATURE",
      };
    }

    this.logger.info(`${path} signature verified`, { btcAddress, addressType, ...(timestamp && { timestamp }) });
    return { valid: true, path, timestamp };
  }

  /**
   * Validate timestamp format and freshness, returning an error result if invalid.
   */
  private validateTimestamp(timestamp: string): BtcVerifyResult | null {
    const timestampDate = new Date(timestamp);
    if (isNaN(timestampDate.getTime())) {
      this.logger.warn("Invalid timestamp format", { timestamp });
      return {
        valid: false,
        error: "Timestamp must be a valid ISO 8601 date string",
        code: "INVALID_MESSAGE_FORMAT",
      };
    }

    const age = Date.now() - timestampDate.getTime();

    if (age > MAX_TIMESTAMP_AGE_MS) {
      const ageMinutes = Math.floor(age / 1000 / 60);
      this.logger.warn("Timestamp too old", { timestamp, ageMinutes, maxMinutes: 5 });
      return {
        valid: false,
        error: `Timestamp must be within 5 minutes. Current age: ${ageMinutes} minutes`,
        code: "STALE_TIMESTAMP",
      };
    }

    if (age < -MAX_FUTURE_TOLERANCE_MS) {
      this.logger.warn("Timestamp is in the future", { timestamp, age });
      return {
        valid: false,
        error: "Timestamp cannot be more than 1 minute in the future",
        code: "STALE_TIMESTAMP",
      };
    }

    return null;
  }

  /**
   * Low-level signature verification.
   *
   * Routes by signature format:
   * - BIP-137 (65 bytes, header 27-42): used by P2PKH and P2SH wallets
   * - BIP-322 (witness-serialized): used by P2WPKH (bc1q) and P2TR (bc1p) wallets
   *
   * Returns both the verification result and the underlying error reason (if any),
   * so callers can surface actionable messages rather than a bare boolean.
   */
  private verifySignatureWithReason(
    address: string,
    message: string,
    signature: string
  ): { verified: boolean; reason?: string } {
    try {
      const sigBytes = new Uint8Array(Buffer.from(signature, "base64"));

      if (isBip137Signature(sigBytes)) {
        // BIP-137 path: P2PKH (1...) and P2SH-P2WPKH (3...)
        const verified = verifyBip137(address, message, signature);
        return { verified };
      } else {
        // BIP-322 path: P2WPKH (bc1q...) and P2TR (bc1p...)
        const addressType = detectAddressType(address);
        let verified = false;
        if (addressType === "P2WPKH") {
          verified = bip322VerifyP2WPKH(message, signature, address);
        } else if (addressType === "P2TR") {
          verified = bip322VerifyP2TR(message, signature, address);
        } else {
          return {
            verified: false,
            reason: `BIP-322 not supported for address type: ${addressType}`,
          };
        }
        return { verified };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn("Low-level signature verification error", { error: reason, address });
      return { verified: false, reason };
    }
  }

  /**
   * Generate a self-service message with current timestamp.
   * Helper method for clients generating self-service messages.
   */
  static generateSelfServiceMessage(): string {
    return `${BTC_MESSAGES.BASE} | ${new Date().toISOString()}`;
  }
}
