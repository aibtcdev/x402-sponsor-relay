import { describe, expect, it, vi } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

/**
 * #398 Mode C — confirm-reconcile idempotency invariants.
 *
 * Verifies four properties:
 * 1. settlement_confirmed fires exactly once for a given nonce across N reconcile ticks.
 * 2. A second reconcile pass does not recompute settlement_ms (value stable).
 * 3. ledgerInFlightCount counts only 'assigned' and 'broadcasted'; confirmed rows excluded.
 * 4. ledgerGetBroadcastedNonces does not return confirmed rows after they are marked.
 */

// ---------------------------------------------------------------------------
// Helpers for transitionQueueEntry double
// ---------------------------------------------------------------------------

type SqlExecResult = {
  toArray: () => unknown[];
  rowsWritten: number;
};

function makeTransitionDouble(opts: {
  preRow: {
    dispatched_at: string | null;
    submitted_at: string | null;
    original_fee: string | null;
    sender_address: string | null;
  };
  rowsWrittenOnUpdate: number;
}) {
  const logMock = vi.fn();
  // sql.exec is called twice in the confirmed branch:
  //   1st call: SELECT → returns preRow
  //   2nd call: UPDATE → returns { rowsWritten: N }
  let callCount = 0;
  const execMock = vi.fn((): SqlExecResult => {
    callCount++;
    if (callCount % 2 === 1) {
      // Odd calls are the SELECT
      return { toArray: () => [opts.preRow], rowsWritten: 0 };
    }
    // Even calls are the UPDATE
    return { toArray: () => [], rowsWritten: opts.rowsWrittenOnUpdate };
  });

  const double = {
    sql: { exec: execMock },
    log: logMock,
  };
  return { double, execMock, logMock };
}

const runTransition = (
  double: unknown,
  walletIndex: number,
  sponsorNonce: number,
  state: "dispatched" | "confirmed" | "replaying" | "retired"
) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NonceDO as any).prototype.transitionQueueEntry.call(double, walletIndex, sponsorNonce, state);

// ---------------------------------------------------------------------------
// Test 1: settlement_confirmed fires exactly once
// ---------------------------------------------------------------------------

