# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

x402 Stacks Sponsor Relay - A Cloudflare Worker enabling gasless transactions for AI agents on the Stacks blockchain. Accepts pre-signed transactions, validates agent authorization, sponsors the transaction, and relays to x402 facilitator.

**Status**: Initial scaffolding complete. See REQUIREMENTS.md for goals and open questions.

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

# DO NOT run npm run deploy - commit and push for automatic deployment
```

## Architecture

**Stack:**
- Cloudflare Workers for deployment
- Hono.js (planned) for HTTP routing
- @stacks/transactions for Stacks transaction handling
- worker-logs service binding for centralized logging

**Endpoints:**
- `/health` - Health check endpoint
- `/relay` - Main endpoint for transaction sponsorship (TODO)

**Project Structure:**
```
src/
  index.ts          # Worker entry point, HTTP routing
  # Planned:
  relay.ts          # Transaction sponsorship logic
  auth.ts           # SIP-018 signature verification
  types.ts          # TypeScript interfaces
```

## Configuration

- `wrangler.jsonc` - Cloudflare Workers config (service bindings, routes)
- Secrets set via `wrangler secret put`:
  - `SPONSOR_PRIVATE_KEY` - Private key for sponsoring transactions

## Service Bindings

**LOGS** - Universal logging service (RPC binding to worker-logs)
```typescript
// Usage:
await env.LOGS.info('x402-relay', 'Transaction sponsored', { txid, agentId })
await env.LOGS.error('x402-relay', 'Sponsorship failed', { error })
```

See [worker-logs integration guide](~/dev/whoabuddy/worker-logs/docs/integration.md) for details.

## Key Decisions Needed

See REQUIREMENTS.md for full list. Key blockers:
1. Stacks facilitator: Build or integrate?
2. Payment token: STX, aBTC, or USDC?
3. Auth flow: SIP-018 signatures vs API keys?
4. Other sponsored tx examples to learn from?

## Related Projects

**Best Practice References:**
- `~/dev/absorbingchaos/thundermountainbuilders/` - CF Worker patterns (D1, R2, Email)
- `~/dev/whoabuddy/worker-logs/` - Universal logging service

**aibtcdev Resources:**
- `../erc-8004-stacks/` - Agent identity contracts
- `../agent-tools-ts/src/stacks-alex/` - Sponsored tx examples
- `../aibtcdev-cache/` - Existing CF Worker with Durable Objects

## Wrangler Setup

Wrangler commands need environment variables from `.env`. Use this pattern:

```bash
# Add to ~/.bashrc or run before wrangler commands
alias wrangler='set -a && . ./.env && set +a && npx wrangler'
```

Or add an npm script:
```bash
npm run wrangler -- <command>
```

### Secrets

Set via `wrangler secret put`:
- `SPONSOR_PRIVATE_KEY` - STX private key for sponsoring transactions

## Development Notes

- Follow existing aibtcdev patterns for Cloudflare Workers
- Use `wrangler.jsonc` format with comments (not .toml)
- Test against testnet before mainnet
- Integrate worker-logs early for debugging
- Use service bindings over HTTP where possible
