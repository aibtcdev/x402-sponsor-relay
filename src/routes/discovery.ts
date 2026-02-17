import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { VERSION } from "../version";

/**
 * Agent Discovery (AX) routes for x402-sponsor-relay.
 * Implements the standard AX discovery chain so AI agents can find and
 * understand the relay service programmatically.
 *
 * Routes:
 *   GET /llms.txt              — Quick-start guide
 *   GET /llms-full.txt         — Full reference documentation
 *   GET /topics                — Topic index (JSON)
 *   GET /topics/:topic         — Topic sub-docs (plaintext)
 *   GET /.well-known/agent.json — A2A agent card (JSON)
 */
const discovery = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// /llms.txt — Quick-start guide
// ---------------------------------------------------------------------------
discovery.get("/llms.txt", (c) => {
  const content = `# x402 Stacks Sponsor Relay

> A Cloudflare Worker enabling gasless transactions for AI agents on the
> Stacks blockchain. The relay accepts pre-signed sponsored transactions,
> pays the network fee on the agent's behalf, and calls the x402 facilitator
> for settlement verification.

Base URL (production): https://x402-relay.aibtc.com
Base URL (staging/testnet): https://x402-relay.aibtc.dev

OpenAPI spec: https://x402-relay.aibtc.com/openapi.json
Swagger UI:   https://x402-relay.aibtc.com/api-docs
Agent card:   https://x402-relay.aibtc.com/.well-known/agent.json

For the full aibtc agent platform, see https://aibtc.com/llms.txt

## When to Use This Relay

Use this relay when your agent needs to:
- Submit Stacks transactions without holding STX for fees (gasless)
- Settle x402 payments (POST /relay) with automatic fee sponsorship
- Broadcast a sponsored transaction directly (POST /sponsor, requires API key)
- Verify that a payment receipt is valid (GET /verify/:receiptId)
- Access a receipt-gated resource (POST /access)
- Provision a free-tier API key via Bitcoin or Stacks signature

## Supported Tokens

- STX (microSTX)
- sBTC (satoshis)
- USDCx (micro-USDCx)

## Quick Start: Get an API Key

API keys are required for POST /sponsor. Provision one for free by proving
ownership of a Bitcoin or Stacks address — no sBTC or STX required.

### Via Bitcoin signature (BIP-137):
POST https://x402-relay.aibtc.com/keys/provision
{
  "btcAddress": "bc1q...",
  "signature": "<base64 BIP-137 sig>",
  "message": "Bitcoin will be the currency of AIs | <ISO-8601 timestamp>"
}

### Via Stacks signature (RSV hex):
POST https://x402-relay.aibtc.com/keys/provision-stx
{
  "stxAddress": "SP...",
  "signature": "0x<hex RSV sig>",
  "message": "Bitcoin will be the currency of AIs | <ISO-8601 timestamp>"
}

The timestamp must be within 5 minutes. Response includes:
  apiKey: "x402_sk_<env>_<32-char-hex>"   — store this securely, shown once
  metadata: { keyId, tier, expiresAt, ... }

Free tier: 10 req/min, 100 req/day, 100 STX/day fee cap. Keys expire in 30 days.

## Quick Start: Submit a Sponsored Transaction (POST /relay)

This endpoint sponsors your transaction AND routes it through the x402 facilitator
for payment settlement. No API key required.

POST https://x402-relay.aibtc.com/relay
Content-Type: application/json
{
  "transaction": "0x00000001...",   // hex-encoded pre-signed sponsored tx
  "settle": {
    "expectedRecipient": "SP...",   // who should receive the payment
    "minAmount": "1000000",         // minimum amount (in token's smallest unit)
    "tokenType": "STX"              // "STX" | "sBTC" | "USDCx"  (default: "STX")
  }
}

Success response:
{
  "success": true,
  "txid": "0x...",
  "explorerUrl": "https://explorer.hiro.so/txid/0x...",
  "settlement": { "success": true, "status": "pending", ... },
  "sponsoredTx": "0x00000001...",   // fully-sponsored tx hex
  "receiptId": "uuid"               // use to verify payment later
}

## Quick Start: Broadcast a Sponsored Transaction (POST /sponsor)

Direct broadcast without facilitator settlement. Requires API key.

POST https://x402-relay.aibtc.com/sponsor
Authorization: Bearer x402_sk_<env>_<32-char-hex>
Content-Type: application/json
{
  "transaction": "0x00000001..."   // hex-encoded pre-signed sponsored tx
}

Success response:
{
  "success": true,
  "txid": "0x...",
  "explorerUrl": "https://explorer.hiro.so/txid/0x...",
  "fee": "1000"                    // microSTX sponsored by the relay
}

## Other Endpoints

- GET  /health              — Health check with network info
- GET  /fees                — Clamped fee estimates (no auth required)
- GET  /verify/:receiptId   — Verify a payment receipt
- POST /access              — Access a receipt-gated resource
- POST /fees/config         — Update fee clamps (admin, API key required)
- GET  /stats               — Relay statistics (JSON)
- GET  /dashboard           — Public dashboard (HTML)

Full reference: https://x402-relay.aibtc.com/llms-full.txt
Topic docs:     https://x402-relay.aibtc.com/topics
`;

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
});

