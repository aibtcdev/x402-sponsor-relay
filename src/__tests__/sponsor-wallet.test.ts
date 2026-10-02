import { describe, expect, it, vi } from "vitest";
import {
  deserializeTransaction,
  getAddressFromPrivateKey,
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
const sponsorAddress = getAddressFromPrivateKey(sponsorKey, "testnet");
const senderKey = makeRandomPrivKey();
const senderAddress = getAddressFromPrivateKey(senderKey, "testnet");

/** Hiro nonce lookup: the sponsor gets `sponsor`, any sender gets a clean account at `senderNext`. */
function nonces(sponsor: { possible_next_nonce: number; detected_missing_nonces?: number[] }, senderNext = 0) {
  return vi.fn(async (address: string) =>
    address === sponsorAddress
      ? sponsor
      : { possible_next_nonce: senderNext, last_executed_tx_nonce: senderNext - 1, last_mempool_tx_nonce: null }
  );
}

async function sponsoredTxHex(key = senderKey, nonce = 0n): Promise<string> {
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
    senderKey: key,
    network: "testnet",
    nonce,
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
  it("takes the first sponsor nonce from Hiro, then counts up locally without re-reading", async () => {
    const fetchNonces = nonces({ possible_next_nonce: 7 });
    const used: number[] = [];
    const broadcast = vi.fn(async (tx): Promise<BroadcastOnlyResult> => {
      used.push(sponsorNonceOf(tx));
      return { txid: `tx${used.length}` };
    });
    const wallet = new SponsorWallet(env, logger, broadcast, fetchNonces, memoryBudget());
    const senders = [makeRandomPrivKey(), makeRandomPrivKey(), makeRandomPrivKey()];

    const results = await Promise.all(senders.map(async (key) => wallet.sponsorAndBroadcast({
      txHex: await sponsoredTxHex(key), sponsorKey, fee: "3000", senderAddress: getAddressFromPrivateKey(key, "testnet"),
    })));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(used).toEqual([7, 8, 9]);
    expect(fetchNonces.mock.calls.filter(([a]) => a === sponsorAddress)).toHaveLength(1);
  });

  it("refuses a sender's second payment while the first is in flight, even before Hiro sees it", async () => {
    const broadcast = vi.fn(async (): Promise<BroadcastOnlyResult> => ({ txid: "t" }));
    const wallet = new SponsorWallet(env, logger, broadcast, nonces({ possible_next_nonce: 0 }, 5), memoryBudget());

    const first = await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(senderKey, 5n), sponsorKey, fee: "3000", senderAddress });
    // Hiro still reports the sender at next=5 with an empty mempool (lag) — the in-memory guard holds.
    const second = await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(senderKey, 6n), sponsorKey, fee: "3000", senderAddress });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, senderNonceCode: "SENDER_NONCE_DUPLICATE", retryable: true });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("refuses a sender with a pending mempool tx, and nonces that are not the sender's next", async () => {
    const broadcast = vi.fn();
    const busy = new SponsorWallet(env, logger, broadcast, vi.fn(async (a: string) => a === sponsorAddress
      ? { possible_next_nonce: 0 }
      : { possible_next_nonce: 4, last_executed_tx_nonce: 2, last_mempool_tx_nonce: 3 }), memoryBudget());
    const clean = new SponsorWallet(env, logger, broadcast, nonces({ possible_next_nonce: 0 }, 4), memoryBudget());

    expect(await busy.sponsorAndBroadcast({ txHex: await sponsoredTxHex(senderKey, 4n), sponsorKey, fee: "3000", senderAddress }))
      .toMatchObject({ ok: false, senderNonceCode: "SENDER_NONCE_DUPLICATE" });
    expect(await clean.sponsorAndBroadcast({ txHex: await sponsoredTxHex(senderKey, 3n), sponsorKey, fee: "3000", senderAddress }))
      .toMatchObject({ ok: false, senderNonceCode: "SENDER_NONCE_STALE", retryable: false });
    expect(await clean.sponsorAndBroadcast({ txHex: await sponsoredTxHex(senderKey, 6n), sponsorKey, fee: "3000", senderAddress }))
      .toMatchObject({ ok: false, senderNonceCode: "SENDER_NONCE_GAP" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("fills the lowest missing nonce before anything else", async () => {
    const broadcast = vi.fn(async (): Promise<BroadcastOnlyResult> => ({ txid: "t" }));
    const wallet = new SponsorWallet(
      env, logger, broadcast,
      nonces({ possible_next_nonce: 12, detected_missing_nonces: [10, 9] }),
      memoryBudget()
    );

    const result = await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(), sponsorKey, fee: "3000", senderAddress });

    expect(result).toMatchObject({ ok: true, sponsorNonce: 9 });
  });

  it("re-reads the chain and retries once when the node rejects the sponsor nonce", async () => {
    const sponsorReads = [{ possible_next_nonce: 3 }, { possible_next_nonce: 5 }];
    const fetchNonces = vi.fn(async (a: string) => a === sponsorAddress
      ? sponsorReads.shift()!
      : { possible_next_nonce: 0, last_executed_tx_nonce: null, last_mempool_tx_nonce: null });
    const broadcast = vi.fn()
      .mockResolvedValueOnce({ error: "ConflictingNonceInMempool", details: "", retryable: true, nonceConflict: true, responsible: "sponsor" })
      .mockResolvedValueOnce({ txid: "ok" });
    const wallet = new SponsorWallet(env, logger, broadcast, fetchNonces, memoryBudget());

    const result = await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(), sponsorKey, fee: "3000", senderAddress });

    expect(result).toMatchObject({ ok: true, txid: "ok", sponsorNonce: 5 });
    expect(fetchNonces.mock.calls.filter(([a]) => a === sponsorAddress)).toHaveLength(2);
  });

  it("does not retry a sender-side nonce conflict, and re-reads the chain next time", async () => {
    const fetchNonces = nonces({ possible_next_nonce: 3 });
    const broadcast = vi.fn(async (): Promise<BroadcastOnlyResult> => ({
      error: "ConflictingNonceInMempool", details: "", retryable: false, nonceConflict: true, responsible: "sender",
    }));
    const wallet = new SponsorWallet(env, logger, broadcast, fetchNonces, memoryBudget());
    const txHex = await sponsoredTxHex();

    const first = await wallet.sponsorAndBroadcast({ txHex, sponsorKey, fee: "3000", senderAddress });
    await wallet.sponsorAndBroadcast({ txHex, sponsorKey, fee: "3000", senderAddress });

    expect(first).toMatchObject({ ok: false, responsible: "sender" });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(fetchNonces.mock.calls.filter(([a]) => a === sponsorAddress)).toHaveLength(2);
  });

  it("refuses once the daily budget would be exceeded, without signing or broadcasting", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const broadcast = vi.fn();
    const wallet = new SponsorWallet(
      { ...env, SPONSOR_DAILY_BUDGET_USTX: "10000" } as Env,
      logger, broadcast,
      nonces({ possible_next_nonce: 0 }),
      memoryBudget({ day, spent: "8000" })
    );

    const result = await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(), sponsorKey, fee: "3000", senderAddress });

    expect(result).toMatchObject({ ok: false, error: "Daily sponsor budget reached" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("adds each successful fee to today's spend and resets on a new day", async () => {
    const budget = memoryBudget({ day: "2000-01-01", spent: "999999" });
    const wallet = new SponsorWallet(
      env, logger,
      async () => ({ txid: "t" }),
      nonces({ possible_next_nonce: 0 }),
      budget
    );

    await wallet.sponsorAndBroadcast({ txHex: await sponsoredTxHex(), sponsorKey, fee: "3000", senderAddress });

    expect(budget.value).toEqual({ day: new Date().toISOString().slice(0, 10), spent: "3000" });
  });

  it("keeps the client's origin signature intact", async () => {
    const txHex = await sponsoredTxHex();
    let sent: unknown;
    const wallet = new SponsorWallet(
      env, logger,
      async (tx) => { sent = tx; return { txid: "t" }; },
      nonces({ possible_next_nonce: 0 }),
      memoryBudget()
    );

    await wallet.sponsorAndBroadcast({ txHex, sponsorKey, fee: "3000", senderAddress });

    const origin = deserializeTransaction(txHex).auth.spendingCondition;
    expect((sent as { auth: { spendingCondition: unknown } }).auth.spendingCondition).toEqual(origin);
  });
});
