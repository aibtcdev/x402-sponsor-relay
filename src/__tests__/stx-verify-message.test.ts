/**
 * Unit tests for plain message signature format tolerance in StxVerifyService.
 *
 * Mirrors stx-verify-sip018.test.ts — same RSV / VRS / raw matrix, same
 * recovery-byte normalization (27→0, 28→1), applied to verifyMessage and
 * verifyProvisionMessage so that BIP-137 wallets (Leather older paths,
 * v ∈ {27,28}) are not silently rejected on the plain-message surface.
 */

import { describe, it, expect } from "vitest";
import { makeRandomPrivKey, getAddressFromPublicKey } from "@stacks/transactions";
import { hashMessage, ecSign } from "@stacks/encryption";
import { hexToBytes, bytesToHex } from "@stacks/common";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { StxVerifyService, STX_MESSAGES } from "../services/stx-verify";
import type { Logger } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeService(network: "mainnet" | "testnet" = "mainnet"): StxVerifyService {
  return new StxVerifyService(noopLogger, network);
}

// Produce a 65-byte RSV hex signature (r||s||v) using @stacks/encryption.ecSign + Stacks message hash.
// ecSign uses secp256k1 signSync with { der: false } which produces compact ECDSA bytes compatible
// with Signature.fromBytes recovery. We find the recovery ID by trying both and matching the expected pubkey.
function signPlainMessage(message: string, privateKey: string): string {
  const hash = hashMessage(message);
  const privKeyBytes = hexToBytes(privateKey).slice(0, 32);
  const pubKeyHex = bytesToHex(secp256k1.getPublicKey(privKeyBytes, true));
  const compact = ecSign(hash, privateKey);
  for (const rec of [0, 1] as const) {
    try {
      const recovered = secp256k1.Signature.fromBytes(compact).addRecoveryBit(rec).recoverPublicKey(hash).toHex(true);
      if (recovered === pubKeyHex) {
        const rsv = new Uint8Array(65);
        rsv.set(compact, 0);
        rsv[64] = rec;
        return bytesToHex(rsv);
      }
    } catch {}
  }
  throw new Error("Could not determine recovery ID for test fixture");
}

// Rotate a 65-byte RSV hex signature to VRS layout with v ∈ {27,28}
function rsvToVrs(rsvHex: string): string {
  const b = hexToBytes(rsvHex);
  if (b.length !== 65) throw new Error("Expected 65-byte RSV signature");
  const vrs = new Uint8Array(65);
  vrs[0] = b[64] + 27; // 0→27, 1→28
  vrs.set(b.slice(0, 64), 1);
  return bytesToHex(vrs);
}

// Strip last byte to get raw 64-byte r||s
function rsvToRaw(rsvHex: string): string {
  const b = hexToBytes(rsvHex);
  if (b.length !== 65) throw new Error("Expected 65-byte RSV signature");
  return bytesToHex(b.slice(0, 64));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StxVerifyService.verifyMessage — signature format tolerance", () => {
  const MESSAGE = STX_MESSAGES.BASE;

  it("accepts 65-byte RSV signature (native @stacks output)", () => {
    const privateKey = makeRandomPrivKey();
    const pubKeyBytes = secp256k1.getPublicKey(hexToBytes(privateKey).slice(0, 32), true);
    const address = getAddressFromPublicKey(bytesToHex(pubKeyBytes), "mainnet");
    const sig = signPlainMessage(MESSAGE, privateKey);

    const result = makeService().verifyMessage(sig, MESSAGE);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(address);
  });

  it("accepts 65-byte VRS signature with v ∈ {27,28} (BIP-137 style)", () => {
    const privateKey = makeRandomPrivKey();
    const pubKeyBytes = secp256k1.getPublicKey(hexToBytes(privateKey).slice(0, 32), true);
    const address = getAddressFromPublicKey(bytesToHex(pubKeyBytes), "mainnet");
    const vrsSig = rsvToVrs(signPlainMessage(MESSAGE, privateKey));

    const result = makeService().verifyMessage(vrsSig, MESSAGE);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(address);
  });

  it("accepts 64-byte raw r||s signature by trying both recovery IDs", () => {
    const privateKey = makeRandomPrivKey();
    const pubKeyBytes = secp256k1.getPublicKey(hexToBytes(privateKey).slice(0, 32), true);
    const address = getAddressFromPublicKey(bytesToHex(pubKeyBytes), "mainnet");
    const rawSig = rsvToRaw(signPlainMessage(MESSAGE, privateKey));

    const result = makeService().verifyMessage(rawSig, MESSAGE);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(address);
  });

  it("rejects garbage hex", () => {
    const result = makeService().verifyMessage("deadbeef", MESSAGE);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("INVALID_SIGNATURE");
  });

  it("rejects a signature produced for a different message", () => {
    const privateKey = makeRandomPrivKey();
    const sig = signPlainMessage("not the right message", privateKey);

    const result = makeService().verifyMessage(sig, MESSAGE);
    // Recovers a pubkey — but it's the wrong one; result.valid may be true with wrong address,
    // which is expected (verifyMessage does not gate on address). What matters is that the
    // recovered address is NOT the address of privateKey.
    const pubKeyBytes = secp256k1.getPublicKey(hexToBytes(privateKey).slice(0, 32), true);
    const correctAddress = getAddressFromPublicKey(bytesToHex(pubKeyBytes), "mainnet");
    if (result.valid) {
      expect(result.stxAddress).not.toBe(correctAddress);
    }
  });
});

describe("StxVerifyService.verifyProvisionMessage — VRS tolerance", () => {
  it("accepts VRS-format signature on base message (registration path)", () => {
    const privateKey = makeRandomPrivKey();
    const pubKeyBytes = secp256k1.getPublicKey(hexToBytes(privateKey).slice(0, 32), true);
    const address = getAddressFromPublicKey(bytesToHex(pubKeyBytes), "mainnet");
    const vrsSig = rsvToVrs(signPlainMessage(STX_MESSAGES.BASE, privateKey));

    const result = makeService().verifyProvisionMessage(vrsSig, STX_MESSAGES.BASE);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(address);
  });
});
