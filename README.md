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
  "version": "0.1.0"
}
```

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
console.log(`Transaction: https://explorer.stacks.co/txid/${txid}?chain=testnet`);
console.log(`Settlement status: ${settlement.status}`);
```

## Endpoints

| Environment | URL | Network |
|-------------|-----|---------|
| Staging | https://x402-relay.aibtc.dev | Testnet |
| Production | https://x402-relay.aibtc.com | Mainnet |

## Rate Limits

- 10 requests per minute per sender address
- Rate limiting is based on the transaction sender, not IP

## Development

```bash
# Install dependencies
npm install

# Start local dev server
npm run dev

# Run test script
npm run test:relay -- <private-key> http://localhost:8787

# Type check
npm run check
```

## Related Projects

- [x402 Protocol](https://www.x402.org/) - HTTP-native payment standard
- [x402-stacks](https://github.com/tony1908/x402Stacks) - x402 for Stacks
- [stx402](https://stx402.com) - x402 Stacks implementation

## License

MIT
