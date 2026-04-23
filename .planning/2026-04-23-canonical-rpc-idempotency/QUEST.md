# Quest: Canonical RPC Idempotency + NonceDO Durability

**Goal:** Bring the relay's RPC `submitPayment` path to parity with the x402 V2 HTTP facilitator's canonical idempotency contract (client-supplied `payment-identifier`), finish two in-flight NonceDO durability fixes (move Hiro fetches outside `blockConcurrencyWhile` in both `fetch()` and `alarm()`), land the defensive 429/503 dedup polish, and adopt the new RPC contract in both consumer apps.

**Status:** active

**Repos:**
- /home/whoabuddy/dev/aibtcdev/x402-sponsor-relay (primary — relay endpoints, NonceDO, PaymentIdService, deploy target)
- /home/whoabuddy/dev/aibtcdev/tx-schemas (schema source of truth, npm `@aibtc/tx-schemas`, release-please managed)
- /home/whoabuddy/dev/aibtcdev/landing-page (RPC consumer #1 — BTC inbox submit path)
- /home/whoabuddy/dev/aibtcdev/agent-news (RPC consumer #2 — NewsDO submit path)

**Created:** 2026-04-23

---

## Context

### Production evidence

- **30 SENDER_NONCE_DUPLICATE rejections in 24h** on aibtc-landing (2026-04-22 → 2026-04-23) on sequential nonces 1931-1941 across multiple BTC inbox addresses. PR #349 reduced the noise but did not eliminate it — the underlying gap is that the RPC path has no idempotency primitive, so retries collide on nonce reservation. Drives the canonical RPC idempotency track.
- **6 ERRORs on x402-relay 2026-04-13/14** with `"A call to blockConcurrencyWhile() in a Durable Object waited for too long"` — drives the two NonceDO durability PRs (#326 already approved, #350 follows the same pattern in `alarm()`).
- **0 hits in 12 days** on phantom-txid / `verifyTxidAlive` failure patterns — PR #271 (Hiro 429/503 → dead) is defensive polish to land cleanly, not a hot fix.

### Canonical idempotency contract

`tx-schemas/src/core/enums.ts:139-148` `CanonicalDomainBoundary.paymentIdentity` already mandates:

```
field: "paymentId"
idempotencyInputField: "payment-identifier"
duplicateSubmissionPolicy: "same-submission-reuses-paymentId-until-terminal-outcome"
```

The relay's V2 HTTP path implements this via `src/services/payment-identifier.ts` (`PaymentIdService`). The RPC path is the gap. PR #292's relay-computed `SHA-256(txHex)` mechanism is non-canonical (the contract requires a *client*-supplied identifier) and will be superseded once the canonical path ships.

### Filed issues / PRs (state at quest creation)

| Repo | Item | State | Phase |
|------|------|-------|-------|
| x402-sponsor-relay | PR #326 | APPROVED, MERGEABLE | 1 |
| x402-sponsor-relay | #350 | OPEN, depends on #326 | 2 |
| x402-sponsor-relay | PR #271 | APPROVED, 4 review asks | 3 |
| tx-schemas | #28 | OPEN | 4 |
| x402-sponsor-relay | #351 | OPEN, depends on tx-schemas#28 published | 6 |
| x402-sponsor-relay | PR #292 | APPROVED, DIRTY → close on #351 ship | 7 |
| landing-page | #635 | OPEN, depends on #351 deployed | 9 |
| agent-news | #624 | OPEN, depends on #351 deployed | 10 |

## Key Dependencies

```
tx-schemas #28 (Phase 4)
    └─▶ release-please publishes @aibtc/tx-schemas (Phase 5)
            └─▶ relay #351 RPC routes through PaymentIdService (Phase 6)
                    ├─▶ close PR #292 with redirect (Phase 7)
                    └─▶ staging soak on aibtc.dev (Phase 8)
                            ├─▶ landing-page #635 (Phase 9, parallel)
                            └─▶ agent-news #624 (Phase 10, parallel)
                                    └─▶ production verification (Phase 11)
```

Independent tracks (can run in parallel with the dependency chain above):
- Phase 1 (PR #326 merge) → Phase 2 (#350)
- Phase 3 (PR #271 rework)

### Out of scope

- x402-api consumer adoption — separate quest, immediately follows.

### Coexistence note

Two other quests are active at creation time (`2026-04-03-ops-dashboard`, `2026-04-13-proactive-confirmation`). Multiple quests can coexist; only one runs at a time via `/quest-run`.
