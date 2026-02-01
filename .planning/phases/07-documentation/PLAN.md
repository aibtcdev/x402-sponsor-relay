# Phase 7: Documentation and Testing

## Goal
Update documentation, add test script for /sponsor, prepare for high traffic.

## Tasks

### Task 1: Create test-sponsor.ts script
- [x] Create `scripts/test-sponsor.ts` based on `test-relay.ts` structure
- [x] Accept API key from `TEST_API_KEY` environment variable
- [x] Build sponsored transaction (same as test-relay.ts)
- [x] Submit to `/sponsor` endpoint with Bearer auth
- [x] Handle success/error responses appropriately
- [x] Add `test:sponsor` npm script to package.json

### Task 2: Update README.md with /sponsor documentation
- [x] Add POST /sponsor endpoint documentation
- [x] Document request/response format
- [x] Add API key authentication section
- [x] Document rate limits and spending caps per tier
- [x] Add API key management CLI documentation
- [x] Update All Endpoints table

### Task 3: Verify CLAUDE.md completeness
- [x] Check /sponsor endpoint is documented (already done)
- [x] Verify request/response examples are accurate
- [x] Add test:sponsor command to Commands section

### Task 4: Run verification
- [x] Run `npm run check` to verify TypeScript compiles
- [x] Update PHASES.md status to `completed`

## Implementation Notes

### test-sponsor.ts Structure
Similar to test-relay.ts but:
- Uses `Authorization: Bearer <api-key>` header
- Sends only `{ transaction: "..." }` body (no settle options)
- Response format differs (success/error with fee info)

### Rate Limit Tiers
| Tier | Requests/min | Requests/day | Daily Fee Cap |
|------|-------------|--------------|---------------|
| free | 10 | 100 | 100 STX |
| standard | 60 | 10,000 | 1,000 STX |
| unlimited | Unlimited | Unlimited | No cap |
