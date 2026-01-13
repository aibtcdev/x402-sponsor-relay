# x402 Stacks Sponsor Relay

A Cloudflare Worker that enables gasless transactions for AI agents on the Stacks blockchain by sponsoring and relaying transactions.

## Overview

The [x402 protocol](https://www.x402.org/) is an HTTP-native payment standard that uses the HTTP 402 "Payment Required" status code to enable instant, autonomous stablecoin payments. This project brings x402 to Stacks by providing a sponsor relay service that:

1. Accepts pre-signed sponsored transactions from agents
2. Validates the transaction format (must be sponsored type)
3. Sponsors the transaction (covers gas fees with our key)
4. Broadcasts to the Stacks network

## Goals

### Primary Goals

- [x] **Gasless agent transactions**: Agents can submit transactions without holding STX for fees
- [ ] **Signature-based auth**: Validate agent identity using SIP-018 structured data signatures (optional)
- [ ] **x402 compatibility**: Integrate with x402 protocol flow for payment verification
- [x] **Stacks-native**: Full support for Stacks transaction types

### Secondary Goals

- [x] **Rate limiting**: Prevent abuse with per-sender rate limits (10 req/min)
- [ ] **Spending caps**: Configurable max sponsorship per agent/timeframe
- [x] **Metrics/logging**: Track usage via worker-logs service
- [x] **Multi-network**: Support both mainnet and testnet via config

## Implementation Status

### Completed

- [x] Core `/relay` POST endpoint
- [x] Transaction deserialization and sponsored type validation
- [x] `sponsorTransaction()` integration with @stacks/transactions
- [x] Broadcasting to Stacks network
- [x] In-memory rate limiting per sender
- [x] CORS headers for cross-origin requests
- [x] worker-logs integration for observability
- [x] Test script for end-to-end validation
- [x] x402-stacks fork with `sponsored: true` support (PR #8)

### Pending

- [ ] Deploy to testnet staging (x402-relay.aibtc.dev)
- [ ] Deploy to mainnet production (x402-relay.aibtc.com)
- [ ] End-to-end test with real transactions
- [ ] SIP-018 signature verification
- [ ] x402 payment flow for fee recovery
- [ ] ERC-8004 agent registry integration
- [ ] Persistent rate limiting (KV or Durable Objects)

## Decisions Made

| Question         | Decision                                                    |
| ---------------- | ----------------------------------------------------------- |
| Agent identity   | Start with any Stacks address; ERC-8004 as future milestone |
| Flow origin      | Agent calls relay directly                                  |
| Abuse prevention | Rate limits (10 req/min per sender)                         |
| Payment token    | STX, sBTC, USDCx (via x402-stacks)                          |
| Facilitator      | Use existing facilitator.stacksx402.com                     |

## Architecture

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
  │◀─────────────────────────────│◀─────────────────────────────────│
  │ { txid: "0x..." }            │                                  │
```

## API

### POST /relay

Request:

```json
{
  "transaction": "<hex-encoded-sponsored-stacks-transaction>"
}
```

Response (success):

```json
{
  "txid": "0x..."
}
```

Response (error):

```json
{
  "error": "Transaction must be sponsored",
  "details": "Build transaction with sponsored: true"
}
```

### GET /health

Response:

```json
{
  "status": "ok",
  "network": "testnet",
  "version": "0.1.0"
}
```

## Open Questions (Remaining)

### Protocol Design

1. ~~**Facilitator location**~~: Using existing facilitator.stacksx402.com

2. ~~**Payment token**~~: STX, sBTC, USDCx supported via x402-stacks

3. **Payment timing**: Pre-pay (deposit) or pay-per-transaction?

   - Currently: Free sponsorship with rate limits
   - Future: x402 payment flow for fee recovery

4. **Settlement**: On-chain or off-chain accounting?
   - Currently: No settlement (free tier)
   - Future: Clarity contract for deposits/withdrawals?

### Authentication

5. ~~**Agent identity**~~: Any Stacks address; ERC-8004 as milestone

6. **Signature message**: What structured data should agents sign?
   - Currently: Not required
   - Future: SIP-018 domain-separated message

### Operations

7. **Sponsor key management**: Currently Cloudflare Secrets

   - Future: Key rotation? Multiple keys?

8. ~~**Rate limits**~~: 10 req/min per sender (in-memory)

   - Future: Persistent via KV or Durable Objects

9. **Monitoring**: Using worker-logs service
   - Future: Metrics dashboard?

## Context

### Existing Work

**x402 Stacks Ecosystem:**

- **stx402** (`~/dev/whoabuddy/stx402/`): Full x402 implementation at stx402.com
- **x402-stacks** (`~/dev/tony1908/x402Stacks/`): npm package, PR #8 adds sponsored tx
- **Facilitator**: facilitator.stacksx402.com (testnet + mainnet)

**Sponsored Transactions:**

- **`agent-tools-ts/src/stacks-alex/`**: ALEX SDK sponsored transaction examples
- **Stacks.js docs**: https://docs.stacks.co/stacks.js/build-transactions#sponsored-transactions

**Agent Identity:**

- **`erc-8004-stacks/`**: ERC-8004 agent identity/reputation contracts (testnet deployed)

**Infrastructure:**

- **worker-logs** (`~/dev/whoabuddy/worker-logs/`): Universal logging at logs.wbd.host

## Next Steps

1. ~~Research existing x402 facilitator implementations~~ ✓
2. ~~Implement basic relay without 402 flow~~ ✓
3. Deploy to testnet staging environment
4. End-to-end test with real testnet transactions
5. Add SIP-018 signature verification (optional auth)
6. Add x402 payment layer for fee recovery
7. Design Clarity contract for deposits (if needed)

## Resources

### x402 Protocol

- [x402 Protocol](https://www.x402.org/)
- [x402 GitHub](https://github.com/coinbase/x402)
- [x402 Documentation](https://docs.cdp.coinbase.com/x402/welcome)

### Stacks

- [Sponsored Transactions](https://docs.stacks.co/stacks.js/build-transactions#sponsored-transactions)
- [SIP-018 Signed Structured Data](https://github.com/stacksgov/sips/blob/main/sips/sip-018/sip-018-signed-structured-data.md)
- [Stacks.js Transactions](https://stacks.js.org/packages/transactions)

### Local Resources

- [x402-stacks PR #8](https://github.com/tony1908/x402Stacks/pull/8) - Sponsored tx support
- [stx402 Implementation](~/dev/whoabuddy/stx402/) - Reference patterns
- [Universal Logger](~/dev/whoabuddy/worker-logs/) - logs.wbd.host
