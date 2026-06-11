import { afterEach, describe, expect, it, vi } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

/**
 * Regression tests for #284 / PR #415.
 *
 * Before this fix, `transitionQueueEntry("confirmed")` updated `dispatch_queue`
 * but never called `advanceSenderNonce`. So `sender_state.next_expected_nonce`
 * stayed at its seeded value after every relay-sponsored confirmation, causing
 * the next sequential nonce to be held as SENDER_NONCE_GAP until the alarm
 * repair fired (~5 minutes later).
 *
 * These tests verify that the sender frontier advances immediately on the
 * happy-path confirmation, not only in the failure-recovery (alarm) path.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

type PreRow = {
  dispatched_at: string | null;
  submitted_at: string | null;
  original_fee: string | null;
  sender_address: string | null;
  sender_nonce: number | null;
};

function makeConfirmDouble(opts: {
  preRow: PreRow;
  rowsWrittenOnUpdate: number;
}) {
  let callCount = 0;
  const execMock = vi.fn(() => {
    callCount++;
    if (callCount % 2 === 1) {
      return { toArray: () => [opts.preRow], rowsWritten: 0 };
    }
    return { toArray: () => [], rowsWritten: opts.rowsWrittenOnUpdate };
  });
  const advanceSenderNonceMock = vi.fn();

  const double = {
    sql: { exec: execMock },
    log: vi.fn(),
    advanceSenderNonce: advanceSenderNonceMock,
  };
  return { double, execMock, advanceSenderNonceMock };
}

const runTransition = (double: unknown, walletIndex: number, sponsorNonce: number) =>
  (NonceDO as any).prototype.transitionQueueEntry.call(double, walletIndex, sponsorNonce, "confirmed");

describe("transitionQueueEntry confirmed branch — sender frontier advance (#284)", () => {
  it("advances sender frontier immediately when the relay confirms a sponsored tx", () => {
    const { double, advanceSenderNonceMock } = makeConfirmDouble({
      preRow: {
        dispatched_at: "2026-06-01T00:00:00.000Z",
        submitted_at: "2026-06-01T00:00:01.000Z",
        original_fee: "2500",
        sender_address: "SP3SENDERSTALE000000000000000000000000",
        sender_nonce: 140,
      },
      rowsWrittenOnUpdate: 1,
    });

    runTransition(double, 0, 999);

    expect(advanceSenderNonceMock).toHaveBeenCalledTimes(1);
    expect(advanceSenderNonceMock).toHaveBeenCalledWith("SP3SENDERSTALE000000000000000000000000", 140);
  });

  it("does NOT advance sender frontier when UPDATE is a no-op (row already confirmed — idempotent)", () => {
    const { double, advanceSenderNonceMock } = makeConfirmDouble({
      preRow: {
        dispatched_at: "2026-06-01T00:00:00.000Z",
        submitted_at: "2026-06-01T00:00:01.000Z",
        original_fee: "2500",
        sender_address: "SP3SENDERSTALE000000000000000000000000",
        sender_nonce: 140,
      },
      rowsWrittenOnUpdate: 0,
    });

    runTransition(double, 0, 999);

    expect(advanceSenderNonceMock).not.toHaveBeenCalled();
  });

  it("does NOT advance sender frontier for pre-migration rows with null sender fields", () => {
    const { double, advanceSenderNonceMock } = makeConfirmDouble({
      preRow: {
        dispatched_at: "2026-01-01T00:00:00.000Z",
        submitted_at: null,
        original_fee: null,
        sender_address: null,
        sender_nonce: null,
      },
      rowsWrittenOnUpdate: 1,
    });

    runTransition(double, 0, 42);

    expect(advanceSenderNonceMock).not.toHaveBeenCalled();
  });

  it("advances frontier for nonce 0 (first sponsored tx from a freshly seeded sender)", () => {
    const { double, advanceSenderNonceMock } = makeConfirmDouble({
      preRow: {
        dispatched_at: "2026-06-10T03:00:00.000Z",
        submitted_at: "2026-06-10T03:00:01.000Z",
        original_fee: "3000",
        sender_address: "SPQ6E2KZ6S3XA9KZJ8F4SSA01FFHMZEKGJA3GCF6",
        sender_nonce: 0,
      },
      rowsWrittenOnUpdate: 1,
    });

    runTransition(double, 1, 500);

    // Confirms the regression from silentgeckoaudit3801: sender seeded at 0,
    // nonce 0 confirmed, next /sponsor with nonce 1 was incorrectly held as gap.
    expect(advanceSenderNonceMock).toHaveBeenCalledTimes(1);
    expect(advanceSenderNonceMock).toHaveBeenCalledWith("SPQ6E2KZ6S3XA9KZJ8F4SSA01FFHMZEKGJA3GCF6", 0);
  });
});
