import { describe, expect, it, vi, afterEach } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSnapshotBuilderDouble(rawAvailabilities: number[]) {
  return {
    getInitializedWallets: async () => rawAvailabilities.map((_, walletIndex) => ({ walletIndex })),
    state: {
      storage: {
        get: async () => [],
      },
    },
    walletQuarantineRecentKey: (walletIndex: number) => `quarantine:${walletIndex}`,
    walletHeadroom: (walletIndex: number) => rawAvailabilities[walletIndex],
    getStateValue: () => null,
    getStoredCount: () => 0,
  };
}

describe("NonceDO sponsor status snapshot clamp", () => {
  it("floors negative wallet headroom at zero available", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-30T18:20:10.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotBuilderDouble([-3])
    );

    expect(snapshot.noncePool.totalAvailable).toBe(0);
    expect(snapshot.noncePool.totalReserved).toBe(20);
    expect(snapshot.noncePool.totalCapacity).toBe(20);
    expect(snapshot.noncePool.poolAvailabilityRatio).toBe(0);
  });

  it("caps oversized wallet headroom at the chaining limit", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-30T18:20:10.000Z"));

    const snapshot = await (NonceDO as any).prototype.buildSponsorStatusSnapshot.call(
      makeSnapshotBuilderDouble([27])
    );

    expect(snapshot.noncePool.totalAvailable).toBe(20);
    expect(snapshot.noncePool.totalReserved).toBe(0);
    expect(snapshot.noncePool.totalCapacity).toBe(20);
    expect(snapshot.noncePool.poolAvailabilityRatio).toBe(1);
  });
});

