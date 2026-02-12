# Phase 1: Standardize Response Format

## Goal
Create consistent `ok()` / `err()` response helpers that all endpoints use, including txid, explorer link, and internal UUID (requestId).

## Research Summary

### Current State
- `BaseEndpoint.ts` has `errorResponse()` (legacy) and `structuredError()` methods
- `requestId` is already generated in `loggerMiddleware` and stored in context
- Error codes and `RelayErrorResponse` type already defined in `types.ts`
- Success responses are inconsistent - each endpoint returns different formats

### Required Changes
1. Create `ok()` helper that includes `success: true`, `requestId`, optional `txid`, optional `explorerUrl`
2. Refactor `err()` helper to always include `requestId` in response
3. Update all endpoints to use new helpers
4. Add `explorerUrl` generation utility

### Explorer URL Format
- Mainnet: `https://explorer.hiro.so/txid/{txid}?chain=mainnet`
- Testnet: `https://explorer.hiro.so/txid/{txid}?chain=testnet`

## Tasks

### Task 1.1: Add response helper types to types.ts
**File:** `src/types.ts`
- Add `RelaySuccessResponse` interface with `success: true`, `requestId`, optional `txid`, optional `explorerUrl`
- Add `BaseSuccessResponse` for simpler endpoints (health, stats)

### Task 1.2: Create response helpers module
**File:** `src/utils/response.ts` (new file)
- Create `buildExplorerUrl(txid, network)` function
- Export helper for building consistent responses

### Task 1.3: Update BaseEndpoint with ok() and err() helpers
**File:** `src/endpoints/BaseEndpoint.ts`
- Add `ok()` method that returns success response with requestId
- Add `okWithTx()` method that includes txid and explorerUrl
- Refactor `structuredError()` to include requestId (rename to `err()` for consistency)
- Mark `errorResponse()` as deprecated

### Task 1.4: Refactor relay.ts to use new helpers
**File:** `src/endpoints/relay.ts`
- Replace `structuredError()` calls with `err()`
- Replace success `c.json()` call with `okWithTx()`
- Ensure all responses include requestId

### Task 1.5: Refactor health.ts to use new helpers
**File:** `src/endpoints/health.ts`
- Replace `c.json()` with `ok()`

### Task 1.6: Refactor DashboardStats.ts to use new helpers
**File:** `src/endpoints/DashboardStats.ts`
- Replace `c.json()` success response with `ok()`
- Replace `errorResponse()` with `err()`

### Task 1.7: Update index.ts error handlers
**File:** `src/index.ts`
- Update global error handler to use standardized format
- Update 404 handler to use standardized format
- Add requestId to error responses

### Task 1.8: Run type check and verify
**Command:** `npm run check`
- Ensure TypeScript compiles without errors

## Deliverables
- [x] `src/types.ts` - Updated with success response types
- [x] `src/utils/response.ts` - New response utilities module
- [x] `src/endpoints/BaseEndpoint.ts` - Updated with ok()/err() helpers
- [x] `src/endpoints/relay.ts` - Refactored to use new helpers
- [x] `src/endpoints/health.ts` - Refactored to use new helpers
- [x] `src/endpoints/DashboardStats.ts` - Refactored to use new helpers
- [x] `src/index.ts` - Updated error handlers
- [x] TypeScript compiles successfully
