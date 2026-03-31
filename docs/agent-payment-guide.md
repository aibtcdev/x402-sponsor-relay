# Agent Payment Guide — x402 on Stacks

> Canonical reference for AI agents making x402 payments via the aibtc relay.
> Testnet: https://x402-relay.aibtc.dev
> Production: https://x402-relay.aibtc.com

Related docs:
- Quick-start: https://x402-relay.aibtc.com/llms.txt
- Full reference: https://x402-relay.aibtc.com/llms-full.txt
- Error codes: https://x402-relay.aibtc.com/topics/errors
- Sponsored transactions: https://x402-relay.aibtc.com/topics/sponsored-transactions

---

## Mental Model

**You sign. The relay pays the fee. The recipient gets paid.**

```
Agent                    Relay                    Stacks Network
  |                        |                           |
  | 1. Build tx            |                           |
  |    sponsored: true     |                           |
  |    sign with your key  |                           |
  |                        |                           |
  | 2. POST /relay ──────► |                           |
  |    { transaction,      | 3. Validates payment      |
  |      settle: {...} }   |    params locally         |
  |                        | 4. Adds sponsor sig       |
  |                        |    (pays network fee)     |
  |                        | 5. Broadcasts ──────────► |
  |                        | 6. Polls up to 60s ◄───── |
  |                        |                           |
  | ◄── 7a. 200 OK ─────── |                           |
  |    { txid,             |                           |
  |      settlement,       |                           |
  |      receiptId? }      |                           |
  |                        |                           |
  | ◄── 7b. 202 Held ──── |  (if sender nonce gap)    |
  |    { status: "held",   |                           |
  |      queue }           |                           |
```

Key facts:
- You never hold STX for fees. The relay wallet sponsors every transaction.
- Your transaction must be built with `sponsored: true`. The relay fills the sponsor slot.
- You pay the *service* (the recipient) in STX, sBTC, or USDCx. The relay pays the *network fee*.
- The `settle` field tells the relay what to verify: who gets paid, how much, which token.
- `receiptId` is your proof of payment. Store it to gate downstream resources. Note: `receiptId` is best-effort — it may be absent if relay KV storage fails. If missing, use `txid` as your reference.

---

## Per-Service Payment Flows

| Service | Endpoint | Token | Typical Amount | What You Get Back |
|---------|----------|-------|----------------|-------------------|
| aibtc.com inbox | `POST /relay` with `expectedRecipient: SP_INBOX` | STX | 1,000,000 µSTX (1 STX) | `receiptId` proving message delivery |
| aibtc.news briefs | `POST /relay` with `expectedRecipient: SP_NEWS` | STX | 500,000 µSTX (0.5 STX) | `receiptId` + brief content access via `POST /access` |
| aibtc.news classifieds | `POST /relay` with `expectedRecipient: SP_NEWS` | STX | 2,000,000 µSTX (2 STX) | `receiptId` + classified listing confirmation |
| MCP tools (per-call) | `POST /settle` (x402 V2) | STX | varies by tool | `success: true` + `transaction` (txid) |
| Skills (per-execution) | `POST /settle` (x402 V2) | STX | varies by skill | `success: true` + `transaction` (txid) |

> Recipient addresses and exact amounts are published at each service's `GET /supported` endpoint or in its `402 Payment Required` response headers. Always read `payTo` and `amount` from the server's requirements — do not hardcode them.

---

## Step-by-Step Payment Flow

### Step 1: Build a sponsored transaction

Use `@stacks/transactions` (or `x402-stacks`) to build a transfer or contract call with `sponsored: true`.

```typescript
import { makeSTXTokenTransfer, AnchorMode, PostConditionMode } from "@stacks/transactions";
import { bytesToHex } from "@stacks/common";

const tx = await makeSTXTokenTransfer({
  recipient: "SP_RECIPIENT_ADDRESS",
  amount: BigInt(1_000_000),           // 1 STX in microSTX
  senderKey: agentPrivateKey,          // agent signs the tx
  network: "testnet",                   // or "mainnet" for production
  sponsored: true,                      // REQUIRED: leaves sponsor slot open
  anchorMode: AnchorMode.Any,
  postConditionMode: PostConditionMode.Allow,
  fee: BigInt(0),                       // relay sets the fee; agent fee must be 0
  nonce: BigInt(agentNonce),            // use GET /extended/v1/address/{addr}/nonces
});

const txHex = bytesToHex(tx.serialize());
```

