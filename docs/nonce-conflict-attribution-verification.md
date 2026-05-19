# Verification: nonce-conflict-attribution

**Prepared:** 2026-05-18
**Status:** Pre-deploy — PRs open, 24h window not yet started
**Quest:** nonce-conflict-attribution

---

## 1. Pre-Deploy State

### Production relay version at time of prep

```
GET https://x402-relay.aibtc.com/health → version: "1.32.1"
GET https://x402-relay.aibtc.dev/health  → version: "1.32.1" (staging)
```

None of the quest PRs are deployed yet. All seven PRs are open as of 2026-05-18.

### PR Dependency Stack

| PR | Title | Repo | Status | Base branch | Issue |
|----|-------|------|--------|-------------|-------|
| [#379](https://github.com/aibtcdev/x402-sponsor-relay/pull/379) | feat(relay): add nonceExpiresAt to /relay and /sponsor responses (#374) | relay | OPEN | main | #374 |
| [#380](https://github.com/aibtcdev/x402-sponsor-relay/pull/380) | fix(sponsor): FALLBACK_NONCE_EXPIRY_MS constant + okWithTx nonceExpiresAt test | relay | OPEN | feat/374-sponsor-nonce-expires-at (#379) | #374 |
| [#383](https://github.com/aibtcdev/x402-sponsor-relay/pull/383) | feat(sponsor): add sponsorNonceValidForMs and docs to nonce-expires-at contract (#374) | relay | OPEN | fix/380-fallback-nonce-expiry-constant (#380) | #374 |
| [#384](https://github.com/aibtcdev/x402-sponsor-relay/pull/384) | test(sponsor): contract test for nonceExpiresAt TTL (#375) | relay | OPEN | feat/374-sponsor-nonce-ttl-contract (#383) | #375 |
| [#381](https://github.com/aibtcdev/x402-sponsor-relay/pull/381) | fix(settlement): attribute nonce conflicts via reason_data.is_origin (#377) | relay | OPEN | main | #377 |
| [#382](https://github.com/aibtcdev/x402-sponsor-relay/pull/382) | fix(settle): re-sponsor pre-sponsored txs on sponsor-fault conflict (#373) | relay | OPEN | main | #373 |
| [#385](https://github.com/aibtcdev/x402-sponsor-relay/pull/385) | perf(settle): pool Hiro WebSocket subscriptions per sponsor sender (#376) | relay | OPEN | main | #376 |
| [#883](https://github.com/aibtcdev/landing-page/pull/883) | fix(inbox): clamp reconciliation queue to nonceExpiresAt (#375) | landing-page | OPEN | main | #375 |

### PR Chain Dependency Diagram

```
main
 ├── #379 (base: main) ─► #380 (base: #379) ─► #383 (base: #380) ─► #384 (base: #383)
 │                                              [Phase 3 / #374]     [Phase 4 / #375]
 ├── #381 (base: main)   [Phase 1 / #377]
 ├── #382 (base: main)   [Phase 2 / #373]  ← logically depends on #381 being deployed first
 └── #385 (base: main)   [Phase 6 / #376]

landing-page:
 └── #883 (base: main)   [Phase 5 / #375]  ← requires relay #383 deployed to prod
```

**Note on #381 and #382:** Both have `main` as base branch. Phase 2 (#382) was developed assuming Phase 1 (#381) code is present. Merge #381 first, then #382 should be rebased/verified before merge.

---

## 2. Merge Order Guidance

### Recommended sequence

1. **#379** — Merge first. Foundation for the #374 TTL chain. `feat/374-sponsor-nonce-expires-at` → `main`
2. **#380** — Merge immediately after #379. Stacked on #379; will need rebase after #379 merges. `fix/380-fallback-nonce-expiry-constant` → `main`
3. **#383** — Merge after #380. Stacked on #380; rebase after #380 merges. `feat/374-sponsor-nonce-ttl-contract` → `main`
4. **#384** — Merge after #383. Stacked on #383; rebase after #383 merges. `test/375-sponsor-ttl-contract-test` → `main`
5. **#381** — Independent of the #379→#383 chain; can merge any time but should be before #382. `fix/377-nonce-conflict-attribution` → `main`
6. **#382** — Merge after #381. Both have `main` as base branch but #382 depends on Phase 1 types being present. Verify no rebase needed after #381 merges. `fix/373-settle-responsor-recovery` → `main`
7. **#385** — Independent; can merge any time alongside the above. `perf/376-pool-hiro-ws-subscriptions` → `main`
8. **#883** (landing-page) — Merge **after** relay #383 is deployed to mainnet production (consumers need `nonceExpiresAt` in the live `/sponsor` response for CI contract tests to pass if unmocked). `fix/375-clamp-reconciliation-to-nonce-expires-at` → `main`

### Deployment notes

- Cloudflare Git integration auto-deploys on push to `main` for both repos. Every merge to `main` triggers a production deploy. No manual `wrangler deploy` step needed.
- The relay stack #379→#380→#383→#384 is a 4-deep chain. Options:
  - **(a) Sequential merges**: Merge #379, wait for CI, merge #380 (after rebase), wait, merge #383 (after rebase), wait, merge #384 (after rebase). Safest; 4 separate deploys.
  - **(b) Collapse with merge queue**: If the repo has merge queue configured, queue all four in order. Each merge triggers a rebase of the next.
- For #381 → #382: both base on `main`. After #381 merges, run `git fetch origin && git rebase origin/main` on #382's branch and push before merging #382.
- **Landing-page PR #883 must not merge until relay version with #383 is live on mainnet.** Verify with `curl https://x402-relay.aibtc.com/health | jq .version` — version should be ≥ next release after #383 ships.

---

## 3. Worker-Logs Sanity Check

**Admin key:** Source `~/dev/aibtcdev/worker-logs/.env` for `ADMIN_API_KEY` (length: 64 chars).

**Reachability check result (2026-05-18):** `GET https://logs.aibtc.com/` returned HTTP 200. Admin key is valid. Service is up.

**Registered apps:** `x402-relay`, `aibtc-landing`, `x402-api-host`, `agent-news`

**Quick health check command for future runs:**
```bash
source ~/dev/aibtcdev/worker-logs/.env
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://logs.aibtc.com/ -H "X-Admin-Key: ${ADMIN_API_KEY}"
```
Expected: `HTTP 200`. If not 200, admin key may have rotated — check `~/dev/aibtcdev/worker-logs/.env`.

---

## 4. Baseline Metrics (Pre-Deploy)

Measured 2026-05-18 from production logs at `logs.aibtc.com`:

| Metric | Baseline (pre-deploy) | Query window |
|--------|----------------------|--------------|
| `conflicting_nonce` hard errors in aibtc-landing | **10** total since May 15 (8 on May 15, 2 on May 17) | May 15–18 |
| `Broadcast rejected by node (client error)` in x402-relay | **10** since May 15 | May 15–18 |
| WS 429 fallbacks (`Hiro tx stream errored; falling back`) in x402-relay | **15** since May 14 | May 14–18 |
| Largest burst of WS 429s in one minute | **7** (2026-05-18 21:00 UTC) | May 14–18 |
| `settle.responsor_after_conflict` events | **0** (event doesn't exist pre-deploy) | May 14–18 |
| `SENDER_NONCE_CONFLICT` error code in any log | **0** (code doesn't exist pre-deploy) | May 14–18 |
| `SENDER_NONCE_GAP` fallback logs | **0** | May 14–18 |

---

## 5. Log Queries for Post-Deploy Verification

Run these after all relay PRs are merged and Cloudflare has deployed. Use a 24-hour window starting from the timestamp of the final merged commit's deploy.

**Setup:**
```bash
source ~/dev/aibtcdev/worker-logs/.env
# ADMIN_API_KEY is now set
SINCE="<ISO 8601 timestamp of deploy + 1 minute>"  # e.g. "2026-05-20T14:00:00Z"
```

### Metric 1: Hard CONFLICTING_NONCE on pre-sponsored /settle where responsible=sponsor

**Target: 0 in 24h window**

```bash
# Count ConflictingNonceInMempool events where responsible=sponsor on /settle
curl -s "https://logs.aibtc.com/logs?app_id=x402-relay&level=WARN&since=${SINCE}&limit=500" \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  | jq '[.data[] | select(
      .message == "Broadcast rejected by node (client error)" and
      .context.path == "/settle" and
      .context.clientRejection == "ConflictingNonceInMempool" and
      .context.responsible == "sponsor"
    )] | length'
```

**Also check for settle errors returning CONFLICTING_NONCE to callers** (from aibtc-landing):
```bash
curl -s "https://logs.aibtc.com/logs?app_id=aibtc-landing&level=ERROR&since=${SINCE}&limit=500" \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  | jq '[.data[] | select(.context.errorReason == "conflicting_nonce")] | length'
```

Expected: 0 (or close to 0 — some sender-side conflicts are expected and acceptable).

### Metric 2: SENDER_NONCE_CONFLICT events appearing; no sponsor slot burned

**Target: SENDER_NONCE_CONFLICT appears for sender-side conflicts; no sponsor slot consumed on those paths**

```bash
# Count SENDER_NONCE_CONFLICT codes in x402-relay responses
curl -s "https://logs.aibtc.com/logs?app_id=x402-relay&since=${SINCE}&limit=500" \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  | jq '[.data[] | select(
      .context.code == "SENDER_NONCE_CONFLICT" or
      .context.agentErrorCode == "SENDER_NONCE_CONFLICT"
    )] | {count: length, events: [.[] | {timestamp, message, context}]}'
```

```bash
# Confirm sender-side conflicts are NOT generating sponsor nonce assignment events
# (cross-check: sponsor slot burns happen at debug level as "nonce.assigned" or similar)
curl -s "https://logs.aibtc.com/logs?app_id=x402-relay&level=DEBUG&since=${SINCE}&limit=500" \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  | jq '[.data[] | select(.message | contains("nonce") and contains("assign"))] | length'
```

Expected: SENDER_NONCE_CONFLICT count > 0 (for any genuine sender errors) AND no corresponding sponsor nonce assignments for those request_ids.

### Metric 3: settle.responsor_after_conflict log events (recovery working)

**Target: ≥1 event visible if any sponsor-side conflict occurred and was recovered**

```bash
curl -s "https://logs.aibtc.com/logs?app_id=x402-relay&since=${SINCE}&limit=500" \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  | jq '[.data[] | select(.message == "settle.responsor_after_conflict")] |
    {count: length, events: [.[] | {timestamp, context}]}'
```

Expected: ≥1 if any sponsor-side conflicts occurred and were recovered. 0 is acceptable only if no sponsor-side conflicts happened in the window.

### Metric 4: /sponsor response includes nonceExpiresAt + sponsorNonceValidForMs

**Target: Both fields present in live /sponsor response**

Direct probe against production (requires a valid API key and sponsored tx):
```bash
npm run test:sponsor -- https://x402-relay.aibtc.com
# Inspect output for: nonceExpiresAt (ISO 8601) and sponsorNonceValidForMs (number)
```

Or check worker-logs for any /sponsor INFO events that include the fields:
```bash
curl -s "https://logs.aibtc.com/logs?app_id=x402-relay&level=INFO&since=${SINCE}&limit=100" \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  | jq '[.data[] | select(.context.path == "/sponsor" and .context.nonceExpiresAt != null)] |
    {count: length, sample: .[0].context}'
```

Alternatively, check the OpenAPI spec:
```bash
curl -s "https://x402-relay.aibtc.com/openapi.json" \
  | jq '.paths."/sponsor".post.responses."200".content."application/json".schema.properties | keys'
# Should include "nonceExpiresAt" and "sponsorNonceValidForMs"
```

### Metric 5: WS 429 fallbacks ≤1 per 20-tx burst

**Target: ≤1 WS 429 per burst (baseline was 7-14 per burst)**

```bash
# Count total WS 429 fallbacks in 24h
curl -s "https://logs.aibtc.com/logs?app_id=x402-relay&level=WARN&since=${SINCE}&limit=500" \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  | jq '[.data[] | select(.message == "Hiro tx stream errored; falling back")] |
    {count: length, by_minute: (group_by(.timestamp[0:16]) | map({time: .[0].timestamp[0:16], count: length}))}'
```

Expected: Total count significantly lower than baseline (15 in 4 days). No single minute with >1 event.

### Metric 6: No new SENDER_NONCE_GAP fallbacks caused by the changes

**Target: 0 new SENDER_NONCE_GAP events in the 24h window**

```bash
curl -s "https://logs.aibtc.com/logs?app_id=x402-relay&level=WARN&since=${SINCE}&limit=500" \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  | jq '[.data[] | select(
      .context.warningCode == "SENDER_NONCE_GAP" or
      .context.code == "SENDER_NONCE_GAP" or
      (.message | contains("SENDER_NONCE_GAP"))
    )] | length'
```

### Metric 7: landing-page re-sponsor calls past TTL (no stale rebroadcasts)

**Target: Log evidence of /sponsor re-calls when TTL exceeded; no stale hex rebroadcasts**

```bash
# Check aibtc-landing for re-sponsor activity after TTL
curl -s "https://logs.aibtc.com/logs?app_id=aibtc-landing&level=INFO&since=${SINCE}&limit=500" \
  -H "X-Admin-Key: ${ADMIN_API_KEY}" \
  | jq '[.data[] | select(
      .message | contains("re-sponsor") or contains("sponsor_refresh") or contains("nonce_expired")
    )] | {count: length, events: [.[] | {timestamp, message, context}]}'
```

Note: The exact log message depends on what landing-page PR #883 emits. Check the PR description for the log vocabulary before running this query.

---

## 6. Production Probe Commands

Run these immediately after all relay PRs are deployed to confirm the wire contract:

```bash
# Health check (no auth)
curl -s https://x402-relay.aibtc.com/health | jq .

# Verify /sponsor response shape (requires API key in .env)
npm run test:sponsor -- https://x402-relay.aibtc.com
# Expected output should include:
# nonceExpiresAt: "2026-05-XX T..."  (ISO 8601)
# sponsorNonceValidForMs: 600000     (10 * 60 * 1000 ms)

# Verify /settle endpoint (requires funded test wallet)
npm run test:settle -- https://x402-relay.aibtc.com
# Expected: success response, ws_connection pooled (check logs for single WS open)

# Verify OpenAPI reflects new fields
curl -s https://x402-relay.aibtc.com/openapi.json \
  | jq '.paths."/sponsor".post.responses."200".content."application/json".schema.properties | keys'
# Expected: includes "nonceExpiresAt" and "sponsorNonceValidForMs"

# Staging probe (testnet)
curl -s https://x402-relay.aibtc.dev/health | jq .
npm run test:sponsor -- https://x402-relay.aibtc.dev
npm run test:settle -- https://x402-relay.aibtc.dev
```

---

## 7. Acceptance Table

| # | Metric | Target | Query section | Status |
|---|--------|--------|---------------|--------|
| 1 | Hard `CONFLICTING_NONCE` on pre-sponsored `/settle` where `responsible=sponsor` | 0 in 24h | §5 Metric 1 | Pending (PRs not merged) |
| 2 | `SENDER_NONCE_CONFLICT` events for sender-side conflicts; no sponsor slot burned | ≥0 events if sender conflicts occur; 0 sponsor slots burned on those | §5 Metric 2 | Pending |
| 3 | `settle.responsor_after_conflict` log event when recovery triggered | ≥1 if sponsor conflict occurred and recovered | §5 Metric 3 | Pending |
| 4 | `/sponsor` response includes `nonceExpiresAt` + `sponsorNonceValidForMs` | Both fields present in live response | §5 Metric 4 | Pending |
| 5 | WS 429 fallbacks per 20-tx burst | ≤1 per burst (baseline: 7–14) | §5 Metric 5 | Pending |
| 6 | No new `SENDER_NONCE_GAP` fallback logs | 0 in 24h post-deploy | §5 Metric 6 | Pending |
| 7 | landing-page re-calls `/sponsor` past TTL; no stale hex rebroadcasts | Log evidence of re-sponsor; 0 stale rebroadcasts | §5 Metric 7 | Pending |

---

## 8. GitHub Issue Closure Drafts

When the 24h metrics pass, post the following comments and close each issue.

### Issue #377 — Use `reason_data.is_origin` for nonce-conflict attribution

**Comment draft:**
```
Fixed by #381 (merged: <DATE>).

`decideBroadcastAction` now returns `responsible: "sender"` for `BadNonce` when `is_origin === true` and `responsible: "sponsor"` when `is_origin === false`. The structured pipeline is threaded through `settlement.broadcastAndConfirm` and consumed by `/settle` and `/relay`. Unit-test matrix covers all (reason, is_origin) combinations.

Metric: 0 hard CONFLICTING_NONCE errors attributable to sponsor-side conflicts in 24h post-deploy. TODO: insert observed count.

Closing.
```

### Issue #373 — `/settle` re-sponsor pre-sponsored txs on ConflictingNonceInMempool

**Comment draft:**
```
Fixed by #382 (merged: <DATE>), depends on #381.

Pre-sponsored transactions arriving at `/settle` with a sponsor-side `ConflictingNonceInMempool` now re-sponsor via `SponsorService.sponsorTransaction` and rebroadcast on a fresh nonce. The `settle.responsor_after_conflict` log event is emitted on the recovery path. Sender-side conflicts return `SENDER_NONCE_CONFLICT` (HTTP 422) with no sponsor slot consumed.

Metric: 0 hard CONFLICTING_NONCE returns for sponsor-fault pre-sponsored txs in 24h. TODO: insert observed count. Recovery events: TODO insert `settle.responsor_after_conflict` count.

Closing.
```

### Issue #374 — Explicit `validUntil` on `/sponsor` responses

**Comment draft:**
```
Fixed by #379, #380, #383 (merged: <DATEs>).

`POST /sponsor` success response now includes:
- `nonceExpiresAt`: ISO 8601 UTC timestamp (absolute TTL)
- `sponsorNonceValidForMs`: integer ms equal to `STALE_THRESHOLD_MS` (600000)

Both fields are documented in `docs/sponsor-nonce-ttl.md`, reflected in `/openapi.json` and `/docs`, and surfaced in `/llms-full.txt` and `/topics/sponsored-transactions`.

Metric: Both fields confirmed present in live `/sponsor` response at `x402-relay.aibtc.com`. TODO: paste sample response.

Closing.
```

### Issue #375 — Align sponsor-nonce TTL with downstream queue retry budgets

**Comment draft:**
```
Fixed by relay PRs #379, #380, #383, #384 and landing-page PR #883 (merged: <DATEs>).

The relay now publishes `nonceExpiresAt` on `/sponsor` responses (Option C from the issue). The landing-page reconciliation queue reads this field and clamps its retry deadline. Past TTL, the queue re-calls `/sponsor` for fresh sponsored hex instead of rebroadcasting stale hex.

Metric: 0 stale rebroadcasts past TTL observed in aibtc-landing logs in 24h post-deploy. TODO: insert observed count.

Closing.
```

### Issue #376 — Pool Hiro WebSocket subscriptions

**Comment draft:**
```
Fixed by #385 (merged: <DATE>).

`HiroTxStream` is now a module-level singleton keyed per sender address. Multiple concurrent `/settle` calls on the same sender share one WS connection with an in-memory `{txid → resolver}` map (LRU-capped at 256). The long-poll fallback is unchanged.

Metric: WS 429 fallbacks dropped from TODO-baseline to TODO-observed in 24h post-deploy. Largest per-minute burst: TODO (baseline: 7). No single minute exceeded 1 fallback.

Closing.
```

---

## 9. Staging Deployment Notes

Staging (testnet) at `https://x402-relay.aibtc.dev` is on version 1.32.1 as of 2026-05-18. Staging also auto-deploys on push to `main`. PRs targeting `main` will deploy to staging first, then production (both auto-deployed from the same `main` branch per `wrangler.jsonc` environments).

To verify staging is up before a production merge:
```bash
curl -s https://x402-relay.aibtc.dev/health | jq .version
```

---

## 10. Notes and Caveats

1. **`responsible` field post-deploy query:** The `Broadcast rejected by node (client error)` log event pre-deploy does not include a `responsible` field (all 10 pre-deploy events show `null`). Post-deploy, the field should be populated. If it remains null, the Phase 1 wire-up may not be reaching the log statement — investigate `settlement.broadcastAndConfirm` log output.

2. **`settle.responsor_after_conflict` event:** This event name was specified in the PHASES.md. Confirm the exact event name emitted by PR #382 before querying — check `src/endpoints/settle.ts` in the merged code.

3. **Landing-page log vocabulary for TTL re-sponsor:** The exact log message for TTL-triggered re-sponsor calls was not confirmed from PR #883. Review the PR diff for log statements before running Metric 7 query.

4. **WS pooling scope:** PR #385 used a module-level singleton instead of a NonceDO holder (DO approach was rejected due to non-serializable WebSocket). The 20-concurrent-settle test should show ≤1 WS open. If WS 429s persist, check whether the module-level singleton is being reset across isolate cold starts.

5. **Issue stale description check:** All five issues (#373, #374, #375, #376, #377) were confirmed OPEN as of 2026-05-18 with accurate descriptions matching the quest work. No stale bullets found that the PRs resolved without updating the issue.

6. **CONFLICTING_NONCE vs SENDER_NONCE_CONFLICT naming:** The pre-deploy error code visible in aibtc-landing logs is `conflicting_nonce` (from x402 V2 spec). Post-deploy, sponsor-side conflicts should resolve (recovery) and sender-side conflicts should surface as `SENDER_NONCE_CONFLICT`. Monitor both error code namespaces.
