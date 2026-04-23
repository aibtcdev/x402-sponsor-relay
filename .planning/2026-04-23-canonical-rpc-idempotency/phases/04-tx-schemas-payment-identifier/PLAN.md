<?xml version="1.0" encoding="UTF-8"?>
<plan>
  <goal>Add optional paymentIdentifier to RpcSubmitPaymentArgsSchema in tx-schemas for x402 V2 idempotency parity (closes aibtcdev/tx-schemas#28). Triggers minor version bump 1.0.0 -> 1.1.0 via release-please.</goal>
  <context>
    tx-schemas is @aibtc/tx-schemas npm package. Current version 1.0.0.
    HTTP path already has payment_identifier_conflict in HttpSettleErrorReasonSchema and
    HttpPaymentIdentifierExtensionSchema using PaymentIdSchema (pay_ prefix).
    The quest spec wants a more general PaymentIdentifierSchema: [a-zA-Z0-9_-]{16,128}
    (no pay_ prefix — caller-controlled idempotency key, not relay-assigned paymentId).
    RPC path needs parity: optional paymentIdentifier field in submit args + RPC_PAYMENT_IDENTIFIER_CONFLICT error code.
    CanonicalDomainBoundary.transportBoundaries.sharedDomain needs updating to reflect this.
    release-please uses conventional commits — feat(rpc): ... triggers minor bump automatically.
  </context>

  <task id="1">
    <name>Add PaymentIdentifierSchema to core/primitives.ts and export from core/index.ts</name>
    <files>
      /home/whoabuddy/dev/aibtcdev/tx-schemas/src/core/primitives.ts
      /home/whoabuddy/dev/aibtcdev/tx-schemas/src/core/index.ts
    </files>
    <action>
      Add PaymentIdentifierSchema to src/core/primitives.ts:
        export const PaymentIdentifierSchema = z.string().regex(
          /^[a-zA-Z0-9_-]{16,128}$/,
          "Expected a caller-provided payment identifier: [a-zA-Z0-9_-]{16,128}"
        );
      It is already exported from core/index.ts via "export * from ./primitives.js".
      Also update src/http/schemas.ts to DRY: import PaymentIdentifierSchema from core/primitives
      and use it in HttpPaymentIdentifierExtensionSchema.id instead of PaymentIdSchema.
      Note: PaymentIdSchema has pay_ prefix; PaymentIdentifierSchema is more general.
      The HTTP extension id should accept caller-controlled identifiers — switch to PaymentIdentifierSchema.
    </action>
    <verify>
      cd /home/whoabuddy/dev/aibtcdev/tx-schemas && npm run typecheck 2>&amp;1 | head -20
    </verify>
    <done>PaymentIdentifierSchema exported from core, http/schemas.ts uses it in extension</done>
  </task>

  <task id="2">
    <name>Extend RpcSubmitPaymentRequestSchema and add RPC_PAYMENT_IDENTIFIER_CONFLICT error code</name>
    <files>
      /home/whoabuddy/dev/aibtcdev/tx-schemas/src/rpc/schemas.ts
    </files>
    <action>
      1. Import PaymentIdentifierSchema from ../core/primitives.js
      2. Add "RPC_PAYMENT_IDENTIFIER_CONFLICT" to RPC_ERROR_CODES array (after "NONCE_OCCUPIED")
      3. Extend RpcSubmitPaymentRequestSchema with:
           paymentIdentifier: PaymentIdentifierSchema.optional()
         This makes the field backward-compatible (existing callers unaffected).
      4. Export RpcSubmitPaymentRequest type already infers from schema — no separate type needed.
    </action>
    <verify>
      cd /home/whoabuddy/dev/aibtcdev/tx-schemas && npm run typecheck 2>&amp;1 | head -20
    </verify>
    <done>RpcSubmitPaymentRequestSchema has optional paymentIdentifier, RPC_PAYMENT_IDENTIFIER_CONFLICT in error codes</done>
  </task>

  <task id="3">
    <name>Update CanonicalDomainBoundary and add tests</name>
    <files>
      /home/whoabuddy/dev/aibtcdev/tx-schemas/src/core/enums.ts
      /home/whoabuddy/dev/aibtcdev/tx-schemas/tests/rpc.test.ts
    </files>
    <action>
      1. In src/core/enums.ts, update CanonicalDomainBoundary.transportBoundaries.sharedDomain
         to include "paymentIdentifier idempotency" alongside the existing entries.
      2. In tests/rpc.test.ts add test cases:
         - paymentIdentifier accepted when present in submit request (valid 20-char value)
         - paymentIdentifier absent is fine (backward compat)
         - RPC_PAYMENT_IDENTIFIER_CONFLICT accepted as error code in rejected response
    </action>
    <verify>
      cd /home/whoabuddy/dev/aibtcdev/tx-schemas && npm test 2>&amp;1 | tail -30
    </verify>
    <done>CanonicalDomainBoundary updated, tests green</done>
  </task>
</plan>