// ---------------------------------------------------------------------------
// /llms-full.txt — Full reference documentation
// ---------------------------------------------------------------------------
discovery.get("/llms-full.txt", (c) => {
  const content = `# x402 Stacks Sponsor Relay — Full Reference

Base URL (production): https://x402-relay.aibtc.com
Base URL (staging/testnet): https://x402-relay.aibtc.dev
OpenAPI spec: https://x402-relay.aibtc.com/openapi.json
Agent card:   https://x402-relay.aibtc.com/.well-known/agent.json

For the full aibtc agent platform, see https://aibtc.com/llms-full.txt

Quick-start guide: https://x402-relay.aibtc.com/llms.txt

## Topic Sub-Docs

For focused deep-dives:
- https://x402-relay.aibtc.com/topics/sponsored-transactions
- https://x402-relay.aibtc.com/topics/api-keys
- https://x402-relay.aibtc.com/topics/authentication
- https://x402-relay.aibtc.com/topics/errors

---

## POST /relay — Submit Sponsored Transaction for Settlement

Accepts a pre-signed sponsored transaction, pays the fee with the relay's
wallet, and calls the x402 facilitator to verify payment settlement.

No API key required. Rate limited: 10 requests/minute per sender address
(derived from the transaction itself).

### Request

POST /relay
Content-Type: application/json

{
  "transaction": "<hex-encoded sponsored tx>",   // required
  "settle": {                                     // required
    "expectedRecipient": "SP...",                 // required — STX address
    "minAmount": "1000000",                       // required — smallest unit
    "tokenType": "STX",                           // optional — "STX"|"sBTC"|"USDCx", default "STX"
    "expectedSender": "SP...",                    // optional — restrict sender
    "resource": "/api/endpoint",                  // optional — for tracking
    "method": "GET"                               // optional — for tracking
  },
  "auth": {                                       // optional — SIP-018 structured data auth
    "signature": "0x...",                         // RSV signature
    "message": {
      "action": "relay",                          // must be "relay"
      "nonce": "1708099200000",                   // unix ms timestamp
      "expiry": "1708185600000"                   // must be in the future
    }
  }
}

### Success Response (200)

{
  "success": true,
  "requestId": "uuid",
  "txid": "0x...",
  "explorerUrl": "https://explorer.hiro.so/txid/0x...",
  "settlement": {
    "success": true,
    "status": "pending",          // "pending" | "confirmed" | "failed"
    "sender": "SP...",
    "recipient": "SP...",
    "amount": "1000000",
    "blockHeight": 12345          // only when confirmed
  },
  "sponsoredTx": "0x00000001...",  // fully-sponsored tx hex
  "receiptId": "uuid"              // use with GET /verify/:receiptId
}

### Error Responses

- 400 MISSING_TRANSACTION — transaction field absent
- 400 MISSING_SETTLE_OPTIONS — settle field absent
- 400 INVALID_SETTLE_OPTIONS — settle validation failed
- 400 INVALID_TRANSACTION — cannot deserialize tx
- 400 NOT_SPONSORED — tx must have fee-sponsor mode
- 400 SETTLEMENT_FAILED — facilitator rejected settlement
- 401 INVALID_AUTH_SIGNATURE — SIP-018 sig invalid or wrong action
- 401 AUTH_EXPIRED — SIP-018 expiry in the past
- 429 RATE_LIMIT_EXCEEDED — retryable: true, retryAfter: 60
- 500 SPONSOR_CONFIG_ERROR — relay misconfigured, not retryable
- 500 SPONSOR_FAILED — sponsoring failed, retryable: true
- 502 FACILITATOR_ERROR — upstream gateway error, retryAfter: 5
- 504 FACILITATOR_TIMEOUT — upstream timeout, retryAfter: 5

---

## POST /sponsor — Sponsor and Broadcast Directly

Sponsors the transaction and broadcasts it directly to the Stacks network.
Does NOT go through the x402 facilitator. No settlement verification.

Requires API key. Optional SIP-018 auth for additional security.

### Request

POST /sponsor
Authorization: Bearer x402_sk_<env>_<32-char-hex>
Content-Type: application/json

{
  "transaction": "<hex-encoded sponsored tx>",   // required
  "auth": {                                       // optional — SIP-018 auth
    "signature": "0x...",
    "message": {
      "action": "sponsor",                        // must be "sponsor"
      "nonce": "1708099200000",
      "expiry": "1708185600000"
    }
  }
}

### Success Response (200)

{
  "success": true,
  "requestId": "uuid",
  "txid": "0x...",
  "explorerUrl": "https://explorer.hiro.so/txid/0x...",
  "fee": "1000"                   // microSTX sponsored by relay
}

### Error Responses

- 400 INVALID_TRANSACTION / NOT_SPONSORED — tx validation failed
- 401 MISSING_API_KEY / INVALID_API_KEY / EXPIRED_API_KEY — auth failed
- 401 INVALID_AUTH_SIGNATURE / AUTH_EXPIRED — SIP-018 auth failed
- 429 RATE_LIMIT_EXCEEDED / DAILY_LIMIT_EXCEEDED / SPENDING_CAP_EXCEEDED
- 500 SPONSOR_CONFIG_ERROR / SPONSOR_FAILED — broadcast failed

---

## POST /keys/provision — Provision API Key via Bitcoin Signature

Provision a free-tier API key by proving ownership of a Bitcoin address
using BIP-137 signature verification. No prior authentication required.

### Two Signing Paths

1. Registration path (bare message, can be reused from AIBTC registration):
   message = "Bitcoin will be the currency of AIs"

2. Self-service path (timestamped, must be within 5 minutes):
   message = "Bitcoin will be the currency of AIs | 2026-02-16T12:00:00.000Z"

### Request

POST /keys/provision
Content-Type: application/json

{
  "btcAddress": "bc1q...",
  "signature": "<base64 BIP-137 sig>",
  "message": "Bitcoin will be the currency of AIs | 2026-02-16T12:00:00.000Z"
}

Accepts any Bitcoin address format: P2PKH (1...), P2SH (3...), Bech32 (bc1q...),
Taproot (bc1p...).

### Success Response (200)

{
  "success": true,
  "requestId": "uuid",
  "apiKey": "x402_sk_prod_a1b2c3d4...",   // store securely, shown once
  "metadata": {
    "keyId": "a1b2c3d4",
    "appName": "btc:bc1q...",
    "contactEmail": "btc+bc1q...@x402relay.system",
    "tier": "free",
    "createdAt": "2026-02-16T12:00:00.000Z",
    "expiresAt": "2026-03-18T12:00:00.000Z",
    "active": true,
    "btcAddress": "bc1q..."
  }
}

### Error Responses

- 400 MISSING_BTC_ADDRESS — invalid or absent btcAddress
- 400 MISSING_SIGNATURE — signature absent
- 400 INVALID_MESSAGE_FORMAT — message absent or malformed
- 400 INVALID_SIGNATURE — BIP-137 verification failed
- 400 STALE_TIMESTAMP — timestamp older than 5 minutes
- 409 ALREADY_PROVISIONED — this BTC address already has a key
- 500 INTERNAL_ERROR — storage error, retryable: true

---

## POST /keys/provision-stx — Provision API Key via Stacks Signature

Same as /keys/provision but uses a Stacks RSV hex signature instead of BIP-137.

### Request

POST /keys/provision-stx
Content-Type: application/json

{
  "stxAddress": "SP...",
  "signature": "0x<hex RSV sig>",
  "message": "Bitcoin will be the currency of AIs | 2026-02-16T12:00:00.000Z"
}

### Success Response (200)

Same shape as /keys/provision but with stxAddress instead of btcAddress in metadata.

### Error Responses

- 400 MISSING_STX_ADDRESS / MISSING_SIGNATURE / INVALID_MESSAGE_FORMAT
- 400 INVALID_STX_SIGNATURE — Stacks sig verification failed
- 400 STALE_TIMESTAMP
- 409 ALREADY_PROVISIONED
- 500 INTERNAL_ERROR

---

## GET /verify/:receiptId — Verify a Payment Receipt

Returns the status and details of a receipt created by POST /relay.

### Request

GET /verify/:receiptId

### Success Response (200)

{
  "success": true,
  "requestId": "uuid",
  "receipt": {
    "receiptId": "uuid",
    "status": "valid",              // "valid" | "consumed"
    "senderAddress": "SP...",
    "txid": "0x...",
    "explorerUrl": "https://...",
    "settlement": {
      "success": true,
      "status": "pending",
      "recipient": "SP...",
      "amount": "1000000"
    },
    "resource": "/api/endpoint",   // from original settle options
    "method": "GET",
    "accessCount": 0
  }
}

### Error Responses

- 400 MISSING_RECEIPT_ID
- 404 NOT_FOUND / INVALID_RECEIPT / RECEIPT_EXPIRED
- 500 INTERNAL_ERROR

---

## POST /access — Access a Receipt-Gated Resource

Validates a receipt token, optionally proxies to a downstream service,
and returns the gated resource.

### Request

POST /access
Content-Type: application/json

{
  "receiptId": "uuid",
  "resource": "/api/endpoint",      // optional — must match receipt's resource
  "targetUrl": "https://..."        // optional — HTTPS only, proxied if provided
}

### Success Response (200)

{
  "success": true,
  "requestId": "uuid",
  "granted": true,
  "receipt": {
    "receiptId": "uuid",
    "senderAddress": "SP...",
    "resource": "/api/endpoint",
    "accessCount": 1
  },
  "data": { ... },        // relay-hosted resource data (if applicable)
  "proxy": {              // present if targetUrl was provided
    "status": 200,
    "statusText": "OK",
    "headers": {},
    "body": { ... }
  }
}

### Error Responses

- 400 MISSING_RECEIPT_ID
- 404 INVALID_RECEIPT / RECEIPT_EXPIRED / NOT_FOUND
- 409 RECEIPT_CONSUMED — receipt already used
- 400 RESOURCE_MISMATCH — resource field doesn't match receipt
- 502 PROXY_FAILED — targetUrl unreachable
- 500 INTERNAL_ERROR

---

## GET /fees — Clamped Fee Estimates

Returns fee estimates from the Hiro API, clamped to relay-configured floor/ceiling
values to prevent extreme fees. No authentication required.

### Response

{
  "success": true,
  "requestId": "uuid",
  "fees": {
    "token_transfer":  { "low_priority": 180, "medium_priority": 270, "high_priority": 360 },
    "contract_call":   { "low_priority": 250, "medium_priority": 400, "high_priority": 600 },
    "smart_contract":  { "low_priority": 500, "medium_priority": 800, "high_priority": 1200 }
  },
  "source": "hiro",   // "hiro" | "cache" | "default"
  "cached": false
}

Values are in microSTX per transaction.

---

## POST /fees/config — Update Fee Clamps (Admin)

Update floor/ceiling clamp values for fee estimation. Requires API key.

### Request

POST /fees/config
Authorization: Bearer x402_sk_<env>_<32-char-hex>
Content-Type: application/json

{
  "token_transfer":  { "floor": 100, "ceiling": 5000 },
  "contract_call":   { "floor": 200, "ceiling": 10000 },
  "smart_contract":  { "floor": 400, "ceiling": 20000 }
}

All fields are optional — only provided types are updated.

---

## GET /health — Health Check

Returns service health, Stacks network connectivity, and sponsor wallet info.

### Response

{
  "success": true,
  "requestId": "uuid",
  "status": "ok",
  "version": "1.4.0",
  "network": "mainnet"
}

---

## GET /stats — Relay Statistics

Returns aggregate relay statistics for the last 24h and 7 days.
Includes transaction counts, token breakdown, fee stats, and facilitator health.

---

## SIP-018 Structured Data Authentication

The relay supports optional SIP-018 authentication on POST /relay and POST /sponsor.
When included, the auth field provides:
- Domain binding (signatures only valid for x402-sponsor-relay on this chain)
- Replay protection via nonce (unix timestamp ms)
- Time-bound authorization via expiry

For complete SIP-018 details:
https://x402-relay.aibtc.com/topics/authentication

---

## Receipt System

POST /relay creates a receipt when settlement succeeds. The receiptId is returned
in the response. Receipts can be:
- Verified: GET /verify/:receiptId — check status, sender, settlement details
- Used for access: POST /access — gate a resource behind payment proof

Receipts track accessCount. A receipt can be used multiple times unless consumed
by a one-time-use access grant.

For complete receipt and access flow:
https://x402-relay.aibtc.com/topics/sponsored-transactions

---

## Error Response Shape

All errors follow this format:

{
  "success": false,
  "requestId": "uuid",
  "error": "Human-readable description",
  "code": "ERROR_CODE",
  "details": "Additional context",   // optional
  "retryable": true,
  "retryAfter": 5                    // seconds, also sent as Retry-After header
}

For the complete error code reference:
https://x402-relay.aibtc.com/topics/errors

---

## Rate Limiting

- POST /relay: 10 requests/minute per sender address (from transaction)
- POST /sponsor: per-key tier limits (free: 10/min, 100/day)
- POST /keys/provision: no auth required, abuse mitigation via BTC sig
- All other endpoints: generous limits

When rate-limited, the response includes:
- HTTP 429 with code RATE_LIMIT_EXCEEDED or DAILY_LIMIT_EXCEEDED
- retryable: true
- retryAfter: N seconds
- Retry-After header

---

## Related Services

- x402 Facilitator: https://facilitator.stacksx402.com
- AIBTC Platform:   https://aibtc.com
- GitHub:           https://github.com/aibtcdev/x402-sponsor-relay
`;

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
});

