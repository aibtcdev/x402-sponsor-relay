# Phases

## Phase 1: Standardize Response Format
**Goal:** Create consistent `ok()` / `err()` response helpers that all endpoints use, including txid, explorer link, and internal UUID.
**Status:** `completed`

## Phase 2: Fix Facilitator Health Check Bug
**Goal:** Fix the facilitator health check to use `/health` endpoint instead of relying on `/api/v1/settle` responses.
**Status:** `completed`

## Phase 3: Add API Key Infrastructure
**Goal:** Implement API key storage, validation, and per-key rate limiting infrastructure.
**Status:** `completed`

## Phase 4: Add /sponsor Endpoint
**Goal:** Create new `/sponsor` endpoint for general transaction sponsorship (direct broadcast, no facilitator).
**Status:** `completed`

## Phase 5: Implement Fee Monitoring per API Key
**Goal:** Track sponsor fees per API key with spending caps and alerts.
**Status:** `completed`

## Phase 6: Update Dashboard for API Key Stats
**Goal:** Add API key statistics to the dashboard for monitoring usage.
**Status:** `completed`

## Phase 7: Documentation and Testing
**Goal:** Update documentation, add test script for /sponsor, prepare for high traffic.
**Status:** `completed`

---

## Dependency Graph

```
Phase 1: Standardize Response Format ──┐
                                       ├──► Phase 3: API Key Infrastructure
Phase 2: Fix Facilitator Health Check ─┘              │
                                                      ▼
                                       Phase 4: /sponsor Endpoint
                                                      │
                                                      ▼
                                       Phase 5: Fee Monitoring per Key
                                                      │
                                                      ▼
                                       Phase 6: Dashboard API Key Stats
                                                      │
                                                      ▼
                                       Phase 7: Documentation and Testing
```

**Note:** Phases 1 and 2 can be executed in parallel.
