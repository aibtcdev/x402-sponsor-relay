# Phase 2 Result

## What Shipped

PR #353 merged as squash commit `74344d806aee9b5a9ac548deaaa0f831d5c52180`
Branch: `fix/alarm-mempool-prefetch` (deleted after merge)

### Change summary

Moved `fetchMempoolForSponsor` loop from inside `blockConcurrencyWhile` to outside (Phase 1 / Phase 2 pattern).

**Outside the lock (new):**
- `prefetchedMempoolSnapshots: Map<number, Record<number, HiroSponsorTxView> | null>`
- Parallel `Promise.all` over `reconcileWalletsPre` (same pre-lock slice as nonce-info fetch)
- Errors caught per-wallet → null entry in map

**Inside the lock (replaced):**
- Sequential for-loop over `reconcileWallets` consuming `prefetchedMempoolSnapshots`
- `reconcile_skipped_api_blind` warn emitted inside the lock for null entries
- No Hiro I/O

### Behavior preserved
- `reconcile_skipped_api_blind` fires inside the lock (same log ordering as before)
- Fail-open semantics: null snapshot skips schema reconcile for that wallet
- Feature flag guard (`isWalletCapacityEnabled`) applied to both pre-fetch and consumption

### Cursor-slice note
`reconcileWalletsPre` (computed before the lock from `walletCursorPre`) is the same slice
as `reconcileWallets` computed inside the lock. The DO is single-threaded and no requests
run between Phase 1 and Phase 2, so the two computations always yield identical results.
This matches the pattern arc0btc confirmed safe in Phase 1 / PR #326.

## Simplifier Output

One non-behavioral improvement: comment trimmed from structural description
("Mirrors the nonce-info pre-fetch above") to WHY-focused constraint
("Must stay outside blockConcurrencyWhile; sequential I/O inside the lock risks the 30 s budget").

Two potential follow-ups noted (not applied — out of scope / behavioral):
- The two `Promise.all` blocks (nonce-info + mempool) are sequential; a combined
  `Promise.all([fetchNonceInfos, fetchMempoolSnapshots])` would cut Phase 1 latency in half.
- `isWalletCapacityEnabled()` is called 3× in alarm(); could be hoisted to a local const.

## Local Checks

- `npm run check`: same pre-existing errors (tx-schemas import mismatches), no new errors.
- `npm run deploy:dry-run`: same pre-existing build errors, no new errors.

## Post-Deploy Log Check

Fetched `logs.aibtc.com/dashboard/api/logs/x402-relay?level=ERROR&limit=20`.

- Most recent ERROR (2026-04-22T23:59:45): `/keys/provision-stx` invalid signature — unrelated.
- `blockConcurrencyWhile` timeout errors: last seen 2026-04-14, 5 entries that day. None since.
  This is consistent with Phase 1 (#326) already resolving the nonce-info fetch race. Phase 2
  closes the remaining mempool-fetch vector.
- No `reconcile_skipped_api_blind` regressions at ERROR level.
- No new regressions from this change.
