# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

x402 Stacks Sponsor Relay - A Cloudflare Worker enabling gasless transactions for AI agents on the Stacks blockchain. Accepts pre-signed sponsored transactions, sponsors them, verifies payment parameters locally, and broadcasts directly to the Stacks network. Supports confirmed (immediate) and pending (60s timeout) settlement states with idempotent retry via KV dedup.

**Status**: Native settlement (no external facilitator), payment receipts, protected resource access, and idempotent retry. Deployed to testnet staging.

## Commands

```bash
# Install dependencies
npm install

# Local development
npm run dev

# Type check
npm run check

# Dry-run deploy (verify build)
npm run deploy:dry-run

# Test relay endpoint (requires .env with AGENT_MNEMONIC or AGENT_PRIVATE_KEY)
npm run test:relay
npm run test:relay -- [relay-url]

# Test sponsor endpoint (requires .env with TEST_API_KEY)
npm run test:sponsor
npm run test:sponsor -- [relay-url]

# Test provision endpoint - Bitcoin signature (requires .env with AGENT_MNEMONIC or AGENT_PRIVATE_KEY)
npm run test:provision
npm run test:provision -- [relay-url]

# Test provision endpoint - Stacks signature (requires .env with AGENT_MNEMONIC or AGENT_PRIVATE_KEY)
npm run test:provision-stx
npm run test:provision-stx -- [relay-url]

# Test SIP-018 structured data auth (requires .env with AGENT_MNEMONIC and TEST_API_KEY)
npm run test:sip018-auth
npm run test:sip018-auth -- [relay-url]

# Test fees endpoint (no auth required)
npm run test:fees
npm run test:fees -- [relay-url]

# API key management
npm run keys -- list                            # List all keys
npm run keys -- create --app "App" --email "x@y.com"  # Create key

# DO NOT run npm run deploy - commit and push for automatic deployment
```

## Architecture

**Stack:**
- Cloudflare Workers for deployment
- Hono web framework with Chanfana for OpenAPI documentation
- @stacks/transactions for Stacks transaction handling
- x402-stacks (fork) for building sponsored transactions
- worker-logs service binding for centralized logging

**Endpoints:**
- `GET /` - Service info
- `GET /health` - Health check with network info
- `GET /docs` - Swagger UI API documentation (Chanfana)
- `GET /openapi.json` - OpenAPI specification
- `POST /relay` - Submit sponsored transaction for native settlement (verify locally + broadcast + poll, optional SIP-018 auth)
- `POST /sponsor` - Sponsor and broadcast transaction directly (requires API key, optional SIP-018 auth)
- `POST /keys/provision` - Provision API key via Bitcoin signature (BIP-137)
- `POST /keys/provision-stx` - Provision API key via Stacks signature
- `GET /verify/:receiptId` - Verify a payment receipt
- `POST /access` - Access protected resource with receipt token
- `GET /fees` - Get clamped fee estimates (no auth required)
- `POST /fees/config` - Update fee clamps (admin, requires API key)
- `GET /stats` - Relay statistics (JSON API)
- `GET /dashboard` - Public dashboard (HTML)

**Agent Discovery (AX) — `src/routes/discovery.ts`:**
- `GET /llms.txt` - Quick-start guide: what the relay does, key provisioning, /relay and /sponsor examples
- `GET /llms-full.txt` - Full reference: all endpoints with schemas, SIP-018 auth, receipt system, error codes
- `GET /topics` - Topic index: JSON array of available topic docs with descriptions and URLs
- `GET /topics/:topic` - Topic sub-docs (plaintext). Available topics:
  - `sponsored-transactions` — Full relay flow, step-by-step with transaction diagram
  - `api-keys` — Key provisioning via BTC/STX sig, tiers, expiry, renewal
  - `authentication` — SIP-018 structured data auth, domain constants, message schema
  - `errors` — All error codes with HTTP status, retry behavior, and descriptions