// ---------------------------------------------------------------------------
// /topics — Topic index (JSON)
// ---------------------------------------------------------------------------
discovery.get("/topics", (c) => {
  const topics = [
    {
      topic: "sponsored-transactions",
      description:
        "Full relay flow: agent builds sponsored tx, relay sponsors it, facilitator settles, receipt issued. Includes receipt verification and access gating.",
      url: "https://x402-relay.aibtc.com/topics/sponsored-transactions",
    },
    {
      topic: "api-keys",
      description:
        "API key provisioning via BTC signature (BIP-137) or STX signature (RSV hex). Key tiers, expiry, and management.",
      url: "https://x402-relay.aibtc.com/topics/api-keys",
    },
    {
      topic: "authentication",
      description:
        "SIP-018 structured data authentication for /relay and /sponsor. Domain constants, message schema, signature creation.",
      url: "https://x402-relay.aibtc.com/topics/authentication",
    },
    {
      topic: "errors",
      description:
        "Complete error code reference with descriptions, HTTP status codes, and retry behavior.",
      url: "https://x402-relay.aibtc.com/topics/errors",
    },
  ];

  return c.json({
    service: "x402-sponsor-relay",
    description:
      "Deep-dive reference docs for specific relay topics. Each doc is self-contained and covers unique workflow content.",
    topics,
    related: {
      quickStart: "https://x402-relay.aibtc.com/llms.txt",
      fullReference: "https://x402-relay.aibtc.com/llms-full.txt",
      openApiSpec: "https://x402-relay.aibtc.com/openapi.json",
      agentCard: "https://x402-relay.aibtc.com/.well-known/agent.json",
      aibtcPlatform: "https://aibtc.com/llms.txt",
    },
  });
});

