# x402 Stacks Sponsor Relay

A Cloudflare Worker that enables gasless transactions for AI agents on the Stacks blockchain by sponsoring and relaying transactions to an x402 facilitator.

## Overview

The [x402 protocol](https://www.x402.org/) is an HTTP-native payment standard that uses the HTTP 402 "Payment Required" status code to enable instant, autonomous stablecoin payments. This project brings x402 to Stacks by providing a sponsor relay service that:

1. Accepts pre-signed transactions from agents
2. Validates the transaction and agent authorization via signatures
3. Sponsors the transaction (covers gas fees)
4. Relays to the x402 facilitator for settlement on Stacks

## Goals

### Primary Goals

- [ ] **Gasless agent transactions**: Agents can submit transactions without holding STX for fees
- [ ] **Signature-based auth**: Validate agent identity using SIP-018 structured data signatures
- [ ] **x402 compatibility**: Integrate with x402 protocol flow for payment verification
- [ ] **Stacks-native**: Full support for Stacks transaction types and Clarity contracts

### Secondary Goals

- [ ] **Rate limiting**: Prevent abuse with per-agent rate limits
- [ ] **Spending caps**: Configurable max sponsorship per agent/timeframe
- [ ] **Metrics/logging**: Track usage for billing and debugging
- [ ] **Multi-network**: Support both mainnet and testnet

## Context

### Existing Work

**Sponsored Transactions:**
- **`agent-tools-ts/src/stacks-alex/sponsored-swap.ts`**: ALEX SDK sponsored transactions
- **`agent-tools-ts/src/stacks-alex/sponsored-broadcast.ts`**: Broadcast pattern for sponsored tx
- **Other sponsored tx examples**: See Open Questions #12

**Agent Identity:**
- **`erc-8004-stacks/`**: ERC-8004 agent identity/reputation contracts (testnet deployed)

**Cloudflare Patterns:**
- **`~/dev/absorbingchaos/thundermountainbuilders/`**: Best practice CF Worker with D1, R2, Email Workers
  - Uses `wrangler.jsonc` format with comments
  - TanStack Start/Router + Hono patterns
  - Comprehensive CLAUDE.md and `.claude/settings.local.json`
- **`aibtcdev-cache/`**: Existing aibtcdev CF Worker with Durable Objects

**Universal Logging:**
- **`~/dev/whoabuddy/worker-logs/`**: Centralized logging service for CF Workers
  - Live at: https://logs.wbd.host
  - RPC service binding for internal workers (no API key needed)
  - Per-app isolated SQLite via Durable Objects
  - See [Integration Guide](~/dev/whoabuddy/worker-logs/docs/integration.md)

### x402 Protocol

From the [x402 whitepaper](https://www.x402.org/x402-whitepaper.pdf):

- Client requests resource without payment → Server responds HTTP 402
- Response includes `PaymentRequirements` with accepted networks/tokens
- Client signs and submits payment to facilitator
- Facilitator settles on-chain and returns proof
- Client retries request with payment proof

**Key roles**:
- **Resource Server**: The API or service requiring payment (our relay is the resource)
- **Facilitator**: Handles payment verification and settlement (we relay TO this)
- **Client**: The agent making the request

### Stacks Specifics

- Use **SIP-018** for signed structured data verification
- Transactions require a sponsor signature for fee-less submission
- Stacks.js `sponsorTransaction()` for adding sponsor signature
- Broadcast via Hiro API or direct to node

## Architecture (Draft)

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Agent     │────▶│  Sponsor Relay       │────▶│ x402 Facilitator│
│  (Client)   │     │  (Cloudflare Worker) │     │   (Stacks)      │
└─────────────┘     └──────────────────────┘     └─────────────────┘
      │                       │                          │
      │ 1. POST /relay        │                          │
      │    + signed tx        │                          │
      │    + auth signature   │                          │
      │◀──────────────────────│                          │
      │ 2. 402 Payment Req    │                          │
      │    (if not paid)      │                          │
      │                       │                          │
      │ 3. Retry with payment │                          │
      │─────────────────────▶ │                          │
      │                       │ 4. Sponsor tx            │
      │                       │─────────────────────────▶│
      │                       │ 5. Broadcast             │
      │◀──────────────────────│◀─────────────────────────│
      │ 6. txid               │                          │
```

## API Design (Draft)

### POST /relay

Request:
```json
{
  "transaction": "<hex-encoded-stacks-transaction>",
  "agentId": "stacks:2147483648:identity-registry:0",
  "signature": "<SIP-018-signature>",
  "paymentProof": "<optional-x402-payment-proof>"
}
```

Response (success):
```json
{
  "txid": "0x...",
  "status": "broadcasted"
}
```

Response (payment required):
```
HTTP 402 Payment Required
X-Payment: <payment-requirements>
```

## Open Questions

### Protocol Design

1. **Facilitator location**: Build our own Stacks facilitator or integrate with existing x402 infrastructure?
   - x402 currently supports Base, Solana, Polygon, Avalanche, Sui, Near
   - No existing Stacks facilitator found

2. **Payment token**: What token for sponsorship fees?
   - STX native?
   - aBTC (wrapped Bitcoin)?
   - USDC on Stacks?

3. **Payment timing**: Pre-pay (deposit) or pay-per-transaction?
   - Deposit model: Agent deposits funds, relay deducts per tx
   - Pay-per-tx: x402 flow with 402 response on each request

4. **Settlement**: On-chain or off-chain accounting?
   - Clarity contract for deposits/withdrawals?
   - Or centralized balance tracking?

### Authentication

5. **Agent identity**: How to verify agent is authorized?
   - ERC-8004 identity registry lookup?
   - SIP-018 signature verification?
   - API keys per agent?

6. **Signature message**: What structured data should agents sign?
   - Transaction hash?
   - Nonce + timestamp + tx hash?
   - Full SIP-018 domain separation?

### Operations

7. **Sponsor key management**: How to secure the sponsor private key?
   - Cloudflare Secrets?
   - Multiple keys with rotation?
   - Hardware security module?

8. **Rate limits**: What limits are appropriate?
   - Per agent per hour/day?
   - Global throughput limits?
   - Spending caps in STX/USD?

9. **Monitoring**: What metrics matter?
   - Transactions sponsored
   - Fees paid
   - Agent activity
   - Error rates

### Integration

10. **x402 compatibility**: How closely follow the spec?
    - Full HTTP 402 flow?
    - Simplified version for Stacks?
    - Hybrid approach?

11. **ERC-8004 integration**: Use agent identity registry?
    - Require registered agents only?
    - Or open to any valid Stacks address?

### Learning & Research

12. **Other sponsored tx resources**: What other implementations should we learn from?
    - ALEX SDK sponsored tx service (how does their backend work?)
    - Hiro/Stacks ecosystem examples?
    - Other meta-transaction patterns from EVM?

13. **Logging integration**: Use worker-logs service binding?
    - RPC binding vs HTTP API?
    - What log levels and context for each operation?
    - Request correlation for debugging?

## Next Steps

1. Research existing x402 facilitator implementations
2. Define the minimum viable authentication flow
3. Design the Clarity contract for deposits (if needed)
4. Implement basic relay without 402 flow first
5. Add x402 payment layer

## Resources

### x402 Protocol
- [x402 Protocol](https://www.x402.org/)
- [x402 GitHub](https://github.com/coinbase/x402)
- [x402 Documentation](https://docs.cdp.coinbase.com/x402/welcome)
- [x402 Whitepaper](https://www.x402.org/x402-whitepaper.pdf)

### Stacks
- [SIP-018 Signed Structured Data](https://github.com/stacksgov/sips/blob/main/sips/sip-018/sip-018-signed-structured-data.md)
- [Stacks.js Transactions](https://stacks.js.org/packages/transactions)
- [Hiro API](https://docs.hiro.so/stacks/api)

### Local Resources
- [ERC-8004 Stacks Contracts](../erc-8004-stacks/)
- [ALEX Sponsored Transactions](../agent-tools-ts/src/stacks-alex/)
- [CF Best Practices - Thunder Mountain](~/dev/absorbingchaos/thundermountainbuilders/)
- [Universal Logger](~/dev/whoabuddy/worker-logs/) - https://logs.wbd.host
