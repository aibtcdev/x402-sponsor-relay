/**
 * Unit tests for StxVerifyService — 0x-prefix handling and signature validation.
 *
 * Covers:
 * - verifyMessage: unprefixed, 0x-prefixed, 0X-prefixed, and garbage signatures
 * - verifySip018: same four cases applied to the SIP-018 structured-data path
 * - Edge cases: too-short hex (128 chars) and too-long hex (132 chars)
 *
 * Uses a real key pair with inline fixture generation for self-consistent results.
 * No mocking of publicKeyFromSignatureRsv — real Stacks.js crypto throughout.
 * No beforeAll/beforeEach state: each test is independent (vitest convention).
 */

import { describe, it, expect } from "vitest";
import {
  getAddressFromPrivateKey,
  tupleCV,
  uintCV,
  stringAsciiCV,
  signMessageHashRsv,
  signStructuredData,
} from "@stacks/transactions";
import { hashMessage } from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";
import { StxVerifyService, STX_MESSAGES } from "../services/stx-verify";
import { SIP018_DOMAIN } from "../types";
import type { Logger } from "../types";

// ---------------------------------------------------------------------------
// Shared test doubles
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Logger that captures warn calls for assertions in invalid-input tests.
function makeCaptureLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (msg: string) => warns.push(msg),
    error: () => {},
    debug: () => {},
  };
  return { logger, warns };
}

function makeService(network: "mainnet" | "testnet" = "testnet"): StxVerifyService {
  return new StxVerifyService(noopLogger, network);
}

// ---------------------------------------------------------------------------
// Fixture: generate real RSV signatures with a known private key.
//
// Private key: a stable test key (never used for real funds).
// signMessageHashRsv (@stacks/transactions) returns a 130-char hex string directly.
// signStructuredData (@stacks/transactions) returns a 130-char hex string directly.
// ---------------------------------------------------------------------------

const FIXTURE_PRIVATE_KEY =
  "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801";
const FIXTURE_MESSAGE = STX_MESSAGES.BASE;
const FIXTURE_ADDRESS = getAddressFromPrivateKey(FIXTURE_PRIVATE_KEY, "testnet");

function signPlainMessage(message: string, privateKey: string): string {
  const messageHash = hashMessage(message);
  const messageHashHex = bytesToHex(messageHash);
  // signMessageHashRsv returns a 130-char hex string (no 0x prefix)
  return signMessageHashRsv({ messageHash: messageHashHex, privateKey });
}

const FIXTURE_SIG = signPlainMessage(FIXTURE_MESSAGE, FIXTURE_PRIVATE_KEY);

// SIP-018 fixture: sign a real domain+message tuple with signStructuredData
const SIP018_DOMAIN_TESTNET = SIP018_DOMAIN.testnet;
const SIP018_DOMAIN_TUPLE = tupleCV({
  name: stringAsciiCV(SIP018_DOMAIN_TESTNET.name),
  version: stringAsciiCV(SIP018_DOMAIN_TESTNET.version),
  "chain-id": uintCV(SIP018_DOMAIN_TESTNET.chainId),
});
const SIP018_MESSAGE_TUPLE = tupleCV({
  action: stringAsciiCV("relay"),
  nonce: uintCV(1708099200000),
  expiry: uintCV(9999999999999),
});
// signStructuredData returns a 130-char hex string (no 0x prefix)
const SIP018_FIXTURE_SIG = signStructuredData({
  domain: SIP018_DOMAIN_TUPLE,
  message: SIP018_MESSAGE_TUPLE,
  privateKey: FIXTURE_PRIVATE_KEY,
});
const SIP018_FIXTURE_ADDRESS = FIXTURE_ADDRESS; // same key, same address

// ---------------------------------------------------------------------------
// verifyMessage — the four required cases (QUEST.md acceptance criterion #4)
// ---------------------------------------------------------------------------

