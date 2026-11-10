# Agent Payment Guide — x402 on Stacks

> Canonical reference for AI agents making x402 payments through the aibtc relay.
> Testnet: https://x402-relay.aibtc.dev
> Production: https://x402-relay.aibtc.com

Related docs:
- Quick-start: https://x402-relay.aibtc.com/llms.txt
- Full reference: https://x402-relay.aibtc.com/llms-full.txt
- x402 V2 facilitator: https://x402-relay.aibtc.com/topics/x402-v2-facilitator
- Error codes: https://x402-relay.aibtc.com/topics/errors

---

## Mental Model

**You sign and pay your own STX fee. The relay verifies and broadcasts. The recipient gets paid.**

```
Agent                         Relay                       Stacks Network
  |                             |                              |
  | 1. Build a self-paid tx     |                              |
  |    (standard auth, fee > 0) |                              |
  |                             |                              |
  | 2. POST /settle ──────────► | 3. Verify payTo / amount /   |
  |    { paymentPayload,        |    asset locally             |
  |      paymentRequirements }  | 4. Broadcast ──────────────► |
  |                             |                              |
  | ◄── 5. 200 { success,       |    (confirmation is tracked  |
  |       transaction: txid }   |     in the background)       |
```

Key facts:
- Your wallet pays the network fee. Build a **standard** transaction (do not set `sponsored: true`) with a non-zero fee. See `GET /fees` for estimates.
- **Public sponsorship has been removed.** `POST /relay` no longer exists (404), and `POST /settle` does not sponsor: a transaction with an empty sponsor slot (`sponsored: true`, fee 0) is refused with `errorReason: "invalid_transaction_state"`.
- Relay-paid fees exist only for aibtc.com's own worker over a Cloudflare service binding (`RelayRPC.sponsorPayment` / `submitPayment`). They are not reachable over HTTP.
- You pay the *service* (the recipient) in STX, sBTC, or USDCx. `paymentRequirements` tells the relay what to verify: who gets paid, how much, which token.
- `POST /settle` returns once the node accepts the broadcast. A `success: true` response means "broadcast", not "confirmed".

Always read `payTo`, `amount`, `asset` and `network` from the resource server's `402 Payment Required` response. Do not hardcode them.

---

## Step-by-Step Payment Flow

### Step 1: Build a self-paid transaction

```typescript
import { makeSTXTokenTransfer } from "@stacks/transactions";

const tx = await makeSTXTokenTransfer({
  recipient: paymentRequirements.payTo,
  amount: BigInt(paymentRequirements.amount), // smallest unit (microSTX for STX)
  senderKey: agentPrivateKey,
  network: "testnet",                          // "mainnet" for production
  fee: BigInt(feeMicroStx),                    // non-zero; see GET /fees
  nonce: BigInt(agentNonce),                   // see "Account nonce" below
  // do NOT set sponsored: true
});

const txHex = tx.serialize(); // hex string
```

For sBTC or USDCx, build a SIP-010 `transfer` contract call to `payTo` instead; the same self-paid rules apply.

### Step 2 (optional): POST /verify

Local validation only, nothing is broadcast. Same request body as `/settle`.

```json
{ "isValid": true, "payer": "SP..." }
{ "isValid": false, "invalidReason": "recipient_mismatch" }
```

`/verify` checks recipient, amount and asset. It does **not** check the sponsor slot, so a transaction with an empty sponsor slot can pass `/verify` and still be refused by `/settle`.

### Step 3: POST /settle

```typescript
const RELAY = "https://x402-relay.aibtc.dev";

const res = await fetch(`${RELAY}/settle`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    x402Version: 2, // optional
    paymentPayload: {
      x402Version: 2,
      payload: { transaction: txHex },
      // optional, see "Idempotency" below
      extensions: { "payment-identifier": { info: { id: "pay_" + crypto.randomUUID() } } },
    },
    paymentRequirements: {
      scheme: "exact",
      network: "stacks:2147483648", // testnet; mainnet = "stacks:1"
      amount: "1000000",
      asset: "STX",                 // "STX" | "sBTC" | CAIP-19 contract id
      payTo: "SP_RECIPIENT_ADDRESS",
      maxTimeoutSeconds: 60,
    },
  }),
});
const result = await res.json();
```

### Step 4: Handle the response

Per the x402 V2 spec, settlement outcomes come back as **HTTP 200** — check `success`, not the status code.

```json
// Success
{ "success": true, "payer": "SP...", "transaction": "0x<txid>", "network": "stacks:2147483648" }

// Failure (transaction is "" when nothing was broadcast)
{ "success": false, "errorReason": "recipient_mismatch", "transaction": "", "network": "stacks:2147483648" }
```

