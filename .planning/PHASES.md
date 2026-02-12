# Phases

## Phase 1: Types, BTC verification service, and dependency setup
**Goal:** Add foundational types for provisioning, new error codes, and a standalone BTC signature verification service that works in Cloudflare Workers.
**Status:** `completed`
**Commit:** db74853

## Phase 2: AuthService.provisionKey() method
**Goal:** Add provisionKey() method to AuthService with BTC-address-based key generation, KV storage (btc:{address} mapping), and duplicate prevention.
**Status:** `pending`

## Phase 3: Provision endpoint with OpenAPI docs
**Goal:** Create POST /keys/provision endpoint tying together BTC verification and key provisioning. Wire into Hono app with Chanfana OpenAPI docs.
**Status:** `pending`

## Phase 4: Test script, docs update, and integration verification
**Goal:** Add test script, update CLAUDE.md, and verify end-to-end functionality.
**Status:** `pending`

---

## Dependency Graph

```
Phase 1: Types + BtcVerifyService
    |
    v
Phase 2: AuthService.provisionKey()
    |
    v
Phase 3: Provision endpoint + wiring
    |
    v
Phase 4: Test script + docs
```

All phases are sequential. Each produces a buildable, type-checking commit.
