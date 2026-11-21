import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { p2pkh } from "@scure/btc-signer";
import { hashSha256Sync } from "@stacks/encryption";
import { BtcVerifyService, BTC_MESSAGES } from "../services/btc-verify";
import type { Logger } from "../types";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

// BIP-137 message hash: dsha256("\x18Bitcoin Signed Message:\n" || varint(len) || msg)
function bip137Hash(message: string): Uint8Array {
  const prefix = new TextEncoder().encode("\x18Bitcoin Signed Message:\n");
  const msg = new TextEncoder().encode(message);
  const buf = new Uint8Array(prefix.length + 1 + msg.length);
  buf.set(prefix, 0);
  buf[prefix.length] = msg.length; // < 0xfd
  buf.set(msg, prefix.length + 1);
  return hashSha256Sync(hashSha256Sync(buf));
}

// Sign the way a legacy wallet does: header = base + recovery id.
function signBip137(priv: Uint8Array, message: string, headerBase: 27 | 31): string {
  const rec = secp256k1.sign(bip137Hash(message), priv, { prehash: false, format: "recovered" });
  const out = new Uint8Array(65);
  out[0] = headerBase + rec[0];
  out.set(rec.slice(1), 1);
  return Buffer.from(out).toString("base64");
}

const priv = new Uint8Array(32).fill(7);
const svc = new BtcVerifyService(logger);

describe("BIP-137 P2PKH signatures (header 27-34)", () => {
  it("accepts a compressed-key P2PKH signature (header 31-34) [control]", async () => {
    const address = p2pkh(secp256k1.getPublicKey(priv, true)).address!;
    const sig = signBip137(priv, BTC_MESSAGES.BASE, 31);
    const res = await svc.verify(address, BTC_MESSAGES.BASE, sig, "bip137");
    expect(res.valid, `compressed control failed: ${res.reason}`).toBe(true);
  });

  it("accepts an uncompressed-key P2PKH signature (header 27-30)", async () => {
    const address = p2pkh(secp256k1.getPublicKey(priv, false)).address!;
    const sig = signBip137(priv, BTC_MESSAGES.BASE, 27);
    const res = await svc.verify(address, BTC_MESSAGES.BASE, sig, "bip137");
    expect(res.valid, `valid uncompressed sig rejected: ${res.reason}`).toBe(true);
  });

  it("rejects a header-27 signature presented for the compressed-key address", async () => {
    const compressedAddress = p2pkh(secp256k1.getPublicKey(priv, true)).address!;
    const sig = signBip137(priv, BTC_MESSAGES.BASE, 27);
    const res = await svc.verify(compressedAddress, BTC_MESSAGES.BASE, sig, "bip137");
    expect(res.valid, "header-27 sig must not validate for the compressed address").toBe(false);
  });
});
