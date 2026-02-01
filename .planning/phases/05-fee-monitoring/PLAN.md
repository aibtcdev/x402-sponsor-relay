# Phase 5: Fee Monitoring per API Key

**Goal:** Track sponsor fees per API key with spending caps and alerts.

## Tasks

### Task 1: Add Spending Cap Fields to Types
- Add `dailyFeeCapMicroStx` to `TIER_LIMITS`
- Add `SPENDING_CAP_EXCEEDED` error code
- Add `ApiKeyFeeStats` interface for per-key fee tracking

### Task 2: Extend AuthService with Fee Tracking Methods
- `recordFeeSpent(keyId: string, feeAmount: bigint): Promise<void>`
- `getRemainingSpendingCap(keyId: string): Promise<bigint | null>`
- `getKeyFeeStats(keyId: string): Promise<ApiKeyFeeStats>`

### Task 3: Update Sponsor Endpoint
- Before sponsoring: check if key has remaining spending capacity
- After sponsoring: record fee spent against the API key
- Return `SPENDING_CAP_EXCEEDED` error if over limit

### Task 4: Integrate with StatsService
- Ensure fee data is tracked in both global stats and per-key stats
- Keep existing `recordUsage()` in AuthService for volume tracking

### Task 5: Update State and Verify
- Run `npm run check` to verify TypeScript compiles
- Update STATE.md and PHASES.md

## Implementation Details

### KV Storage Structure
```
usage:daily:{keyId}:{YYYY-MM-DD}  -> ApiKeyUsage (existing, includes feesPaid)
```

The existing `ApiKeyUsage.feesPaid` field already tracks daily fees per key.
We need to:
1. Add spending caps to tier limits
2. Check cap before sponsoring
3. Record fee after sponsoring

### Spending Caps
```typescript
TIER_LIMITS = {
  free: { requestsPerMinute: 10, dailyLimit: 100, dailyFeeCapMicroStx: 100_000_000 }, // 100 STX/day
  standard: { requestsPerMinute: 60, dailyLimit: 10000, dailyFeeCapMicroStx: 1_000_000_000 }, // 1000 STX/day
  unlimited: { requestsPerMinute: Infinity, dailyLimit: Infinity, dailyFeeCapMicroStx: null }
}
```

## Files to Modify
- `src/types.ts` - Add spending cap fields and error code
- `src/services/auth.ts` - Add fee tracking methods
- `src/endpoints/sponsor.ts` - Check cap before, record fee after
