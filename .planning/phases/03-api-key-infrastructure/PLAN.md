# Phase 3: Add API Key Infrastructure

## Goal
Implement API key storage, validation, and per-key rate limiting infrastructure.

## Tasks

### 1. Update types.ts
- [x] Add `API_KEYS_KV` to `Env` interface
- [x] Add `RateLimitTier` type and `TIER_LIMITS` constant
- [x] Add `ApiKeyMetadata` interface
- [x] Add `ApiKeyUsage` interface
- [x] Add `ApiKeyValidationResult` type
- [x] Add `ApiKeyErrorCode` type
- [x] Add `AuthContext` interface
- [x] Extend `RelayErrorCode` with API key error codes
- [x] Update `AppVariables` to include optional `auth` context

### 2. Create AuthService
- [x] Create `src/services/auth.ts`
- [x] Implement key format validation (`x402_sk_<env>_<32-char-hex>`)
- [x] Implement key hashing with SHA-256
- [x] Implement `validateKey()` for key lookup and validation
- [x] Implement `checkRateLimit()` for per-key rate limiting
- [x] Implement `recordUsage()` for usage tracking
- [x] Implement admin methods: `createKey`, `revokeKey`, `renewKey`, `listKeys`

### 3. Create auth middleware
- [x] Create `src/middleware/auth.ts`
- [x] Implement grace period behavior (log warnings, allow requests)
- [x] Extract Bearer token from Authorization header
- [x] Validate API key and store auth context in Hono variables
- [x] Return structured error responses using standardized format

### 4. Create admin CLI script
- [x] Create `scripts/manage-api-keys.ts`
- [x] Implement commands: create, list, info, revoke, renew, usage
- [x] Add wrangler KV integration for remote execution
- [x] Add proper validation and error handling

### 5. Update wrangler.jsonc
- [x] Add `API_KEYS_KV` binding to top-level config
- [x] Add `API_KEYS_KV` binding to staging environment
- [x] Add `API_KEYS_KV` binding to production environment

### 6. Update middleware/index.ts exports
- [x] Export `authMiddleware` from index

### 7. Add npm script for key management
- [x] Add `keys` script to package.json

## Dependencies
- Phases 1 & 2 must be complete (standardized response helpers available)

## Verification
- Run `npm run check` to verify TypeScript compiles
- Review middleware uses `err()` helper for consistent responses