Other HTTP statuses:
- `400` — malformed request (`invalid_payload`, `invalid_payment_requirements`, `invalid_scheme`, `invalid_network`, `unrecognized_asset`).
- `409` — `payment_identifier_conflict` (same id, different payload).
- `500` — `unexpected_settle_error`; retry with backoff.

Present the txid (`transaction`) to the resource server as proof of payment.

### Step 5 (optional): Track confirmation

```
GET /settle/status/:txid          # relay's record: broadcast | pending | confirmed | failed
GET /settle/status/:txid?live=true # also fetches the live Hiro status
```

You can also query the Stacks API directly. Hiro's `dropped_replace_by_fee` status is usually transient (most such transactions confirm); only `abort_*` is a definitive on-chain rejection.

---

## Idempotency and Retries

- **Same tx hex within 5 minutes** returns the cached result (same txid), so resending the identical signed hex after a network error is safe. Note that this cache hit is returned *before* `paymentRequirements` are checked, so it only tells you that this hex was settled — not that it satisfies a different `payTo`/`amount`.
- **payment-identifier** (`paymentPayload.extensions["payment-identifier"].info.id`, 16–128 chars, `[a-zA-Z0-9_-]+`, `pay_` prefix recommended):
  - same id + same payload → cached `200` response, no re-broadcast;
  - same id + different payload (rebuilt tx) → `409 payment_identifier_conflict`. This blocks an accidental double payment. If you really mean to send a different transaction, use a new id;
  - only successful settles are cached (5 minutes).
- **Retrying the same payment means resending the same signed hex.** Never re-sign the same payment at a new nonce: if the first transaction is still in the mempool, both can confirm and you pay twice. If you must rebuild (for example a higher fee), keep the **same nonce** so only one of the two can confirm.

### Account nonce

```typescript
const r = await fetch(`https://api.testnet.hiro.so/extended/v1/address/${addr}/nonces`);
const { possible_next_nonce } = await r.json();
```

---

## x402 V2 Error Codes (POST /settle, POST /verify)

`/settle` returns these in `errorReason`, `/verify` in `invalidReason`.

HTTP status: `/verify` always answers HTTP 200. `/settle` answers HTTP 200 for every code except the request-validation codes (`invalid_payload`, `invalid_payment_requirements`, `invalid_scheme`, `invalid_network`, `unrecognized_asset`), which come back as HTTP 400, plus `payment_identifier_conflict` (409) and `unexpected_settle_error` (500). Always check `success` / `isValid` rather than the status code alone.

| Code | Endpoint | Agent Action |
|------|----------|--------------|
| `invalid_payload` | both | Body is not JSON, `paymentPayload`/`paymentRequirements` or `payload.transaction` is missing, or the payment-identifier is malformed |
| `invalid_payment_requirements` | both | `network`, `payTo`, `amount` or `asset` missing |
| `invalid_scheme` | both | `scheme` is set and is not `"exact"` |
| `invalid_network` | both | `network` does not match the relay (testnet `stacks:2147483648`, mainnet `stacks:1`) |
| `unrecognized_asset` | both | Use `"STX"`, `"sBTC"`, or a supported CAIP-19 contract id |
| `invalid_transaction_state` | both | Tx hex is malformed or cannot be verified. On `/settle` it also means the tx has an **empty sponsor slot** — build a self-paid tx |
| `recipient_mismatch` | both | Tx recipient must exactly match `payTo` |
| `amount_insufficient` | both | Tx amount is below `amount` |
| `unsupported_scheme` | both | Tx token does not match `asset` (e.g. an STX transfer against `asset: "sBTC"`) |
| `payment_identifier_conflict` | both | HTTP 409: same payment-identifier used with a different payload |
| `unexpected_verify_error` | `/verify` | Internal error; retry |
| `client_insufficient_funds` | `/settle` | Wallet cannot cover the transfer plus fee; top up, then re-sign |
| `client_bad_nonce` | `/settle` | Nonce is stale; fetch `possible_next_nonce` and re-sign |
| `signature_validation_failed` | `/settle` | Wrong network, wrong key, or corrupted bytes; rebuild and re-sign |
| `conflicting_nonce` | `/settle` | A transaction with this nonce is already in the mempool. If it is this same payment, wait — do not re-sign at a new nonce |
| `broadcast_failed` | `/settle` | Transient node/network failure; retry with backoff by resending the **same signed hex** |
| `transaction_failed` | `/settle` | The node rejected the tx for a non-retryable reason (e.g. `FeeTooLow`). This also covers **too many pending txs from your address** (`TooMuchChaining`): wait for your earlier txs to confirm, then resend the same hex — do not re-sign at a new nonce |
| `unexpected_settle_error` | `/settle` | HTTP 500 internal error; retry with backoff |

---

## POST /sponsor (API key)

`POST /sponsor` still sponsors and broadcasts a transaction directly, with **no payment verification**. It requires an API key (`Authorization: Bearer x402_sk_...`). Use it only when you hold a key and want the relay to pay the fee for a non-payment transaction.

Build the transaction with `sponsored: true` and `fee: 0` (the relay sets the sponsor fee):

```typescript
const tx = await makeSTXTokenTransfer({
  recipient: "SP...",
  amount: 1_000_000n,
  senderKey: agentPrivateKey,
  network: "testnet",
  sponsored: true,
  fee: 0n,
  nonce: BigInt(agentNonce),
});