describe("StxVerifyService.verifyMessage — 0x prefix handling", () => {
  it("(a) accepts a valid signature without 0x prefix", () => {
    const service = makeService("testnet");
    const result = service.verifyMessage(FIXTURE_SIG, FIXTURE_MESSAGE);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.stxAddress).toBe(FIXTURE_ADDRESS);
      expect(result.path).toBe("plain-message");
    }
  });

  it("(b) accepts the same valid signature with lowercase 0x prefix", () => {
    const service = makeService("testnet");
    const result = service.verifyMessage(`0x${FIXTURE_SIG}`, FIXTURE_MESSAGE);

    expect(result.valid).toBe(true);
    if (result.valid) {
      // Recovered address must match — proves the prefix was stripped correctly.
      expect(result.stxAddress).toBe(FIXTURE_ADDRESS);
      expect(result.path).toBe("plain-message");
    }
  });

  it("(c) accepts the same valid signature with uppercase 0X prefix", () => {
    const service = makeService("testnet");
    const result = service.verifyMessage(`0X${FIXTURE_SIG}`, FIXTURE_MESSAGE);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.stxAddress).toBe(FIXTURE_ADDRESS);
      expect(result.path).toBe("plain-message");
    }
  });

  it("(d) rejects garbage input with INVALID_SIGNATURE, not VERIFICATION_ERROR", () => {
    const { logger, warns } = makeCaptureLogger();
    const service = new StxVerifyService(logger, "testnet");
    const result = service.verifyMessage("not-a-real-sig", FIXTURE_MESSAGE);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("INVALID_SIGNATURE");
      expect(result.code).not.toBe("VERIFICATION_ERROR");
    }
    // Must emit warn, not error — no ERROR-level noise for client-malformed input
    expect(warns.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// verifyMessage — edge cases from DECISION.md
// ---------------------------------------------------------------------------

describe("StxVerifyService.verifyMessage — edge cases", () => {
  it("rejects a too-short hex signature (128 chars) with INVALID_SIGNATURE", () => {
    const service = makeService("testnet");
    // 128 hex chars = 64 bytes, one byte short of the required 65-byte RSV
    const result = service.verifyMessage("a".repeat(128), FIXTURE_MESSAGE);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("INVALID_SIGNATURE");
    }
  });

  it("rejects a too-long hex signature (132 chars) with INVALID_SIGNATURE", () => {
    const service = makeService("testnet");
    // 132 hex chars = 66 bytes, one byte over the required 65-byte RSV
    const result = service.verifyMessage("a".repeat(132), FIXTURE_MESSAGE);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("INVALID_SIGNATURE");
    }
  });
});

// ---------------------------------------------------------------------------
// verifySip018 — same four required cases applied to the SIP-018 path
// ---------------------------------------------------------------------------

describe("StxVerifyService.verifySip018 — 0x prefix handling", () => {
  it("(a) accepts a valid SIP-018 signature without 0x prefix", () => {
    const service = makeService("testnet");
    const result = service.verifySip018({
      signature: SIP018_FIXTURE_SIG,
      domain: SIP018_DOMAIN_TUPLE,
      message: SIP018_MESSAGE_TUPLE,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.stxAddress).toBe(SIP018_FIXTURE_ADDRESS);
      expect(result.path).toBe("sip018");
    }
  });

  it("(b) accepts a SIP-018 signature with lowercase 0x prefix", () => {
    const service = makeService("testnet");
    const result = service.verifySip018({
      signature: `0x${SIP018_FIXTURE_SIG}`,
      domain: SIP018_DOMAIN_TUPLE,
      message: SIP018_MESSAGE_TUPLE,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.stxAddress).toBe(SIP018_FIXTURE_ADDRESS);
      expect(result.path).toBe("sip018");
    }
  });

  it("(c) accepts a SIP-018 signature with uppercase 0X prefix", () => {
    const service = makeService("testnet");
    const result = service.verifySip018({
      signature: `0X${SIP018_FIXTURE_SIG}`,
      domain: SIP018_DOMAIN_TUPLE,
      message: SIP018_MESSAGE_TUPLE,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.stxAddress).toBe(SIP018_FIXTURE_ADDRESS);
      expect(result.path).toBe("sip018");
    }
  });

  it("(d) rejects garbage SIP-018 input with INVALID_SIGNATURE, not VERIFICATION_ERROR", () => {
    const { logger, warns } = makeCaptureLogger();
    const service = new StxVerifyService(logger, "testnet");
    const result = service.verifySip018({
      signature: "not-a-real-sig",
      domain: SIP018_DOMAIN_TUPLE,
      message: SIP018_MESSAGE_TUPLE,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("INVALID_SIGNATURE");
      expect(result.code).not.toBe("VERIFICATION_ERROR");
    }
    expect(warns.length).toBeGreaterThan(0);
  });
});
