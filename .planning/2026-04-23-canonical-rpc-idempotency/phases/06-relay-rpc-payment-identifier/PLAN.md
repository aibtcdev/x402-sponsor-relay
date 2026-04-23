<plan>
  <goal>Route RPC submitPayment through PaymentIdService for HTTP/RPC idempotency parity, resolving #351</goal>
  <context>
    The HTTP V2 /settle path already implements client-controlled idempotency via PaymentIdService
    (cache lookup before nonce path, 300s TTL, hit/conflict/miss semantics via KV prefix "payid:settle:").
    The RPC submitPayment() path had no equivalent. Internal consumers (landing-page, agent-news)
    that use the service binding would not benefit from the payment-identifier contract.

    tx-schemas 1.1.0 (Phase 5) added:
    - Optional `paymentIdentifier` field to RpcSubmitPaymentRequestSchema
    - PAYMENT_IDENTIFIER_CONFLICT to RpcErrorCodeSchema

    PaymentIdService (src/services/payment-identifier.ts) already implements lookup/store/conflict
    semantics keyed by endpoint discriminant ("settle" | "verify").
  </context>

  <task id="1">
    <name>Extend PaymentIdService with "rpc" endpoint namespace</name>
    <files>src/services/payment-identifier.ts</files>
    <action>
      Add "rpc" to PaymentIdEndpoint type union. Add PAYMENT_ID_RPC_PREFIX constant.
      Extract ENDPOINT_PREFIX lookup map (eliminates nested ternary duplication).
      Replace two copies of nested ternary prefix selection with ENDPOINT_PREFIX[endpoint].
    </action>
    <verify>npm run check</verify>
    <done>PaymentIdEndpoint includes "rpc", single ENDPOINT_PREFIX map used in both methods</done>
  </task>

  <task id="2">
    <name>Implement paymentIdentifier in submitPayment</name>
    <files>src/rpc.ts</files>
    <action>
      Import PaymentIdService. Add optional paymentIdentifier?: string as 3rd arg.
      After hex normalization, construct PaymentIdService(kv, logger).
      Before checkSenderNonce (and before getReusablePaymentRecord):
        if paymentIdentifier provided:
          compute payloadHash = computePayloadHash(cleanHex, settle ?? null)
          checkPaymentId(paymentIdentifier, payloadHash, "rpc"):
            hit → return cached response (idempotent)
            conflict → return PAYMENT_IDENTIFIER_CONFLICT error
            miss → continue normal flow
      After successful queue enqueue:
        if paymentIdentifier && payloadHash:
          ctx.waitUntil(recordPaymentId(paymentIdentifier, payloadHash, acceptedResult, "rpc"))
    </action>
    <verify>npm run check &amp;&amp; npm test</verify>
    <done>submitPayment accepts 3rd arg, lookup before nonce, store after accept, pure-additive</done>
  </task>

  <task id="3">
    <name>Tests + discovery doc updates</name>
    <files>
      src/__tests__/rpc-payment-identifier.test.ts,
      src/routes/discovery.ts,
      package.json
    </files>
    <action>
      Bump @aibtc/tx-schemas to ^1.1.0 in package.json, run npm install.
      Write rpc-payment-identifier.test.ts covering:
        - miss, hit+same, hit+different, namespace isolation (rpc vs settle)
        - hash determinism (same/different inputs, null settle stability)
        - KV fail-open (undefined kv, KV.get throws)
      Update /llms-full.txt to add "Internal Service Binding (RPC)" section.
      Update /topics/x402-v2-facilitator to add "RPC submitPayment — payment-identifier Parity" section.
    </action>
    <verify>npm test (all 117 pass), npm run deploy:dry-run</verify>
    <done>11 new tests pass, docs document new behavior, build succeeds</done>
  </task>
</plan>
