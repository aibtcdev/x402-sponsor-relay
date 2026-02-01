# Phase 2: Use Auth Middleware Properly

## Objective
Apply `requireAuthMiddleware` to the /sponsor route instead of doing inline auth checks in the endpoint handler.

## Tasks

- [x] Review existing middleware in `src/middleware/auth.ts`
- [x] Apply `requireAuthMiddleware` to `/sponsor` route in `src/index.ts`
- [x] Remove inline auth check from `src/endpoints/sponsor.ts`
- [x] Verify TypeScript compiles with `npm run check`
- [x] Update PHASES.md status to completed

## Analysis

### Current State
1. `src/middleware/auth.ts` has:
   - `authMiddleware` - validates API keys, allows grace period for missing keys
   - `requireAuthMiddleware` - rejects requests without valid API key (no grace period)

2. `src/index.ts` line 19 applies `authMiddleware` to `/sponsor`:
   ```typescript
   app.use("/sponsor", authMiddleware);
   ```

3. `src/endpoints/sponsor.ts` lines 192-202 has inline auth check:
   ```typescript
   const auth = c.get("auth");
   if (!auth || auth.gracePeriod) {
     logger.warn("API key required for /sponsor endpoint");
     return this.err(c, {
       error: "API key required",
       code: "MISSING_API_KEY",
       status: 401,
       retryable: false,
     });
   }
   ```

### Target State
1. Apply BOTH `authMiddleware` (to set auth context) AND `requireAuthMiddleware` (to enforce) to `/sponsor`
2. Remove the inline auth check from the endpoint handler

### Implementation Notes
- `requireAuthMiddleware` assumes `authMiddleware` has already run to set `c.get("auth")`
- Must apply middlewares in order: `authMiddleware` first, then `requireAuthMiddleware`
- Error response format in middleware already matches standardized format

## Files to Modify
- `src/index.ts` - Add `requireAuthMiddleware` after `authMiddleware`
- `src/endpoints/sponsor.ts` - Remove inline auth check (lines 192-202)
