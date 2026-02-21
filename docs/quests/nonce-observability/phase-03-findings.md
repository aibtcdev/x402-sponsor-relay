# Phase 3 Findings: BadNonce Root Cause Analysis (Issue #95)

**Date:** 2026-02-21
**Phase:** 3 of nonce-stability quest
**Status:** Root cause confirmed

---

## TL;DR

The root cause is a **nonce leak** in `src/endpoints/relay.ts` at the payment verification step (Step C). When `verifyPaymentParams()` fails after a nonce has already been assigned from NonceDO, the nonce is silently consumed — never released back to the pool and never broadcast. This creates a hole in the nonce sequence that causes subsequent BadNonce rejections.

---

## Incident Data

### The Reported Event (Issue #95)

| Field | Value |
|-------|-------|
| Timestamp | 2026-02-21 ~15:58 UTC (log: 15:59:03) |
| Request ID | `d3ad4e10-faf0-4441-830b-985886737a28` |
| Agent STX | `SP16H0KE0BPR4XNQ64115V5Y1V3XTPGMWG5YPC9TR` (cocoa007 / Fluid Briar) |
| Wallet selected | wallet 0 (`SP1PMPPVCMVW96FSWFV30KJQ4MNBMZ8MRWR3JWQ7`) |
| Nonce assigned | 514 |
| Result | `BadNonce` from broadcast node |

### Log Timeline for Request d3ad4e10

```
15:59:00.892  INFO  Relay request received
15:59:02.795  DEBUG Using NonceDO sponsor nonce {sponsorNonce: "514", walletIndex: 0}
15:59:02.798  INFO  Transaction sponsored {fee: "5000", walletIndex: 0}
15:59:02.805  DEBUG Payment verification succeeded {recipient: "SPKH9...", amount: "100", tokenType: "sBTC"}
15:59:03.105  WARN  Broadcast rejected due to nonce conflict {status: 400, details: "transaction rejected: BadNonce"}
15:59:06.180  INFO  Nonce DO resync completed {walletsChanged: 0, walletCount: 5}
```

Note: the resync reported `walletsChanged: 0` — NonceDO saw no divergence from chain state because the pool head was already past 514.

---

## Nonce 514 Assignment History

Production logs show nonce 514 on wallet 0 was assigned on **three separate occasions**:

| Time (UTC) | Request ID | Outcome |
|-----------|------------|---------|
| 08:02:00 | `035a842e` | Token type mismatch (sBTC vs STX) — `verifyPaymentParams` fails, no broadcast, **nonce leaked** |
| 12:33:27 | `fc904265` | `BadNonce` — broadcast rejected (nonce already ahead on chain) |
| 15:59:02 | `d3ad4e10` | `BadNonce` — broadcast rejected (the #95 incident) |

The first assignment at 08:02 is the root event: nonce 514 was assigned from NonceDO, sponsoring succeeded, but then `verifyPaymentParams()` returned a failure (token type mismatch between sBTC and STX). The relay returned a 400 error **without releasing the nonce back to the pool**.

---

## Root Cause: Missing releaseNonceDO on verifyPaymentParams Failure

### Code Location

`src/endpoints/relay.ts`, lines 316-330 (Step C):

```typescript
// Step C — Verify payment parameters locally
const verifyResult = settlementService.verifyPaymentParams(
  sponsorResult.sponsoredTxHex,
  body.settle
);
if (!verifyResult.valid) {
  c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
  return this.err(c, {                  // <-- RETURNS WITHOUT RELEASING NONCE
    error: verifyResult.error,
    code: "SETTLEMENT_VERIFICATION_FAILED",
    status: 400,
    details: verifyResult.details,
    retryable: false,
  });
}
```

### What Happens After the Leak

1. NonceDO assigns nonce 514 — it moves from `available[]` to `reserved[]`
2. `sponsorTransaction()` signs the tx with nonce 514
3. `verifyPaymentParams()` returns `valid: false` (token type mismatch)
4. Relay returns HTTP 400
5. Nonce 514 stays in `reserved[]` permanently (until 10-minute stale cleanup fires)
6. Pool continues handing out nonces 515, 516, 517... — all broadcast and confirm
7. Meanwhile 514 never appears on chain — it becomes a gap
8. Stale cleanup after 10 min returns 514 to `available[]`
9. Next request gets assigned 514, broadcasts it, but node rejects: `BadNonce` because the chain is already at nonce 515+

### Compare with Broadcast Failure Path (lines 342-350)

The broadcast failure path correctly calls `releaseNonceDO`:

```typescript
if ("error" in broadcastResult) {
  // Release the nonce back to the pool so it can be reused (broadcast failed)
  if (sponsorNonce !== null) {
    c.executionCtx.waitUntil(
      releaseNonceDO(c.env, logger, sponsorNonce, undefined, sponsorWalletIndex)...
    );
  }
```

This same pattern is missing at the `verifyPaymentParams` failure exit.

---

## Why the Alarm Did NOT Self-Heal This

The alarm's gap detection in `reconcileNonceForWallet()` detects gaps via `detected_missing_nonces` from Hiro. A nonce is listed as "missing" by Hiro only when a **higher nonce is in the mempool** with no corresponding lower nonce. If nonce 514 is in `reserved[]` (leaked) and never broadcast, then:

- There is no tx in the mempool for nonce 514
- If subsequent nonces (515+) are confirmed but NOT in mempool, Hiro doesn't flag 514 as missing
- The alarm's gap fill is only triggered when `detected_missing_nonces.length > 0`
- A leaked-then-returned nonce (514 back in available after 10 min) looks "available" to NonceDO but is stale from the chain's perspective

The `gapsFilled: 0` stat in the nonce stats confirms: the alarm never fired a gap-fill for this episode.

---

## Frequency Analysis

From WARN logs on 2026-02-21 and 2026-02-20:
- BadNonce errors occurring approximately every 30-90 minutes
- 46 `conflictsDetected` with 384 total assignments = 12% conflict rate
- This is much higher than expected for a coordinated nonce system

The high rate suggests `verifyPaymentParams` failures are more common than expected, possibly from:
1. Token type mismatches (agent sends sBTC tx but labels it STX, or vice versa)
2. Recipient mismatches
3. Amount below minimum

Each such failure leaks one nonce, and each leaked nonce eventually causes one BadNonce error.

---

## Proposed Fix

In `src/endpoints/relay.ts`, add nonce release to the `verifyPaymentParams` failure path. The sponsored tx nonce is readable from `sponsorResult.sponsoredTxHex`:

```typescript
// Step C — Verify payment parameters locally
const verifyResult = settlementService.verifyPaymentParams(
  sponsorResult.sponsoredTxHex,
  body.settle
);
if (!verifyResult.valid) {
  // Release the nonce back to the pool — we signed but never broadcast, so it can be reused
  const leakedNonce = extractSponsorNonce(
    deserializeTransaction(stripHexPrefix(sponsorResult.sponsoredTxHex))
  );
  if (leakedNonce !== null) {
    c.executionCtx.waitUntil(
      releaseNonceDO(c.env, logger, leakedNonce, undefined, sponsorResult.walletIndex).catch(() => {})
    );
  }

  c.executionCtx.waitUntil(statsService.recordError("validation").catch(() => {}));
  return this.err(c, {
    error: verifyResult.error,
    code: "SETTLEMENT_VERIFICATION_FAILED",
    status: 400,
    details: verifyResult.details,
    retryable: false,
  });
}
```

**Simpler alternative:** Move `extractSponsorNonce` to immediately after Step B (before Step C) since `verifyResult.data.transaction` isn't available yet at this point but the sponsored tx hex is. The nonce is in the sponsor's spending condition within `sponsorResult.sponsoredTxHex`.

---

## Current Nonce Pool State (2026-02-21 ~17:00 UTC)

```
Wallet 0: confirmed=514, pool available=20 (515-534)  -- healthy, past the incident
Wallet 1: confirmed=39,  pool available=20 (40-59)    -- healthy
Wallet 2: confirmed=39,  pool available=20 (40-59)    -- healthy
Wallet 3: confirmed=38,  pool available=20 (39-58)    -- healthy
Wallet 4: confirmed=37,  pool available=17, reserved=1 -- watch: 1 nonce reserved, may be another leak
```

Wallet 4 has `reserved: 1` with `maxNonce=54` but chain only at 37. This means 16 nonces (38-53) should be in mempool or confirmed. If they've already confirmed but the reserved entry is stale (leaked), the stale cleanup will return it within 10 minutes.

---

## Actions Required

1. **Fix (PR):** Add `releaseNonceDO()` call at `verifyPaymentParams` failure exit in `relay.ts`
2. **Verify:** Check if there are other early-return paths in `relay.ts` or `sponsor.ts` that also skip nonce release
3. **Monitor:** Watch wallet 4's reserved count — if it stays at 1 for > 10 minutes, investigate
4. **Consider:** Log a warning when `verifyPaymentParams` fails post-sponsoring, including the nonce being released, so these events are observable in production
