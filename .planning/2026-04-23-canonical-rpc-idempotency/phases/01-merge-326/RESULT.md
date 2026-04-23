# Phase 1 Result: Merge PR #326

**Status:** completed
**Merged commit:** 307bb3c
**Merged at:** 2026-04-23T07:41:20Z

## What Was Done

1. Reviewed PR #326 (`fix(nonce): move Hiro fetches outside blockConcurrencyWhile`) — single-file change to `src/durable-objects/nonce-do.ts`, two-phase split in both `assignNonce()` and `alarm()`.

2. Addressed arc0btc's review items:
   - **[question] Cursor slice mismatch:** Confirmed safe. `getStateValue(ALARM_WALLET_CURSOR_KEY)` reads from in-memory SQL state; the DO is single-threaded, so no operation can advance the cursor between Phase 1 and Phase 2 of `alarm()`. The defensive re-computation in Phase 2 is functionally identical to Phase 1's slice. Posted explanation as a PR comment.
   - **[nit] Redundant has+get:** Applied. Replaced three-line `has + get` ternary with a single `Map.get` call (commit `e918e94` on the fork branch). `Map.get` already returns `undefined` for absent keys and `null` for keys explicitly set to `null`. Updated inline comment to document the distinction.

3. Pushed the nit fix to the fork's branch (`tfireubs-ui/fix/noncedo-cold-start`), updating PR head to `e918e94`.

## Simplifier Output

One change produced: the `has + get` → `Map.get` simplification (item 2 above). All other code — two-phase structure, comments, TypeScript types, error handling — was clean with no redundancy.

## Local CI Results

- `npm run check` (tsc --noEmit): PASSED, no new errors
- `npm run deploy:dry-run`: PASSED, build successful at 2366.61 KiB / 476.89 KiB gzip
- Pre-existing warnings (multiple environments, duplicate package.json key) unchanged

## Post-Deploy Log Status

Fetched production error logs from `logs.aibtc.com` (x402-relay, ERROR level, limit 50) at time of merge:
- Last `blockConcurrencyWhile` timeout: `2026-04-14T01:48:59` (9 days before merge)
- Most recent ERROR: `2026-04-22T23:59:45` — `provision-stx` signature error, unrelated
- Zero `blockConcurrencyWhile` errors in the 9 days before merge
- Cloudflare Git integration auto-deploy triggered on merge; fix takes effect on next DO cold start
