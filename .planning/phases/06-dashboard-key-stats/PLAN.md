# Phase 6: Update Dashboard for API Key Stats

## Goal
Add API key statistics to the dashboard for monitoring usage.

## Tasks

### Task 1: Add getAggregateKeyStats method to AuthService
- [ ] Create `AggregateKeyStats` type in `types.ts`
- [ ] Implement `getAggregateKeyStats()` in `AuthService`
- [ ] Use KV list to iterate over usage records for today
- [ ] Return total active keys, total fees today, top keys by usage

### Task 2: Extend DashboardStats endpoint with API key stats
- [ ] Add `apiKeys` field to `DashboardOverview` type
- [ ] Update schema in `DashboardStats.ts` to include new fields
- [ ] Call `AuthService.getAggregateKeyStats()` from endpoint
- [ ] Include anonymized key data (prefix only)

### Task 3: Add API key dashboard components
- [ ] Create `apiKeyStatsCard()` component in `cards.ts`
- [ ] Create `topKeysTable()` component for showing top keys
- [ ] Add status indicators (active/rate limited/capped)

### Task 4: Update dashboard page to display API key stats
- [ ] Import new components in `overview.ts`
- [ ] Add API Keys section between Token Breakdown and Facilitator Health
- [ ] Wire up data from `DashboardOverview.apiKeys`

### Task 5: Verify and update documentation
- [ ] Run `npm run check` to verify TypeScript compiles
- [ ] Update PHASES.md status to `completed`

## Type Definitions

```typescript
// New types to add to types.ts
interface ApiKeyStatsEntry {
  keyPrefix: string;  // First 12 chars of keyId
  requestsToday: number;
  feesToday: string;
  status: "active" | "rate_limited" | "capped";
}

interface AggregateKeyStats {
  totalActiveKeys: number;
  totalFeesToday: string;
  topKeys: ApiKeyStatsEntry[];
}

// Extend DashboardOverview
interface DashboardOverview {
  // ... existing fields
  apiKeys?: AggregateKeyStats;
}
```

## Dashboard Layout

```
┌─────────────────┬─────────────────┐
│   API Keys      │  Fees Today     │
│      12         │   45.2 STX      │
└─────────────────┴─────────────────┘
┌─────────────────────────────────────┐
│  Top Keys by Usage (Today)          │
│  ─────────────────────────────────  │
│  x402_sk_..a1b2  │  234 req │ 12 STX │
│  x402_sk_..c3d4  │  156 req │  8 STX │
│  x402_sk_..e5f6  │   89 req │  4 STX │
└─────────────────────────────────────┘
```

## Implementation Notes

1. KV list operations can be expensive - limit to 50 keys max
2. Use `usage:daily:*:YYYY-MM-DD` prefix to find today's usage
3. Anonymize keys by showing only keyId prefix (first 12 chars)
4. Status is derived from: rate limit checks and spending cap checks
