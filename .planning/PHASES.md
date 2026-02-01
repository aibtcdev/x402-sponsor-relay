# Phases

## Phase 1: Remove Dead Code
**Goal:** Remove deprecated methods and unused imports from BaseEndpoint.ts
**Status:** `completed`

## Phase 2: Use Auth Middleware Properly
**Goal:** Apply `requireAuthMiddleware` to /sponsor route, remove inline auth check from endpoint handler
**Status:** `completed`

## Phase 3: Extract Shared Utilities
**Goal:** Extract duplicated code - empty usage factory, OpenAPI response schemas, simplify status logic
**Status:** `completed`

## Phase 4: Type Improvements
**Goal:** Define TierConfig interface, document hashApiKey duplication
**Status:** `pending`

---

## Dependency Graph

```
Phase 1: Remove Dead Code
    │
    ▼
Phase 2: Use Auth Middleware
    │
    ▼
Phase 3: Extract Shared Utilities
    │
    ▼
Phase 4: Type Improvements
```

All phases are sequential - each builds on clean code from the previous phase.
