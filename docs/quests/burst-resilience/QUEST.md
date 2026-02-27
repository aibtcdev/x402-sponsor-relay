# Quest: burst-resilience

## Goal

Fix relay reliability under burst load — transient drop handling, dynamic fee escalation, and updated documentation. Preparing for 100 to 10,000 agent scale.

## Problem Statement

At 2026-02-27 03:00 UTC, a burst of ~70 relay requests (sBTC inbox payments, 100 sats each) hit in a single hour from aibtc-landing agents. Results:

- 30 transactions reported as `dropped_replace_by_fee` (43% reported failure rate)
- 17 nonces quarantined (`txid_recorded_on_failed_release`)
- 8 stale nonce evictions
- `pool_invariant_violation` on wallet 0
- Reported success rate dropped to 57% for that hour, dragging 24h rate to 88%
- System self-healed after ~20 minutes, subsequent hours showed 100% success

### Root Cause (Corrected After On-Chain Verification)

**Critical finding:** On-chain verification of all 30 "dropped" txids shows **28 of 30 actually confirmed successfully**. Only 1 was a real abort (`abort_by_post_condition`), 1 had a lookup error. The **93% false positive rate** was caused by:

**The bug: `isTxStatusTerminal()` in `src/services/settlement.ts`** treated `dropped_*` statuses as terminal — the polling loop exited immediately on a drop report. But Hiro's `dropped_*` status is **transient**: the transaction is often still in mempool or about to confirm.

**Secondary effects of the false-positive drops:**
- 17 nonces quarantined unnecessarily (NonceDO saw the relay fail and quarantined those nonces)
- 8 stale nonce evictions (pool fragmentation)
- `pool_invariant_violation` (pool state diverged from on-chain reality)
- Agents told `retryable: false` for transactions that confirmed moments later

**Static fee tier** (secondary) — `SponsorService.sponsorTransaction()` always used `medium_priority`. Dynamic fee escalation was added in Phase 2 to reduce confirmation latency under burst load, though the primary incident was caused by the polling bug, not fees.

## Incident Data

| Metric | Value |
|--------|-------|
| Window | 03:00-04:00 UTC, Feb 27 |
| Total requests | ~70 |
| Reported success | 40 (57%) |
| Reported RBF drops | 30 (43%) |
| Actually confirmed on-chain | 28/30 (93% false positive) |
| Actually aborted | 1/30 (3%) |
| Quarantined nonces | 17 |
| Stale evictions | 8 |
| Recovery time | ~20 minutes (self-healed) |

## Key Finding: abort_* vs dropped_* Semantics

On the Stacks blockchain, only `abort_*` statuses are truly terminal (on-chain rejection). The `dropped_*` statuses from Hiro's API are transient — they indicate the transaction is not yet confirmed, but it may still confirm. The relay now:

1. Treats `abort_*` as terminal — exits polling loop immediately with `SETTLEMENT_FAILED` (422)
2. Treats `dropped_*` as transient — logs a warning and continues polling through the 60s timeout
3. If still dropped at timeout, returns `status: "pending"` (safe for agents to poll via `/verify/:receiptId`)

## Repos

| Repo | Role |
|------|------|
| aibtcdev/x402-sponsor-relay | Primary — all fixes are relay-side |

## Constraints

- Cloudflare Workers environment (no long-lived processes)
- Durable Objects for state management (NonceDO already exists)
- Must be backward compatible — no agent-facing API changes except adding new error codes
- Conventional commits: `fix(fees):`, `feat(backpressure):`, `fix(settlement):`, etc.
- Each phase independently deployable

## Scale Context

| Scenario | Volume | Burst | Status |
|----------|--------|-------|--------|
| Current | ~100-400 tx/day | up to 70/hour | fixed with Phase 1 |
| Near-term | 1,000 agents | 200-500 tx/hour | Phase 2 fee escalation helps |
| Medium-term | 10,000 agents | 1,000+ tx/hour | needs queue + admission |

## Status

**Phase:** Complete (3/3 phases)
**Branch:** main (merged)
**PRs:** Phases 1-2 merged, Phase 3 committed directly