const res = await fetch(`${RELAY}/sponsor`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ transaction: tx.serialize() }),
});
// 200: { success: true, requestId, txid, explorerUrl, fee }
```

Optional SIP-018 `auth` field (`action: "sponsor"`): see https://x402-relay.aibtc.com/topics/authentication.

`GET /status/sponsor` reports whether the payment sponsor wallet behind `/sponsor` can take a transaction now (`canSponsor`, `reasons`). Check it if you get `SPONSOR_EXHAUSTED`.

### /sponsor error codes

Errors use the shape `{ success: false, requestId, error, code, details?, retryable, retryAfter? }`; `retryAfter` is also sent as a `Retry-After` header.

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `MISSING_API_KEY` / `INVALID_API_KEY` | 401 | false | Send a valid `Authorization: Bearer x402_sk_...` header |
| `EXPIRED_API_KEY` / `REVOKED_API_KEY` | 401 | false | Provision a new key |
| `INVALID_AUTH_SIGNATURE` | 401 | false | SIP-018 signature invalid or `action` is not `"sponsor"`; re-sign |
| `AUTH_EXPIRED` | 401 | false | SIP-018 `expiry` is in the past; re-sign with a future expiry |
| `MISSING_TRANSACTION` | 400 | false | Add the `transaction` field |
| `MALFORMED_PAYLOAD` | 400 | false | Tx hex cannot be parsed (repeated malformed payloads get the IP blocked with `RATE_LIMIT_EXCEEDED`, `retryAfter: 600`) |
| `INVALID_TRANSACTION` | 400 | false | Tx is invalid; rebuild it |
| `NOT_SPONSORED` | 400 | false | `/sponsor` needs `sponsored: true` |
| `SENDER_NONCE_GAP` | 400 | false | Your nonce is ahead of the chain; submit the missing nonces first |
| `CLIENT_BAD_NONCE` | 422 | true | Nonce already used; fetch `possible_next_nonce`, re-sign, resubmit |
| `CLIENT_INSUFFICIENT_FUNDS` | 422 | false | Wallet cannot cover the transfer; top up, then re-sign |
| `SIGNATURE_VALIDATION_FAILED` | 422 | false | Wrong network, wrong key, or corrupted bytes; rebuild and re-sign |
| `BROADCAST_REJECTED` | 422 | true | Node rejected the tx for another client reason; inspect `details`, correct, resubmit |
| `CLIENT_NONCE_CONFLICT` | 409 | true | You already have a pending tx at this nonce; wait for it to confirm or drop. If this request retries that same payment (e.g. after a `BROADCAST_FAILED` 502), resend the **same signed hex**; do not re-sign it at a new nonce, or both can confirm. Sign at the next nonce only for a different payment |
| `RATE_LIMIT_EXCEEDED` | 429 | true | Per-key request rate exceeded; wait `retryAfter` |
| `DAILY_LIMIT_EXCEEDED` | 429 | true | Daily request quota reached; resets at midnight UTC |
| `SPENDING_CAP_EXCEEDED` | 429 | true | Daily sponsor-fee cap for your tier reached; resets at midnight UTC |
| `TOO_MUCH_CHAINING` | 429 | true | Sponsor wallet congested, or too many pending txs from your address; wait `retryAfter` (30s) |
| `BROADCAST_FAILED` | 400 / 502 | 400: false, 502: true | 400 = the node rejected the tx for a client reason. 502 = node/network issue or unclear outcome; the node may still hold the tx. Retry with backoff by resending the **same signed hex** (the relay returns the earlier txid if it landed). Do not re-sign the same payment at a new nonce, or both can confirm |
| `SPONSOR_EXHAUSTED` | 503 | true | Sponsor wallet low on STX or its daily budget is spent; wait `retryAfter`, check `GET /status/sponsor` |
| `SPONSOR_CONFIG_ERROR` | 500 | false | Relay misconfigured; contact the operator |
| `INTERNAL_ERROR` | 500 | true | Unexpected error; retry with backoff |

Rate limits by tier: free 10/min, 100/day, 100 STX/day fee cap; standard 60/min, 10,000/day, 1,000 STX/day; unlimited has no limits.

---

## API Keys

Provision a free-tier key (30-day expiry) by signing a message with your own key. One key per address.

```typescript
import { hashMessage, signMessageHashRsv } from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";

