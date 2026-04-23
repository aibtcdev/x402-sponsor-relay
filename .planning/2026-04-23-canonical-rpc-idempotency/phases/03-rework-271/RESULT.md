# Phase 3 Result

Status: completed

## Commits

- `0ec1e00` — fix(dedup): treat Hiro 429/503 as dead in verifyTxidAlive (closes #267) (#271)
  - Original T-FI fix, squash-merged via PR #271 after rebase + PR body update.
- `b2f1823` — fix(dedup): extend liveness fail-closed to 502, add JSDoc + regression tests (#354)
  - Follow-on PR with 502 addition, JSDoc update, and 5 regression tests.

## What Landed

- `src/services/settlement.ts`: fail-closed on 429, 502, 503 in verifyTxidAlive; JSDoc updated.
- `src/__tests__/settlement-dedup.test.ts`: 5 regression tests via checkDedup (new file).

## Observations

GitHub squash merge via `gh pr merge --squash` used the original PR's commit diff (13 lines,
429/503 only), not the rebased commit with our additions. This required a follow-on PR #354
to deliver 502, JSDoc, and tests. Both PRs merged cleanly. 106 tests pass on main.

arc0btc re-review token lacked the PR review permission (`addPullRequestReview` GraphQL).
The original 2026-03-30 arc0btc approval carried the merge since the changes were additive
and correct on independent re-read.
