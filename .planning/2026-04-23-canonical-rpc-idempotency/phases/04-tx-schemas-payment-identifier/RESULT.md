# Phase 4 Result

Status: completed
Date: 2026-04-23
Feature PR: aibtcdev/tx-schemas#29 (squash-merged, commit 159ad69)
Release PR: aibtcdev/tx-schemas#30 (open, chore(main): release tx-schemas 1.1.0)

## What shipped

### New: PaymentIdentifierSchema (src/core/primitives.ts)
Shared Zod schema for caller-controlled idempotency keys: `[a-zA-Z0-9_-]{16,128}`.
Exported from `@aibtc/tx-schemas/core` via core/index.ts barrel.
Distinct from PaymentIdSchema (relay-assigned, pay_ prefix).

### Extended: RpcSubmitPaymentRequestSchema (src/rpc/schemas.ts)
Added optional `paymentIdentifier: PaymentIdentifierSchema.optional()`.
Backward-compatible — existing callers that omit the field are unaffected.

### New error code: PAYMENT_IDENTIFIER_CONFLICT (src/rpc/schemas.ts)
Added to RPC_ERROR_CODES array. Bare name (no RPC_ prefix) — consistent
with all other codes in the array. RPC parity for HTTP `payment_identifier_conflict`.

### DRY fix: HttpPaymentIdentifierExtensionSchema (src/http/schemas.ts)
Extension `.info.id` now uses PaymentIdentifierSchema instead of PaymentIdSchema.
Correctness fix: extension ids are caller-provided, so requiring pay_ prefix was wrong.

### Updated: CanonicalDomainBoundary (src/core/enums.ts)
transportBoundaries.sharedDomain extended with "paymentIdentifier idempotency"
to make the cross-transport contract explicit.

## Tests
225 tests pass (6 new in tests/rpc.test.ts):
- paymentIdentifier accepted when present
- absent paymentIdentifier: backward compat confirmed
- too-short (< 16 chars) rejected
- too-long (> 128 chars) rejected
- disallowed chars rejected
- PAYMENT_IDENTIFIER_CONFLICT accepted as rejected error code

## Simplifier findings applied
- RPC_PAYMENT_IDENTIFIER_CONFLICT → PAYMENT_IDENTIFIER_CONFLICT (naming convention)
- Extracted STUB_TX_HEX const (appeared 5x in new tests)
- Trimmed WHAT comments, kept only non-obvious WHY

## Downstream
Phase 5 merges release PR #30 to publish @aibtc/tx-schemas@1.1.0.
Phase 6 bumps relay to consume paymentIdentifier in RPC submitPayment.
