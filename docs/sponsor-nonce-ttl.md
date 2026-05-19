# Sponsor Nonce TTL Contract

## Overview

Every successful `/sponsor` response (and every `/relay` success that includes
`sponsoredTx`) contains two fields that tell consumers exactly how long the
relay will honour the sponsored transaction hex before reclaiming the nonce:

| Field | Type | Description |
|-------|------|-------------|
| `nonceExpiresAt` | `string` (ISO 8601) | UTC timestamp after which the relay **may** reclaim this sponsor nonce. |
| `sponsorNonceValidForMs` | `number` (integer ms) | Duration the nonce remains valid, equal to `STALE_THRESHOLD_MS` (currently `600000` = 10 minutes). |

The two fields are mutually derivable: `nonceExpiresAt ≈ Date.now() + sponsorNonceValidForMs`.
Both are published intentionally — consumers can use whichever representation
fits their retry logic.

## Source Constant

The TTL derives from `STALE_THRESHOLD_MS` in
`src/durable-objects/nonce-do.ts` (line 427). The NonceDO alarm reclaims
sponsor nonces after this interval if no broadcast is recorded. The relay's
`SponsorService` (see `src/services/sponsor.ts`) captures the value at
nonce-assignment time and forwards it through every success path.

A `FALLBACK_NONCE_EXPIRY_MS` constant in `sponsor.ts` mirrors the same value
and is used when the NonceDO does not return an expiry (DO rollout window or
configuration gap). It must stay in sync with `STALE_THRESHOLD_MS`.

## Example Response

```json
{
  "success": true,
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "txid": "0xabc123...",
  "explorerUrl": "https://explorer.hiro.so/txid/0xabc123...",
  "fee": "1250",
  "nonceExpiresAt": "2026-05-18T12:10:00.000Z",
  "sponsorNonceValidForMs": 600000
}
```

## Consumer Contract

**Rule: do NOT retry the same sponsored tx hex past `nonceExpiresAt`.**

Once the relay reclaims the sponsor nonce, rebroadcasting the original hex
will produce a `ConflictingNonceInMempool` error (the nonce is now assigned
to a different transaction). The relay correctly attributes this as a
sponsor-side conflict, but no recovery is possible for the old hex.

The correct recovery action is to call `/sponsor` again with the same inner
client-signed payload — this obtains a fresh sponsor signature on a new
nonce, and the relay returns a new `nonceExpiresAt`.

## Consumer Adoption Checklist

Implement this pattern in any queue or retry loop that calls `/sponsor`:

1. **Read `nonceExpiresAt`** from the `/sponsor` (or `/relay`) response and
   store it alongside the sponsored hex in your queue entry.

2. **Clamp the retry deadline** to `nonceExpiresAt`. Do not schedule a retry
   past this timestamp using the original sponsored hex.

3. **At each retry attempt**, check `Date.now() < Date.parse(nonceExpiresAt)`:
   - **Before expiry** — rebroadcast the original `sponsoredTx` hex as-is.
   - **At or after expiry** — call `/sponsor` with the original
     client-signed (inner) payload to obtain fresh sponsored hex and a new
     `nonceExpiresAt`, then enqueue that instead.

4. **On `/sponsor` failure** during step 3 recovery — retry the `/sponsor`
   call with your queue's existing backoff. Do not fall back to the stale
   sponsored hex.

## Clock-Skew Consideration

The `nonceExpiresAt` timestamp is set by the relay server clock. Consumer
clocks may differ by a few seconds. It is safe to subtract a small buffer
(e.g. 5–10 seconds) from `nonceExpiresAt` when computing the retry deadline
to avoid racing the relay's reclaim alarm.

## Relationship to `/relay`

`/relay` also returns `nonceExpiresAt` (in addition to `sponsoredTx`,
`settlement`, and `receiptId`) because the relay sponsors the transaction
internally. The same TTL contract applies: if you re-submit the same
`sponsoredTx` hex from a `/relay` response past `nonceExpiresAt`, call
`/relay` again with the original client-signed hex to obtain a fresh
sponsorship.

## Field Stability

These fields are considered stable as of the version that introduced them.
`sponsorNonceValidForMs` will only change if `STALE_THRESHOLD_MS` is
changed (which requires a documented operational decision). Consumers should
read the value from the response rather than hardcoding it.
