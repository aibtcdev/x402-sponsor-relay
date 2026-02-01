# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

x402 Stacks Sponsor Relay - A Cloudflare Worker enabling gasless transactions for AI agents on the Stacks blockchain. Accepts pre-signed sponsored transactions, sponsors them, and calls the x402 facilitator for settlement verification.

**Status**: Core relay with facilitator integration complete. Deployed to testnet staging.

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
- `GET /docs` - Swagger UI API documentation
- `GET /openapi.json` - OpenAPI specification
- `POST /relay` - Submit sponsored transaction for settlement (x402 facilitator)
- `POST /sponsor` - Sponsor and broadcast transaction directly (requires API key)
- `GET /stats` - Relay statistics (JSON API)
- `GET /dashboard` - Public dashboard (HTML)

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
  }
}

Response (success): {
  txid: "0x...",
  settlement: {
    success: true,
    status: "pending" | "confirmed" | "failed",
    sender: "SP...",
    recipient: "SP...",
    amount: "1000000",
    blockHeight?: 12345
  }
}

Response (error): {
  error: "...",
  code: "FACILITATOR_TIMEOUT" | "RATE_LIMIT_EXCEEDED" | ...,
  details: "...",
  retryable: true | false,
  retryAfter?: 5  // seconds, also sent as Retry-After header
}

// POST /sponsor (requires API key)
Request: {
  transaction: "hex-encoded-sponsored-tx"
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
```

**Key Files:**
- `src/index.ts` - Hono app entry point with Chanfana OpenAPI setup
- `src/version.ts` - Single source of truth for VERSION constant
- `src/types.ts` - Centralized type definitions
- `scripts/test-relay.ts` - Test script for /relay endpoint (no auth)
- `scripts/test-sponsor.ts` - Test script for /sponsor endpoint (API key auth)
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
| Facilitator | facilitator.stacksx402.com (existing) |

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
Agent                    Relay                    Facilitator              Stacks
  │                        │                           │                     │
  │ 1. Build tx with       │                           │                     │
  │    sponsored: true     │                           │                     │
  │                        │                           │                     │
  │ 2. POST /relay         │                           │                     │
  │    { transaction,      │                           │                     │
  │      settle: {...} }   │                           │                     │
  │───────────────────────▶│                           │                     │
  │                        │ 3. Validate & sponsor    │                     │
  │                        │                           │                     │
  │                        │ 4. POST /api/v1/settle   │                     │
  │                        │───────────────────────────▶│                     │
  │                        │                           │ 5. Broadcast        │
  │                        │                           │────────────────────▶│
  │                        │                           │◀────────────────────│
  │                        │◀───────────────────────────│ 6. Settlement      │
  │◀───────────────────────│ 7. Return { txid,        │                     │
  │                        │    settlement: {...} }   │                     │
```

## Future Enhancements

See GitHub issues for planned enhancements:
- [#6 - SIP-018 signature verification](https://github.com/aibtcdev/x402-sponsor-relay/issues/6)
- [#7 - ERC-8004 agent registry integration](https://github.com/aibtcdev/x402-sponsor-relay/issues/7)
