import { describe, expect, it, vi, afterEach } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeNonceDoHarness() {
  const state = new Map<string, number>();
  const setStateValue = (key: string, value: number) => state.set(key, value);
  const getStateValue = (key: string) => (state.has(key) ? state.get(key)! : null);

  const harness = Object.create(NonceDO.prototype) as InstanceType<typeof NonceDO> & {
    setStateValue: typeof setStateValue;
    getStateValue: typeof getStateValue;
  };

  harness.sql = {
    exec: vi.fn().mockReturnValue({ toArray: () => [] }),
  } as unknown as InstanceType<typeof NonceDO>["sql"];
  harness.hiroNonceCache = new Map();
  (harness as any).chainFrontierCache = new Map();
  harness.setStateValue = setStateValue;
  harness.getStateValue = getStateValue;

  return harness;
}

describe("NonceDO assign frontier gap (#434)", () => {
  it("assigns the chain frontier when head is ahead with an empty ledger gap", () => {
    const harness = makeNonceDoHarness();
    setWalletState(harness, 0, { frontier: 24, head: 28, hiroNext: 24 });

    const assigned = (harness as any).resolveNextAssignNonce(0, 24);
    expect(assigned).toBe(24);
  });

  it("does not shrink the wallet head when filling an earlier gap", () => {
    const harness = makeNonceDoHarness();
    setWalletState(harness, 0, { frontier: 24, head: 28, hiroNext: 24 });

    (harness as any).advanceWalletHeadAfterAssign(0, 24);
    expect((harness as any).ledgerGetWalletHead(0)).toBe(28);
  });

  it("prefers a funded wallet over a low-balance wallet on headroom ties", () => {
    const harness = makeNonceDoHarness();
    setWalletState(harness, 0, { frontier: 10, head: 10, hiroNext: 10 });
    setWalletState(harness, 4, { frontier: 10, head: 10, hiroNext: 10 });
    harness.setStateValue("wallet_balance_ustx:0", 900);
    harness.setStateValue("wallet_balance_ustx:4", 5_000_000);

    const chosen = (harness as any).selectWalletForAssignment([
      { walletIndex: 0, headroom: 20 },
      { walletIndex: 4, headroom: 20 },
    ]);

    expect(chosen?.walletIndex).toBe(4);
  });

  it("excludes wallets below the minimum sponsor assignment balance", () => {
    const harness = makeNonceDoHarness();
    harness.setStateValue("wallet_balance_ustx:0", 900);
    harness.setStateValue("min_assign_balance_ustx", 30_000);

    expect((harness as any).isWalletFundedForAssignment(0)).toBe(false);
    expect((harness as any).isWalletFundedForAssignment(1)).toBe(true);
  });
});

function setWalletState(
  harness: ReturnType<typeof makeNonceDoHarness>,
  walletIndex: number,
  opts: { frontier: number; head: number; hiroNext: number }
) {
  harness.setStateValue(`chain_frontier:${walletIndex}`, opts.frontier);
  (harness as any).chainFrontierCache.set(walletIndex, opts.frontier);
  (harness as any).ledgerAdvanceWalletHead(walletIndex, opts.head);
  harness.hiroNonceCache.set(walletIndex, { value: opts.hiroNext, expiresAt: Date.now() + 60_000 });
}
