# x402 Stacks Sponsor Relay

A Cloudflare Worker that verifies and settles x402 payments on the Stacks blockchain, and sponsors transactions for API-key holders and aibtc.com's own worker.

## Overview

The [x402 protocol](https://www.x402.org/) is an HTTP-native payment standard that uses the HTTP 402 "Payment Required" status code to enable instant, autonomous payments. This relay is an x402 V2 facilitator for Stacks:

1. Agents build and sign a normal **self-paid** transaction (standard auth, non-zero fee) paying the resource server
2. `POST /settle` verifies recipient, amount and asset locally, then broadcasts the transaction (`POST /verify` checks without broadcasting)
3. The relay returns the txid, which the agent presents as proof of payment

Public fee sponsorship has been removed: the former `POST /relay` endpoint no longer exists, and `/settle` refuses a transaction with an empty sponsor slot (`invalid_transaction_state`). Relay-paid fees are available only to aibtc.com's own worker over the Cloudflare service binding (`RelayRPC.sponsorPayment` / `submitPayment`), and to API-key holders via `POST /sponsor`. Agent guide: [docs/agent-payment-guide.md](./docs/agent-payment-guide.md).

## For downstream consumers

If you're building a worker that calls the relay (landing-page, agent-news, mcp-server, x402-api, skills, etc.), start with **[docs/post-337-downstream-contracts.md](./docs/post-337-downstream-contracts.md)** — it covers the RPC service binding (preferred over HTTP), the `/health` shape, and the canonical error contract.

## API

### POST /sponsor

Sponsor and broadcast a transaction directly (requires API key authentication).

**Headers:**
```
Authorization: Bearer x402_sk_test_...
Content-Type: application/json
```

**Request:**
```json
{
  "transaction": "<hex-encoded-sponsored-stacks-transaction>"
}
```

**Response (success):**
```json
{
  "success": true,
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "txid": "0x...",
  "explorerUrl": "https://explorer.hiro.so/txid/0x...?chain=testnet",
  "fee": "1000"
}
```

**Response (error):**
```json
{
  "success": false,
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "error": "Daily spending cap exceeded",
  "code": "SPENDING_CAP_EXCEEDED",
  "details": "Your API key has exceeded its daily spending limit.",
  "retryable": true,
  "retryAfter": 3600
}
```

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `MISSING_API_KEY` | 401 | No API key provided |
| `INVALID_API_KEY` | 401 | API key not found or revoked |
| `EXPIRED_API_KEY` | 401 | API key has expired |
| `MISSING_TRANSACTION` | 400 | Transaction field is missing |
| `INVALID_TRANSACTION` | 400 | Transaction is malformed |
| `NOT_SPONSORED` | 400 | Transaction must be built with `sponsored: true` |
| `SPENDING_CAP_EXCEEDED` | 429 | Daily fee cap exceeded for this API key tier |
| `BROADCAST_FAILED` | 400 / 502 | 400: the node rejected the tx for a client reason (not retryable). 502: broadcast rejected, or its outcome unclear (the node may still hold the tx). Resend the same signed hex; do not re-sign the same payment at a new nonce. See [docs/post-337-downstream-contracts.md](docs/post-337-downstream-contracts.md) |

### POST /settle, POST /verify, GET /supported

x402 V2 facilitator endpoints ([spec](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) sections 7.1–7.3). Request shapes, `errorReason` codes and idempotency rules are in [docs/agent-payment-guide.md](./docs/agent-payment-guide.md) and at `/topics/x402-v2-facilitator`.

### GET /verify/:receiptId

Look up a payment receipt by ID and return its status. Receipts were issued by the former `POST /relay`; existing ones stay readable, no new ones are created.

**Response (success):**
```json
{
  "success": true,
  "requestId": "...",
  "receipt": {
    "receiptId": "550e8400-...",
    "status": "valid",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "expiresAt": "2025-01-01T01:00:00.000Z",
    "senderAddress": "SP...",
    "txid": "0x...",
    "explorerUrl": "https://explorer.hiro.so/txid/0x...?chain=testnet",
    "settlement": {
      "success": true,
      "status": "confirmed",
      "recipient": "SP...",
      "amount": "1000000"
    },
    "resource": "/api/endpoint",
    "method": "GET",
    "accessCount": 0
  }
}
```

**Response (not found):** `404` for unknown or expired receipts.

### POST /access

Access a protected resource using a payment receipt. Validates the receipt (exists, not expired, not consumed, resource matches) and either returns relay-hosted data or proxies to a downstream service.

**Request:**
```json
{
  "receiptId": "550e8400-...",
  "resource": "/api/endpoint",
  "targetUrl": "https://downstream-service.com/api/endpoint"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `receiptId` | Yes | Receipt ID issued by the former `POST /relay` (existing receipts only) |
| `resource` | No | Resource path (validated against receipt) |
| `targetUrl` | No | Downstream URL for proxying (HTTPS only, no internal hosts) |

**Response (success):**
```json
{
  "success": true,
  "requestId": "...",
  "granted": true,
  "receipt": {
    "receiptId": "550e8400-...",
    "senderAddress": "SP...",
    "resource": "/api/endpoint",
    "accessCount": 1
  },
  "data": { "..." }
}
```

> **Note:** Receipts are one-time-use — consumed after successful access. If proxying, the receipt is only consumed on a 2xx downstream response. The `targetUrl` must be HTTPS and cannot point to internal hosts.

### GET /health

Service health summary. Use `GET /status/sponsor` to check whether the x402 payment sponsor can take a payment now.

**Response:**
```json
{
  "success": true,
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "ok",
  "network": "testnet",
  "version": "0.3.0"
}
```

### Status Surfaces

- `RelayRPC.getSponsorStatus()` is the canonical internal sponsor status read for trusted same-account consumers such as `landing-page`.
- `GET /status/sponsor` is the canonical public sponsor status read for autonomous agents and other HTTP consumers.
- `GET /health` is only a thin service-readiness summary.
- `GET /wallets` remains the detailed operator/debugging path for per-wallet balance and inventory and is intentionally separate from sponsor readiness.

### GET /docs

Interactive API documentation (Swagger UI).

### GET /openapi.json

OpenAPI 3.1 specification for programmatic access.

## Usage

### Paying via POST /settle

Build a standard self-paid transaction (do not set `sponsored: true`; see `GET /fees` for a fee) and settle it:

```typescript
import { makeSTXTokenTransfer } from "@stacks/transactions";

const transaction = await makeSTXTokenTransfer({
  recipient: "SP...",  // paymentRequirements.payTo
  amount: 1000000n,
  senderKey: privateKey,
  network: "testnet",
  fee: 3000n,          // sender pays the network fee
});

const response = await fetch("https://x402-relay.aibtc.dev/settle", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    paymentPayload: { x402Version: 2, payload: { transaction: transaction.serialize() } },
    paymentRequirements: {
      scheme: "exact",
      network: "stacks:2147483648",
      amount: "1000000",
      asset: "STX",
      payTo: "SP...",
    },
  }),
});

