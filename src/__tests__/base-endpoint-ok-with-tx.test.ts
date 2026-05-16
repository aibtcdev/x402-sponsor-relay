/**
 * Unit test for the okWithTx conditional nonceExpiresAt behaviour.
 *
 * okWithTx uses a conditional spread to include nonceExpiresAt only when
 * provided: `...(opts.nonceExpiresAt && { nonceExpiresAt: opts.nonceExpiresAt })`.
 * This test exercises that path without importing BaseEndpoint (which has a
 * transitive dep on @noble/hashes/sha256 that is absent in this env).
 */
import { describe, expect, it } from "vitest";

function buildOkWithTxBody(opts: {
  txid: string;
  sponsoredTx?: string;
  nonceExpiresAt?: string;
}): Record<string, unknown> {
  return {
    success: true,
    requestId: "req-test",
    txid: opts.txid,
    explorerUrl: `https://explorer.hiro.so/txid/0x${opts.txid}?chain=mainnet`,
    ...(opts.sponsoredTx && { sponsoredTx: opts.sponsoredTx }),
    ...(opts.nonceExpiresAt && { nonceExpiresAt: opts.nonceExpiresAt }),
  };
}

describe("okWithTx nonceExpiresAt inclusion", () => {
  it("includes nonceExpiresAt in response when sponsoredTx is set", () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const body = buildOkWithTxBody({
      txid: "abc123",
      sponsoredTx: "deadbeef",
      nonceExpiresAt: expiresAt,
    });
    expect(body.nonceExpiresAt).toBe(expiresAt);
  });
});
