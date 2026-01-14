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
- `POST /relay` - Submit sponsored transaction for sponsorship and settlement

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

Response (error): { error: "...", details: "..." }
```

**Project Structure:**
```
src/
  index.ts              # Hono app entry point with Chanfana OpenAPI setup
  types.ts              # Centralized type definitions
  endpoints/
    index.ts            # Barrel exports
    BaseEndpoint.ts     # Base class extending OpenAPIRoute
    health.ts           # GET /health endpoint
    relay.ts            # POST /relay endpoint
  middleware/
    index.ts            # Barrel exports
    logger.ts           # Request-scoped logging middleware
    rate-limit.ts       # Rate limiting utilities
  services/
    index.ts            # Barrel exports
    sponsor.ts          # Transaction sponsoring logic
    facilitator.ts      # x402 facilitator API client
scripts/
  test-relay.ts         # Test script for building and submitting sponsored tx
```

## Deployment URLs

- **Testnet (staging)**: https://x402-relay.aibtc.dev
- **Mainnet (production)**: https://x402-relay.aibtc.com

## Configuration

- `wrangler.jsonc` - Cloudflare Workers config (service bindings, routes, environments)
- `.env` - Local development secrets (not committed, loaded by wrangler)
- `.env.example` - Template for required environment variables
- Secrets set via `wrangler secret put`:
  - `SPONSOR_PRIVATE_KEY` - Private key for sponsoring transactions

## Deployment

```bash
# Authenticate with Cloudflare
npx wrangler login

# Set secrets for staging
npx wrangler secret put SPONSOR_PRIVATE_KEY --env staging

# Deploy to staging (testnet)
npx wrangler deploy --env staging

# Deploy to production (mainnet)
npx wrangler secret put SPONSOR_PRIVATE_KEY --env production
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
2. Set `SPONSOR_PRIVATE_KEY` in `.env`
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

## Next Steps

- [x] Deploy to testnet staging environment
- [x] Integrate x402 facilitator for settlement verification
- [x] Refactor to Hono + Chanfana for auto-generated docs
- [ ] End-to-end test with real testnet transactions
- [ ] Add SIP-018 signature verification (optional auth layer)
- [ ] Add ERC-8004 agent registry lookup
