# Quest: schema-driven-dashboard

## Goal

Rebuild the relay's embedded dashboard (`/dashboard`, `/stats`) on top of `@aibtc/tx-schemas` as the canonical data model. Fix critical metric bugs (settlement time inflation, missing token volume, mixed time windows), align error categorization with the 19 terminal reasons / 6 categories from tx-schemas, and add wallet throughput history. The result is a dashboard that gives operators real insight into relay health instead of misleading numbers.

## Repos

| Repo | Role |
|------|------|
| `~/dev/aibtcdev/x402-sponsor-relay` | Primary -- all code changes |
| `~/dev/aibtcdev/tx-schemas` | Read-only reference for schema shapes (`@aibtc/tx-schemas` v0.4.0) |

## Constraints

- StatsDO keeps SQLite approach (atomic upserts, no read-modify-write)
- Dashboard stays server-rendered HTML + Alpine.js (no React/build step)
- Import types from `@aibtc/tx-schemas`, don't redefine
- Cloudflare Workers environment (no Node.js APIs)
- Additive changes to `/stats` API -- don't break existing consumers
- Each phase independently deployable (no half-broken dashboard between phases)
- `@aibtc/tx-schemas` v0.4.0 is already a dependency in package.json

## Critical Bugs

1. **Settlement time shows 3-5 DAYS** -- `dispatched_at` gets set at various lifecycle points; gap-fill txs and stale held entries skew percentiles
2. **Token volume missing for /sponsor** -- hardcodes `tokenType: "STX"` and `amount: "0"` at sponsor.ts:449-450
3. **Fee stats mix time windows** -- total/average from rolling 24h (hourly_stats) but min/max from today's calendar day (daily_stats)
4. **Success rate hides client errors** -- only effective rate shown, no raw rate exposure in /stats API
5. **Error categorization too crude** -- 5 buckets vs tx-schemas' 19 terminal reasons across 6 categories
6. **Nonce pool/wallet views are snapshots** -- no throughput history (txs processed per wallet per hour)
7. **No comparison periods** -- 24h rolling vs yesterday calendar day (apples to oranges)

## Status

active
