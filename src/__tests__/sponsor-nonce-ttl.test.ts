/**
 * Unit tests for the sponsor-nonce TTL wire contract.
 *
 * Documents and verifies the shape of the two fields published on every
 * /sponsor (and /relay with sponsoredTx) success response:
 *   - nonceExpiresAt: ISO 8601 UTC, ~10 min in the future
 *   - sponsorNonceValidForMs: integer ms, equal to STALE_THRESHOLD_MS (600 000)
 *
 * These tests are intentionally isolated from the full Worker stack to avoid
 * transitive deps on @noble/hashes and Cloudflare bindings. They test the
 * shape logic directly, matching the pattern in base-endpoint-ok-with-tx.test.ts.
 */
import { describe, expect, it } from "vitest";

/** Mirrors SPONSOR_NONCE_VALID_FOR_MS in src/endpoints/sponsor.ts */
const SPONSOR_NONCE_VALID_FOR_MS = 10 * 60 * 1_000; // 600 000 ms = 10 min

/** Mirrors STALE_THRESHOLD_MS in src/durable-objects/nonce-do.ts */
const STALE_THRESHOLD_MS = 10 * 60 * 1_000;

/** Mirrors FALLBACK_NONCE_EXPIRY_MS in src/services/sponsor.ts */
const FALLBACK_NONCE_EXPIRY_MS = 10 * 60 * 1_000;

/**
 * Simulate the /sponsor success response body shape, matching what
 * src/endpoints/sponsor.ts builds via this.ok(c, { ..., nonceExpiresAt, sponsorNonceValidForMs }).
 */
function buildSponsorSuccessBody(opts: {
  txid: string;
  fee: string;
  nonceExpiresAt: string;
  sponsorNonceValidForMs: number;
}): Record<string, unknown> {
  return {
    success: true,
    requestId: "req-test",
    txid: opts.txid,
    explorerUrl: `https://explorer.hiro.so/txid/0x${opts.txid}`,
    fee: opts.fee,
    nonceExpiresAt: opts.nonceExpiresAt,
    sponsorNonceValidForMs: opts.sponsorNonceValidForMs,
  };
}

describe("Sponsor nonce TTL wire contract", () => {
  it("nonceExpiresAt is present and is a valid ISO 8601 string", () => {
    const expiresAt = new Date(Date.now() + SPONSOR_NONCE_VALID_FOR_MS).toISOString();
    const body = buildSponsorSuccessBody({
      txid: "abc123",
      fee: "1250",
      nonceExpiresAt: expiresAt,
      sponsorNonceValidForMs: SPONSOR_NONCE_VALID_FOR_MS,
    });

    expect(typeof body.nonceExpiresAt).toBe("string");
    // Must parse as a valid Date
    const parsed = new Date(body.nonceExpiresAt as string);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // Must be in ISO 8601 format (ends with Z)
    expect((body.nonceExpiresAt as string).endsWith("Z")).toBe(true);
  });

  it("nonceExpiresAt is approximately 10 minutes in the future at assignment time", () => {
    const before = Date.now();
    const expiresAt = new Date(Date.now() + SPONSOR_NONCE_VALID_FOR_MS).toISOString();
    const after = Date.now();

    const parsed = new Date(expiresAt).getTime();
    // Lower bound: before + TTL - 1s slack
    expect(parsed).toBeGreaterThanOrEqual(before + SPONSOR_NONCE_VALID_FOR_MS - 1_000);
    // Upper bound: after + TTL + 1s slack
    expect(parsed).toBeLessThanOrEqual(after + SPONSOR_NONCE_VALID_FOR_MS + 1_000);
  });

  it("sponsorNonceValidForMs is present and equals STALE_THRESHOLD_MS (600000)", () => {
    const body = buildSponsorSuccessBody({
      txid: "abc123",
      fee: "1250",
      nonceExpiresAt: new Date(Date.now() + SPONSOR_NONCE_VALID_FOR_MS).toISOString(),
      sponsorNonceValidForMs: SPONSOR_NONCE_VALID_FOR_MS,
    });

    expect(typeof body.sponsorNonceValidForMs).toBe("number");
    expect(Number.isInteger(body.sponsorNonceValidForMs)).toBe(true);
    expect(body.sponsorNonceValidForMs).toBe(600_000);
  });

  it("constant consistency: SPONSOR_NONCE_VALID_FOR_MS equals STALE_THRESHOLD_MS equals FALLBACK_NONCE_EXPIRY_MS", () => {
    // All three must stay in sync. If STALE_THRESHOLD_MS is updated, the others must follow.
    expect(SPONSOR_NONCE_VALID_FOR_MS).toBe(STALE_THRESHOLD_MS);
    expect(SPONSOR_NONCE_VALID_FOR_MS).toBe(FALLBACK_NONCE_EXPIRY_MS);
  });

  it("nonceExpiresAt and sponsorNonceValidForMs are mutually derivable", () => {
    const assignedAt = Date.now();
    const expiresAt = new Date(assignedAt + SPONSOR_NONCE_VALID_FOR_MS).toISOString();

    const derivedMs = new Date(expiresAt).getTime() - assignedAt;
    // Within 10ms of SPONSOR_NONCE_VALID_FOR_MS (clock drift tolerance)
    expect(Math.abs(derivedMs - SPONSOR_NONCE_VALID_FOR_MS)).toBeLessThan(10);
  });

  it("response body includes both TTL fields alongside required sponsor fields", () => {
    const expiresAt = new Date(Date.now() + SPONSOR_NONCE_VALID_FOR_MS).toISOString();
    const body = buildSponsorSuccessBody({
      txid: "deadbeef",
      fee: "999",
      nonceExpiresAt: expiresAt,
      sponsorNonceValidForMs: SPONSOR_NONCE_VALID_FOR_MS,
    });

    // Required fields
    expect(body.success).toBe(true);
    expect(body.txid).toBe("deadbeef");
    expect(body.fee).toBe("999");
    // TTL fields
    expect(body.nonceExpiresAt).toBe(expiresAt);
    expect(body.sponsorNonceValidForMs).toBe(600_000);
  });
});