const message = `Bitcoin will be the currency of AIs | ${new Date().toISOString()}`;
const signature = signMessageHashRsv({
  messageHash: bytesToHex(hashMessage(message)),
  privateKey: agentPrivateKey,
}).data;

const r = await fetch(`${RELAY}/keys/provision-stx`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ stxAddress: agentAddress, signature, message }),
});
const { apiKey } = await r.json(); // shown only once — store it securely
```

`POST /keys/provision` does the same with a Bitcoin address and a BIP-137/BIP-322 signature (`btcAddress`, `signature`, `message`). Details: https://x402-relay.aibtc.com/topics/api-keys.

| Code | HTTP | Agent Action |
|------|------|--------------|
| `MISSING_BTC_ADDRESS` / `MISSING_STX_ADDRESS` / `MISSING_SIGNATURE` | 400 | Add the missing field |
| `INVALID_MESSAGE_FORMAT` | 400 | `message` must match the required format |
| `INVALID_SIGNATURE` / `INVALID_STX_SIGNATURE` | 400 | Signature does not verify; check message and signing method |
| `STALE_TIMESTAMP` | 400 | Timestamp older than 5 minutes; re-sign with a fresh one |
| `INVALID_BTC_ADDRESS` / `UNSUPPORTED_ADDRESS_TYPE` | 400 | Use a supported, valid address |
| `ALREADY_PROVISIONED` | 409 | This address already has a key; use it |

---

## Receipts (legacy, read-only)

Receipts were issued by the former `POST /relay`. Existing receipts (30-day TTL) remain readable; **no new receipts are created**, and `/settle` does not issue them.

- `GET /verify/:receiptId` — receipt status. `404 NOT_FOUND` if unknown or expired.
- `POST /access` `{ receiptId, resource?, targetUrl? }` — one-time use of a receipt to reach a resource.

| Code | HTTP | Agent Action |
|------|------|--------------|
| `MISSING_RECEIPT_ID` | 400 | Provide `receiptId` |
| `NOT_FOUND` | 404 | Receipt unknown or expired |
| `RECEIPT_CONSUMED` | 400 | Receipt already used |
| `RESOURCE_MISMATCH` | 400 | `resource` does not match the receipt |
| `INVALID_RECEIPT` | 400 | `targetUrl` invalid, not HTTPS, or points at an internal host |
| `PROXY_FAILED` | 502 | Downstream unreachable or non-2xx; retry after backoff |

---

## Fees

`GET /fees` (no auth) returns clamped fee estimates in microSTX for `token_transfer`, `contract_call` and `smart_contract`, each with `low_priority` / `medium_priority` / `high_priority`. Use them to pick the fee for a self-paid transaction. `source` is `hiro`, `cache` or `default` (fallback when Hiro is unreachable). `FEE_FETCH_FAILED` (500) is an unexpected error; retry after backoff.

---

## Network Constants

| Environment | Base URL | CAIP-2 Network | Stacks Network |
|-------------|----------|----------------|----------------|
| Testnet (staging) | https://x402-relay.aibtc.dev | `stacks:2147483648` | testnet |
| Mainnet (production) | https://x402-relay.aibtc.com | `stacks:1` | mainnet |

`GET /supported` returns `{ kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: ["payment-identifier"], signers: { "stacks:*": [] } }`. `signers` is empty because `/settle` does not co-sign: there is no fee payer to put in a 402's `extra.feePayer`.

SIP-018 domain (for the optional `/sponsor` auth): `name="x402-sponsor-relay"`, `version="1"`, `chainId=1` (mainnet) or `2147483648` (testnet).

---

## Common Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `404` on `POST /relay` | Endpoint removed | Build a self-paid tx and use `POST /settle` |
| `invalid_transaction_state` on `/settle` with a tx that passed `/verify` | Tx built with `sponsored: true`, fee 0 | Build a standard tx with a non-zero fee |
| `recipient_mismatch` | Tx recipient differs from `payTo` | Use `payTo` exactly as given in the 402 response |
| `unsupported_scheme` | Token in tx differs from `asset` | Transfer the asset the server asked for |
| `client_bad_nonce` / `CLIENT_BAD_NONCE` | Stale nonce | Fetch `possible_next_nonce` and re-sign |
| Paid twice | Re-signed the same payment at a new nonce after a timeout or error | Resend the same signed hex; if you must rebuild, keep the same nonce |
| `payment_identifier_conflict` | Reused an id with a rebuilt tx | Resend the original hex, or use a new id for a genuinely new payment |