- `GET /.well-known/agent.json` - A2A agent card: skills, capabilities, auth methods, network config

**Request/Response:**
```typescript
// POST /relay
Request: {
  transaction: "hex-encoded-sponsored-tx",
  settle: {
    expectedRecipient: "SP...",
    minAmount: "1000000",
    tokenType?: "STX" | "sBTC" | "USDCx",
    expectedSender?: "SP...",
    resource?: "/api/endpoint",
    method?: "GET"
  },
  auth?: {
    signature: "0x1234...",  // RSV signature of SIP-018 structured data
    message: {
      action: "relay",
      nonce: "1708099200000",  // Unix timestamp ms for replay protection
      expiry: "1708185600000"  // Expiry timestamp (unix ms)
    }
  }
}

Response (success): {
  success: true,
  requestId: "uuid",
  txid: "0x...",
  explorerUrl: "https://explorer.hiro.so/txid/...",
  settlement: {
    success: true,
    status: "pending" | "confirmed" | "failed",
    sender: "SP...",
    recipient: "SP...",
    amount: "1000000",
    blockHeight?: 12345
  },
  sponsoredTx: "0x00000001...",  // fully-sponsored tx hex
  receiptId?: "uuid"  // only when KV storage succeeds
}

Response (error): {
  error: "...",
  code: "SETTLEMENT_BROADCAST_FAILED" | "SETTLEMENT_VERIFICATION_FAILED" | "RATE_LIMIT_EXCEEDED" | ...,
  details: "...",
  retryable: true | false,
  retryAfter?: 5  // seconds, also sent as Retry-After header
}

// POST /sponsor (requires API key)
Request: {
  transaction: "hex-encoded-sponsored-tx",
  auth?: {
    signature: "0x1234...",  // RSV signature of SIP-018 structured data
    message: {
      action: "sponsor",
      nonce: "1708099200000",  // Unix timestamp ms for replay protection
      expiry: "1708185600000"  // Expiry timestamp (unix ms)
    }
  }
}

Response (success): {
  success: true,
  requestId: "uuid",
  txid: "0x...",
  explorerUrl: "https://explorer.hiro.so/txid/...",
  fee: "1000"  // sponsored fee in microSTX
}

Response (error): {
  success: false,
  requestId: "uuid",
  code: "INVALID_TRANSACTION" | "BROADCAST_FAILED" | ...,
  error: "description",
  retryable: boolean
}

// GET /verify/:receiptId
Response (success): {
  success: true,
  requestId: "uuid",
  receipt: {
    receiptId: "uuid",
    status: "valid" | "consumed",
    senderAddress: "SP...",
    txid: "0x...",
    explorerUrl: "https://...",
    settlement: { success, status, recipient, amount },
    resource: "/api/endpoint",
    method: "GET",
    accessCount: 0
  }
}

// POST /access
Request: {
  receiptId: "uuid",
  resource?: "/api/endpoint",
  targetUrl?: "https://downstream-service.com/..."  // HTTPS only
}

Response (success): {
  success: true,
  requestId: "uuid",
  granted: true,
  receipt: { receiptId, senderAddress, resource, accessCount },
  data?: { ... },  // relay-hosted resource
  proxy?: { status, statusText, headers, body }  // proxied resource
}

// POST /keys/provision (no authentication required)
Request: {
  btcAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  signature: "H9L5yLFj...",  // Base64-encoded BIP-137 signature
  message: "Bitcoin will be the currency of AIs"  // or with timestamp for self-service
}

Response (success): {
  success: true,
  requestId: "uuid",
  apiKey: "x402_sk_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  metadata: {
    keyId: "a1b2c3d4",
    appName: "btc:1A1zP1eP",
    contactEmail: "btc+1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa@x402relay.system",
    tier: "free",
    createdAt: "2026-02-12T12:00:00.000Z",
    expiresAt: "2026-03-14T12:00:00.000Z",  // 30 days
    active: true,
    btcAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
  }
}

Response (error - duplicate BTC address): {
  success: false,
  requestId: "uuid",
  error: "Bitcoin address already has a provisioned API key",
  code: "ALREADY_PROVISIONED",
  retryable: false
}

Response (error - invalid signature): {
  success: false,
  requestId: "uuid",
  error: "Invalid signature for registration message",
  code: "INVALID_SIGNATURE",
  retryable: false
}

Response (error - stale timestamp): {
  success: false,
  requestId: "uuid",
  error: "Timestamp must be within 5 minutes. Current age: 7 minutes",
  code: "STALE_TIMESTAMP",
  retryable: false
}

// POST /keys/provision-stx (no authentication required)
Request: {
  stxAddress: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
  signature: "0x1234567890abcdef...",  // Hex-encoded RSV signature
  message: "Bitcoin will be the currency of AIs"  // or with timestamp for self-service
}

Response (success): {
  success: true,
  requestId: "uuid",
  apiKey: "x402_sk_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  metadata: {
    keyId: "a1b2c3d4",
    appName: "stx:SP2J6ZY4",
    contactEmail: "stx+SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7@x402relay.system",
    tier: "free",
    createdAt: "2026-02-16T12:00:00.000Z",
    expiresAt: "2026-03-18T12:00:00.000Z",  // 30 days
    active: true,
    stxAddress: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7"
  }
}

Response (error - duplicate STX address): {
  success: false,
  requestId: "uuid",
  error: "Stacks address already has a provisioned API key",
  code: "ALREADY_PROVISIONED",
  retryable: false
}

Response (error - invalid signature): {
  success: false,
  requestId: "uuid",
  error: "Invalid signature for message",
  code: "INVALID_STX_SIGNATURE",
  retryable: false
}

Response (error - stale timestamp): {
  success: false,
  requestId: "uuid",
  error: "Timestamp must be within 5 minutes. Current age: 7 minutes",
  code: "STALE_TIMESTAMP",
  retryable: false
}
```