describe("NonceDO stale sender repair helpers", () => {
  it("only produces a stale-low repair candidate after the hold-age threshold and outside cooldown", () => {
    const nowMs = Date.parse("2026-03-31T20:10:00.000Z");
    const evaluate = (NonceDO as any).prototype.evaluateStaleSenderRepairCandidate;

    const candidate = evaluate.call(
      {},
      {
        next_expected_nonce: 3,
        last_refresh_attempt_at: null,
      },
      [
        {
          sender_nonce: 7,
          received_at: "2026-03-31T20:04:00.000Z",
          expires_at: "2026-03-31T20:11:00.000Z",
        },
        {
          sender_nonce: 8,
          received_at: "2026-03-31T20:05:00.000Z",
          expires_at: "2026-03-31T20:11:00.000Z",
        },
      ],
      nowMs
    );

    expect(candidate).toEqual({
      nextExpectedNonce: 3,
      lowestHeldNonce: 7,
      oldestHeldAgeMs: 6 * 60 * 1000,
      handSize: 2,
    });

    expect(
      evaluate.call(
        {},
        {
          next_expected_nonce: 3,
          last_refresh_attempt_at: "2026-03-31T20:02:00.000Z",
        },
        [
          {
            sender_nonce: 7,
            received_at: "2026-03-31T20:04:00.000Z",
            expires_at: "2026-03-31T20:11:00.000Z",
          },
        ],
        nowMs
      )
    ).toBeNull();

    expect(
      evaluate.call(
        {},
        {
          next_expected_nonce: 7,
          last_refresh_attempt_at: null,
        },
        [
          {
            sender_nonce: 7,
            received_at: "2026-03-31T20:04:00.000Z",
            expires_at: "2026-03-31T20:11:00.000Z",
          },
        ],
        nowMs
      )
    ).toBeNull();
  });

  it("repairs a stale-low sender frontier only up to the lowest held nonce", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-31T20:10:00.000Z"));

    const repair = (NonceDO as any).prototype.maybeRepairStaleSenderFrontier;
    const recordSenderRefreshAttempt = vi.fn();
    const conservativeBumpSenderFrontier = vi.fn().mockReturnValue({
      advanced: true,
      previousFrontier: 3,
      prunedCount: 2,
    });
    const log = vi.fn();
    const fetchNonceInfo = vi.fn().mockResolvedValue({
      possible_next_nonce: 12,
      last_executed_tx_nonce: 11,
      last_mempool_tx_nonce: null,
      detected_missing_nonces: [],
      detected_mempool_nonces: [],
    });

    const repaired = await repair.call({
      getSenderState: () => ({
        next_expected_nonce: 3,
        last_refresh_attempt_at: null,
      }),
      getHand: () => [
        {
          sender_nonce: 7,
          received_at: "2026-03-31T20:04:00.000Z",
          expires_at: "2026-03-31T20:11:00.000Z",
        },
        {
          sender_nonce: 8,
          received_at: "2026-03-31T20:05:00.000Z",
          expires_at: "2026-03-31T20:11:00.000Z",
        },
      ],
      evaluateStaleSenderRepairCandidate: (NonceDO as any).prototype.evaluateStaleSenderRepairCandidate,
      recordSenderRefreshAttempt,
      fetchNonceInfo,
      conservativeBumpSenderFrontier,
      log,
    }, "ST123");

    expect(repaired).toBe(true);
    expect(recordSenderRefreshAttempt).toHaveBeenCalledWith("ST123", "2026-03-31T20:10:00.000Z");
    expect(fetchNonceInfo).toHaveBeenCalledWith("ST123");
    expect(conservativeBumpSenderFrontier).toHaveBeenCalledWith("ST123", 7);
    expect(log).toHaveBeenCalledWith(
      "info",
      "sender_frontier_repaired",
      expect.objectContaining({
        senderAddress: "ST123",
        previousNextExpectedNonce: 3,
        newNextExpectedNonce: 7,
        lowestHeldNonce: 7,
        hiroPossibleNextNonce: 12,
        prunedStaleLowEntries: 2,
      })
    );
  });

  it("skips stale-low repair when cooldown blocks refresh or Hiro is not yet at the held frontier", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-31T20:10:00.000Z"));

    const repair = (NonceDO as any).prototype.maybeRepairStaleSenderFrontier;
    const log = vi.fn();

    const cooldownFetch = vi.fn();
    const cooldownResult = await repair.call({
      getSenderState: () => ({
        next_expected_nonce: 3,
        last_refresh_attempt_at: "2026-03-31T20:05:30.000Z",
      }),
      getHand: () => [
        {
          sender_nonce: 7,
          received_at: "2026-03-31T20:04:00.000Z",
          expires_at: "2026-03-31T20:11:00.000Z",
        },
      ],
      evaluateStaleSenderRepairCandidate: (NonceDO as any).prototype.evaluateStaleSenderRepairCandidate,
      recordSenderRefreshAttempt: vi.fn(),
      fetchNonceInfo: cooldownFetch,
      conservativeBumpSenderFrontier: vi.fn(),
      log,
    }, "ST456");

    expect(cooldownResult).toBe(false);
    expect(cooldownFetch).not.toHaveBeenCalled();

    const recordSenderRefreshAttempt = vi.fn();
    const conservativeBumpSenderFrontier = vi.fn();
    const fetchNonceInfo = vi.fn().mockResolvedValue({
      possible_next_nonce: 6,
      last_executed_tx_nonce: 5,
      last_mempool_tx_nonce: null,
      detected_missing_nonces: [],
      detected_mempool_nonces: [],
    });

    const hiroLagged = await repair.call({
      getSenderState: () => ({
        next_expected_nonce: 3,
        last_refresh_attempt_at: null,
      }),
      getHand: () => [
        {
          sender_nonce: 7,
          received_at: "2026-03-31T20:04:00.000Z",
          expires_at: "2026-03-31T20:11:00.000Z",
        },
      ],
      evaluateStaleSenderRepairCandidate: (NonceDO as any).prototype.evaluateStaleSenderRepairCandidate,
      recordSenderRefreshAttempt,
      fetchNonceInfo,
      conservativeBumpSenderFrontier,
      log,
    }, "ST789");

    expect(hiroLagged).toBe(false);
    expect(recordSenderRefreshAttempt).toHaveBeenCalledWith("ST789", "2026-03-31T20:10:00.000Z");
    expect(conservativeBumpSenderFrontier).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "info",
      "sender_frontier_refresh_skipped",
      expect.objectContaining({
        senderAddress: "ST789",
        lowestHeldNonce: 7,
        hiroPossibleNextNonce: 6,
      })
    );
  });
});
