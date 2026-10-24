import { describe, it, expect } from "vitest";
import { deserializeTransaction, makeSTXTokenTransfer, sponsorTransaction, randomPrivateKey } from "@stacks/transactions";
import { isStructuralBroadcastFailure } from "../utils/broadcast-outcome";

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

describe("isStructuralBroadcastFailure (real @stacks/transactions throws)", () => {
  it("retires malformed hex that the old patterns missed", () => {
    for (const hex of ["zz", "00", "000000000104", ""]) {
      expect(isStructuralBroadcastFailure(thrown(() => deserializeTransaction(hex)))).toBe(true);
    }
  });

  it("retires sponsor-signing a standard (non-sponsored) tx", async () => {
    const tx = await makeSTXTokenTransfer({
      recipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
      amount: 1n,
      senderKey: randomPrivateKey(),
      network: "mainnet",
      fee: 200n,
      nonce: 0n,
    });
    const err = await sponsorTransaction({
      transaction: tx,
      sponsorPrivateKey: randomPrivateKey(),
      network: "mainnet",
      fee: 1n,
      sponsorNonce: 0n,
    }).then(() => null, (e: unknown) => e);
    expect(isStructuralBroadcastFailure(err)).toBe(true);
  });

  it("keeps the original patterns and leaves transient errors retryable", () => {
    expect(isStructuralBroadcastFailure(new Error("Failed to deserialize transaction"))).toBe(true);
    expect(isStructuralBroadcastFailure(new Error("malformed payload"))).toBe(true);
    expect(isStructuralBroadcastFailure(new Error("fetch failed"))).toBe(false);
    expect(isStructuralBroadcastFailure(new Error("NotEnoughFunds"))).toBe(false);
    expect(isStructuralBroadcastFailure(new Error("Too Many Requests"))).toBe(false);
  });
});