// HTTP 200 for both outcomes; check `success`
const { success, transaction: txid, errorReason } = await response.json();
```

### Building a Sponsored Transaction (POST /sponsor only)

`POST /sponsor` takes a transaction built with `sponsored: true` and `fee: 0n`; the relay adds the sponsor signature and fee.

```typescript
const transaction = await makeSTXTokenTransfer({
  recipient: "SP...",
  amount: 1000000n,
  senderKey: privateKey,
  network: "testnet",
  sponsored: true,  // Required for /sponsor
  fee: 0n,          // Sponsor pays
});

const txHex = transaction.serialize();
```

See [API Key Authentication](#api-key-authentication) for the request.

## Deployments

| Environment | URL | Network |
|-------------|-----|---------|
| Staging | https://x402-relay.aibtc.dev | Testnet |
| Production | https://x402-relay.aibtc.com | Mainnet |

## All Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | None | Service info |
| GET | `/health` | None | Service health summary |
| GET | `/status/sponsor` | None | x402 payment sponsor readiness (configured, funded, under daily budget) |
| GET | `/docs` | None | Swagger UI documentation |
| GET | `/openapi.json` | None | OpenAPI specification |
| POST | `/settle` | None | x402 V2 settle: verify payment + broadcast a self-paid tx |
| POST | `/verify` | None | x402 V2 verify: local validation only |
| GET | `/supported` | None | x402 V2 supported payment kinds |
| POST | `/sponsor` | API Key | Sponsor and broadcast transaction directly |
| GET | `/verify/:receiptId` | None | Verify a payment receipt |
| POST | `/access` | None | Access protected resource with receipt |
| GET | `/stats` | None | Relay statistics (JSON) |
| GET | `/dashboard` | None | Public dashboard (HTML) |

## Rate Limits

### /sponsor Endpoint (API Key)

Rate limits and spending caps are based on API key tier:

| Tier | Requests/min | Requests/day | Daily Fee Cap |
|------|-------------|--------------|---------------|
| free | 10 | 100 | 100 STX |
| standard | 60 | 10,000 | 1,000 STX |
| unlimited | Unlimited | Unlimited | No cap |

## API Key Authentication

The `/sponsor` endpoint requires API key authentication.

### Obtaining an API Key

API keys are provisioned via the CLI:

```bash
# Set your environment (staging = testnet, production = mainnet)
export WRANGLER_ENV=staging

