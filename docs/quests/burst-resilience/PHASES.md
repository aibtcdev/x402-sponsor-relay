# Phases: burst-resilience

## Phase 1: Fix transient drop handling in polling loop

**Goal:** Stop treating `dropped_*` statuses as terminal in `broadcastAndConfirm()`. Continue polling — the transaction is likely still confirming. This single fix addresses 28 of 30 false-positive failures from the Feb 27 incident.

**The fix:**
- Split `isTxStatusTerminal()` into `isTxAborted()` (truly terminal) and `isTxDropped()` (transient)
- In the polling loop: `abort_*` → return error immediately. `dropped_*` → log warning, continue polling.
- If the tx stays `dropped_*` through the full 60s timeout, return `status: "pending"` (same as timeout)
- Nonce is NOT released early on a drop — the tx may still confirm
- Updated `verifyTxidAlive()` to also distinguish aborted from dropped

**Files changed:**
- `src/services/settlement.ts` — `isTxStatusTerminal()`, `broadcastAndConfirm()`, `verifyTxidAlive()`

**Status:** completed
**Commit:** 457f3cb — `fix(settlement): continue polling through transient dropped statuses`

---

## Phase 2: Dynamic fee escalation

**Goal:** Replace static `medium_priority` fee with pool-pressure-aware selection. While not the root cause of the incident (28/30 txs confirmed at 3,000 uSTX), higher fees under burst load reduce the chance of genuine RBF and improve confirmation latency.

**The fix:**
- Extended NonceDO `/assign` response to return `totalReserved` across all wallets
- Fee tier selection: <25% pool pressure → low, 25-60% → medium, >60% → high
- Saves fees during normal load (low instead of medium), escalates during burst

**Files changed:**
- `src/durable-objects/nonce-do.ts` — `/assign` response includes `totalReserved`
- `src/services/sponsor.ts` — fee tier selection based on pool pressure

**Status:** completed
**Commit:** 966c2b0 — `feat(fees): dynamic fee escalation based on pool pressure`

---

## Phase 3: Observability and documentation

**Goal:** Update error documentation, discovery routes, and CLAUDE.md to reflect corrected drop handling and fee escalation. Archive quest findings.

**Changes:**
- `src/routes/discovery.ts` — errors topic: `SETTLEMENT_FAILED` now notes it is `abort_*` only; new "Settlement Status: pending vs failed" section explains transient drop semantics
- `CLAUDE.md` — settlement states section updated to note `dropped_*` is transient, `abort_*` is terminal; added "Drop vs abort semantics" block
- `docs/quests/burst-resilience/QUEST.md` — corrected root cause, evidence table, key finding section
- `docs/quests/burst-resilience/PHASES.md` — all phases marked completed with commit SHAs

**Status:** completed
**Commit:** docs: update error handling docs for transient drop behavior
