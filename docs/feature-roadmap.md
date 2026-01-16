# Feature Roadmap

This document outlines planned enhancements for the x402 Sponsor Relay, addressing operational concerns around reliability and cost management.

---

## 1. Transaction Queue & Retry Mechanism

### Current State ✅ IMPLEMENTED
- **No queue**: Transactions are processed synchronously
- **No persistence**: Failed transactions are lost
- **Structured errors**: All errors include `retryable` flag and `Retry-After` header
- **Rate limiting**: In-memory only, resets on worker restart

### Implemented: Client-Side Retry Guidance ✅

All error responses now include structured retry guidance:

```typescript
// Error response with retry guidance
{
  error: "Facilitator timeout",
  code: "FACILITATOR_TIMEOUT",
  retryable: true,
  retryAfter: 5, // seconds - also sent as Retry-After header
  details: "Request timed out after 30s, safe to retry"
}
```

**Error Codes and Retry Behavior:**

| Code | HTTP | Retryable | Retry-After |
|------|------|-----------|-------------|
| `MISSING_TRANSACTION` | 400 | No | - |
| `MISSING_SETTLE_OPTIONS` | 400 | No | - |
| `INVALID_SETTLE_OPTIONS` | 400 | No | - |
| `INVALID_TRANSACTION` | 400 | No | - |
| `NOT_SPONSORED` | 400 | No | - |
| `RATE_LIMIT_EXCEEDED` | 429 | Yes | 60s |
| `SPONSOR_CONFIG_ERROR` | 500 | No | - |
| `SPONSOR_FAILED` | 500 | Yes | - |
| `FACILITATOR_TIMEOUT` | 504 | Yes | 5s |
| `FACILITATOR_ERROR` | 502 | Yes | 5s |
| `FACILITATOR_INVALID_RESPONSE` | 502 | Yes | 10s |
| `SETTLEMENT_FAILED` | 400 | No | - |
| `INTERNAL_ERROR` | 500 | Yes | 5s |

**Note:** When settlement fails after successful sponsoring, the fee is still recorded since the sponsor has already paid.

### Future: Server-Side Queue (Optional)

If needed for unreliable clients, can add Durable Objects queue:

```typescript
// Async response
POST /relay → 202 Accepted
{
  queueId: "tx_abc123",
  status: "queued",
  statusUrl: "/relay/tx_abc123"
}

// Status polling
GET /relay/tx_abc123 → 200 OK
{
  queueId: "tx_abc123",
  status: "completed", // queued | processing | completed | failed
  attempts: 2,
  txid: "0x...",
  settlement: { ... }
}
```

---

## 2. Network Fee Management

### Current State ✅ PARTIALLY IMPLEMENTED
- Agent builds tx with `fee: 0n` (sponsor pays all)
- Sponsor key is static, configured via secret
- **Fee tracking**: ✅ Implemented - all fees tracked in stats
- **Dashboard visibility**: ✅ Implemented - fees shown in overview
- Sponsor account balance monitoring: 🔜 Not yet implemented

### Implemented: Fee Tracking ✅

Fees are now extracted from each sponsored transaction and tracked:

**Daily Stats** include fee metrics:
```typescript
interface FeeStats {
  total: string;    // Total fees paid in microSTX
  count: number;    // Number of transactions with fee data
  min: string;      // Minimum fee paid
  max: string;      // Maximum fee paid
}
```

**Dashboard Overview** includes:
```typescript
fees: {
  total: string;        // Total fees paid today
  average: string;      // Average fee per transaction
  min: string;          // Minimum fee today
  max: string;          // Maximum fee today
  trend: "up" | "down" | "stable";  // vs previous day
  previousTotal: string; // Yesterday's total for comparison
}
```

**Hourly Data** includes fees for time-series analysis:
```typescript
hourlyData: Array<{
  hour: string;
  transactions: number;
  success: number;
  fees?: string;  // Total fees for this hour
}>
```

### Future: Budget Controls (Optional)

If needed, can add spending controls:

```typescript
// Environment config
DAILY_FEE_BUDGET=10000000     // 10 STX max per day
ALERT_THRESHOLD=8000000        // Alert at 80%
PAUSE_ON_BUDGET_EXCEEDED=true  // Stop accepting txs
```

### Future: Sponsor Account Monitoring

- Poll sponsor address balance on `/health` calls
- Alert if balance falls below threshold
- Show estimated transactions remaining

```typescript
// Health check addition
{
  status: "healthy",
  sponsor: {
    address: "SP...",
    balance: "50000000",     // 50 STX
    lowBalanceWarning: false,
    estimatedTxRemaining: 1000  // at current avg fee
  }
}
```

### Implementation Priority

| Feature | Priority | Status | Impact |
|---------|----------|--------|--------|
| Fee tracking in stats | High | ✅ Done | Visibility |
| Dashboard fee metrics | High | ✅ Done | Visibility |
| Sponsor balance monitoring | Medium | 🔜 Planned | Prevent outage |
| Fee cap (reject high fees) | Low | - | Cost control |
| Daily budget controls | Low | - | Cost control |

---

## 3. Implementation Status

### Phase 1: Observability ✅ COMPLETE

**Goal**: Full visibility into relay economics

1. **Track fees in stats service** ✅
   - Fee extracted from each sponsored transaction
   - Daily and hourly fee totals stored in KV
   - Fee metrics calculated (total, avg, min, max)

2. **Structured error responses** ✅
   - All errors include `retryable` flag
   - `Retry-After` header for transient errors
   - Documented error codes in OpenAPI spec

3. **Sponsor account monitoring** 🔜
   - Query balance on `/health` calls
   - Add low balance warning
   - Expose in dashboard

### Phase 2: Controls (Future)

**Goal**: Prevent unexpected costs

1. **Fee cap configuration**
   - Environment variable for max fee
   - Reject or warn on high fees

2. **Daily budget**
   - Track cumulative daily fees
   - Alert at threshold
   - Optional pause when exceeded

### Phase 3: Resilience (Future)

**Goal**: Improve reliability

1. **Durable Objects queue**
   - Persistent transaction state
   - Automatic retry with backoff
   - Async mode option

2. **Idempotency**
   - Transaction deduplication
   - Idempotency keys from client

---

## Decisions Made

1. **Retry ownership**: Client handles retries
   - Relay provides structured error responses with retry guidance
   - Clients use `retryable` flag and `Retry-After` header
   - Simple, transparent, client has full control

2. **Fee tracking**: Focus on visibility first
   - Track all fees in daily/hourly stats
   - Dashboard shows total, average, min, max
   - Budget controls deferred until data informs thresholds

3. **Async vs sync**: Sync only for now
   - Simpler implementation
   - 30s timeout sufficient for Stacks transactions
   - Can add async mode later if needed
