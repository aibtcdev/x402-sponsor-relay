# Post-#337 Downstream Contracts

**Audience:** Authors of any worker that consumes the relay — landing-page, agent-news, mcp-server, x402-api, skills, future first-party services.

**Purpose:** A single canonical reference for how to call the relay correctly after PR #337 (the boring-tx state machine + RPC binding hardening). If you're verifying a downstream PR against the relay's current contract, start here.

For complete HTTP API reference (every endpoint, every field), see the live OpenAPI spec at `GET /openapi.json` or the Swagger UI at `GET /docs`. This doc covers the three things that aren't obvious from the OpenAPI alone:

1. **The RPC service-binding contract** (`env.X402_RELAY`) — preferred over HTTP for first-party workers.
2. **The post-#337 `/health` shape** — what `status` actually means now.
3. **The error contract** — codes, retryable, retryAfter, idempotency.

## 1. RPC service binding (preferred for first-party workers)

The relay exposes a `WorkerEntrypoint` named `RelayRPC` for same-account Cloudflare workers. Service bindings skip the HTTP round-trip and authenticate by trust (the binding itself is the auth).

### wrangler.jsonc setup

```jsonc
"services": [
  {
    "binding": "X402_RELAY",
    "service": "x402-sponsor-relay",
    "entrypoint": "RelayRPC"
  }
]
```

### Public methods

```ts
env.X402_RELAY.submitPayment(
  txHex: string,
  settle?: SettleOptions,
  paymentIdentifier?: string
): Promise<RpcSubmitPaymentResult>

env.X402_RELAY.checkPayment(paymentId: string): Promise<RpcCheckPaymentResult>

env.X402_RELAY.getSponsorStatus(): Promise<SponsorStatusResult>
```

The `RpcSubmitPaymentResult`, `RpcCheckPaymentResult`, and `SponsorStatusResult` types are the canonical contract. They are exported from `@aibtc/tx-schemas/rpc` and consumers should import from there to stay version-locked:

```ts
import type {
  RpcSubmitPaymentResult,
  RpcCheckPaymentResult,
} from "@aibtc/tx-schemas/rpc";
```

### Idempotency via paymentIdentifier

`paymentIdentifier` is an optional client-controlled string (16–128 chars, `[a-zA-Z0-9_-]+`). Same `id` + same payload returns the cached prior response. Same `id` + different payload returns `PAYMENT_IDENTIFIER_CONFLICT`. Different `id` is treated as a fresh request.

Use this to make `submitPayment` safe to retry on transient errors.

### Migration note

Prior to PR #294, downstream workers used `fetch(${RELAY_URL}/settle, ...)` over HTTP. Post-#294 the RPC binding is the recommended path. As of this writing:

- ✅ `landing-page`, `agent-news` migrated to RPC binding.
- ✅ `x402-api` PR #107 completes the api-side state machine that pairs with this contract.
- 🔍 `mcp-server`, `skills`, and `x402-api` should be audited for any remaining direct HTTP `/settle` or `/relay` calls and migrated to the RPC binding.

## 2. `/health` response shape (post-#337)

`GET /health` returns:

```json
{
  "success": true,
  "requestId": "<uuid>",
  "status": "ok" | "degraded",
  "network": "mainnet" | "testnet",
  "version": "<semver>"
}
```

### What `status` means

- `ok` — nonce pool is healthy or the pool's health signal is unavailable (relay defaults to optimistic when the coordinator is unreachable; observability is logged separately via `/nonce/state`).
- `degraded` — nonce pool reports unhealthy: circuit breaker open, gaps detected, or low capacity.

### How consumers should treat it

- `status === "ok"` — proceed.
- `status !== "ok"` — treat as unhealthy. Don't pattern-match other values; today only `"degraded"` is emitted, but future values may exist.

For richer health detail (per-wallet capacity, gap detection) call `GET /nonce/state` separately.

## 3. Error contract

### Error response envelope

All error responses share this shape:

```json
{
  "success": false,
  "requestId": "<uuid>",
  "error": "human-readable description",
  "code": "MACHINE_READABLE_CODE",
  "retryable": true | false,
  "retryAfter": 5
}
```

- `error` — descriptive, do not pattern-match.
- `code` — the canonical machine-readable identifier. Always present on error responses. Pattern-match this.
- `retryable` — whether a same-payload retry is appropriate.
- `retryAfter` — seconds, present when relevant (rate-limit, transient backoff). Also surfaced in HTTP `Retry-After` header on HTTP responses.

### Canonical error codes

The full enumeration is exported from `@aibtc/tx-schemas/rpc` as `RPC_ERROR_CODES`:

| Code | Category | Retryable | Notes |
|------|----------|-----------|-------|
| `INVALID_TRANSACTION` | validation | no | Malformed hex or deserialization failure |
| `NOT_SPONSORED` | validation | no | Tx is not a sponsored transaction |
| `SENDER_NONCE_STALE` | sender | yes (rebuild) | Sender's nonce already confirmed/in-mempool — re-acquire and rebuild |
| `SENDER_NONCE_DUPLICATE` | sender | yes (rebuild) | Sender nonce collision — re-acquire and rebuild |
| `SENDER_NONCE_GAP` | sender | yes (later) | Hold/wait for sender to catch up |
| `NONCE_CONFLICT` | relay | yes (resubmit) | Sponsor nonce collision — resubmit same serialized tx |
| `SPONSOR_NONCE_STALE` | relay | yes (resubmit) | Internal sponsor nonce drift — resubmit |
| `SPONSOR_NONCE_DUPLICATE` | relay | yes (resubmit) | Internal sponsor nonce dup — resubmit |
| `BROADCAST_FAILED` | settlement | yes (resubmit) | Relay signed but Hiro rejected — resubmit |
| `TX_BROADCAST_ERROR` | settlement | varies | Generic broadcast error; check `error` for detail |
| `SETTLEMENT_FAILED` | settlement | no | Tx broadcast OK but `abort_*` on-chain. Terminal. |
| `INTERNAL_ERROR` | relay | yes (transient) | Relay-side bug or infra; brief backoff |
| `INSUFFICIENT_FUNDS` | sender | no | Sender lacks funds |
| `CLIENT_NONCE_CONFLICT` | sender | yes (rebuild) | Hiro reported `ConflictingNonceInMempool` |
| `CLIENT_BAD_NONCE` | sender | yes (rebuild) | Hiro reported `BadNonce` |
| `TOO_MUCH_CHAINING` | sender | yes (later) | Sender chain depth exceeded |
| `SPONSOR_EXHAUSTED` | relay | yes (later) | All sponsor wallets at capacity |
| `ORIGIN_CHAINING_LIMIT` | sender | yes (later) | Origin (sender) chaining limit hit |
| `BROADCAST_RATE_LIMITED` | settlement | yes (with retryAfter) | Hiro rate-limited the relay; respect `retryAfter` |
| `SENDER_HAND_EXPIRED` | sender | yes (rebuild) | Held nonce slot expired (15-min TTL) |
| `NONCE_OCCUPIED` | relay | yes (resubmit) | Slot occupied by another tx |
| `PAYMENT_IDENTIFIER_CONFLICT` | client | no | `paymentIdentifier` reused with different payload |

### terminalReason on payment status

When checking a payment via `checkPayment(paymentId)` and the payment is in a terminal state, `terminalReason` summarizes why. Categories per `tx-schemas`:

| Category | Examples |
|----------|----------|
| `validation` | `invalid_transaction`, `not_sponsored` |
| `sender` | `sender_nonce_*`, `origin_chaining_limit`, `sender_hand_expired` |
| `relay` | `sponsor_failure`, `queue_unavailable`, `internal_error`, `sponsor_exhausted`, `sponsor_nonce_conflict` |
| `settlement` | `broadcast_failure`, `chain_abort`, `broadcast_rate_limited` |
| `replacement` | `nonce_replacement`, `superseded` |
| `identity` | `expired`, `unknown_payment_identity` |

These categories also appear in `GET /stats` under `terminalReasons`.

## 4. Common downstream patterns

### Pattern: pay-once-with-retry

```ts
const id = `pay_${crypto.randomUUID()}`;
let attempt = 0;
const maxAttempts = 5;

while (attempt < maxAttempts) {
  const result = await env.X402_RELAY.submitPayment(txHex, settle, id);

  if (result.accepted) {
    // Use result.paymentId — poll status with checkPayment(paymentId).
    return result;
  }

  if (!result.retryable) {
    // Terminal — bubble up to user.
    throw new Error(`${result.code}: ${result.error}`);
  }

  // Resubmit-class errors (NONCE_CONFLICT, BROADCAST_FAILED, etc.) — same id + same payload is safe.
  // Rebuild-class errors (SENDER_NONCE_STALE, etc.) — must build a fresh tx and use a NEW id.
  await sleep((result.retryAfter ?? 1) * 1000);
  attempt++;
}
```

### Pattern: poll for confirmation

```ts
const result = await env.X402_RELAY.submitPayment(txHex, settle);
if (!result.accepted) throw new Error(result.code);

const checkPoll = async (): Promise<RpcCheckPaymentResult> => {
  for (let i = 0; i < 30; i++) {
    const status = await env.X402_RELAY.checkPayment(result.paymentId);
    if (status.status === "confirmed" || status.status === "failed") return status;
    await sleep(2000);
  }
  throw new Error("timeout waiting for confirmation");
};
```

## 5. References

- **Source:** `src/rpc.ts` — `RelayRPC` class definition.
- **Canonical types:** `@aibtc/tx-schemas/rpc` (npm package; lock to `^1.1.0` org-wide).
- **OpenAPI spec:** `GET /openapi.json` — full HTTP endpoint inventory.
- **Swagger UI:** `GET /docs` — interactive HTTP API explorer.
- **Health endpoint source:** `src/endpoints/health.ts`.
- **Per-feature deep dives:** `docs/agent-payment-guide.md`, `docs/sponsor-ledger-lifecycle.md`, `docs/state-machine.md`, `docs/nonce-pool-operations.md`.
- **Originating change:** PR #337 (boring-tx state machine + structured error contract). Schemas tagged in `@aibtc/tx-schemas` v1.0.0+.

## 6. Versioning

- The relay's HTTP and RPC contracts follow semver via the `version` field in `/health`.
- The schema package `@aibtc/tx-schemas` is the source of truth for type shapes. Pin to `^1.1.0` (current canonical) across consuming repos.
- Breaking changes to the RPC contract will bump the `tx-schemas` major version; non-breaking additions will be minor bumps.