**SIP-018 Authentication:**

The relay supports optional SIP-018 structured data signature verification for enhanced security on `/relay` and `/sponsor` endpoints. This provides:
- Domain-bound signatures (specific to x402-sponsor-relay)
- Replay protection via nonce (unix timestamp ms)
- Time-bound authorization via expiry timestamp
- Backward compatibility (auth field is optional)

Domain constants:
- Mainnet: `name="x402-sponsor-relay"`, `version="1"`, `chainId=1`
- Testnet: `name="x402-sponsor-relay"`, `version="1"`, `chainId=2147483648`

Message schema (ClarityValue tuple):
```clarity
{
  action: (string-ascii 10),     ;; "relay" or "sponsor"
  nonce: uint,                    ;; Unix timestamp ms for replay protection
  expiry: uint                    ;; Expiry timestamp (unix ms), must be in future
}
```

The signature is created by:
1. Encoding the domain and message as SIP-018 structured data
2. Hashing the encoded bytes with SHA-256
3. Signing the hash with the sender's Stacks private key (RSV format)
4. Including the signature and message in the `auth` field

If the auth field is provided, the relay verifies:
- Signature is valid for the recovered Stacks address
- Action matches the endpoint ("relay" or "sponsor") — prevents cross-endpoint replay
- Nonce is a valid integer (used as unique identifier in the signed tuple)
- Expiry is in the future (not expired)
- Domain matches the relay's network

If verification fails, the request is rejected with HTTP 401. If the auth field is omitted, the request proceeds without SIP-018 verification (backward compatible).

