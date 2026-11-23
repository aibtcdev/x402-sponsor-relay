import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { p2pkh, p2sh, p2wpkh } from "@scure/btc-signer";
import { hashSha256Sync } from "@stacks/encryption";
import { BtcVerifyService, BTC_MESSAGES } from "../services/btc-verify";
import type { Logger } from "../types";

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

// Sign the way bitcoinjs-message does by default: header = 31-34 base + recovery id,
// regardless of the address's actual type.
function signBip137(priv: Uint8Array, message: string, headerBase: number): string {
  const rec = secp256k1.sign(bip137Hash(message), priv, { prehash: false, format: "recovered" });
  const out = new Uint8Array(65);
  out[0] = headerBase + rec[0];
  out.set(rec.slice(1), 1);
  return Buffer.from(out).toString("base64");
}

const priv = new Uint8Array(32).fill(7);
const pub = secp256k1.getPublicKey(priv, true);
const p2wpkhAddr = p2wpkh(pub).address!;
const p2shP2wpkhAddr = p2sh(p2wpkh(pub)).address!;
const p2pkhAddr = p2pkh(pub).address!;

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

describe("BIP-137 header/address-type mismatch (#502)", () => {
  it("accepts a header 31-34 signature for a native SegWit bc1q address", async () => {
    const logger = makeLogger();
    const svc = new BtcVerifyService(logger);
    const sig = signBip137(priv, BTC_MESSAGES.BASE, 31);
    const res = svc.verify(p2wpkhAddr, BTC_MESSAGES.BASE, sig);
    expect(res.valid, `bc1q + header-31 sig rejected: ${JSON.stringify(res)}`).toBe(true);
  });

  it("accepts a header 31-34 signature for a wrapped SegWit 3... address", async () => {
    const logger = makeLogger();
    const svc = new BtcVerifyService(logger);
    const sig = signBip137(priv, BTC_MESSAGES.BASE, 31);
    const res = svc.verify(p2shP2wpkhAddr, BTC_MESSAGES.BASE, sig);
    expect(res.valid, `3... + header-31 sig rejected: ${JSON.stringify(res)}`).toBe(true);
  });

  it("still accepts the spec-correct header 39-42 for a bc1q address", async () => {
    const logger = makeLogger();
    const svc = new BtcVerifyService(logger);
    const sig = signBip137(priv, BTC_MESSAGES.BASE, 39);
    const res = svc.verify(p2wpkhAddr, BTC_MESSAGES.BASE, sig);
    expect(res.valid).toBe(true);
  });

  it("still accepts header 31-34 for a P2PKH 1... address", async () => {
    const logger = makeLogger();
    const svc = new BtcVerifyService(logger);
    const sig = signBip137(priv, BTC_MESSAGES.BASE, 31);
    const res = svc.verify(p2pkhAddr, BTC_MESSAGES.BASE, sig);
    expect(res.valid).toBe(true);
  });
});

describe("BIP-137 failure reasons (#502)", () => {
  it("logs the derived addresses when the recovered key does not match", () => {
    const logger = makeLogger();
    const svc = new BtcVerifyService(logger);
    const otherPriv = new Uint8Array(32).fill(9);
    const sig = signBip137(otherPriv, BTC_MESSAGES.BASE, 31);
    const res = svc.verify(p2wpkhAddr, BTC_MESSAGES.BASE, sig);
    expect(res.valid).toBe(false);
    const warnCall = logger.warn.mock.calls.find((c) => String(c[0]).includes("signature verification failed"));
    expect(warnCall, "expected a warn log with failure reason").toBeTruthy();
    const meta = warnCall![1] as { reason?: string };
    expect(meta.reason).toContain("does not map to");
    expect(meta.reason).toContain("P2WPKH=");
  });

  it("rejects BIP-137 for a bc1p address with a Taproot-specific reason", () => {
    const logger = makeLogger();
    const svc = new BtcVerifyService(logger);
    const sig = signBip137(priv, BTC_MESSAGES.BASE, 39);
    const res = svc.verify("bc1p5d7rjq7g6r4d0k3j5h4g2f0q0w0e0r0t0y0u0i0o", BTC_MESSAGES.BASE, sig);
    expect(res.valid).toBe(false);
    const warnCall = logger.warn.mock.calls.find((c) => String(c[0]).includes("signature verification failed"));
    const meta = warnCall![1] as { reason?: string };
    expect(meta.reason).toContain("Taproot");
  });
});