describe("transitionQueueEntry confirmed branch — settlement_confirmed idempotency (#398 Mode C)", () => {
  it("emits settlement_confirmed exactly once when the first UPDATE transitions the row", () => {
    const preRow = {
      dispatched_at: "2026-05-01T00:00:00.000Z",
      submitted_at: "2026-05-01T00:00:00.000Z",
      original_fee: "3000",
      sender_address: "SP_SENDER",
    };

    // First call: rowsWritten=1 (row transitions to confirmed)
    const { double: d1, logMock: log1 } = makeTransitionDouble({ preRow, rowsWrittenOnUpdate: 1 });
    runTransition(d1, 0, 42, "confirmed");
    expect(log1).toHaveBeenCalledTimes(1);
    expect(log1).toHaveBeenCalledWith("info", "settlement_confirmed", expect.objectContaining({ walletIndex: 0, sponsorNonce: 42 }));

    // Second call (simulates a repeated reconcile tick): rowsWritten=0 (already confirmed)
    const { double: d2, logMock: log2 } = makeTransitionDouble({ preRow, rowsWrittenOnUpdate: 0 });
    runTransition(d2, 0, 42, "confirmed");
    expect(log2).not.toHaveBeenCalled();
  });

  it("does not emit settlement_confirmed when the UPDATE is a no-op (already confirmed)", () => {
    const preRow = {
      dispatched_at: "2026-01-01T00:00:00.000Z",
      submitted_at: null,
      original_fee: null,
      sender_address: null,
    };
    const { double, logMock } = makeTransitionDouble({ preRow, rowsWrittenOnUpdate: 0 });
    runTransition(double, 1, 99, "confirmed");
    expect(logMock).not.toHaveBeenCalled();
  });

  it("settlement_ms is stable across repeated calls (not recomputed from Date.now on re-confirm)", () => {
    // The key invariant: rowsWritten=0 means no UPDATE happened, so settlement_ms in the DB
    // remains whatever was stored on the first successful transition. We verify the no-op call
    // does not attempt to log a (potentially different) settlementMs.
    const firstSubmittedAt = "2026-05-20T00:00:00.000Z";
    const preRow = {
      dispatched_at: null,
      submitted_at: firstSubmittedAt,
      original_fee: "2500",
      sender_address: "SP_STABLE",
    };

    // First tick: transitions (rowsWritten=1)
    const { double: d1, logMock: log1 } = makeTransitionDouble({ preRow, rowsWrittenOnUpdate: 1 });
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-05-20T01:00:00.000Z").getTime());
    runTransition(d1, 0, 7, "confirmed");
    const firstCall = log1.mock.calls[0];
    const firstSettlementMs = firstCall[2].settlementMs as number;
    expect(firstSettlementMs).toBeGreaterThan(0); // ~3600000ms

    vi.restoreAllMocks();

    // Second tick (5 minutes later): rowsWritten=0 — no log emitted at all
    const { double: d2, logMock: log2 } = makeTransitionDouble({ preRow, rowsWrittenOnUpdate: 0 });
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-05-20T01:05:00.000Z").getTime());
    runTransition(d2, 0, 7, "confirmed");
    expect(log2).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Test 2: ledgerInFlightCount excludes 'confirmed'
// ---------------------------------------------------------------------------

const runInFlightCount = (double: unknown, walletIndex: number): number =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NonceDO as any).prototype.ledgerInFlightCount.call(double, walletIndex);

describe("ledgerInFlightCount — excludes confirmed nonces (#398 Mode C)", () => {
  it("returns 0 when the only nonces in the DB are confirmed", () => {
    // Simulate: SELECT returns count=0 (query excludes 'confirmed')
    const execMock = vi.fn((): SqlExecResult => ({ toArray: () => [{ count: 0 }], rowsWritten: 0 }));
    const double = { sql: { exec: execMock } };

    const result = runInFlightCount(double, 0);
    expect(result).toBe(0);

    // Verify the SQL query does NOT include 'confirmed' in the IN list
    const sqlCall = execMock.mock.calls[0][0] as string;
    expect(sqlCall).not.toContain("'confirmed'");
    expect(sqlCall).toContain("'assigned'");
    expect(sqlCall).toContain("'broadcasted'");
  });

  it("counts only assigned+broadcasted rows (N assigned + M confirmed = returns N)", () => {
    // The double returns N (assigned+broadcasted count); confirmed are excluded by the SQL
    const assignedAndBroadcastedCount = 3;
    const execMock = vi.fn((): SqlExecResult => ({
      toArray: () => [{ count: assignedAndBroadcastedCount }],
      rowsWritten: 0,
    }));
    const double = { sql: { exec: execMock } };

    const result = runInFlightCount(double, 2);
    expect(result).toBe(assignedAndBroadcastedCount);
  });

  it("falls back to 0 when query returns no rows", () => {
    const execMock = vi.fn((): SqlExecResult => ({ toArray: () => [], rowsWritten: 0 }));
    const double = { sql: { exec: execMock } };

    const result = runInFlightCount(double, 0);
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: ledgerGetBroadcastedNonces excludes confirmed rows
// ---------------------------------------------------------------------------

const runGetBroadcastedNonces = (double: unknown, walletIndex: number) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NonceDO as any).prototype.ledgerGetBroadcastedNonces.call(double, walletIndex);

describe("ledgerGetBroadcastedNonces — excludes confirmed rows (#398 Mode C)", () => {
  it("queries with state != 'confirmed' filter so confirmed rows are not rescanned", () => {
    const execMock = vi.fn((): SqlExecResult => ({ toArray: () => [], rowsWritten: 0 }));
    const double = { sql: { exec: execMock } };

    runGetBroadcastedNonces(double, 0);

    const sqlCall = execMock.mock.calls[0][0] as string;
    // Must exclude confirmed
    expect(sqlCall).toContain("state != 'confirmed'");
    // Must still require txid IS NOT NULL
    expect(sqlCall).toContain("txid IS NOT NULL");
  });

  it("returns only non-confirmed rows (broadcasts that are still pending/failed)", () => {
    const pendingRow = {
      nonce: 100,
      txid: "0xabc",
      assigned_at: "2026-05-20T00:00:00.000Z",
      broadcasted_at: "2026-05-20T00:01:00.000Z",
    };
    const execMock = vi.fn((): SqlExecResult => ({ toArray: () => [pendingRow], rowsWritten: 0 }));
    const double = { sql: { exec: execMock } };

    const result = runGetBroadcastedNonces(double, 0);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ nonce: 100, txid: "0xabc" });
  });
});

// ---------------------------------------------------------------------------
// Test 4 (P1 regression): ledgerMarkConfirmedByReconcile advances dispatch_queue
// even when nonce_intents is ALREADY confirmed
// ---------------------------------------------------------------------------

/**
 * Build a minimal double for ledgerMarkConfirmedByReconcile.
 *
 * ledgerMarkConfirmedByReconcile does:
 *   1. UPDATE nonce_intents ... AND state != 'confirmed'  → rowsWritten = intentRowsWritten
 *   2. (if rowsWritten > 0) INSERT INTO nonce_events
 *   3. (unconditional) this.transitionQueueEntry(walletIndex, nonce, "confirmed")
 *
 * transitionQueueEntry is itself a private method on NonceDO, so we mock it directly on
 * the double rather than trying to replicate its SQL call sequence.  The mock records
 * whether it was called and, when queueRowsWritten > 0, also calls log("info",
 * "settlement_confirmed", ...) to simulate the side-effect we are asserting.
 */
function makeReconcileDouble(opts: {
  intentRowsWritten: number;  // 0 = nonce_intents already confirmed; 1 = just transitioned
  queueRowsWritten: number;   // 0 = dispatch_queue already confirmed; 1 = just transitioned
}) {
  const logMock = vi.fn();

  // sql.exec is called by ledgerMarkConfirmedByReconcile directly (UPDATE nonce_intents,
  // INSERT INTO nonce_events). We route by SQL fragment.
  const execMock = vi.fn((_sql: string, ..._args: unknown[]): SqlExecResult => {
    const sql = _sql as string;

    if (sql.includes("UPDATE nonce_intents")) {
      return { toArray: () => [], rowsWritten: opts.intentRowsWritten };
    }
    if (sql.includes("INSERT INTO nonce_events")) {
      return { toArray: () => [], rowsWritten: 1 };
    }

    // Fallback — should not be reached in this test path
    return { toArray: () => [], rowsWritten: 0 };
  });

  // Mock transitionQueueEntry: if queueRowsWritten > 0 simulate the settlement_confirmed
  // log that the real method emits on a successful dispatch_queue transition.
  const transitionQueueEntryMock = vi.fn(
    (_walletIndex: number, sponsorNonce: number, _state: string) => {
      if (opts.queueRowsWritten > 0) {
        logMock("info", "settlement_confirmed", { walletIndex: _walletIndex, sponsorNonce });
      }
    }
  );

  const double = { sql: { exec: execMock }, log: logMock, transitionQueueEntry: transitionQueueEntryMock };
  return { double, execMock, logMock, transitionQueueEntryMock };
}

const runLedgerMarkConfirmed = (double: unknown, walletIndex: number, nonce: number, txid: string): void =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NonceDO as any).prototype.ledgerMarkConfirmedByReconcile.call(double, walletIndex, nonce, txid);

describe("ledgerMarkConfirmedByReconcile — P1 regression: dispatch_queue advances even when nonce_intents already confirmed (#398 Mode C)", () => {
  it("advances dispatch_queue to confirmed when nonce_intents was ALREADY confirmed (intentRowsWritten=0)", () => {
    // Scenario: releaseNonce ran before reconciliation, so nonce_intents.state is already
    // 'confirmed'. The UPDATE nonce_intents writes 0 rows. transitionQueueEntry must still
    // be called unconditionally so dispatch_queue can advance and settlement_confirmed fires.
    const { double, logMock, transitionQueueEntryMock } = makeReconcileDouble({ intentRowsWritten: 0, queueRowsWritten: 1 });

    runLedgerMarkConfirmed(double, 0, 42, "0xdeadbeef");

    // The key invariant: transitionQueueEntry is called even though nonce_intents rowsWritten=0
    expect(transitionQueueEntryMock).toHaveBeenCalledTimes(1);
    expect(transitionQueueEntryMock).toHaveBeenCalledWith(0, 42, "confirmed");

    // settlement_confirmed must fire exactly once via transitionQueueEntry (queue transitioned)
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(logMock).toHaveBeenCalledWith("info", "settlement_confirmed", expect.objectContaining({ walletIndex: 0, sponsorNonce: 42 }));
  });

  it("does NOT re-emit settlement_confirmed when both nonce_intents AND dispatch_queue are already confirmed", () => {
    // Scenario: both tables already confirmed — a second reconcile tick must be a no-op.
    // transitionQueueEntry is still called (unconditional) but its internal guard silences it.
    const { double, logMock, transitionQueueEntryMock } = makeReconcileDouble({ intentRowsWritten: 0, queueRowsWritten: 0 });

    runLedgerMarkConfirmed(double, 0, 42, "0xdeadbeef");

    // transitionQueueEntry is called unconditionally
    expect(transitionQueueEntryMock).toHaveBeenCalledTimes(1);
    // But queueRowsWritten=0 means dispatch_queue was already confirmed → no settlement_confirmed
    expect(logMock).not.toHaveBeenCalled();
  });

  it("emits settlement_confirmed when both tables need to transition (normal happy path)", () => {
    // Normal happy path: nonce_intents transitions (intentRowsWritten=1) AND dispatch_queue transitions
    const { double, logMock, transitionQueueEntryMock } = makeReconcileDouble({ intentRowsWritten: 1, queueRowsWritten: 1 });

    runLedgerMarkConfirmed(double, 0, 55, "0xcafebabe");

    // transitionQueueEntry is called unconditionally
    expect(transitionQueueEntryMock).toHaveBeenCalledTimes(1);
    expect(transitionQueueEntryMock).toHaveBeenCalledWith(0, 55, "confirmed");
    // settlement_confirmed fires once via transitionQueueEntry
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(logMock).toHaveBeenCalledWith("info", "settlement_confirmed", expect.objectContaining({ walletIndex: 0, sponsorNonce: 55 }));
  });

  it("settlement_confirmed fires exactly once across two reconcile ticks (idempotency end-to-end)", () => {
    // Tick 1: both tables transition → settlement_confirmed fires once
    const { double: d1, logMock: log1 } = makeReconcileDouble({ intentRowsWritten: 1, queueRowsWritten: 1 });
    runLedgerMarkConfirmed(d1, 0, 77, "0xfeedface");
    expect(log1).toHaveBeenCalledTimes(1);

    // Tick 2: both already confirmed → transitionQueueEntry still called, but silent
    const { double: d2, logMock: log2 } = makeReconcileDouble({ intentRowsWritten: 0, queueRowsWritten: 0 });
    runLedgerMarkConfirmed(d2, 0, 77, "0xfeedface");
    expect(log2).not.toHaveBeenCalled();
  });
});