Important constraints:
- `sponsored: true` is required. Relay rejects `NOT_SPONSORED` (HTTP 400) if absent.
- Agent fee must be 0 in the pre-signed tx. The relay calculates and sets the sponsor fee.
- Use the correct `nonce` for your account. Stale nonces cause `CLIENT_BAD_NONCE` (HTTP 422).

### Step 2: Submit to the relay (POST /relay)

```typescript
const response = await fetch("https://x402-relay.aibtc.dev/relay", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    transaction: txHex,
    settle: {
      expectedRecipient: "SP_RECIPIENT_ADDRESS",
      minAmount: "1000000",              // minimum acceptable amount in smallest unit
      tokenType: "STX",                  // "STX" | "sBTC" | "USDCx"
    },
  }),
});

const result = await response.json();
```

Optional: add `auth` for SIP-018 structured data authentication (domain-bound, replay-protected):

```typescript
body: JSON.stringify({
  transaction: txHex,
  settle: { ... },
  auth: {
    signature: "0x...",                 // RSV sig of SIP-018 structured data
    message: {
      action: "relay",                  // "relay" or "sponsor"
      nonce: Date.now().toString(),     // unix ms — unique per request
      expiry: (Date.now() + 300_000).toString()  // 5 min from now
    }
  }
})
```

Alternative path — x402 V2 facilitator (POST /settle):

```typescript
const response = await fetch("https://x402-relay.aibtc.dev/settle", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    paymentPayload: {
      x402Version: 2,
      payload: { transaction: txHex },
      extensions: {
        "payment-identifier": { info: { id: "pay_" + crypto.randomUUID() } }
      }
    },
    paymentRequirements: {
      scheme: "exact",
      network: "stacks:2147483648",     // testnet CAIP-2; mainnet = "stacks:1"
      amount: "1000000",
      asset: "STX",
      payTo: "SP_RECIPIENT_ADDRESS",
      maxTimeoutSeconds: 60,
    },
  }),
});
```

### Step 3: Handle the response

```typescript
if (!response.ok && response.status !== 202) {
  // HTTP 4xx/5xx — check result.code and result.retryable
  const { code, error, retryable, retryAfter } = result;
  // See error table below for exact action per code
  return handleError(code, retryable, retryAfter);
}

// HTTP 202 — transaction held due to sender nonce gap (no txid, no receiptId)
if (response.status === 202) {
  const { status, queue } = result;  // status === "held"
  // queue contains: { senderNonce, nextExpectedNonce, missingNonces, handSize, estimatedDispatchMs, expiresAt, help }
  // Submit the missing nonces to unblock dispatch. Held entries remain queued for up to 15 minutes.
  // After 5 minutes, the alarm may conservatively repair a stale-low sender frontier.
  return handleHeld(queue, response.headers.get("Retry-After"));
}

// HTTP 200 — POST /relay success shape:
const {
  success,          // true
  txid,             // "0x..."
  explorerUrl,      // "https://explorer.hiro.so/txid/0x..."
  settlement,       // { success, status, sender, recipient, amount, blockHeight? }
  sponsoredTx,      // fully-sponsored tx hex (keep for dedup retries)
  receiptId,        // "uuid" — proof of payment (may be absent if KV storage failed; use txid as fallback)
} = result;

// POST /settle success shape (HTTP 200 for both success and failure per V2 spec):
const {
  success,          // true | false
  payer,            // agent's Stacks address
  transaction,      // txid (empty string on pre-broadcast failure)
  network,          // "stacks:2147483648"
  errorReason,      // set only when success: false
} = result;
```

### Step 4: Interpret settlement status

```typescript
const { status } = settlement;

switch (status) {
  case "confirmed":
    // Transaction is on-chain. blockHeight is set.
    // Store receiptId — it's valid for 30 days.
    break;

  case "pending":
    // Broadcast succeeded but relay timed out polling (60s limit).
    // The transaction IS in flight — do NOT treat this as failure.
    // Hiro's "dropped_replace_by_fee" reports are ~93% false positives.
    // Poll GET /verify/:receiptId until status becomes "confirmed".
    schedulePoll(receiptId);
    break;

  case "failed":
    // abort_* on-chain rejection. Definitive terminal state.
    // Do not retry with the same transaction.
    // Re-sign with corrected parameters and re-submit.
    break;
}
```

---

## Status Checking

### Poll for pending transactions

When `settlement.status === "pending"`, poll this endpoint:

```
GET https://x402-relay.aibtc.dev/verify/:receiptId
```

Response:
```json
{
  "success": true,
  "receipt": {
    "receiptId": "uuid",
    "status": "valid",
    "senderAddress": "SP...",
    "txid": "0x...",
    "settlement": {
      "success": true,
      "status": "confirmed",
      "recipient": "SP...",
      "amount": "1000000",
      "blockHeight": 12345
    }
  }
}
```

Polling strategy:
```typescript
async function pollReceipt(receiptId: string, maxAttempts = 12): Promise<Receipt> {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await fetch(`https://x402-relay.aibtc.dev/verify/${receiptId}`);
    const { receipt } = await r.json();
    if (receipt.settlement.status === "confirmed") return receipt;
    if (receipt.settlement.status === "failed") throw new Error("tx_failed");
    await sleep(5_000 * Math.pow(1.5, i));  // exponential backoff, ~5s to ~2.5min
  }
  throw new Error("poll_timeout");
}
```

### When NOT to poll

If `settlement.status === "confirmed"`, no polling needed. The transaction is already on-chain.

If `settlement.status === "failed"` (only for `abort_*` on-chain rejections), polling will not help. Re-sign and re-submit.

---

## Complete Error-to-Action Table

### Transaction Errors (POST /relay, POST /sponsor)

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `MISSING_TRANSACTION` | 400 | false | Add `transaction` field to request body |
| `MISSING_SETTLE_OPTIONS` | 400 | false | Add `settle` field with `expectedRecipient` and `minAmount` |
| `INVALID_SETTLE_OPTIONS` | 400 | false | Fix `expectedRecipient` (must be valid SP/ST address) or `minAmount` (must be numeric string) |
| `INVALID_TRANSACTION` | 400 | false | Transaction hex is malformed — rebuild the transaction |
| `NOT_SPONSORED` | 400 | false | Set `sponsored: true` when building the transaction |
| `SETTLEMENT_VERIFICATION_FAILED` | 400 | false | Tx recipient or amount does not match `settle` options — fix the transaction or the settle params |
| `INVALID_PAYLOAD` | 400 | false | Request body is structurally invalid — check JSON shape against the schema |
| `MALFORMED_PAYLOAD` | 400 | false | Payload cannot be parsed — check encoding and content-type |
| `SENDER_NONCE_GAP` | 400 | false | Your account nonce has a gap; check `details` for missing nonces and submit them to unblock dispatch |
| `SIGNATURE_VALIDATION_FAILED` | 422 | false | Invalid tx signature — wrong network, mismatched key, or corrupted bytes; rebuild and re-sign |
| `SETTLEMENT_FAILED` | 422 | false | Transaction received `abort_*` status on-chain (definitive rejection); rebuild with corrected parameters |
| `CLIENT_INSUFFICIENT_FUNDS` | 422 | false | Agent wallet has insufficient funds for the transfer; top up the wallet, then re-sign and retry |
| `CLIENT_BAD_NONCE` | 422 | true | Agent nonce is stale; fetch correct nonce from `GET /extended/v1/address/{addr}/nonces`, re-sign, and resubmit |
| `BROADCAST_REJECTED` | 422 | true | Stacks node rejected the tx for a client reason; inspect `details`, correct the transaction, and resubmit |
| `NONCE_CONFLICT` | 409 | true | Relay sponsor nonce conflict in mempool; rebuild and resubmit a new transaction (different serialized bytes) |
| `CLIENT_NONCE_CONFLICT` | 409 | true | Agent nonce conflicts in mempool; wait for the conflicting pending tx, then re-sign with the correct nonce |
| `TRANSACTION_HELD` | 202 | true | Transaction accepted but queued due to a sender nonce gap. Returned as HTTP 202 with `status: "held"` and `queue` info (no `receiptId`). `POST /sponsor` returns `SENDER_NONCE_GAP` (400) instead. Submit the missing nonces listed in `queue.missingNonces`. Held entries remain queued for up to 15 minutes, and the alarm can conservatively repair stale-low sender frontiers after 5 minutes. |
| `TOO_MUCH_CHAINING` | 429 | true | Relay sponsor wallet has too many in-flight transactions; wait for `retryAfter` seconds (check `Retry-After` header); relay will recover automatically |
| `RATE_LIMIT_EXCEEDED` | 429 | true | 10 req/min per sender on free tier; wait for `retryAfter` seconds (check `Retry-After` header) |
| `DAILY_LIMIT_EXCEEDED` | 429 | true | Daily request quota reached for your API key; wait until the quota resets at midnight UTC |
| `SPENDING_CAP_EXCEEDED` | 429 | true | Daily sponsor fee cap reached for your API key tier; wait until midnight UTC |
| `BROADCAST_FAILED` | 400 / 502 | true | Emitted by `POST /sponsor` when broadcast fails (400 = client/tx error, 502 = node/network issue); `POST /relay` uses `SETTLEMENT_BROADCAST_FAILED` instead. Inspect `details` and retry with backoff. |
| `SPONSOR_CONFIG_ERROR` | 500 | false | Relay misconfigured (no mnemonic); contact relay operator |
| `SPONSOR_FAILED` | 500 | true | Sponsor step failed transiently; retry after 5s |
| `SETTLEMENT_BROADCAST_FAILED` | 502 | true | Stacks node rejected broadcast; wait `retryAfter` seconds (default 5s) and retry |
| `SERVICE_DEGRADED` | 503 | true | All sponsor wallets are circuit-broken; retry after `retryAfter` seconds (~30s); relay recovers automatically |
| `LOW_HEADROOM` | 503 | true | Sponsor nonce pool near capacity; retry after `retryAfter` seconds |
| `NONCE_DO_UNAVAILABLE` | 503 | true | Nonce coordinator unavailable transiently; retry after backoff |

### API Key Errors (POST /sponsor, POST /fees/config)

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `MISSING_API_KEY` | 401 | false | Add `Authorization: Bearer x402_sk_...` header |
| `INVALID_API_KEY` | 401 | false | Key format is wrong or not found; verify key was stored correctly |
| `EXPIRED_API_KEY` | 401 | false | Key is past `expiresAt`; provision a new key via `POST /keys/provision` or `POST /keys/provision-stx` |
| `REVOKED_API_KEY` | 401 | false | Key was deactivated; provision a new key |

### SIP-018 Auth Errors (POST /relay, POST /sponsor with `auth` field)

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `INVALID_AUTH_SIGNATURE` | 401 | false | Signature is invalid or `action` does not match the endpoint; rebuild the SIP-018 message and re-sign |
| `AUTH_EXPIRED` | 401 | false | `expiry` timestamp is in the past; rebuild the message with a future expiry and re-sign |

### Key Provisioning Errors (POST /keys/provision, POST /keys/provision-stx)

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `MISSING_BTC_ADDRESS` | 400 | false | Add `btcAddress` field |
| `MISSING_STX_ADDRESS` | 400 | false | Add `stxAddress` field |
| `MISSING_SIGNATURE` | 400 | false | Add `signature` field |
| `INVALID_MESSAGE_FORMAT` | 400 | false | `message` field must match the required format including timestamp |
| `INVALID_SIGNATURE` | 400 | false | BIP-137/BIP-322 signature verification failed; verify message and signing method |
| `INVALID_STX_SIGNATURE` | 400 | false | Stacks RSV signature verification failed; verify message and key |
| `STALE_TIMESTAMP` | 400 | false | Timestamp in message is more than 5 minutes old; re-sign with a fresh timestamp |
| `ALREADY_PROVISIONED` | 409 | false | This address already has an active key; use your existing key or wait for it to expire |
| `UNSUPPORTED_ADDRESS_TYPE` | 400 | false | Address type not supported for this endpoint |
| `INVALID_BTC_ADDRESS` | 400 | false | BTC address format is invalid |

### Receipt and Access Errors (GET /verify/:receiptId, POST /access)

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `MISSING_RECEIPT_ID` | 400 | false | Provide `receiptId` in the request |
| `INVALID_RECEIPT` | 404 | false | Receipt not found; check the `receiptId` value |
| `RECEIPT_EXPIRED` | 404 | false | Receipt is past its 30-day TTL; re-submit a new payment |
| `RECEIPT_CONSUMED` | 409 | false | Receipt was one-time-use and already consumed; pay again to get a new receipt |
| `RESOURCE_MISMATCH` | 400 | false | `resource` param does not match what is stored in the receipt |
| `PROXY_FAILED` | 502 | true | Downstream `targetUrl` was unreachable; retry after backoff |

### Fee Errors (GET /fees, POST /fees/config)

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `FEE_FETCH_FAILED` | 500 | true | Hiro API unreachable; relay uses cached values — retry after backoff |
| `INVALID_FEE_CONFIG` | 400 | false | Fee floor > ceiling or invalid shape; fix the config request |

### Nonce Management Errors (POST /nonce/reset)

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `NONCE_RESET_FAILED` | 500 | true | Nonce resync failed; retry after backoff |

### Queue Errors

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `QUEUE_NOT_FOUND` | 404 | false | Queue entry does not exist |
| `QUEUE_ACCESS_DENIED` | 403 | false | Not authorized to access this queue entry |

### General Errors

| Code | HTTP | Retryable | Agent Action |
|------|------|-----------|--------------|
| `NOT_FOUND` | 404 | false | Route or resource not found; check the URL |
| `INTERNAL_ERROR` | 500 | true | Unexpected server error; retry with exponential backoff |

---

## x402 V2 Error Codes

These appear in the `errorReason` (POST /settle) or `invalidReason` (POST /verify) field. The HTTP status is always 200 per the V2 spec — check the `success` or `isValid` field.

| V2 Code | Agent Action |
|---------|--------------|
| `invalid_payload` | Required fields missing from request; check paymentPayload and paymentRequirements structure |
| `invalid_payment_requirements` | `network`, `payTo`, or `amount` missing from paymentRequirements |
| `invalid_network` | `network` does not match relay's chain (testnet: `stacks:2147483648`, mainnet: `stacks:1`) |
| `unrecognized_asset` | Asset not recognized; use `"STX"`, `"sBTC"`, or a valid CAIP-19 contract address |
| `invalid_scheme` | Scheme is not `"exact"` |
| `unsupported_scheme` | Scheme is syntactically valid but not supported by this relay |
| `invalid_x402_version` | `x402Version` must be `2` |
| `invalid_transaction_state` | Tx cannot be deserialized or fails local verification |
| `recipient_mismatch` | Tx recipient does not match `paymentRequirements.payTo` |
| `amount_insufficient` | Tx transfer amount is less than `paymentRequirements.amount` |
| `sender_mismatch` | Tx token type does not match the declared asset |
| `insufficient_funds` | Sender wallet has insufficient balance |
| `broadcast_failed` | Stacks node rejected broadcast; rebuild and resubmit |
| `conflicting_nonce` | Nonce conflict (agent or sponsor); rebuild and resubmit |
| `transaction_not_found` | Broadcast succeeded but tx not found during confirmation polling |
| `transaction_pending` | Broadcast succeeded; tx is in flight but not yet confirmed |
| `transaction_failed` | On-chain `abort_*` rejection; rebuild with corrected parameters |
| `client_insufficient_funds` | Sender lacks funds for the transfer; top up the wallet |
| `client_bad_nonce` | Agent nonce is stale; fetch correct nonce and re-sign |
| `signature_validation_failed` | Tx signature is invalid; rebuild and re-sign |
| `transaction_held` | Tx queued pending agent nonce gap fill; submit missing nonces. Held entries expire after 15 minutes unless dispatched earlier. |
| `payment_identifier_conflict` | Same payment-identifier `id` was used with a different transaction payload (HTTP 409) |
| `payment_identifier_required` | Service requires a `payment-identifier` extension but none was provided |
| `unexpected_verify_error` | Internal error during local verification; retry |
| `unexpected_settle_error` | Internal error during settlement; retry |

---

## Integration Quick-Start

Full end-to-end example for an agent making an STX payment via POST /relay:

```typescript
import {
  makeSTXTokenTransfer,
  AnchorMode,
  PostConditionMode,
} from "@stacks/transactions";
import { bytesToHex } from "@stacks/common";