**Key Files:**
- `src/index.ts` - Hono app entry point with Chanfana OpenAPI setup (Swagger at /docs)
- `src/routes/discovery.ts` - AX discovery routes (/llms.txt, /llms-full.txt, /topics, /topics/:topic, /.well-known/agent.json)
- `src/version.ts` - Single source of truth for VERSION constant
- `src/types.ts` - Centralized type definitions (includes SIP-018 domain constants)
- `src/endpoints/BaseEndpoint.ts` - Base class with ok/okWithTx/err helpers
- `src/endpoints/relay.ts` - Relay endpoint (sponsor + settle + receipt, optional SIP-018 auth)
- `src/endpoints/sponsor.ts` - Sponsor endpoint (direct broadcast, API key + optional SIP-018 auth)
- `src/endpoints/verify.ts` - Receipt verification endpoint
- `src/endpoints/access.ts` - Protected resource access endpoint
- `src/endpoints/provision.ts` - API key provisioning via BTC signature (BIP-137)
- `src/endpoints/provision-stx.ts` - API key provisioning via Stacks signature
- `src/endpoints/fees.ts` - Fee estimation endpoint (public, no auth)
- `src/endpoints/fees-config.ts` - Fee clamp configuration endpoint (admin, API key auth)
- `src/services/receipt.ts` - ReceiptService (store/retrieve/consume receipts in KV)
- `src/services/btc-verify.ts` - BtcVerifyService (BIP-137 signature verification)
- `src/services/stx-verify.ts` - StxVerifyService (plain message + SIP-018 signature verification)
- `src/services/auth.ts` - AuthService (API key management and provisioning)
- `src/services/fee.ts` - FeeService (fetch/clamp/cache fee estimates from Hiro API)
- `src/services/sponsor.ts` - SponsorService (validate/sponsor transactions with clamped fees)
- `scripts/test-relay.ts` - Test script for /relay endpoint (no auth)
- `scripts/test-sponsor.ts` - Test script for /sponsor endpoint (API key auth)
- `scripts/test-provision.ts` - Test script for /keys/provision endpoint (BTC sig)
- `scripts/test-provision-stx.ts` - Test script for /keys/provision-stx endpoint (STX sig)
- `scripts/test-sip018-auth.ts` - Test script for SIP-018 auth on /relay and /sponsor
- `scripts/test-fees.ts` - Test script for /fees endpoint (no auth)
- `scripts/manage-api-keys.ts` - CLI for API key management
- `docs/` - State machine diagram and feature roadmap

## Deployment URLs

- **Testnet (staging)**: https://x402-relay.aibtc.dev
- **Mainnet (production)**: https://x402-relay.aibtc.com

## Configuration

- `wrangler.jsonc` - Cloudflare Workers config (service bindings, routes, environments)
- `.env` - Local development secrets (not committed, loaded by wrangler)
- `.env.example` - Template for required environment variables
- Secrets set via `wrangler secret put`:
  - `SPONSOR_MNEMONIC` - 24-word mnemonic phrase for sponsor wallet (preferred)
  - `SPONSOR_ACCOUNT_INDEX` - Account index to derive (default: 0, optional)
  - `SPONSOR_PRIVATE_KEY` - Hex private key (fallback, not recommended)
  - `HIRO_API_KEY` - Optional API key for Hiro fee estimation endpoint (higher rate limits)

## Deployment

```bash
# Authenticate with Cloudflare
npx wrangler login

# Set secrets for staging (use mnemonic - preferred)
npx wrangler secret put SPONSOR_MNEMONIC --env staging
# Optional: set account index if not using default (0)
npx wrangler secret put SPONSOR_ACCOUNT_INDEX --env staging

# Deploy to staging (testnet)
npx wrangler deploy --env staging

# Deploy to production (mainnet)
npx wrangler secret put SPONSOR_MNEMONIC --env production
npx wrangler deploy --env production
```

## Service Bindings

**LOGS** - Universal logging service (RPC binding to worker-logs)

The logger middleware automatically creates a request-scoped logger available in endpoints:
```typescript
// In endpoint handlers
const logger = this.getLogger(c);
logger.info('Transaction sponsored', { txid });
```

See [worker-logs integration guide](~/dev/whoabuddy/worker-logs/docs/integration.md) for details.

## Key Decisions Made

