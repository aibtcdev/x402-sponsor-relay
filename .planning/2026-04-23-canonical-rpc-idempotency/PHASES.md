# Phases

## Phase 1: Merge NonceDO fetch() durability fix
Goal: Merge PR #326 (`fix(nonce): move Hiro fetches outside blockConcurrencyWhile`) on x402-sponsor-relay as-is. Already approved, mergeable, no conflicts. Verify staging deploy is clean (no `Nonce state request failed` ERRORs) before moving on.
Status: `completed`

## Phase 2: NonceDO alarm() durability fix (#350)
Goal: Apply the same Phase1/Phase2 pattern from #326 to `fetchMempoolForSponsor` inside `alarm()` (`nonce-do.ts:8163-8175`). Pre-fetch all wallet mempool snapshots in parallel outside `blockConcurrencyWhile`; consume inside. Preserve `reconcile_skipped_api_blind` fail-open semantics. New branch + PR addressing #350. Depends on Phase 1.
Status: `completed`

## Phase 3: Rework PR #271 (Hiro 429/503 dedup)
Goal: Address the four open review asks on PR #271: (a) drop `closes #267` from PR body since current main no longer matches the original phantom-txid scenario; (b) add focused regression test for 429/503 → returns false in `verifyTxidAlive`; (c) update stale fail-open JSDoc at `settlement.ts:1206`; (d) reply to arc0btc on whether 502 should be included (and add it if yes). Push to existing branch, request re-review, merge.
Status: `completed`

## Phase 4: tx-schemas spec for canonical RPC payment-identifier (#28)
Goal: In aibtcdev/tx-schemas, add optional `paymentIdentifier` to `RpcSubmitPaymentArgsSchema`, extract shared `PaymentIdentifierSchema` exported from `core` (single source for HTTP and RPC), add `RPC_PAYMENT_IDENTIFIER_CONFLICT` to `RpcErrorCodeSchema`, update `CanonicalDomainBoundary.transportBoundaries.sharedDomain` note, add CHANGELOG entry. Pure additive, minor version bump, no breaking changes. Branch + PR.
Status: `completed`

## Phase 5: Release tx-schemas + publish to npm
Goal: Merge the release-please PR generated from Phase 4 to cut the new minor version and publish `@aibtc/tx-schemas` to npm. No code change in this phase — gating step so downstream phases can install the new version.
Status: `pending`

## Phase 6: Relay RPC routes through PaymentIdService (#351)
Goal: In x402-sponsor-relay, bump `@aibtc/tx-schemas` to the new version and route RPC `submitPayment` through the existing `PaymentIdService`. Cache hit + same payload → idempotent return; cache hit + different payload → `PAYMENT_IDENTIFIER_CONFLICT`. Ship pure-additive (no SHA-256 fallback yet). Update `/llms-full.txt` and `/topics/x402-v2-facilitator` discovery docs to describe the RPC parity. Add tests mirroring the V2 path's cache hit/miss/conflict cases. Depends on Phase 5.
Status: `pending`

## Phase 7: Close PR #292 with redirect
Goal: Close PR #292 with a comment explaining that the canonical client-supplied `payment-identifier` path shipped in #351, linking to the new docs, and noting the SHA-256 fallback for unaware clients can be re-evaluated as a follow-up if needed. Update issue #277 to reflect resolution path. Depends on Phase 6 merging.
Status: `pending`

## Phase 8: Staging soak on aibtc.dev
Goal: Let relay #351 bake on staging (aibtc.dev) for at least 48h. Monitor logs.aibtc.dev for unexpected `PAYMENT_IDENTIFIER_CONFLICT` errors, RPC submitPayment latency regressions, and confirm SENDER_NONCE_DUPLICATE rate baseline (no consumers using it yet, so should be unchanged). Sign off in STATE.md before consumer adoption. Depends on Phase 6.
Status: `pending`

## Phase 9: landing-page adopts paymentIdentifier (#635)
Goal: In `lib/inbox/relay-rpc.ts:215 submitViaRPC`, bump `@aibtc/tx-schemas`, derive deterministic `paymentIdentifier` from `(senderAddress, nonce, recipientAddress)` (e.g. `pay_<sha256(...).slice(0,28)>`), and pass through to the relay. Map `PAYMENT_IDENTIFIER_CONFLICT` in `RPC_ERROR_CODE_MAP` (line 50). Add tests proving same-input → same-identifier on retry. Branch + PR on aibtcdev/landing-page. Depends on Phase 8.
Status: `pending`

## Phase 10: agent-news adopts paymentIdentifier (#624)
Goal: In `src/objects/news-do.ts`, bump `@aibtc/tx-schemas`, derive `paymentIdentifier` from `(beatId, senderAddress, nonce)`, and pass to `env.X402_RELAY.submitPayment`. Map new error code in the existing RPC error handler. Branch + PR on aibtcdev/agent-news. Can run in parallel with Phase 9.
Status: `pending`

## Phase 11: Production verification
Goal: Confirm both consumers in production (aibtc.com landing + agent-news) are sending `paymentIdentifier` on every RPC submitPayment, observe SENDER_NONCE_DUPLICATE drop to near zero (target: <2/24h vs. baseline of 30/24h), and verify `PAYMENT_IDENTIFIER_CONFLICT` only appears on genuine client retry races. Capture before/after numbers, write findings to MEMORY.md, archive quest. Depends on Phases 9 + 10.
Status: `pending`