// ---------------------------------------------------------------------------
// /topics/:topic — Topic sub-docs (plaintext)
// ---------------------------------------------------------------------------
discovery.get("/topics/:topic", (c) => {
  const topic = c.req.param("topic");

  const topicDocs: Record<string, string> = {
    "sponsored-transactions": `# Sponsored Transactions — Full Relay Flow

Service: https://x402-relay.aibtc.com
Quick-start: https://x402-relay.aibtc.com/llms.txt
Full reference: https://x402-relay.aibtc.com/llms-full.txt

## Overview

The sponsored transaction flow lets an AI agent pay for a Stacks transaction
without holding STX for fees. The relay's wallet covers the network fee.

Two modes are available:

1. POST /relay — Sponsors + settles via x402 facilitator (payment proof)
2. POST /sponsor — Sponsors + broadcasts directly (no settlement verification, API key required)

## Step-by-Step: POST /relay

### Step 1: Build a Sponsored Transaction

Using the x402-stacks library or @stacks/transactions:

import { makeSTXTokenTransfer, AnchorMode, TransactionVersion } from "@stacks/transactions";

const tx = await makeSTXTokenTransfer({
  recipient: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
  amount: BigInt(1000000),       // 1 STX in microSTX
  sponsored: true,               // REQUIRED — marks this as a sponsored tx
  senderKey: agentPrivateKey,
  network: "mainnet",
  anchorMode: AnchorMode.Any,
  fee: 0,                        // relay will set the actual fee
});

const txHex = tx.serialize().toString("hex");

### Step 2: POST to /relay

POST https://x402-relay.aibtc.com/relay
Content-Type: application/json

{
  "transaction": "0x" + txHex,
  "settle": {
    "expectedRecipient": "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
    "minAmount": "1000000",
    "tokenType": "STX"
  }
}

### Step 3: Handle the Response

Success (200):
{
  "success": true,
  "txid": "0x...",
  "explorerUrl": "https://explorer.hiro.so/txid/0x...",
  "settlement": {
    "success": true,
    "status": "pending"
  },
  "sponsoredTx": "0x...",      // the fully-signed tx with relay's fee signature
  "receiptId": "uuid"          // save this for later verification
}

Error (4xx/5xx): See https://x402-relay.aibtc.com/topics/errors

### Step 4: Verify the Receipt

GET https://x402-relay.aibtc.com/verify/RECEIPT_ID

Returns receipt status, settlement details, and access count.

### Step 5: Access a Receipt-Gated Resource

POST https://x402-relay.aibtc.com/access
{
  "receiptId": "uuid",
  "resource": "/api/protected-endpoint",   // must match settle.resource
  "targetUrl": "https://downstream.com/endpoint"  // optional, HTTPS only
}

## Step-by-Step: POST /sponsor

For direct broadcast without facilitator settlement. Requires API key.

POST https://x402-relay.aibtc.com/sponsor
Authorization: Bearer x402_sk_prod_...
Content-Type: application/json

{
  "transaction": "0x" + txHex
}

Success (200):
{
  "success": true,
  "txid": "0x...",
  "explorerUrl": "https://explorer.hiro.so/txid/0x...",
  "fee": "1000"
}

## Transaction Flow Diagram

Agent                 Relay                   Facilitator         Stacks
  |                     |                          |                 |
  | POST /relay         |                          |                 |
  | { tx, settle }      |                          |                 |
  |-------------------> |                          |                 |
  |                     | validate tx              |                 |
  |                     | check rate limit         |                 |
  |                     | sponsor (add fee sig)    |                 |
  |                     | POST /settle             |                 |
  |                     |------------------------->|                 |
  |                     |                          | broadcast       |
  |                     |                          |---------------->|
  |                     |                          |<----------------|
  |                     |<-------------------------|                 |
  |                     | store receipt in KV      |                 |
  |<------------------- |                          |                 |
  | { txid, receiptId } |                          |                 |
  |                     |                          |                 |
  | GET /verify/ID      |                          |                 |
  |-------------------> |                          |                 |
  |<------------------- |                          |                 |
  | { receipt status }  |                          |                 |

## Notes

- The transaction MUST have sponsored: true set before signing
- The relay sets the actual fee using clamped estimates from GET /fees
- The relay derives the sender address from the transaction itself (no address param needed)
- receiptId is only returned if KV storage succeeds (best-effort)
- Receipts expire after 30 days
`,

    "api-keys": `# API Keys — Provisioning and Management

Service: https://x402-relay.aibtc.com
Full reference: https://x402-relay.aibtc.com/llms-full.txt

## Overview

API keys gate access to POST /sponsor and POST /fees/config. They are free
to provision and tied to a Bitcoin or Stacks address.

Key format: x402_sk_<env>_<32-char-hex>
  where <env> is "prod" (mainnet) or "test" (testnet/staging)

## Provisioning via Bitcoin Signature

POST /keys/provision accepts a BIP-137 signature over a known message.

### Message formats

1. Registration path — matches AIBTC platform genesis message:
   "Bitcoin will be the currency of AIs"
   (no timestamp — can be used exactly once per BTC address)

2. Self-service path — timestamped message:
   "Bitcoin will be the currency of AIs | <ISO-8601 timestamp>"
   Timestamp must be within 5 minutes of server time.

### Request

POST https://x402-relay.aibtc.com/keys/provision
Content-Type: application/json

{
  "btcAddress": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  "signature": "H9L5yLFjti0QTHhPyFrZCT1V...",   // base64 BIP-137
  "message": "Bitcoin will be the currency of AIs | 2026-02-16T12:00:00.000Z"
}

Accepted address formats:
- P2PKH: 1...  (legacy)
- P2SH:  3...  (wrapped segwit)
- Bech32: bc1q...  (native segwit)
- Bech32m: bc1p...  (taproot)

### Response

{
  "success": true,
  "apiKey": "x402_sk_prod_a1b2c3d4e5f6...",   // SAVE THIS — shown once only
  "metadata": {
    "keyId": "a1b2c3d4",
    "appName": "btc:bc1qar0sr",
    "contactEmail": "btc+bc1q...@x402relay.system",
    "tier": "free",
    "createdAt": "2026-02-16T12:00:00.000Z",
    "expiresAt": "2026-03-18T12:00:00.000Z",
    "active": true,
    "btcAddress": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
  }
}

## Provisioning via Stacks Signature

POST /keys/provision-stx accepts an RSV hex signature over the same message formats.

### Request

POST https://x402-relay.aibtc.com/keys/provision-stx
Content-Type: application/json

{
  "stxAddress": "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
  "signature": "0x1234567890abcdef...",   // hex-encoded RSV
  "message": "Bitcoin will be the currency of AIs | 2026-02-16T12:00:00.000Z"
}

Response shape mirrors /keys/provision but with stxAddress in metadata.

## Key Tiers

| Tier     | Requests/min | Requests/day | Fee cap/day     |
|----------|-------------|--------------|-----------------|
| free     | 10          | 100          | 100 STX         |
| standard | 60          | 10,000       | 1,000 STX       |
| unlimited| unlimited   | unlimited    | unlimited       |

All provisioned keys start on the free tier. Contact the team to upgrade.

## Key Expiry

Keys expire 30 days after creation. The metadata.expiresAt field shows the
expiry date. After expiry, the key returns EXPIRED_API_KEY (HTTP 401).

To renew: provision a new key with a fresh timestamped message.

## Using Your API Key

Pass the key in the Authorization header:

Authorization: Bearer x402_sk_prod_a1b2c3d4e5f6...

Required for:
- POST /sponsor
- POST /fees/config

## Error Codes

- 400 MISSING_BTC_ADDRESS / MISSING_STX_ADDRESS
- 400 MISSING_SIGNATURE
- 400 INVALID_MESSAGE_FORMAT
- 400 INVALID_SIGNATURE / INVALID_STX_SIGNATURE
- 400 STALE_TIMESTAMP — timestamp > 5 minutes old
- 409 ALREADY_PROVISIONED — this address already has a key
- 500 INTERNAL_ERROR — storage error, retry

When using an expired/invalid key:
- 401 MISSING_API_KEY
- 401 INVALID_API_KEY
- 401 EXPIRED_API_KEY
- 401 REVOKED_API_KEY
`,

    "authentication": `# Authentication — SIP-018 Structured Data Auth

Service: https://x402-relay.aibtc.com
Full reference: https://x402-relay.aibtc.com/llms-full.txt

## Overview

The relay supports two independent auth layers:

1. API key auth (Bearer token) — required for POST /sponsor, POST /fees/config
2. SIP-018 structured data auth — optional enhancement for POST /relay and POST /sponsor

SIP-018 auth is backward-compatible. If the auth field is omitted, the request
proceeds without it. If provided, the relay verifies the signature.

## SIP-018 Auth: What It Provides

When included in a request, SIP-018 auth provides:
- Domain binding — signature is cryptographically bound to x402-sponsor-relay on this chain
- Replay protection — nonce (unix ms timestamp) is a unique identifier per request
- Time-bound authorization — expiry field limits the window of validity
- Sender identity — relay recovers the Stacks address from the signature

## Domain Constants

Mainnet (chainId = 1):
  name: "x402-sponsor-relay"
  version: "1"
  chainId: 1

Testnet (chainId = 2147483648):
  name: "x402-sponsor-relay"
  version: "1"
  chainId: 2147483648

## Message Schema (Clarity Tuple)

The message that gets signed is a Clarity tuple:

{
  action: (string-ascii 10),   ;; "relay" or "sponsor"
  nonce: uint,                  ;; unix timestamp ms (replay protection)
  expiry: uint                  ;; expiry timestamp (unix ms), must be in future
}

- action must match the endpoint: "relay" for POST /relay, "sponsor" for POST /sponsor
- nonce is the creation time as unix milliseconds
- expiry must be set to a future time (e.g., nonce + 3600000 for 1 hour)

## Creating a SIP-018 Signature

Using @stacks/transactions + x402-stacks:

import { signStructuredData } from "@stacks/transactions";
import { SIP018_DOMAIN_MAINNET } from "x402-stacks";

const domain = {
  name: "x402-sponsor-relay",
  version: "1",
  chainId: 1,   // 1 for mainnet, 2147483648 for testnet
};

const now = Date.now();
const message = {
  action: "relay",            // or "sponsor"
  nonce: now.toString(),
  expiry: (now + 3600000).toString(),  // 1 hour from now
};

const signature = signStructuredData({
  domain,
  message,
  privateKey: agentPrivateKey,
});

## Adding Auth to a Request

POST https://x402-relay.aibtc.com/relay
Content-Type: application/json

{
  "transaction": "0x...",
  "settle": { ... },
  "auth": {
    "signature": "0x1234abcd...",   // RSV hex signature
    "message": {
      "action": "relay",
      "nonce": "1708099200000",
      "expiry": "1708185600000"
    }
  }
}

## Error Responses

If auth is provided but invalid:

- 401 INVALID_AUTH_SIGNATURE — signature failed verification
  { "code": "INVALID_AUTH_SIGNATURE", "retryable": false }

- 401 AUTH_EXPIRED — expiry is in the past
  { "code": "AUTH_EXPIRED", "retryable": false }

If auth is omitted entirely, the request proceeds without SIP-018 verification.

## Notes

- The relay recovers the Stacks address from the signature automatically
- There is no server-side nonce registration — the nonce is just a unix timestamp
- Expiry enforcement prevents pre-signed messages from being reused indefinitely
- Cross-endpoint replay is prevented: a "relay" signature cannot be used on /sponsor
`,

    "errors": `# Error Codes — Complete Reference

Service: https://x402-relay.aibtc.com
Full reference: https://x402-relay.aibtc.com/llms-full.txt

## Error Response Format

All errors return JSON with this shape:

{
  "success": false,
  "requestId": "uuid",
  "error": "Human-readable description",
  "code": "ERROR_CODE",
  "details": "Additional context (optional)",
  "retryable": true | false,
  "retryAfter": 5   // seconds (optional, also sent as Retry-After header)
}

## Transaction Errors (POST /relay, POST /sponsor)

| Code                    | HTTP | Retryable | Description |
|-------------------------|------|-----------|-------------|
| MISSING_TRANSACTION     | 400  | false     | transaction field absent from request body |
| MISSING_SETTLE_OPTIONS  | 400  | false     | settle field absent (relay only) |
| INVALID_SETTLE_OPTIONS  | 400  | false     | expectedRecipient or minAmount invalid |
| INVALID_TRANSACTION     | 400  | false     | tx hex cannot be deserialized |
| NOT_SPONSORED           | 400  | false     | tx must have sponsored: true set |
| SETTLEMENT_FAILED       | 400  | false     | facilitator rejected the settlement |
| RATE_LIMIT_EXCEEDED     | 429  | true      | 10 req/min per sender, retryAfter: 60 |
| DAILY_LIMIT_EXCEEDED    | 429  | true      | key's daily request limit reached |
| SPENDING_CAP_EXCEEDED   | 429  | true      | key's daily fee cap reached |
| SPONSOR_CONFIG_ERROR    | 500  | false     | relay not configured (missing mnemonic) |
| SPONSOR_FAILED          | 500  | true      | sponsoring the tx failed |
| BROADCAST_FAILED        | 500  | true      | Stacks node rejected the broadcast |
| FACILITATOR_TIMEOUT     | 504  | true      | facilitator timed out, retryAfter: 5 |
| FACILITATOR_ERROR       | 502  | true      | facilitator gateway error, retryAfter: 5 |
| FACILITATOR_INVALID_RESPONSE | 500 | true | facilitator response unreadable, retryAfter: 10 |

## API Key Errors (POST /sponsor, POST /fees/config)

| Code                  | HTTP | Retryable | Description |
|-----------------------|------|-----------|-------------|
| MISSING_API_KEY       | 401  | false     | Authorization header absent |
| INVALID_API_KEY       | 401  | false     | Key format invalid or not found |
| EXPIRED_API_KEY       | 401  | false     | Key past its expiresAt date |
| REVOKED_API_KEY       | 401  | false     | Key was manually deactivated |

## SIP-018 Auth Errors (POST /relay, POST /sponsor)

| Code                  | HTTP | Retryable | Description |
|-----------------------|------|-----------|-------------|
| INVALID_AUTH_SIGNATURE| 401  | false     | Signature invalid or wrong action |
| AUTH_EXPIRED          | 401  | false     | expiry timestamp is in the past |

## Provision Errors (POST /keys/provision, POST /keys/provision-stx)

| Code                  | HTTP | Retryable | Description |
|-----------------------|------|-----------|-------------|
| MISSING_BTC_ADDRESS   | 400  | false     | btcAddress absent or invalid format |
| MISSING_STX_ADDRESS   | 400  | false     | stxAddress absent |
| MISSING_SIGNATURE     | 400  | false     | signature absent |
| INVALID_MESSAGE_FORMAT| 400  | false     | message absent or wrong format |
| INVALID_SIGNATURE     | 400  | false     | BIP-137 signature verification failed |
| INVALID_STX_SIGNATURE | 400  | false     | Stacks RSV sig verification failed |
| STALE_TIMESTAMP       | 400  | false     | timestamp > 5 minutes from server time |
| ALREADY_PROVISIONED   | 409  | false     | this address already has a key |

## Receipt and Access Errors

| Code                  | HTTP | Retryable | Description |
|-----------------------|------|-----------|-------------|
| MISSING_RECEIPT_ID    | 400  | false     | receiptId absent |
| INVALID_RECEIPT       | 404  | false     | receiptId not found in KV |
| RECEIPT_EXPIRED       | 404  | false     | receipt past its 30-day TTL |
| RECEIPT_CONSUMED      | 409  | false     | receipt was one-time-use and already used |
| RESOURCE_MISMATCH     | 400  | false     | resource param doesn't match receipt |
| PROXY_FAILED          | 502  | true      | targetUrl unreachable or returned error |

## Fee Errors

| Code              | HTTP | Retryable | Description |
|-------------------|------|-----------|-------------|
| FEE_FETCH_FAILED  | 500  | true      | Hiro API unreachable, relay uses cached/default values |
| INVALID_FEE_CONFIG| 400  | false     | floor > ceiling or invalid config shape |

## General Errors

| Code              | HTTP | Retryable | Description |
|-------------------|------|-----------|-------------|
| NOT_FOUND         | 404  | false     | Route or resource not found |
| INTERNAL_ERROR    | 500  | true      | Unexpected server error |

## Retry Behavior

When retryable: true, wait for retryAfter seconds (or check the Retry-After header)
before retrying. For errors without retryAfter, use exponential backoff starting
at 1 second.

Do NOT retry:
- 400 errors — the request body must be corrected first
- 401 errors — fix auth (new key, fix signature)
- 404 errors — the resource doesn't exist
- 409 errors — the conflict must be resolved

Do retry (after retryAfter):
- 429 rate limit — wait for the window to reset
- 502/504 facilitator errors — upstream may recover
- 500 INTERNAL_ERROR — may be transient
`,
  };

  const content = topicDocs[topic];

  if (!content) {
    return c.json(
      {
        error: "Topic not found",
        code: "NOT_FOUND",
        details: `Unknown topic: ${topic}. Available topics: sponsored-transactions, api-keys, authentication, errors`,
        retryable: false,
      },
      404
    );
  }

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
});

