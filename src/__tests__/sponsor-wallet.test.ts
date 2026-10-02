import { describe, expect, it, vi } from "vitest";
import {
  deserializeTransaction,
  makeContractCall,
  makeRandomPrivKey,
  noneCV,
  principalCV,
  uintCV,
} from "@stacks/transactions";
import { SponsorWallet, type BudgetStore } from "../durable-objects/sponsor-wallet-do";
import type { BroadcastOnlyResult, Env, Logger } from "../types";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const env = { STACKS_NETWORK: "testnet" } as Env;
const sponsorKey = makeRandomPrivKey();

async function sponsoredTxHex(): Promise<string> {
  const tx = await makeContractCall({
    contractAddress: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    contractName: "sbtc-token",
    functionName: "transfer",
    functionArgs: [
      uintCV(100),
      principalCV("ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG"),
      principalCV("ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC"),
      noneCV(),
    ],
    senderKey: makeRandomPrivKey(),
    network: "testnet",
    nonce: 0n,
    fee: 0n,
    sponsored: true,
  });
  return tx.serialize();
}

function memoryBudget(initial?: { day: string; spent: string }): BudgetStore & { value?: { day: string; spent: string } } {
  const store: BudgetStore & { value?: { day: string; spent: string } } = {
    value: initial,
    get: async () => store.value,
    put: async (v) => { store.value = v; },
  };
  return store;
}

const sponsorNonceOf = (tx: unknown) =>
  Number((tx as { auth: { sponsorSpendingCondition: { nonce: bigint } } }).auth.sponsorSpendingCondition.nonce);

describe("SponsorWallet", () => {
  it("takes the first nonce from Hiro, then counts up locally without re-reading", async () => {
    const fetchNonces = vi.fn(async () => ({ possible_next_nonce: 7 }));
    const nonces: number[] = [];
    const broadcast = vi.fn(async (tx): Promise<BroadcastOnlyResult> => {
      nonces.push(sponsorNonceOf(tx));
      return { txid: `tx${nonces.length}` };
    });
    const wallet = new SponsorWallet(env, logger, broadcast, fetchNonces, memoryBudget());
    const txHex = await sponsoredTxHex();

    const results = await Promise.all([1, 2, 3].map(() => wallet.sponsorAndBroadcast({ txHex, sponsorKey, fee: "3000" })));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(nonces).toEqual([7, 8, 9]);
    expect(fetchNonces).toHaveBeenCalledTimes(1);
  });

  it("fills the lowest missing nonce before anything else", async () => {
    const broadcast = vi.fn(async (): Promise<BroadcastOnlyResult> => ({ txid: "t" }));
    const wallet = new SponsorWallet(
      env, logger, broadcast,
      async () => ({ possible_next_nonce: 12, detected_missing_nonces: [10, 9] }),
      memoryBudget()
    );

    const result = await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(), sponsorKey, fee: "3000" });

    expect(result).toMatchObject({ ok: true, sponsorNonce: 9 });
  });

  it("re-reads the chain and retries once when the node rejects the sponsor nonce", async () => {
    const fetchNonces = vi.fn()
      .mockResolvedValueOnce({ possible_next_nonce: 3 })
      .mockResolvedValueOnce({ possible_next_nonce: 5 });
    const broadcast = vi.fn()
      .mockResolvedValueOnce({ error: "ConflictingNonceInMempool", details: "", retryable: true, nonceConflict: true, responsible: "sponsor" })
      .mockResolvedValueOnce({ txid: "ok" });
    const wallet = new SponsorWallet(env, logger, broadcast, fetchNonces, memoryBudget());

    const result = await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(), sponsorKey, fee: "3000" });

    expect(result).toMatchObject({ ok: true, txid: "ok", sponsorNonce: 5 });
    expect(fetchNonces).toHaveBeenCalledTimes(2);
  });

  it("does not retry a sender-side nonce conflict, and re-reads the chain next time", async () => {
    const fetchNonces = vi.fn(async () => ({ possible_next_nonce: 3 }));
    const broadcast = vi.fn(async (): Promise<BroadcastOnlyResult> => ({
      error: "ConflictingNonceInMempool", details: "", retryable: false, nonceConflict: true, responsible: "sender",
    }));
    const wallet = new SponsorWallet(env, logger, broadcast, fetchNonces, memoryBudget());
    const txHex = await sponsoredTxHex();

    const first = await wallet.sponsorAndBroadcast({ txHex, sponsorKey, fee: "3000" });
    await wallet.sponsorAndBroadcast({ txHex, sponsorKey, fee: "3000" });

    expect(first).toMatchObject({ ok: false, responsible: "sender" });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(fetchNonces).toHaveBeenCalledTimes(2);
  });

  it("refuses once the daily budget would be exceeded, without signing or broadcasting", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const broadcast = vi.fn();
    const wallet = new SponsorWallet(
      { ...env, SPONSOR_DAILY_BUDGET_USTX: "10000" } as Env,
      logger, broadcast,
      async () => ({ possible_next_nonce: 0 }),
      memoryBudget({ day, spent: "8000" })
    );

    const result = await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(), sponsorKey, fee: "3000" });

    expect(result).toMatchObject({ ok: false, error: "Daily sponsor budget reached" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("adds each successful fee to today's spend and resets on a new day", async () => {
    const budget = memoryBudget({ day: "2000-01-01", spent: "999999" });
    const wallet = new SponsorWallet(
      env, logger,
      async () => ({ txid: "t" }),
      async () => ({ possible_next_nonce: 0 }),
      budget
    );

    await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(), sponsorKey, fee: "3000" });

    expect(budget.value).toEqual({ day: new Date().toISOString().slice(0, 10), spent: "3000" });
  });

  it("keeps the client's origin signature intact", async () => {
    const txHex = await sponsoredTxHex();
    let sent: unknown;
    const wallet = new SponsorWallet(
      env, logger,
      async (tx) => { sent = tx; return { txid: "t" }; },
      async () => ({ possible_next_nonce: 0 }),
      memoryBudget()
    );

    await wallet.sponsorAndBroadcast({ txHex, sponsorKey, fee: "3000" });

    const origin = deserializeTransaction(txHex).auth.spendingCondition;
    expect((sent as { auth: { spendingCondition: unknown } }).auth.spendingCondition).toEqual(origin);
  });
});
