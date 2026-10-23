/**
 * Regression tests for issue #433: /keys/provision* returned ALREADY_PROVISIONED
 * forever once an address's key passed its 30-day expiry, because
 * provisionKeyByAddress threw DuplicateAddressError on any existing index
 * entry without checking whether that key had actually expired.
 *
 * Covered:
 *   - a still-valid existing key still throws DuplicateAddressError (no regression)
 *   - an expired existing key is replaced: a fresh key is returned, the old
 *     key's metadata is deactivated, and the address index points at the new key
 *   - renewal only happens when the caller allows it (the timestamped
 *     self-service path); a bare registration signature never expires, so a
 *     replayed copy must not mint a new key
 */

import { describe, expect, it } from "vitest";
import { AuthService, DuplicateAddressError } from "../services/auth";
import { MemoryKV } from "./helpers/memory-kv";
import type { ApiKeyMetadata, Logger } from "../types";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("AuthService.provisionKey — expired-address renewal", () => {
  it("still refuses a second provision while the existing key is valid", async () => {
    const kv = new MemoryKV();
    const auth = new AuthService(kv, noopLogger);
    const btcAddress = "bc1qexamplevalid0000000000000000000000";

    await auth.provisionKey(btcAddress);

    await expect(
      auth.provisionKey(btcAddress, { allowRenewal: true })
    ).rejects.toBeInstanceOf(DuplicateAddressError);
  });

  // Backdate an issued key so it reads as expired, the way a real key would
  // after 30 days — same KV record shape storeKeyMetadata writes.
  async function expire(kv: MemoryKV, metadata: ApiKeyMetadata): Promise<string> {
    const keyHash = await kv.get(`keyId:${metadata.keyId}`);
    expect(keyHash).not.toBeNull();
    await kv.put(
      `key:${keyHash as string}`,
      JSON.stringify({ ...metadata, expiresAt: new Date(Date.now() - 1000).toISOString() })
    );
    return keyHash as string;
  }

  it("does not renew an expired key without allowRenewal (bare-signature replay)", async () => {
    const kv = new MemoryKV();
    const auth = new AuthService(kv, noopLogger);
    const btcAddress = "bc1qexamplereplay0000000000000000000000";

    const first = await auth.provisionKey(btcAddress);
    await expire(kv, first.metadata);

    const err = await auth.provisionKey(btcAddress).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateAddressError);
    expect((err as DuplicateAddressError).renewalRequiresTimestamp).toBe(true);

    // Nothing changed: the index still points at the original key.
    expect(await kv.get(`btc:${btcAddress}`)).toBe(first.metadata.keyId);
  });

  it("replaces an expired key instead of 409ing forever", async () => {
    const kv = new MemoryKV();
    const auth = new AuthService(kv, noopLogger);
    const btcAddress = "bc1qexampleexpired000000000000000000000";

    const first = await auth.provisionKey(btcAddress);
    const keyHash = await expire(kv, first.metadata);

    const second = await auth.provisionKey(btcAddress, { allowRenewal: true });

    // A fresh key was issued, not the stale 409.
    expect(second.apiKey).not.toBe(first.apiKey);
    expect(second.metadata.keyId).not.toBe(first.metadata.keyId);
    expect(new Date(second.metadata.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The old key is deactivated for hygiene, not deleted or left active.
    const oldMetadata = await kv.get<ApiKeyMetadata>(`key:${keyHash}`, "json");
    expect(oldMetadata?.active).toBe(false);

    // The address index now resolves to the new key, and a validate on the
    // old plaintext key reflects revocation rather than expiry.
    const indexedKeyId = await kv.get(`btc:${btcAddress}`);
    expect(indexedKeyId).toBe(second.metadata.keyId);

    const validated = await auth.validateKey(second.apiKey);
    expect(validated.valid).toBe(true);
  });
});
