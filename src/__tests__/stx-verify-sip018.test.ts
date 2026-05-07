/**
 * Unit tests for SIP-018 signature format tolerance in StxVerifyService.
 *
 * Stacks signers disagree on wire format and recovery-id convention:
 *   - @stacks/transactions signStructuredData → 65-byte RSV (r||s||v), v ∈ {0,1}
 *   - Leather / some BIP-137 signers        → 65-byte VRS (v||r||s), v ∈ {27,28}
 *   - @noble/curves raw output              → 64-byte r||s, recovery bit separate
 *
 * These tests confirm that verifySip018 accepts all three formats (and recovery-byte
 * normalization 27→0, 28→1), and that it accepts both mainnet and testnet address
 * encodings when checking expectedAddress.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { makeRandomPrivKey, signStructuredData, getAddressFromPublicKey, tupleCV, uintCV, stringAsciiCV } from "@stacks/transactions";
import { hexToBytes, bytesToHex } from "@stacks/common";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { StxVerifyService } from "../services/stx-verify";
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

// Rotate an RSV 65-byte hex signature to VRS layout with v ∈ {27,28}
function rsvToVrs(rsvHex: string): string {
  const b = hexToBytes(rsvHex);
  if (b.length !== 65) throw new Error("Expected 65-byte RSV signature");
  const v = b[64];
  const vBip137 = v + 27; // 0→27, 1→28
  const vrs = new Uint8Array(65);
  vrs[0] = vBip137;
  vrs.set(b.slice(0, 64), 1);
  return Buffer.from(vrs).toString("hex");
}

// Strip last byte to get raw 64-byte r||s
function rsvToRaw(rsvHex: string): string {
  const b = hexToBytes(rsvHex);
  if (b.length !== 65) throw new Error("Expected 65-byte RSV signature");
  return Buffer.from(b.slice(0, 64)).toString("hex");
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DOMAIN = tupleCV({
  name: stringAsciiCV("x402-sponsor-relay"),
  version: stringAsciiCV("1"),
  "chain-id": uintCV(1),
});

const MESSAGE = tupleCV({
  action: stringAsciiCV("relay"),
  nonce: uintCV(1715000000000),
  expiry: uintCV(9999999999999),
});

describe("StxVerifyService.verifySip018 — signature format tolerance", () => {
  let privateKey: string;
  let rsvSig: string;
  let mainnetAddress: string;
  let testnetAddress: string;
  let service: StxVerifyService;

  beforeEach(() => {
    privateKey = makeRandomPrivKey();
    // makeRandomPrivKey returns 33-byte hex (32-byte scalar + 01 compression flag); strip flag for noble
    const pubKeyBytes = secp256k1.getPublicKey(hexToBytes(privateKey).slice(0, 32), true);
    const pubKeyHex = bytesToHex(pubKeyBytes);
    mainnetAddress = getAddressFromPublicKey(pubKeyHex, "mainnet");
    testnetAddress = getAddressFromPublicKey(pubKeyHex, "testnet");

    // signStructuredData returns 65-byte RSV hex
    rsvSig = signStructuredData({
      message: MESSAGE,
      domain: DOMAIN,
      privateKey,
    });

    service = makeService("mainnet");
  });

  it("accepts 65-byte RSV signature (native @stacks output)", () => {
    const result = service.verifySip018({
      signature: rsvSig,
      domain: DOMAIN,
      message: MESSAGE,
      expectedAddress: mainnetAddress,
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(mainnetAddress);
  });

  it("accepts 65-byte VRS signature with v ∈ {27,28} (BIP-137 style)", () => {
    const vrsSig = rsvToVrs(rsvSig);
    const result = service.verifySip018({
      signature: vrsSig,
      domain: DOMAIN,
      message: MESSAGE,
      expectedAddress: mainnetAddress,
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(mainnetAddress);
  });

  it("accepts 64-byte raw r||s signature by trying both recovery IDs", () => {
    const rawSig = rsvToRaw(rsvSig);
    const result = service.verifySip018({
      signature: rawSig,
      domain: DOMAIN,
      message: MESSAGE,
      expectedAddress: mainnetAddress,
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(mainnetAddress);
  });

  it("accepts testnet address when checked against RSV signature (dual network check)", () => {
    const testnetService = makeService("testnet");
    // Same private key, same sig — but check testnet address
    const result = testnetService.verifySip018({
      signature: rsvSig,
      domain: DOMAIN,
      message: MESSAGE,
      expectedAddress: testnetAddress,
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(testnetAddress);
  });

  it("accepts testnet address even when service is configured for mainnet (dual address check)", () => {
    // service is mainnet-configured, but expectedAddress is testnet — should still match
    const result = service.verifySip018({
      signature: rsvSig,
      domain: DOMAIN,
      message: MESSAGE,
      expectedAddress: testnetAddress,
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(testnetAddress);
  });

  it("rejects a wrong address regardless of format", () => {
    const wrongKey = makeRandomPrivKey();
    const wrongPubKeyBytes = secp256k1.getPublicKey(hexToBytes(wrongKey).slice(0, 32), true);
    const wrongAddress = getAddressFromPublicKey(bytesToHex(wrongPubKeyBytes), "mainnet");

    const result = service.verifySip018({
      signature: rsvSig,
      domain: DOMAIN,
      message: MESSAGE,
      expectedAddress: wrongAddress,
    });
    expect(result.valid).toBe(false);
  });

  it("returns signer address when no expectedAddress is given (no-auth recovery path)", () => {
    const result = service.verifySip018({
      signature: rsvSig,
      domain: DOMAIN,
      message: MESSAGE,
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.stxAddress).toBe(mainnetAddress);
  });

  it("returns INVALID_SIGNATURE for garbage hex", () => {
    const result = service.verifySip018({
      signature: "deadbeef",
      domain: DOMAIN,
      message: MESSAGE,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("INVALID_SIGNATURE");
  });
});
