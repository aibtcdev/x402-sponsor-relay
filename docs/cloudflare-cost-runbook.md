# Cloudflare Cost Runbook

This repo is part of the April 2026 bill-reduction sprint. Every cost PR
must record the Cloudflare metric it is expected to move, the
before/after window, and the rollback signal. See
`cloudflare-bill-audit-2026-04.md` (in the org root) for the full
context.

## F3a: Routine INFO log sampling

PR scope:
- `src/utils/log-sampling.ts`: deterministic sampling by message + payment
  context (paymentId, txid, walletIndex, sponsorNonce, senderAddress,
  route). `payment.poll` at 1%, `settlement_confirmed` at 5%.
- `shouldEmitLog` is consulted by both the Hono request logger
  (`src/rpc.ts`) and direct `NonceDO` info logs.
- WARN/ERROR/security/payment-terminal events are not sampled.

Expected Cloudflare movement:
- `worker-logs` ingest from `x402-relay` should drop sharply. April
  baseline: ~1.51 M of the 1.75 M weekly events came from this service,
  almost all routine INFO `payment.poll` / `settlement_confirmed` logs.
- Workers Logs event volume (once Phase 2 enables native logs) and
  Logpush archive volume scale together. Sampling reduces both.

Before/after window:
- Before: 7-day `logs.aibtc.com` per-app totals captured at deploy time.
- Fast safety check: 15-30 minutes after deploy for 5xx, 429 spikes,
  and unexpected WARN/ERROR.
- Cost signal: same-day post-deploy partial-window totals, then a full
  24h and 7-day window.

Cloudflare metric to record:
- `logs.aibtc.com` admin API: per-app daily counts and event count
  totals across the 7-day window.
- Cloudflare Account / GraphQL Analytics: subrequest count for
  `x402-sponsor-relay-production` (sanity check that traffic itself
  has not changed).
- Worker invocations for the same script over the same window.

Dashboard fallback:
- Workers & Pages -> `x402-sponsor-relay-production` -> Metrics ->
  Invocations.
- `logs.aibtc.com/dashboard` -> per-app stats -> 7-day chart.

Rollback signal:
- Loss of WARN/ERROR signal on the dashboard (i.e. the sampler is
  dropping non-INFO events).
- Operators or agents lose the ability to trace a payment from
  `payment.poll` to terminal state. (1% sampling means a single payment
  may have no `payment.poll` log entries; payment lifecycle traces
  should still be reconstructable from terminal-state logs and the
  paymentId-keyed correlation in WARN/ERROR.)
- Sustained 5xx increase or 429 increase that was previously masked by
  high-volume INFO events.

Local validation run for this change:

```sh
npm run typecheck
npm test -- src/__tests__/logger.test.ts src/__tests__/payment-status.test.ts
```

## F3b: Workers Logs migration (Phase 2, deferred)

Scope (future PR, not yet implemented):
- Replace `LogsRPC` calls with `@aibtc/platform/logger` writing to
  Workers Logs (native).
- Add Workers Logpush enablement (`logpush = true`) and a Logpush-to-R2
  job for long-term archive.
- Keep dual-write to `worker-logs` until access parity is demonstrated.

Expected Cloudflare movement:
- `worker-logs` DO row reads/writes drop to zero once dual-write ends.
- Workers Logs event volume becomes the primary cost surface; budget
  per service before cutover.
- Logpush egress to R2 becomes a small recurring cost; partition by
  `(app, date)`.

Pre-cutover checklist (mirrors the audit access-parity gate):
- List active services with recent logs.
- Filter by app, level, time window, request ID, paymentId/txid, route.
- Surface WARN/ERROR summaries across services.
- Issue-ready incident reports from a single payment lifecycle.
- Archived-log query path (R2) for older incidents.

## Operating loop

Every cost PR in this repo follows the same loop:

1. **Plan** - state the metric, expected direction, rollback path.
2. **Implement** - keep PR scope tight to one cost surface.
3. **Release** - record commit SHA, environment, deploy time.
4. **Verify** - 15-30 min health check, same-day cost check, 24-48h
   confirmation.
5. **Record** - update this runbook with before/after numbers and
   follow-up risks.
6. **Advance** - only start the next dependent step after verification
   passes or a rollback decision is made.
