# x402 Stacks Sponsor Relay

A Cloudflare Worker that enables gasless transactions for AI agents on the Stacks blockchain by sponsoring transactions and verifying payment settlement.

## Overview

The [x402 protocol](https://www.x402.org/) is an HTTP-native payment standard that uses the HTTP 402 "Payment Required" status code to enable instant, autonomous stablecoin payments. This relay service brings gasless transactions to Stacks by:

1. Accepting pre-signed sponsored transactions from agents
2. Validating the transaction format (must be sponsored type)
3. Sponsoring the transaction (covers gas fees)
4. Calling the x402 facilitator for settlement verification
5. Returning the settlement status to the agent

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
| `BROADCAST_FAILED` | 502 | Transaction rejected by network |

### POST /relay

Submit a sponsored transaction for relay and settlement.

**Request:**
```json
{
  "transaction": "<hex-encoded-sponsored-stacks-transaction>",
  "settle": {
    "expectedRecipient": "SP...",
    "minAmount": "1000000",
    "tokenType": "STX",
    "expectedSender": "SP...",
    "resource": "/api/endpoint",
    "method": "GET"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `transaction` | Yes | Hex-encoded sponsored Stacks transaction |
| `settle.expectedRecipient` | Yes | Expected payment recipient address |
| `settle.minAmount` | Yes | Minimum payment amount (in smallest unit) |
| `settle.tokenType` | No | Token type: `STX`, `sBTC`, `USDCx` (default: `STX`) |
| `settle.expectedSender` | No | Expected sender address for validation |
| `settle.resource` | No | API resource being accessed (for tracking) |
| `settle.method` | No | HTTP method being used (for tracking) |

**Response (success):**
```json
{
  "txid": "0x...",
  "settlement": {
    "success": true,
    "status": "confirmed",
    "sender": "SP...",
    "recipient": "SP...",
    "amount": "1000000",
    "blockHeight": 12345
  }
}
```

**Response (error):**
```json
{
  "error": "Transaction must be sponsored",
  "details": "Build transaction with sponsored: true"
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "network": "testnet",
  "version": "0.3.0"
}
```

### GET /docs

Interactive API documentation (Swagger UI).

### GET /openapi.json

OpenAPI 3.1 specification for programmatic access.

## Usage

### Building a Sponsored Transaction

Transactions must be built with `sponsored: true` and `fee: 0n`:

```typescript
import { makeSTXTokenTransfer, getAddressFromPrivateKey, TransactionVersion } from "@stacks/transactions";

const senderAddress = getAddressFromPrivateKey(privateKey, TransactionVersion.Testnet);
const recipient = "SP..."; // Payment recipient

const transaction = await makeSTXTokenTransfer({
  recipient,
  amount: 1000000n,
  senderKey: privateKey,
  network: "testnet",
  sponsored: true,  // Required
  fee: 0n,          // Sponsor pays
});

const txHex = Buffer.from(transaction.serialize()).toString("hex");
```

### Submitting to the Relay

```typescript
const response = await fetch("https://x402-relay.aibtc.dev/relay", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    transaction: txHex,
    settle: {
      expectedRecipient: recipient,
      minAmount: "1000000",
      tokenType: "STX",
      expectedSender: senderAddress,
    },
  }),
});

const { txid, settlement } = await response.json();
console.log(`Transaction: https://explorer.hiro.so/txid/${txid}?chain=testnet`);
console.log(`Settlement status: ${settlement.status}`);
```

## Deployments

| Environment | URL | Network |
|-------------|-----|---------|
| Staging | https://x402-relay.aibtc.dev | Testnet |
| Production | https://x402-relay.aibtc.com | Mainnet |

## All Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | None | Service info |
| GET | `/health` | None | Health check with version and network |
| GET | `/docs` | None | Swagger UI documentation |
| GET | `/openapi.json` | None | OpenAPI specification |
| POST | `/relay` | None | Submit transaction via x402 facilitator |
| POST | `/sponsor` | API Key | Sponsor and broadcast transaction directly |
| GET | `/stats` | None | Relay statistics (JSON) |
| GET | `/dashboard` | None | Public dashboard (HTML) |

## Rate Limits

### /relay Endpoint
- 10 requests per minute per sender address
- Rate limiting is based on the transaction sender, not IP

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
- **x402-stacks** - x402 protocol implementation for Stacks

## Development

```bash
# Install dependencies
npm install

# Copy .env.example and configure credentials
cp .env.example .env
# Edit .env with AGENT_MNEMONIC or AGENT_PRIVATE_KEY

# Start local dev server
npm run dev

# Test /relay endpoint (no auth required)
npm run test:relay                              # Uses RELAY_URL from .env or localhost
npm run test:relay -- http://localhost:8787    # Override relay URL

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
- [x402-stacks](https://github.com/tony1908/x402Stacks) - x402 for Stacks
- [stx402](https://stx402.com) - x402 Stacks implementation

## License

MIT
