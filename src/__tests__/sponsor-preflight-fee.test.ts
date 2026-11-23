import { afterEach, describe, expect, it, vi } from "vitest";
import { ClarityType, getAddressFromPrivateKey, makeContractCall, makeRandomPrivKey } from "@stacks/transactions";
import { FeeService } from "../services/fee";
import { SponsorService } from "../services/sponsor";
import type { Env, Logger } from "../types";
import { MemoryKV } from "./helpers/memory-kv";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const SENDER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const SBTC_TOKEN = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7.sbtc-token";

async function noopTx() {
  const key = makeRandomPrivKey();
  return makeContractCall({
    contractAddress: SENDER,
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

// An sBTC `transfer` contract call: paymentSpend resolves the asset to the token contract,
// so the fee floor must use the sip010_transfer tier rather than contract_call.
async function sbtcTransferTx() {
  const key = makeRandomPrivKey();
  const [addr, name] = SBTC_TOKEN.split(".");
  return makeContractCall({
    contractAddress: addr,
    contractName: name,
    functionName: "transfer",
    functionArgs: [{ type: ClarityType.UInt, value: 1000n }],
    senderKey: key,
    network: "testnet",
    nonce: 0n,
    fee: 0n,
    sponsored: true,
  });
}

// fee:config with ceilings above DEPLETED_THRESHOLD (100_000 µSTX) plus cached
// fee:estimates, so getFeeForType runs the real KV path — no FeeService mock.
async function feeConfigKv(kv: MemoryKV, estimates: Record<string, unknown>) {
  await kv.put("fee:config", JSON.stringify({
    token_transfer: { floor: 500, ceiling: 3000 },
    contract_call: { floor: 50000, ceiling: 200000 },
    sip010_transfer: { floor: 50000, ceiling: 200000 },
    smart_contract: { floor: 10000, ceiling: 50000 },
  }));
  await kv.put("fee:estimates", JSON.stringify(estimates));
}

const ESTIMATES_200K = {
  token_transfer: { low_priority: 1000, medium_priority: 1000, high_priority: 1000 },
  contract_call: { low_priority: 200000, medium_priority: 200000, high_priority: 200000 },
  sip010_transfer: { low_priority: 200000, medium_priority: 200000, high_priority: 200000 },
  smart_contract: { low_priority: 50000, medium_priority: 50000, high_priority: 50000 },
};

function service(kv: MemoryKV) {
  return new SponsorService({ STACKS_NETWORK: "testnet", RELAY_KV: kv } as Env, logger);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SponsorService.preflightSponsoredPayment fee floor", () => {
  it("refuses when every known sponsor balance is above the depleted threshold but below the fee floor", async () => {
    const kv = new MemoryKV();
    const sponsorKey = makeRandomPrivKey();
    const sponsorAddress = getAddressFromPrivateKey(sponsorKey, "testnet");
    await kv.put(`wallet_balance:${sponsorAddress}`, "150000");
    await feeConfigKv(kv, ESTIMATES_200K);

    const result = await service(kv).preflightSponsoredPayment(await noopTx(), [sponsorKey]);

    expect(result).toMatchObject({ ok: false, code: "SPONSOR_EXHAUSTED", retryable: true });
  });

  it("allows when a sponsor balance covers the fee floor and returns the floor for broadcast", async () => {
    const kv = new MemoryKV();
    const sponsorKey = makeRandomPrivKey();
    const sponsorAddress = getAddressFromPrivateKey(sponsorKey, "testnet");
    await kv.put(`wallet_balance:${sponsorAddress}`, "250000");
    await feeConfigKv(kv, ESTIMATES_200K);

    const result = await service(kv).preflightSponsoredPayment(await noopTx(), [sponsorKey]);

    expect(result).toEqual({ ok: true, feeFloor: 200000 });
  });

  it("uses the sip010_transfer fee tier for SIP-010 transfers", async () => {
    const kv = new MemoryKV();
    const sponsorKey = makeRandomPrivKey();
    const sponsorAddress = getAddressFromPrivateKey(sponsorKey, "testnet");
    await kv.put(`wallet_balance:${sponsorAddress}`, "150000");
    // contract_call floor would pass at 150000 µSTX; sip010_transfer floor (200000) must refuse.
    await feeConfigKv(kv, {
      ...ESTIMATES_200K,
      contract_call: { low_priority: 50000, medium_priority: 50000, high_priority: 50000 },
    });
    const feeSpy = vi.spyOn(FeeService.prototype, "getFeeForType");

    const result = await service(kv).preflightSponsoredPayment(await sbtcTransferTx(), [sponsorKey]);

    expect(feeSpy).toHaveBeenCalledWith("sip010_transfer");
    expect(result).toMatchObject({ ok: false, code: "SPONSOR_EXHAUSTED" });
  });

  it("skips the fee lookup entirely when a sponsor balance read fails (fail-open)", async () => {
    const kv = new MemoryKV();
    const sponsorKey = makeRandomPrivKey();
    const sponsorAddress = getAddressFromPrivateKey(sponsorKey, "testnet");
    // No wallet_balance entry and no fetch mock: the Hiro read fails, so the balance is
    // unknown and the fee floor must not be computed (it would be unused anyway).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const feeSpy = vi.spyOn(FeeService.prototype, "getFeeForType");

    const result = await service(kv).preflightSponsoredPayment(await noopTx(), [sponsorKey]);

    expect(result).toEqual({ ok: true, feeFloor: null });
    expect(feeSpy).not.toHaveBeenCalled();
  });

  it("skips the fee lookup when sponsor balances are only partially known", async () => {
    const kv = new MemoryKV();
    const knownKey = makeRandomPrivKey();
    const knownAddress = getAddressFromPrivateKey(knownKey, "testnet");
    await kv.put(`wallet_balance:${knownAddress}`, "250000");
    const unknownKey = makeRandomPrivKey();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await feeConfigKv(kv, ESTIMATES_200K);
    const feeSpy = vi.spyOn(FeeService.prototype, "getFeeForType");

    const result = await service(kv).preflightSponsoredPayment(await noopTx(), [knownKey, unknownKey]);

    expect(result).toEqual({ ok: true, feeFloor: null });
    expect(feeSpy).not.toHaveBeenCalled();
  });
});
