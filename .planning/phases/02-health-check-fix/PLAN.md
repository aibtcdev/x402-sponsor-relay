# Phase 2: Fix Facilitator Health Check Bug

## Problem

The facilitator shows as "down" on the dashboard even when it's actually running. This happens because:

1. Health is only recorded from `/api/v1/settle` calls (transaction flow)
2. There's no active health checking - no proactive calls to the facilitator's `/health` endpoint
3. When no settle transactions happen, health status defaults to "unknown" or "down"

## Solution

Add active health checking that calls the facilitator's `/health` endpoint directly.

## Facilitator Health Endpoint

Both facilitators return `{"status":"ok"}` from their `/health` endpoints:
- Testnet: `https://facilitator.x402stacks.xyz/health`
- Mainnet: `https://facilitator.stacksx402.com/health`

## Tasks

### Task 1: Add checkHealth method to FacilitatorService
**File:** `src/services/facilitator.ts`
**Description:** Add a `checkHealth()` method that calls the facilitator's `/health` endpoint and records the result via HealthMonitor.

### Task 2: Call health check from DashboardStats endpoint
**File:** `src/endpoints/DashboardStats.ts`
**Description:** When fetching stats, trigger a fresh health check to ensure current status. The check should be non-blocking - if it fails, use cached data.

### Task 3: Verify TypeScript compiles
**Command:** `npm run check`
**Description:** Ensure all type definitions are correct and the build succeeds.

## Deliverables

- [x] `FacilitatorService.checkHealth()` method implemented
- [x] DashboardStats calls health check on request
- [x] TypeScript builds without errors
- [x] Health status shows "healthy" when facilitator is up

## Success Criteria

After changes:
1. Dashboard shows "healthy" facilitator status when facilitator is up
2. No TypeScript errors
3. Health check is non-intrusive (doesn't slow down dashboard significantly)