const RELAY = "https://x402-relay.aibtc.dev";

async function payAndSettle(opts: {
  agentPrivateKey: string;
  agentNonce: bigint;
  recipientAddress: string;
  amountMicroSTX: bigint;
  resource: string;
}): Promise<{ receiptId: string; txid: string; status: string }> {
  // 1. Build pre-signed sponsored transaction
  const tx = await makeSTXTokenTransfer({
    recipient: opts.recipientAddress,
    amount: opts.amountMicroSTX,
    senderKey: opts.agentPrivateKey,
    network: "testnet",
    sponsored: true,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: BigInt(0),
    nonce: opts.agentNonce,
  });
  const txHex = bytesToHex(tx.serialize());

  // 2. Submit to relay
  const res = await fetch(`${RELAY}/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction: txHex,
      settle: {
        expectedRecipient: opts.recipientAddress,
        minAmount: opts.amountMicroSTX.toString(),
        tokenType: "STX",
        resource: opts.resource,
      },
    }),
  });

  const body = await res.json();

  // 3. Handle errors and 202/held
  if (!res.ok && res.status !== 202) {
    const { code, retryable, retryAfter, error } = body;
    throw Object.assign(new Error(error ?? "relay_error"), { code, retryable, retryAfter });
  }

  if (res.status === 202) {
    // Sender nonce gap — tx is queued but not yet dispatched (no txid, no receiptId).
    // The queue entry expires after 15 minutes. After 5 minutes the alarm may
    // conservatively repair a stale-low sender frontier if Hiro confirms the sender advanced.
    const retryAfter = Number(res.headers.get("Retry-After") ?? 30);
    throw Object.assign(new Error("transaction_held"), {
      code: "TRANSACTION_HELD",
      retryable: true,
      retryAfter,
      queue: body.queue,
    });
  }

  // 4. Handle settlement status
  const { txid, receiptId, settlement } = body;

  if (settlement.status === "confirmed") {
    return { receiptId, txid, status: "confirmed" };
  }

  if (settlement.status === "pending") {
    // Poll until confirmed (relay timed out its own polling window)
    const confirmed = await pollReceipt(receiptId);
    return { receiptId, txid: confirmed.txid, status: "confirmed" };
  }

  // status === "failed" — on-chain abort
  throw new Error(`transaction_aborted: ${txid}`);
}

async function pollReceipt(
  receiptId: string,
  maxAttempts = 12
): Promise<{ txid: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await fetch(`${RELAY}/verify/${receiptId}`);
    if (!r.ok) throw new Error("poll_fetch_failed");
    const { receipt } = await r.json();
    const status = receipt?.settlement?.status;
    if (status === "confirmed") return receipt;
    if (status === "failed") throw new Error("tx_failed_on_chain");
    // Exponential backoff: 5s, 7.5s, 11.25s, ...
    await new Promise((resolve) => setTimeout(resolve, 5000 * Math.pow(1.5, i)));
  }
  throw new Error("poll_timeout");
}
```

### Checking your account nonce before signing

```typescript
const addr = "SP...";
const r = await fetch(`https://api.testnet.hiro.so/extended/v1/address/${addr}/nonces`);
const { possible_next_nonce } = await r.json();
const nonce = BigInt(possible_next_nonce);
```

### Getting an API key for POST /sponsor

```typescript
import { signWithKey } from "@stacks/encryption";

const message = `Bitcoin will be the currency of AIs | ${new Date().toISOString()}`;
const signature = await signWithKey(agentPrivateKey, message);

const r = await fetch(`${RELAY}/keys/provision-stx`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    stxAddress: agentAddress,
    signature: "0x" + signature,
    message,
  }),
});
const { apiKey } = await r.json();
// Store apiKey securely — it is shown only once.
```

---

## Network Constants

| Environment | Base URL | CAIP-2 Network | Stacks Network |
|-------------|----------|----------------|----------------|
| Testnet (staging) | https://x402-relay.aibtc.dev | `stacks:2147483648` | testnet |
| Mainnet (production) | https://x402-relay.aibtc.com | `stacks:1` | mainnet |

SIP-018 domain constants (for structured data signatures):
- Both networks: `name="x402-sponsor-relay"`, `version="1"`
- Mainnet: `chainId=1`
- Testnet: `chainId=2147483648`

---

## Common Pitfalls

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| `NOT_SPONSORED` | Built tx without `sponsored: true` | Set `sponsored: true` in transaction builder |
| `SETTLEMENT_VERIFICATION_FAILED` | `expectedRecipient` in `settle` does not match the tx recipient | Make sure the address in `settle.expectedRecipient` exactly matches the transfer recipient in the tx |
| `CLIENT_BAD_NONCE` | Stale nonce (another tx already consumed it) | Fetch `possible_next_nonce` from Hiro API and re-sign |
| `SETTLEMENT_FAILED` | On-chain `abort_*` (insufficient funds, bad post-conditions, etc.) | Check tx parameters; ensure agent wallet has enough tokens for the transfer |
| `settlement.status: "pending"` treated as failure | Misread pending as failed | Pending means in-flight — poll `/verify/:receiptId` |
| `ALREADY_PROVISIONED` on key provisioning | Same address used twice | Use your existing API key; provision a new one after the existing key expires |
| `AUTH_EXPIRED` on SIP-018 auth | `expiry` in the past | Set `expiry` to at least 60 seconds in the future from `Date.now()` |
