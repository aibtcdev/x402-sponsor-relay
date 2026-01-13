# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

x402 Stacks Sponsor Relay - A Cloudflare Worker enabling gasless transactions for AI agents on the Stacks blockchain. Accepts pre-signed sponsored transactions, sponsors them with our key, and broadcasts to the Stacks network.

**Status**: Core relay endpoint implemented. Ready for testnet deployment and testing.

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

# Test relay endpoint
npm run test:relay -- <private-key> [relay-url]

# DO NOT run npm run deploy - commit and push for automatic deployment
```

## Architecture

**Stack:**
- Cloudflare Workers for deployment
- @stacks/transactions for Stacks transaction handling
- x402-stacks (fork) for building sponsored transactions
- worker-logs service binding for centralized logging

**Endpoints:**
- `GET /health` - Health check with network info
- `POST /relay` - Submit sponsored transaction for sponsorship and broadcast

**Request/Response:**
```typescript
// POST /relay
Request: { transaction: "hex-encoded-sponsored-tx" }
Response: { txid: "0x..." } | { error: "...", details: "..." }
```

**Project Structure:**
```
src/
  index.ts          # Worker entry point with /relay endpoint
scripts/
  test-relay.ts     # Test script for building and submitting sponsored tx
```

## Deployment URLs

- **Testnet (staging)**: https://x402-relay.aibtc.dev
- **Mainnet (production)**: https://x402-relay.aibtc.com

## Configuration

- `wrangler.jsonc` - Cloudflare Workers config (service bindings, routes, environments)
- `.dev.vars` - Local development secrets (not committed)
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
```typescript
const logs = env.LOGS as unknown as LogsRPC;
ctx.waitUntil(logs.info('x402-relay', 'Transaction sponsored', { txid }));
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

1. Start dev server: `npm run dev`
2. Set `SPONSOR_PRIVATE_KEY` in `.dev.vars`
3. Test with: `npm run test:relay -- <agent-private-key> http://localhost:8787`
4. Check logs at logs.wbd.host

## Sponsored Transaction Flow

```
Agent                          Relay                         Stacks Network
  │                              │                                  │
  │ 1. Build tx with             │                                  │
  │    sponsored: true, fee: 0   │                                  │
  │                              │                                  │
  │ 2. POST /relay               │                                  │
  │    { transaction: hex }      │                                  │
  │─────────────────────────────▶│                                  │
  │                              │ 3. Deserialize & validate       │
  │                              │    (must be AuthType.Sponsored) │
  │                              │                                  │
  │                              │ 4. sponsorTransaction()         │
  │                              │    (add sponsor sig + fee)      │
  │                              │                                  │
  │                              │ 5. broadcastTransaction()       │
  │                              │─────────────────────────────────▶│
  │                              │                                  │
  │                              │◀─────────────────────────────────│
  │◀─────────────────────────────│ 6. Return txid                  │
  │ { txid: "0x..." }            │                                  │
```

## Next Steps

- [ ] Deploy to testnet staging environment
- [ ] End-to-end test with real testnet transactions
- [ ] Add SIP-018 signature verification (optional auth layer)
- [ ] Integrate x402 payment flow for fee recovery
- [ ] Add ERC-8004 agent registry lookup