# Create a new API key
npm run keys -- create --app "My App" --email "dev@example.com"

# Create with specific tier (default: free)
npm run keys -- create --app "My App" --email "dev@example.com" --tier standard
```

### Managing API Keys

```bash
# List all API keys
WRANGLER_ENV=staging npm run keys -- list

# Get info about a specific key
WRANGLER_ENV=staging npm run keys -- info x402_sk_test_...

# View usage statistics (last 7 days)
WRANGLER_ENV=staging npm run keys -- usage x402_sk_test_... --days 7

# Renew an expiring key (extends by 30 days)
WRANGLER_ENV=staging npm run keys -- renew x402_sk_test_...

# Revoke a key
WRANGLER_ENV=staging npm run keys -- revoke x402_sk_test_...
```

### Using API Keys

Include the API key in the `Authorization` header:

```typescript
const response = await fetch("https://x402-relay.aibtc.dev/sponsor", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer x402_sk_test_...",
  },
  body: JSON.stringify({ transaction: txHex }),
});
```

## Stack

- **Cloudflare Workers** - Serverless deployment
- **Hono** - Lightweight web framework
- **Chanfana** - OpenAPI documentation generator
- **@stacks/transactions** - Stacks transaction handling

## Development

```bash
# Install dependencies
npm install

# Create .env and configure credentials (see Environment Variables below)
# Required: AGENT_MNEMONIC or AGENT_PRIVATE_KEY for test scripts

# Start local dev server
npm run dev

# Test /sponsor endpoint (requires API key)
npm run test:sponsor                            # Uses TEST_API_KEY from .env
npm run test:sponsor -- http://localhost:8787  # Override relay URL

# Type check
npm run check
```

### Environment Variables

The test scripts support these environment variables (set in `.env`):

| Variable | Description |
|----------|-------------|
| `AGENT_MNEMONIC` | 24-word mnemonic phrase (recommended) |
| `AGENT_PRIVATE_KEY` | Hex-encoded private key (alternative) |
| `AGENT_ACCOUNT_INDEX` | Account index to derive from mnemonic (default: 0) |
| `RELAY_URL` | Relay endpoint URL (default: http://localhost:8787) |
| `TEST_API_KEY` | API key for /sponsor endpoint (required for test:sponsor) |

## Related Projects

- [x402 Protocol](https://www.x402.org/) - HTTP-native payment standard
- [stx402](https://stx402.com) - x402 Stacks implementation

## License

MIT
