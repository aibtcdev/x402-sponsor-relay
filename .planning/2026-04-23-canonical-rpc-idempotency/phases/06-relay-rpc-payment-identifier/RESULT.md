# Phase 6 Result

## Status: completed

## PR
#355 — squash-merged to main as commit 97f0b6b (2026-04-23)

## What shipped

### Core (src/rpc.ts)
- `submitPayment(txHex, settle?, paymentIdentifier?)` — new optional 3rd arg (backward compatible)
- Cache lookup inserted **before** `checkSenderNonce`: same id + same payload → cached paymentId returned, nonce path skipped entirely
- On accept, `ctx.waitUntil(recordPaymentId(..., "rpc"))` stores result in KV
- Error response for conflict: `{ accepted: false, code: "PAYMENT_IDENTIFIER_CONFLICT", retryable: false }`

### Service (src/services/payment-identifier.ts)
- `PaymentIdEndpoint` extended: `"settle" | "verify" | "rpc"`
- `ENDPOINT_PREFIX` record map replaces two copies of nested ternary chains
- RPC KV prefix: `"payid:rpc:"` — isolated from settle/verify namespaces

### Dep bump (package.json)
- `@aibtc/tx-schemas: "^1.0.0"` → `"^1.1.0"`

### Discovery (src/routes/discovery.ts)
- `/llms-full.txt`: "Internal Service Binding (RPC)" section with method signatures and payment-identifier behavior summary
- `/topics/x402-v2-facilitator`: "RPC submitPayment — payment-identifier Parity" section with TypeScript example, KV namespace note, cache TTL

### Tests (src/__tests__/rpc-payment-identifier.test.ts)
- 11 new tests across 3 suites: namespace isolation, hash determinism, KV fail-open
- 117 total tests pass

## Simplifier findings applied
- Extracted `ENDPOINT_PREFIX` lookup map (DRY: two nested ternary chains → one record)
- Removed `computeRpcPayloadHash` test wrapper (thin indirection with no value)
- Trimmed redundant store comment
- Fixed test: `computePayloadHash(cleanHex, null)` ≠ `computePayloadHash(cleanHex, undefined)` — `sortedReplacer` does not normalize undefined to null; `submitPayment` normalizes via `settle ?? null` at the call site

## Post-deploy log check
- No new ERRORs from submitPayment path
- No unexpected PAYMENT_IDENTIFIER_CONFLICT (expected: 0 — no consumers use new arg yet)
- blockConcurrencyWhile errors last seen 2026-04-14 (pre Phase 1 fix)
- Most recent ERROR: invalid STX sig on /keys/provision-stx (2026-04-22, pre-merge, unrelated)