| Decision | Choice |
|----------|--------|
| Agent auth | Any Stacks address (ERC-8004 milestone later) |
| Flow | Agent calls relay directly |
| Abuse prevention | Rate limits (10 req/min per sender) |
| Payment tokens | STX, sBTC, USDCx |
| Settlement | Native (local verify + direct broadcast, no external facilitator) |

## Related Projects

**x402 Stacks Ecosystem:**
- `~/dev/whoabuddy/stx402/` - x402 implementation (stx402.com)
- `~/dev/tony1908/x402Stacks/` - x402-stacks npm package (PR #8 adds sponsored tx)
- Facilitator: facilitator.stacksx402.com

**aibtcdev Resources:**
- `../erc-8004-stacks/` - Agent identity contracts (future integration)
- `../agent-tools-ts/src/stacks-alex/` - ALEX sponsored tx examples

**Infrastructure:**
- `~/dev/whoabuddy/worker-logs/` - Universal logging service (logs.wbd.host)

## Development Workflow

1. Copy `.env.example` to `.env` and fill in credentials
2. Set `SPONSOR_MNEMONIC` in `.env` (preferred) or `SPONSOR_PRIVATE_KEY` (fallback)
3. Start dev server: `npm run dev`
4. Test with: `npm run test:relay -- http://localhost:8787`
5. Check logs at logs.wbd.host

## Sponsored Transaction Flow

```
Agent                    Relay                              Stacks
  │                        │                                  │
  │ 1. Build tx with       │                                  │
  │    sponsored: true     │                                  │
  │                        │                                  │
  │ 2. POST /relay         │                                  │
  │    { transaction,      │                                  │
  │      settle: {...} }   │                                  │
  │───────────────────────▶│                                  │
  │                        │ 3. Validate settle options       │
  │                        │ 4. Validate tx                   │
  │                        │ 5. Check dedup (KV)              │
  │                        │ 6. Sponsor (add fee sig)         │
  │                        │ 7. Verify payment params         │
  │                        │    (recipient/amount/token)      │
  │                        │ 8. Broadcast                     │
  │                        │─────────────────────────────────▶│
  │                        │◀─────────────────────────────────│
  │                        │ 9. Poll confirm (≤60s)           │
  │                        │10. Store receipt (KV)            │
  │                        │11. Record dedup (KV)             │
  │◀───────────────────────│ 12. Return {                     │
  │                        │     txid,                        │
  │                        │     settlement: {                │
  │                        │       status: confirmed|pending, │
  │                        │       blockHeight? },            │
  │                        │     sponsoredTx,                 │
  │                        │     receiptId }                  │
  │                        │                                  │
  │ 13. GET /verify/:id    │                                  │
  │───────────────────────▶│ 14. Check KV receipt            │
  │◀───────────────────────│ 15. Return receipt status       │
  │                        │                                  │
  │ 16. POST /access       │                                  │
  │     { receiptId }      │                                  │
  │───────────────────────▶│ 17. Validate receipt            │
  │                        │ 18. Grant access /              │
  │                        │     proxy request                │
  │◀───────────────────────│ 19. Return data                 │
```

**Settlement states:**
- `confirmed`: tx confirmed on-chain within 60s — includes `blockHeight`
- `pending`: broadcast succeeded but confirmation timed out — safe state, poll `/verify/:receiptId`
- `failed`: tx broadcast OK but aborted/dropped on-chain — returns `SETTLEMENT_FAILED` (422, not retryable)

**Idempotency:** Submitting the same sponsored tx hex within 5 minutes returns the cached result from KV (dedup). Safe for agents to retry on network failure.

## Future Enhancements

See GitHub issues for planned enhancements:
- [#6 - SIP-018 signature verification](https://github.com/aibtcdev/x402-sponsor-relay/issues/6)
- [#7 - ERC-8004 agent registry integration](https://github.com/aibtcdev/x402-sponsor-relay/issues/7)
- Atomic receipt consumption (Durable Object or D1) for concurrent access safety
- Configurable targetUrl allowlist for proxy endpoint
