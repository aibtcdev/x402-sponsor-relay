import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddressFromPrivateKey, makeContractCall, makeRandomPrivKey } from "@stacks/transactions";
import { FeeService } from "../services/fee";
import { SponsorService } from "../services/sponsor";
import type { Env, Logger } from "../types";
import { MemoryKV } from "./helpers/memory-kv";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function noopTx() {
  const key = makeRandomPrivKey();
  return makeContractCall({
    contractAddress: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    contractName: "sbtc-token",
    functionName: "noop",
    functionArgs: [],
    senderKey: key,
    network: "testnet",
    nonce: 0n,
    fee: 0n,
    sponsored: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SponsorService.preflightSponsoredPayment fee floor", () => {
  it("refuses when every known sponsor balance is above the depleted threshold but below the fee floor", async () => {
    const kv = new MemoryKV();
    const sponsorKey = makeRandomPrivKey();
    const sponsorAddress = getAddressFromPrivateKey(sponsorKey, "testnet");
    await kv.put(`wallet_balance:${sponsorAddress}`, "150000");
    vi.spyOn(FeeService.prototype, "getFeeForType").mockResolvedValue(200000);

    const service = new SponsorService({ STACKS_NETWORK: "testnet", RELAY_KV: kv } as Env, logger);
    const result = await service.preflightSponsoredPayment(await noopTx(), [sponsorKey]);

    expect(result).toMatchObject({ code: "SPONSOR_EXHAUSTED", retryable: true });
  });

  it("allows when a sponsor balance covers the fee floor", async () => {
    const kv = new MemoryKV();
    const sponsorKey = makeRandomPrivKey();
    const sponsorAddress = getAddressFromPrivateKey(sponsorKey, "testnet");
    await kv.put(`wallet_balance:${sponsorAddress}`, "250000");
    vi.spyOn(FeeService.prototype, "getFeeForType").mockResolvedValue(200000);

    const service = new SponsorService({ STACKS_NETWORK: "testnet", RELAY_KV: kv } as Env, logger);
    const result = await service.preflightSponsoredPayment(await noopTx(), [sponsorKey]);

    expect(result).toBeNull();
  });
});
