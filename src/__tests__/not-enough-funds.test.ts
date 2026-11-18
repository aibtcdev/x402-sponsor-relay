import { describe, expect, it } from "vitest";
import {
  Cl,
  getAddressFromPrivateKey,
  makeContractCall,
  makeRandomPrivKey,
  makeSTXTokenTransfer,
  sponsorTransaction,
} from "@stacks/transactions";
import type { StacksTransactionWire } from "@stacks/transactions";
import { notEnoughFundsPayer } from "../utils/not-enough-funds";

const senderKey = makeRandomPrivKey();
const sponsorKey = makeRandomPrivKey();
const recipient = getAddressFromPrivateKey(makeRandomPrivKey(), "testnet");

/** stacks-core encodes NotEnoughFunds expected/actual as 0x-prefixed big-endian u128 hex. */
const u128Hex = (n: bigint) => `0x${n.toString(16).padStart(32, "0")}`;

async function sponsoredTransfer(amount: bigint, fee: bigint): Promise<StacksTransactionWire> {
  const tx = await makeSTXTokenTransfer({
    recipient, amount, senderKey, network: "testnet", nonce: 0n, fee: 0n, sponsored: true,
  });
  return sponsorTransaction({ transaction: tx, sponsorPrivateKey: sponsorKey, fee, sponsorNonce: 0n, network: "testnet" });
}

describe("notEnoughFundsPayer", () => {
  it("blames the sponsor when expected equals the sponsor fee on a sponsored STX transfer", async () => {
    const tx = await sponsoredTransfer(250_000n, 3_000n);
    expect(notEnoughFundsPayer(tx, { expected: u128Hex(3_000n), actual: u128Hex(10n) })).toBe("sponsor");
  });

  it("blames the sender when expected equals the transfer amount", async () => {
    const tx = await sponsoredTransfer(250_000n, 3_000n);
    expect(notEnoughFundsPayer(tx, { expected: u128Hex(250_000n), actual: u128Hex(10n) })).toBe("sender");
  });

  it("falls back to the sender when amount and fee are equal, or expected is unreadable", async () => {
    const same = await sponsoredTransfer(3_000n, 3_000n);
    expect(notEnoughFundsPayer(same, { expected: u128Hex(3_000n) })).toBe("sender");
    const tx = await sponsoredTransfer(250_000n, 3_000n);
    expect(notEnoughFundsPayer(tx, undefined)).toBe("sender");
    expect(notEnoughFundsPayer(tx, { expected: "garbage" })).toBe("sender");
  });

  it("blames the sponsor on a sponsored contract call: admission only checks the fee payer", async () => {
    const call = await makeContractCall({
      contractAddress: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      contractName: "sbtc-token",
      functionName: "transfer",
      functionArgs: [Cl.uint(100), Cl.principal(recipient), Cl.principal(recipient), Cl.none()],
      senderKey, network: "testnet", nonce: 0n, fee: 0n, sponsored: true,
      validateWithAbi: false, postConditionMode: "allow",
    });
    const tx = await sponsorTransaction({ transaction: call, sponsorPrivateKey: sponsorKey, fee: 3_000n, sponsorNonce: 0n, network: "testnet" });
    expect(notEnoughFundsPayer(tx, undefined)).toBe("sponsor");
  });

  it("blames the sender on an unsponsored tx", async () => {
    const tx = await makeSTXTokenTransfer({
      recipient, amount: 250_000n, senderKey, network: "testnet", nonce: 0n, fee: 3_000n,
    });
    expect(notEnoughFundsPayer(tx, { expected: u128Hex(3_000n) })).toBe("sender");
  });
});
