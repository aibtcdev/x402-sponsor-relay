# Quest: nonce-conflict-zero

## Goal

Eliminate remaining NONCE_CONFLICT errors in the x402 sponsor relay. After the verify-failure nonce leak fix (PR #98), conflicts continue at ~1 every 35 minutes during active traffic. The pools run 18-19 nonces ahead of confirmed chain state, close to the 20 chaining limit, and the self-healing resync masks the root cause but does not prevent agent-facing errors.

Target: zero agent-visible nonce conflicts under normal traffic (< 50 tx/hour).

## Problem Summary

Post-deploy data (2026-02-21): 6 nonce conflicts in 3.5 hours alongside ~25 successful relays. Every conflict triggers automatic resync and the next request succeeds, but agents receive a 409 error they should not see.

Pool vs chain state divergence shows pools 18-19 nonces ahead of confirmed state, meaning the pools are full of pending nonces that have been broadcast but not yet confirmed. When any of those pending transactions get dropped or replaced, the pool state diverges from reality.

## Repos

| Role    | Repo                                                    |
|---------|---------------------------------------------------------|
| Primary | `/home/whoabuddy/dev/aibtcdev/x402-sponsor-relay`      |

## Status

- [x] Phase 1 -- Add nonce lifecycle observability (implemented)
- [x] Phase 2 -- Fix resync to account for mempool state (implemented)
- [x] Phase 3 -- Guard against pool/chain divergence (implemented)
- [ ] Phase 4 -- Validate and harden under load (pending)

## Key Files

```
src/durable-objects/nonce-do.ts    -- NonceDO pool management, alarm, gap-fill, resync
src/services/sponsor.ts            -- SponsorService, nonce assignment, releaseNonceDO
src/endpoints/relay.ts             -- Relay endpoint, nonce lifecycle
src/endpoints/sponsor.ts           -- Sponsor endpoint, nonce lifecycle
src/services/settlement.ts         -- SettlementService, broadcast, nonce conflict detection
src/utils/stacks.ts                -- NONCE_CONFLICT_REASONS
```

## Design Decisions

| Decision | Choice |
|----------|--------|
| Approach | Incremental fixes, each phase independently deployable |
| Risk tolerance | Conservative -- better to slightly reduce throughput than risk more conflicts |
| Observability first | Cannot fix what we cannot see; structured logging before code changes |
| Resync strategy | Must incorporate mempool pending txs, not just possible_next_nonce |
| Pool management | Reserved nonces that were broadcast should not be recycled into available |
| Backward compat | All changes transparent to agents; no API changes |

## Issues Closed by This Quest

- Remaining nonce conflicts (~1 per 35 min under active traffic)
- Pool/chain state divergence (18-19 nonces ahead)
- Missing structured data in nonce conflict warning logs (null fields)
