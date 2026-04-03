# Transaction State Machine

This document describes the state machine for transactions processed by the x402 Sponsor Relay.

## State Diagram

```mermaid
stateDiagram-v2
    [*] --> Received: POST /relay

    Received --> Validating: Parse request

    state Validating {
        [*] --> CheckFields
        CheckFields --> CheckFormat: Fields present
        CheckFields --> ValidationFailed: Missing fields
        CheckFormat --> CheckSponsored: Valid hex
        CheckFormat --> ValidationFailed: Invalid format
        CheckSponsored --> CheckRateLimit: Is sponsored tx
        CheckSponsored --> ValidationFailed: Not sponsored
        CheckRateLimit --> Validated: Under limit
        CheckRateLimit --> RateLimited: Exceeded
    }

    Validating --> Sponsoring: Validation passed
    ValidationFailed --> [*]: 400 Error
    RateLimited --> [*]: 429 Error

    state Sponsoring {
        [*] --> CheckConfig
        CheckConfig --> AddSignature: Key available
        CheckConfig --> ConfigError: Key missing
        AddSignature --> Serialize: Signed
        AddSignature --> SignError: Signing failed
        Serialize --> Sponsored: Serialized
        Serialize --> SerializeError: Failed
    }

    Sponsoring --> Settling: Sponsored successfully
    ConfigError --> [*]: 500 Error
    SignError --> [*]: 500 Error
    SerializeError --> [*]: 500 Error

    state Settling {
        [*] --> CallFacilitator
        CallFacilitator --> ParseResponse: HTTP 2xx
        CallFacilitator --> Timeout: > 30 seconds
        CallFacilitator --> GatewayError: HTTP 502/504
        ParseResponse --> SettlementSuccess: Valid response
        ParseResponse --> InvalidResponse: Missing txid
    }

    Settling --> RecordStats: Settlement complete
    Timeout --> [*]: 504 Error
    GatewayError --> [*]: 502 Error
    InvalidResponse --> [*]: 502 Error

    state RecordStats {
        [*] --> IncrementCounters
        IncrementCounters --> TrackVolume
        TrackVolume --> UpdateHealth
        UpdateHealth --> [*]
    }

    RecordStats --> Completed: Stats recorded

    state Completed {
        Pending: status = pending
        Confirmed: status = confirmed
        Failed: status = failed
    }

    Completed --> [*]: 200 Response
```

## State Descriptions

| State | Description | Duration |
|-------|-------------|----------|
| **Received** | Request received at `/relay` endpoint | Instant |
| **Validating** | Parsing and validating request body, checking rate limits | < 10ms |
| **Sponsoring** | Adding relay's signature to pre-signed transaction | < 50ms |
| **Settling** | Calling facilitator API to broadcast and verify settlement | 1-30s |
| **RecordStats** | Recording metrics to KV storage | < 100ms |
| **Completed** | Transaction processed, response returned | Terminal |

## Queue Polling Contract

Queue-based polling follows the shared `@aibtc/tx-schemas` contract.

- Public states are `requires_payment`, `queued`, `broadcasting`, `mempool`, `confirmed`, `failed`, `replaced`, and `not_found`.
- Relay-internal `submitted` is never caller-facing. Both RPC and `GET /payment/:id` project it to `queued`.
- Terminal outcomes emit canonical `terminalReason` values. Use that field as the semantic source of truth for retry and recovery decisions.
- Polling adapters may surface `checkStatusUrl` as the canonical poll hint for the same `paymentId`.
- Duplicate submission of the same payment artifact reuses the same relay-owned `paymentId` until that payment reaches a terminal outcome.

## Error States

| Error State | HTTP Code | Cause | Recovery |
|-------------|-----------|-------|----------|
| ValidationFailed | 400 | Invalid request format, missing fields | Client fixes request |
| RateLimited | 429 | Exceeded 10 req/min/sender | Client waits and retries |
| ConfigError | 500 | Sponsor key not configured | Operator action required |
| SignError | 500 | Transaction signing failed | Investigate tx format |
| SerializeError | 500 | Serialization failed | Investigate tx structure |
| Timeout | 504 | Facilitator didn't respond in 30s | Client can retry |
| GatewayError | 502 | Facilitator returned error | Client can retry |
| InvalidResponse | 502 | Facilitator response malformed | Operator investigation |

## Current Flow Characteristics

### Synchronous Processing
- All operations happen in-line within a single HTTP request
- No background processing or deferred execution
- Response includes final settlement status

### Structured Error Responses ✅
- All errors include `retryable` flag
- `Retry-After` header for transient errors
- Error codes documented in OpenAPI spec
- Client handles retries with guidance

### Fee Tracking ✅
- Fee extracted from each sponsored transaction
- Stored in daily and hourly stats
- Dashboard shows total, average, min, max fees
- Hourly fee breakdown for time-series analysis

### Pending Improvements
- Sponsor account balance monitoring
- Budget controls (optional)
- Server-side retry queue (optional)

## Related Documentation

See [Feature Roadmap](./feature-roadmap.md) for implementation status and future plans.