// ---------------------------------------------------------------------------
// /.well-known/agent.json — A2A Agent Card
// ---------------------------------------------------------------------------
discovery.get("/.well-known/agent.json", (c) => {
  const agentCard = {
    name: "x402 Stacks Sponsor Relay",
    description:
      "Gasless transaction relay for AI agents on the Stacks blockchain. " +
      "Accepts pre-signed sponsored transactions, covers the network fee, and calls the x402 facilitator for settlement verification. " +
      "Supports STX, sBTC, and USDCx tokens. API keys provisioned for free via BTC or STX signature.",
    url: "https://x402-relay.aibtc.com",
    provider: {
      organization: "AIBTC Working Group",
      url: "https://aibtc.com",
    },
    version: VERSION,
    documentationUrl: "https://x402-relay.aibtc.com/llms.txt",
    openApiUrl: "https://x402-relay.aibtc.com/openapi.json",
    documentation: {
      quickStart: "https://x402-relay.aibtc.com/llms.txt",
      fullReference: "https://x402-relay.aibtc.com/llms-full.txt",
      openApiSpec: "https://x402-relay.aibtc.com/openapi.json",
      topicDocs: {
        index: "https://x402-relay.aibtc.com/topics",
        sponsoredTransactions: "https://x402-relay.aibtc.com/topics/sponsored-transactions",
        apiKeys: "https://x402-relay.aibtc.com/topics/api-keys",
        authentication: "https://x402-relay.aibtc.com/topics/authentication",
        errors: "https://x402-relay.aibtc.com/topics/errors",
      },
      relatedPlatform: "https://aibtc.com/llms.txt",
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    authentication: {
      schemes: ["bearer"],
      description:
        "Bearer token (API key) required for POST /sponsor. " +
        "Provision a free key via POST /keys/provision (BTC sig) or POST /keys/provision-stx (STX sig). " +
        "Optional SIP-018 structured data auth available on POST /relay and POST /sponsor.",
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    network: {
      production: {
        url: "https://x402-relay.aibtc.com",
        chain: "mainnet",
        chainId: 1,
      },
      staging: {
        url: "https://x402-relay.aibtc.dev",
        chain: "testnet",
        chainId: 2147483648,
      },
    },
    supportedTokens: ["STX", "sBTC", "USDCx"],
    relatedServices: {
      facilitator: "https://facilitator.stacksx402.com",
      aibtcPlatform: "https://aibtc.com",
      github: "https://github.com/aibtcdev/x402-sponsor-relay",
    },
    skills: [
      {
        id: "relay-transaction",
        name: "Relay Sponsored Transaction",
        description:
          "Submit a pre-signed Stacks sponsored transaction for relay and x402 settlement. " +
          "The relay pays the network fee. Accepts STX, sBTC, and USDCx token transfers. " +
          "No API key required. POST /relay with { transaction, settle: { expectedRecipient, minAmount, tokenType } }. " +
          "Returns { txid, settlement, sponsoredTx, receiptId }.",
        tags: ["gasless", "sponsored", "stacks", "x402", "settlement"],
        examples: [
          "Relay a sponsored STX transfer without paying fees",
          "Submit a gasless sBTC transaction via x402",
          "Settle an x402 payment with the sponsor relay",
        ],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "sponsor-transaction",
        name: "Sponsor and Broadcast Transaction",
        description:
          "Sponsor a pre-signed Stacks transaction and broadcast it directly to the network. " +
          "No facilitator settlement — useful for non-payment transactions. " +
          "Requires API key (Bearer token). POST /sponsor with { transaction }. " +
          "Returns { txid, fee }. Optional SIP-018 auth via auth field.",
        tags: ["gasless", "sponsored", "broadcast", "stacks"],
        examples: [
          "Broadcast a sponsored transaction directly",
          "Sponsor a contract call without holding STX",
          "Broadcast a gasless ERC-8004 identity registration",
        ],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "provision-api-key",
        name: "Provision API Key",
        description:
          "Get a free-tier API key for POST /sponsor by signing a known message with your Bitcoin key (BIP-137). " +
          "POST /keys/provision with { btcAddress, signature, message }. " +
          "Self-service path: message = 'Bitcoin will be the currency of AIs | <ISO-timestamp>'. " +
          "Also available via Stacks signature: POST /keys/provision-stx. " +
          "Returns apiKey (store securely — shown once).",
        tags: ["api-key", "provisioning", "bitcoin", "stacks", "authentication"],
        examples: [
          "Get an API key using my Bitcoin signature",
          "Provision a relay key for sponsored transactions",
          "Get a free key by signing with my Stacks wallet",
        ],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "verify-receipt",
        name: "Verify Payment Receipt",
        description:
          "Verify a payment receipt created by a successful POST /relay call. " +
          "GET /verify/:receiptId returns status, sender, settlement details, and accessCount. " +
          "Receipts are valid for 30 days.",
        tags: ["receipt", "verification", "payment"],
        examples: [
          "Check if a receipt is still valid",
          "Verify a payment receipt from a relay transaction",
        ],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "access-resource",
        name: "Access Receipt-Gated Resource",
        description:
          "Use a payment receipt to access a gated resource or proxy a downstream request. " +
          "POST /access with { receiptId, resource?, targetUrl? }. " +
          "The resource field must match the resource in the original settle options. " +
          "If targetUrl is provided (HTTPS only), the relay proxies the request.",
        tags: ["access", "receipt", "proxy", "x402"],
        examples: [
          "Access a protected endpoint using a relay receipt",
          "Proxy a request to a downstream service using a payment receipt",
        ],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "fee-estimates",
        name: "Get Fee Estimates",
        description:
          "Get clamped fee estimates for Stacks transactions. " +
          "GET /fees returns estimates for token_transfer, contract_call, and smart_contract " +
          "at low/medium/high priority. No authentication required. Values in microSTX.",
        tags: ["fees", "estimation", "stacks"],
        examples: [
          "What are the current STX transaction fees?",
          "Get fee estimates before building a transaction",
        ],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "health-check",
        name: "Service Health Check",
        description:
          "Check relay health, network, and sponsor wallet status. " +
          "GET /health returns status, version, network, and sponsorAddress. " +
          "Use before sending transactions to verify the relay is operational.",
        tags: ["health", "monitoring", "status"],
        examples: [
          "Is the relay healthy?",
          "Check relay status before submitting a transaction",
        ],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
  };

  return c.json(agentCard, {
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
});

export { discovery };
