import { describe, expect, it, vi, afterEach } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";
import { createPaymentRecord, getPaymentRecord, putPaymentRecord, transitionPayment } from "../services/payment-status";
import { MemoryKV } from "./helpers/memory-kv";

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
    walletGhostDegradedKey: (walletIndex: number) => `wallet_ghost_degraded:${walletIndex}`,
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
  it("falls back to the legacy sender_state SELECT when refresh columns are unavailable", () => {
    const getSenderState = (NonceDO as any).prototype.getSenderState;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("no such column: last_refresh_failure_at");
      })
      .mockReturnValueOnce({
        toArray: () => [{
          next_expected_nonce: 3,
          seeded_from: "hiro",
          seeded_at: "2026-03-31T20:00:00.000Z",
          last_advanced_at: null,
        }],
      });

    const state = getSenderState.call({
      sql: { exec },
    }, "STLEGACY");

    expect(state).toEqual({
      next_expected_nonce: 3,
      seeded_from: "hiro",
      seeded_at: "2026-03-31T20:00:00.000Z",
      last_advanced_at: null,
      last_refresh_attempt_at: null,
      last_refresh_failure_at: null,
    });
    expect(warn).toHaveBeenCalledWith(
      "[nonce-do] sender_state refresh columns unavailable; falling back to legacy sender_state SELECT:",
      expect.any(Error)
    );
  });

  it("only produces a stale-low repair candidate after the hold-age threshold and outside cooldown", () => {
    const nowMs = Date.parse("2026-03-31T20:10:00.000Z");
    const evaluate = (NonceDO as any).prototype.evaluateStaleSenderRepairCandidate;

    const candidate = evaluate.call(
      {},
      {
        next_expected_nonce: 3,
        last_refresh_attempt_at: null,
        last_refresh_failure_at: null,
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
          last_refresh_failure_at: null,
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
          last_refresh_failure_at: null,
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
        last_refresh_failure_at: null,
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
        last_refresh_failure_at: null,
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
      recordSenderRefreshFailure: vi.fn(),
      fetchNonceInfo: cooldownFetch,
      conservativeBumpSenderFrontier: vi.fn(),
      log,
    }, "ST456");

    expect(cooldownResult).toBe(false);
    expect(cooldownFetch).not.toHaveBeenCalled();

    const recordSenderRefreshAttempt = vi.fn();
    const recordSenderRefreshFailure = vi.fn();
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
        last_refresh_failure_at: null,
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
      recordSenderRefreshFailure,
      fetchNonceInfo,
      conservativeBumpSenderFrontier,
      log,
    }, "ST789");

    expect(hiroLagged).toBe(false);
    expect(recordSenderRefreshAttempt).toHaveBeenCalledWith("ST789", "2026-03-31T20:10:00.000Z");
    expect(recordSenderRefreshFailure).not.toHaveBeenCalled();
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

  it("records the cooldown only after Hiro confirms the held frontier is reachable", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-31T20:10:00.000Z"));

    const repair = (NonceDO as any).prototype.maybeRepairStaleSenderFrontier;
    const recordSenderRefreshAttempt = vi.fn();
    const conservativeBumpSenderFrontier = vi.fn().mockReturnValue({
      advanced: false,
      previousFrontier: 7,
      prunedCount: 0,
    });
    const fetchNonceInfo = vi.fn().mockResolvedValue({
      possible_next_nonce: 7,
      last_executed_tx_nonce: 6,
      last_mempool_tx_nonce: null,
      detected_missing_nonces: [],
      detected_mempool_nonces: [],
    });

    const repaired = await repair.call({
      getSenderState: () => ({
        next_expected_nonce: 3,
        last_refresh_attempt_at: null,
        last_refresh_failure_at: null,
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
      recordSenderRefreshFailure: vi.fn(),
      fetchNonceInfo,
      conservativeBumpSenderFrontier,
      log: vi.fn(),
    }, "ST999");

    expect(repaired).toBe(false);
    expect(recordSenderRefreshAttempt).toHaveBeenCalledWith("ST999", "2026-03-31T20:10:00.000Z");
    expect(conservativeBumpSenderFrontier).toHaveBeenCalledWith("ST999", 7);
  });

  it("lets on-demand sender repair bypass the stale-age gate", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-31T20:10:00.000Z"));

    const repair = (NonceDO as any).prototype.repairSenderWedge;
    const fetchNonceInfo = vi.fn().mockResolvedValue({
      possible_next_nonce: 7,
      last_executed_tx_nonce: 6,
      last_mempool_tx_nonce: null,
      detected_missing_nonces: [],
      detected_mempool_nonces: [],
    });
    const conservativeBumpSenderFrontier = vi.fn().mockReturnValue({
      advanced: true,
      previousFrontier: 3,
      prunedCount: 1,
    });
    const checkAndAssignRun = vi.fn();

    const status = await repair.call({
      getSenderState: () => ({
        next_expected_nonce: 3,
        last_refresh_attempt_at: null,
        last_refresh_failure_at: null,
      }),
      getHand: () => [
        {
          sender_nonce: 7,
          received_at: "2026-03-31T20:09:30.000Z",
          expires_at: "2026-03-31T20:20:00.000Z",
          payment_id: "pay_young_gap",
        },
      ],
      evaluateStaleSenderRepairCandidate: (NonceDO as any).prototype.evaluateStaleSenderRepairCandidate,
      maybeRepairStaleSenderFrontier: (NonceDO as any).prototype.maybeRepairStaleSenderFrontier,
      recordSenderRefreshAttempt: vi.fn(),
      recordSenderRefreshFailure: vi.fn(),
      fetchNonceInfo,
      conservativeBumpSenderFrontier,
      checkAndAssignRun,
      buildSenderWedgeStatus: (NonceDO as any).prototype.buildSenderWedgeStatus,
      log: vi.fn(),
    }, "STYOUNG");

    expect(fetchNonceInfo).toHaveBeenCalledWith("STYOUNG");
    expect(conservativeBumpSenderFrontier).toHaveBeenCalledWith("STYOUNG", 7);
    expect(checkAndAssignRun).toHaveBeenCalledWith("STYOUNG");
    expect(status).toEqual(
      expect.objectContaining({
        senderAddress: "STYOUNG",
        repairTriggered: true,
        repairAdvanced: true,
      })
    );
  });

  it("applies a short failure backoff after a Hiro refresh error", () => {
    const nowMs = Date.parse("2026-03-31T20:10:00.000Z");
    const evaluate = (NonceDO as any).prototype.evaluateStaleSenderRepairCandidate;

    expect(
      evaluate.call(
        {},
        {
          next_expected_nonce: 3,
          last_refresh_attempt_at: null,
          last_refresh_failure_at: "2026-03-31T20:09:00.000Z",
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
          next_expected_nonce: 3,
          last_refresh_attempt_at: null,
          last_refresh_failure_at: "2026-03-31T20:07:30.000Z",
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
    ).toEqual({
      nextExpectedNonce: 3,
      lowestHeldNonce: 7,
      oldestHeldAgeMs: 6 * 60 * 1000,
      handSize: 1,
    });
  });

  it("records a failed refresh timestamp when Hiro refresh throws", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-31T20:10:00.000Z"));

    const repair = (NonceDO as any).prototype.maybeRepairStaleSenderFrontier;
    const recordSenderRefreshAttempt = vi.fn();
    const recordSenderRefreshFailure = vi.fn();
    const fetchNonceInfo = vi.fn().mockRejectedValue(new Error("hiro unavailable"));
    const log = vi.fn();

    const repaired = await repair.call({
      getSenderState: () => ({
        next_expected_nonce: 3,
        last_refresh_attempt_at: null,
        last_refresh_failure_at: null,
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
      recordSenderRefreshFailure,
      fetchNonceInfo,
      conservativeBumpSenderFrontier: vi.fn(),
      log,
    }, "STERR");

    expect(repaired).toBe(false);
    expect(recordSenderRefreshAttempt).not.toHaveBeenCalled();
    expect(recordSenderRefreshFailure).toHaveBeenCalledWith("STERR", "2026-03-31T20:10:00.000Z");
    expect(log).toHaveBeenCalledWith(
      "warn",
      "sender_frontier_refresh_failed",
      expect.objectContaining({
        senderAddress: "STERR",
        error: "hiro unavailable",
      })
    );
  });

  it("clears held metadata when a repaired run is re-queued under the same canonical payment", async () => {
    const kv = new MemoryKV();
    const record = transitionPayment(
      createPaymentRecord("pay_repaired", "testnet"),
      "queued",
      {
        holdReason: "gap",
        nextExpectedNonce: 4,
        missingNonces: [4, 5],
        holdExpiresAt: "2026-04-09T12:30:00.000Z",
      }
    );
    record.relayState = "held";
    await putPaymentRecord(kv, record);

    const sync = (NonceDO as any).prototype.syncPaymentsAfterQueueAssignment;
    await sync.call(
      { env: { RELAY_KV: kv } },
      [{ senderNonce: 6, paymentId: "pay_repaired" }],
      [{ senderNonce: 6, walletIndex: 2, sponsorNonce: 55 }]
    );

    const updated = await getPaymentRecord(kv, "pay_repaired");
    expect(updated).toEqual(
      expect.objectContaining({
        status: "queued",
        relayState: "queued",
        sponsorWalletIndex: 2,
        sponsorNonce: 55,
      })
    );
    expect(updated).not.toHaveProperty("holdReason");
    expect(updated).not.toHaveProperty("nextExpectedNonce");
    expect(updated).not.toHaveProperty("missingNonces");
    expect(updated).not.toHaveProperty("holdExpiresAt");
    expect(updated).not.toHaveProperty("error");
  });

  it("does not fail run assignment when post-assignment payment sync throws", async () => {
    const checkAndAssignRun = (NonceDO as any).prototype.checkAndAssignRun;
    const log = vi.fn();

    const result = await checkAndAssignRun.call({
      getHandGapInfo: () => ({
        hand: [
          {
            sender_nonce: 4,
            tx_hex: "0xabc",
            payment_id: "pay_sync_fail",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        ],
        missingNonces: [],
        nextExpected: 4,
        handSize: 1,
      }),
      assignRunToWallet: () => ({
        assigned: [{ senderNonce: 4, walletIndex: 1, sponsorNonce: 44 }],
        held: [],
      }),
      syncPaymentsAfterQueueAssignment: vi.fn().mockRejectedValue(new Error("kv unavailable")),
      log,
    }, "STSYNC");

    expect(result).toEqual({
      dispatched: true,
      sponsorNonce: 44,
      walletIndex: 1,
      sponsorAddress: "",
    });
    expect(log).toHaveBeenCalledWith(
      "warn",
      "payment_sync_after_assign_failed",
      expect.objectContaining({
        senderAddress: "STSYNC",
        assignedCount: 1,
        error: "kv unavailable",
      })
    );
  });
});
