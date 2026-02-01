# Phase 4: Add /sponsor Endpoint

## Overview
Create a new `/sponsor` endpoint for general transaction sponsorship with direct broadcast (no facilitator).

## Tasks

### Task 1: Update types for sponsor endpoint
- [x] Add `SponsorRequest` interface
- [x] Add `SponsorSuccessResponse` interface
- [x] Add sponsor-specific error codes to `RelayErrorCode` (`BROADCAST_FAILED`)

### Task 2: Create sponsor endpoint class
- [x] Create `src/endpoints/sponsor.ts`
- [x] Extend `BaseEndpoint`
- [x] Define OpenAPI schema with request/response specs
- [x] Implement `handle()` method

### Task 3: Implement broadcast functionality
- [x] Use `broadcastTransaction` from `@stacks/transactions`
- [x] Deserialize sponsored tx hex before broadcast
- [x] Handle broadcast errors appropriately

### Task 4: Apply API key authentication
- [x] Use `authMiddleware` via app.use("/sponsor", authMiddleware)
- [x] Handle auth errors with appropriate response codes in endpoint

### Task 5: Register endpoint
- [x] Export from `src/endpoints/index.ts`
- [x] Register in `src/index.ts` with OpenAPI
- [x] Add "Sponsor" tag to OpenAPI schema

### Task 6: Update documentation
- [x] Update PHASES.md status to `completed`
- [x] Update CLAUDE.md with new endpoint

## Request Format
```typescript
{
  transaction: "hex-encoded-sponsored-tx"
}
```

## Response Format
```typescript
// Success
{
  success: true,
  requestId: "uuid",
  txid: "0x...",
  explorerUrl: "https://explorer.hiro.so/txid/...",
  fee: "1000"
}

// Error
{
  success: false,
  requestId: "uuid",
  code: "INVALID_TRANSACTION" | "BROADCAST_FAILED" | ...,
  error: "description",
  retryable: boolean
}
```

## Key Differences from /relay
1. NO facilitator call - direct broadcast to Stacks node
2. Requires API key authentication
3. No settlement verification
4. Returns fee info in response
