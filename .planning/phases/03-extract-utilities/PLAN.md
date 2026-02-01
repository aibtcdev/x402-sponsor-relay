# Phase 3: Extract Shared Utilities

## Goal
Extract duplicated code into shared utilities to improve maintainability.

## Tasks

### Task 1: Extract `createEmptyUsage()` factory function
**File:** `src/services/auth.ts`
**Status:** completed

The same empty `ApiKeyUsage` object is created in:
- `recordUsage()` method (lines 249-256)
- `recordFeeSpent()` method (lines 403-410)

Extract to a helper function:
```typescript
function createEmptyUsage(date: string): ApiKeyUsage {
  return {
    date,
    requests: 0,
    success: 0,
    failed: 0,
    volume: { STX: "0", sBTC: "0", USDCx: "0" },
    feesPaid: "0",
  };
}
```

### Task 2: Extract shared OpenAPI response schemas
**Files:**
- `src/endpoints/sponsor.ts` (78-181)
- `src/endpoints/relay.ts` (114-224)
- `src/endpoints/DashboardStats.ts` (156-173)

**Target:** Create `src/schemas/responses.ts`
**Status:** completed

Duplicated schemas:
- Error 400 schema (invalid request)
- Error 401 schema (missing/invalid API key)
- Error 429 schema (rate limit/spending cap exceeded)
- Error 500 schema (internal server error)
- Error 502 schema (broadcast/facilitator failed)
- Error 504 schema (facilitator timeout)

### Task 3: Simplify `getAggregateKeyStats` status logic
**File:** `src/services/auth.ts`
**Lines:** 789-822
**Status:** completed

Current code uses hardcoded heuristics that guess status without tier info:
```typescript
if (fees >= BigInt(100_000_000)) {
  status = "capped";
}
if (requests >= 100) {
  // ...
}
```

Solution: Return "active" for all keys since we don't have tier info in the context.
The current guessing is misleading. Also removed unnecessary Promise.all wrapper.

## Verification
- Run `npm run check` after each task
- Functionality should remain unchanged
