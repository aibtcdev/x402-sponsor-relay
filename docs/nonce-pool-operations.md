# Nonce Pool Operations Guide

Operational reference for the x402-sponsor-relay nonce management system. Covers the caller retry contract, pool health monitoring, manual recovery, and capacity planning.

---

## Architecture Overview

The relay uses a pool of sponsor wallets to sign and broadcast Stacks transactions on behalf of callers. Each wallet maintains its own nonce sequence. A Durable Object (`NonceDO`) coordinates assignment across all wallets.

**Default configuration (all environments):**

| Parameter | Value | Env var |
|-----------|-------|---------|
| Wallet count | 10 | `SPONSOR_WALLET_COUNT` |
| Max in-flight per wallet | 20 | hardcoded `CHAINING_LIMIT` |
| Total pool capacity | 200 concurrent nonces | `walletCount × 20` |
| Alarm interval (active) | 60s | `ALARM_INTERVAL_ACTIVE_MS` |
| Alarm interval (idle) | 5 min | `ALARM_INTERVAL_IDLE_MS` |
| Stale assignment threshold | 10 min | `STALE_THRESHOLD_MS` |
| RBF fee | 90,000 uSTX | `RBF_FEE` |
| Gap-fill fee | 30,000 uSTX | `GAP_FILL_FEE` |
| Max gap-fills per alarm cycle | 5 per wallet | `MAX_GAP_FILLS_PER_ALARM` |
| Stuck tx age before RBF | 15 min | `STUCK_TX_AGE_MS` |
| Max RBF attempts per nonce | 3 | `MAX_RBF_ATTEMPTS` |

**Wallet assignment:** round-robin across initialized wallets. Each wallet has independent nonce state and circuit breakers.

---

## Nonce Lifecycle

```
                    ┌──────────────────────────────────────────┐
                    │              NonceDO Ledger               │
                    │                                           │
  /relay request    │  assign ──► broadcasted ──► confirmed     │
  ──────────────►   │    │                                      │
                    │    ├──► conflict  (ConflictingNonceInMempool)
                    │    ├──► failed    (other broadcast error)  │
                    │    └──► expired   (not broadcast in 10min) │
                    │                                           │
                    │  Alarm reconciler (60s/5min):             │
                    │    gap-fill expired/failed nonces         │
                    │    RBF stuck broadcasted nonces (>15min)  │
                    │    confirm ledger via Hiro chain state    │
                    └──────────────────────────────────────────┘
```

**State definitions:**

| State | Meaning |
|-------|---------|
| `assigned` | Nonce handed to SponsorService; transaction being signed and broadcast |
| `broadcasted` | Broadcast accepted by Stacks node; tx in mempool |
| `confirmed` | Chain advanced past this nonce (alarm confirms via Hiro) |
| `conflict` | Broadcast rejected: `ConflictingNonceInMempool` — two txs for same nonce slot |
| `failed` | Broadcast rejected for other reason (client error, fee too low) |
| `expired` | Nonce was assigned but never broadcast within the 10-minute grace period |

---

## Caller Retry Contract

### POST /relay — Response Codes

| HTTP | Error Code | `retryable` | `retryAfter` | Action |
|------|-----------|-------------|-------------|--------|
| 200 | — | — | — | Success. Check `settlement.status` |
| 409 | `NONCE_CONFLICT` | `true` | 30s | Wait, re-sign, retry (see below) |
| 422 | `SETTLEMENT_FAILED` | `false` | — | Surface to user; tx rejected on-chain |
| 422 | `SETTLEMENT_VERIFICATION_FAILED` | `false` | — | Payment params invalid; fix request |
| 422 | `CLIENT_BAD_NONCE` | `false` | — | Agent tx has wrong nonce; re-sign |
| 422 | `CLIENT_INSUFFICIENT_FUNDS` | `false` | — | Agent wallet has insufficient funds |
| 429 | `CHAINING_LIMIT_EXCEEDED` | `true` | dynamic | Pool at capacity; wait and retry |
| 429 | `RATE_LIMIT_EXCEEDED` | `true` | dynamic | Per-sender rate limit hit; back off |
| 503 | `INTERNAL_ERROR` | `true` | 5s | Relay unavailable; retry shortly |

### Handling 409 NONCE_CONFLICT

The relay returned a conflict because the sponsor nonce it used was already in the mempool. The relay has already scheduled a resync — the pool self-heals within 30–60 seconds.

**Required caller steps:**
1. Wait at least `retryAfter` seconds (always 30 for `NONCE_CONFLICT`)
2. Re-sign the transaction — do NOT reuse the old signed hex
   - The agent's own nonce may also need to be updated if time has passed
3. Retry `POST /relay` with the newly signed transaction

**Why re-signing is required:** The sponsor wallet picks a new nonce on the next request. The old signed transaction contains the stale sponsor nonce and will be rejected. The agent-side nonce may also have advanced during the wait.

**Recovery timeline:** ~30–60s in normal conditions. During heavy conflict periods (multiple wallets simultaneously conflicted), recovery may take up to 90s. Check `GET /nonce/stats` if conflicts persist beyond 2 minutes.

### Handling 200 with `settlement.status: "pending"`

The transaction was broadcast but did not confirm within the 60-second polling window. This is not an error.

**Required caller steps:**
1. Store the `receiptId` from the response
2. Poll `GET /verify/:receiptId` every 15–30 seconds
3. Consider confirmed when `receipt.settlement.status === "confirmed"`
4. Consider failed only when `receipt.settlement.status === "failed"`

**Do not retry** `POST /relay` for a pending settlement — this creates duplicate transactions.

### Handling 422 Errors

All 422 responses have `retryable: false`. Do not retry automatically.

- `SETTLEMENT_FAILED`: The transaction reached the chain and was aborted (`abort_*` status). This is a terminal state — surface the error to the user.
- `CLIENT_BAD_NONCE` / `CLIENT_NONCE_CONFLICT`: The agent's own transaction nonce is wrong. Fetch the agent's current nonce from Hiro, re-build the transaction, and retry.
- `SETTLEMENT_VERIFICATION_FAILED`: The transaction's payment parameters do not match the `settle` requirements sent with the request. Fix the transaction construction.

### Drop vs Abort — Dropped Is Not Failed

The relay correctly treats `dropped_replace_by_fee` and other `dropped_*` statuses as **transient**, not terminal. If Hiro reports a drop, the relay continues polling until the 60s timeout, then returns `status: "pending"`. Production data shows 93% of RBF-drop reports eventually confirm on-chain. Only `abort_*` is treated as terminal.

---

## Operational Health Checks

### Check pool state

```bash
curl -s https://x402-relay.aibtc.dev/nonce/stats \
  -H "Authorization: Bearer $ADMIN_API_KEY" | jq .
```

Key fields to inspect:

| Field | Healthy | Investigate |
|-------|---------|-------------|
| `stats.wallets[*].reserved` | < 16 per wallet | >= 18 (approaching chaining limit) |
| `stats.conflictsDetected` | Stable count | Rapidly increasing |
| `stats.gapStatus` | `no_gaps` or `gaps_recovered_historically` | `recent_gap` |
| `stats.lastHiroSync` | Within last 5 min | Older than 10 min |
| `stats.walletUtilization[*].failed_count` | 0 or very low | > 5 in last hour |
| `stats.stuckTxRbfBroadcast` | Stable | Incrementing rapidly |

**Per-wallet pool pressure:** `reserved / 20` — above 75% means the wallet is near its chaining limit. Above 80% overall triggers a surge event.

### Check recent surge events

```bash
curl -s https://x402-relay.aibtc.dev/nonce/surge-history \
  -H "Authorization: Bearer $ADMIN_API_KEY" | jq .surgeEvents
```

A surge event starts when overall pool pressure exceeds 80% and resolves when it drops. Resolved surges include `duration_ms` and `peak_pressure_pct`.

### Check nonce event history for a specific wallet/nonce

```bash
curl -s "https://x402-relay.aibtc.dev/nonce/history/2/610" \
  -H "Authorization: Bearer $ADMIN_API_KEY" | jq .
```

Replace `2` with wallet index and `610` with the nonce value. Returns the `nonce_intents` row and the full audit trail from `nonce_events`.

---

## Manual Recovery Procedures

### Scenario 1: Pool stuck after nonce conflict burst

**Symptoms:** `gapStatus: "recent_gap"`, multiple wallets with elevated `reserved` counts, callers seeing sustained 409s.

**Recovery:**
```bash
# Trigger gap-aware resync on all wallets
curl -s -X POST https://x402-relay.aibtc.dev/nonce/reset \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"resync"}' | jq .
```

The resync applies the reconciler logic immediately instead of waiting for the next alarm. Check `result.wallets[*].changed` and `result.wallets[*].reason` to confirm which wallets were adjusted.

**Expected output patterns:**

| `reason` value | Meaning |
|----------------|---------|
| `GAP RECOVERY: reset to lowest missing nonce N` | Gap detected; head rewound |
| `FORWARD BUMP: advanced from N to M` | Chain moved ahead; head caught up |
| `STALE DETECTION: idle Xs, reset to chain nonce N` | Idle wallet; head reset |
| `nonce is consistent with chain state` | Wallet healthy; no change |
| `nonce is consistent with chain state gap_filled [N,M]` | Gaps filled via self-transfer |
| `nonce is consistent with chain state rbf [N]` | RBF broadcast for stuck tx |

### Scenario 2: Pool head far ahead of chain (lookahead guard triggered)

**Symptoms:** Callers see 429 `CHAINING_LIMIT_EXCEEDED` despite low actual traffic. `nonce/stats` shows `nextNonce` much higher than expected.

**Recovery:**
```bash
# Hard reset to last_executed_tx_nonce + 1 (safe floor)
curl -s -X POST https://x402-relay.aibtc.dev/nonce/reset \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"reset"}' | jq .
```

Use `reset` only when the head has diverged significantly. It discards all in-flight nonce state — use only when no transactions are actively pending.

### Scenario 3: Wallet derivation changed (new mnemonic deployed)

**Symptoms:** New wallets have different addresses than what the DO has stored. Nonce assignments go to wrong wallets.

**Recovery:**
```bash
# Wipe all per-wallet pool state — wallets reinitialize from Hiro on next request
curl -s -X POST https://x402-relay.aibtc.dev/nonce/reset \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"clear-pools"}' | jq .
```

After `clear-pools`, the first request to each wallet re-seeds its nonce head from Hiro.

### Scenario 4: Single wallet circuit-broken

**Symptoms:** One wallet is being skipped (3+ quarantines within 10 min). Other wallets are handling traffic. `nonce/stats` shows one wallet with very low `reserved` but high `failed_count`.

**Action:** Wait — circuit breaker clears automatically after 10 minutes. If unblocking sooner is needed, use `resync` (not `reset`) to let the reconciler clear the quarantined state.

---

## Reconciler Log Interpretation

The NonceDO emits structured logs via worker-logs. Key log messages:

| Log message | Level | Meaning |
|-------------|-------|---------|
| `nonce_assigned` | INFO | Normal assignment; check `walletIndex`, `nonce`, `ledgerReserved` |
| `nonce_released` | INFO | Nonce cleared; `consumed: true` means broadcast succeeded |
| `nonce_conflict_returned` | WARN | 409 returned to caller; resync scheduled |
| `nonce_stale_head_advanced` | WARN | Head was behind Hiro; auto-advanced |
| `nonce_lookahead_capped` | WARN | Head too far ahead of chain; caller gets 429 |
| `reconcile_hiro_divergence` | WARN | Hiro lost sight of a tx we know we sent (tx is young — normal) |
| `conflict_nonce_resolved` | INFO | Conflict nonce either confirmed or gap-filled |
| `gap_fill_rejected` | WARN | Gap-fill broadcast rejected (not `ConflictingNonceInMempool`) |
| `rbf_broadcast_success` | INFO | Stuck tx replaced; check `nonce`, `txid`, `fee`, `attemptNum` |
| `rbf_max_attempts_reached` | WARN | 3 RBF attempts exhausted for a nonce; manual intervention may be needed |
| `circuit_breaker_skip` | WARN | Wallet skipped due to quarantine count; check `quarantineCount` |
| `all_wallets_degraded_using_least_degraded` | WARN | All wallets circuit-broken; using fallback |
| `nonce_reconcile_stale` | WARN | Wallet head was ahead of chain and idle; reset |
| `nonce_alarm_failed` | ERROR | Alarm cycle threw; will reschedule at idle interval |
| `surge_started` | INFO | Pool pressure > 80%; check `pressure_pct`, `totalReserved` |
| `surge_resolved` | INFO | Pressure back below 80%; check `duration_ms` |

**Filtering logs (logs.aibtc.com):**

```bash
# All WARN+ for the nonce DO
GET /dashboard/api/logs/x402-relay?level=WARN

# Specific message search
GET /dashboard/api/logs/x402-relay?message=circuit_breaker_skip
```

---

## Capacity Planning

### Current capacity

With `SPONSOR_WALLET_COUNT=10` and `CHAINING_LIMIT=20`:
- **Max concurrent sponsorings:** 200 (10 × 20)
- **Conflict probability is low** when pool pressure stays below 80% (160 in-flight)
- **Surge threshold:** 160 in-flight nonces across all 10 wallets

### Signs of capacity pressure

1. Frequent 409 `NONCE_CONFLICT` in production logs
2. `surge_started` events with `peak_pressure_pct > 85`
3. `nonce/stats` showing `wallets[*].reserved >= 16` on multiple wallets simultaneously
4. Reconciler log `nonce_reconcile_stale` firing frequently (> 2x per hour per wallet)

### Scaling up wallet count

1. **Verify wallets are funded:** All derived addresses (indices 0..N-1) need STX for fees. Check with `curl https://api.hiro.so/extended/v1/address/{addr}/balances`.

2. **Update `SPONSOR_WALLET_COUNT` in `wrangler.jsonc`:**
   ```jsonc
   "vars": {
     "SPONSOR_WALLET_COUNT": "8"  // was "5"
   }
   ```

3. **Deploy:** commit and push — Cloudflare Git integration deploys automatically.

4. **Dynamic scale-up (automatic):** If all initialized wallets exceed 75% pressure simultaneously, the NonceDO alarm auto-increments `dynamic_wallet_count` (capped by `SPONSOR_WALLET_MAX` env var, absolute max 100). Check `stats.dynamicWalletCount` to see if this has triggered.

### Scaling wallet count formula

Target `reserved / capacity < 60%` under peak load to leave headroom for bursts.

If peak concurrent sponsorings = P:
- Required wallets = `ceil(P / (20 × 0.60))` = `ceil(P / 12)`

Examples:
- 30 concurrent → 3 wallets
- 60 concurrent → 5 wallets
- 120 concurrent → 10 wallets (current)
- 200 concurrent → 17 wallets (requires `SPONSOR_WALLET_MAX` increase and funded addresses)

---

## Troubleshooting Checklist

**Callers seeing sustained 409s (> 2 minutes):**
1. `GET /nonce/stats` — check `gapStatus` and per-wallet `reserved`
2. If `gapStatus: "recent_gap"` — trigger `resync`
3. If reserved counts normal but conflicts persist — check Hiro API status (potential node-side mempool issue)
4. If `circuit_breaker_skip` in logs — wait 10 min for circuit to clear, then `resync`

**Callers seeing 429 CHAINING_LIMIT_EXCEEDED under low traffic:**
1. Check `stats.wallets[*].reserved` — if > 15 on all wallets, pool is genuinely full (wait for drain)
2. If counts look wrong (pool shows full but traffic is low) — check `lastHiroSync`. If stale, Hiro may be unreachable
3. If head has diverged — use `reset` to hard-reset to safe floor

**Gap-fill transactions not clearing gaps:**
1. Check `stats.gapsFilled` counter — if not incrementing, gap-fill may be failing
2. Check `gap_fill_rejected` logs for the rejection reason
3. Verify the flush recipient address (`FLUSH_RECIPIENT` env var) is set correctly for the network
4. Verify sponsor wallets have sufficient STX for gap-fill fees (30,000 uSTX each)

**RBF not clearing stuck transactions after 15 minutes:**
1. Check `nonce/history/:wallet/:nonce` for RBF state
2. If `rbf_max_attempts_reached` in logs — 3 attempts exhausted; use `reset` action
3. Verify sponsor wallets have sufficient STX for RBF fees (90,000 uSTX each)

---

## Related Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /nonce/stats` | Bearer token | Full pool health snapshot |
| `POST /nonce/reset` | Bearer token | Trigger resync/reset/clear-pools |
| `GET /nonce/surge-history` | Bearer token | Last 20 surge events |
| `GET /nonce/history/:wallet/:nonce` | Bearer token | Event trail for specific nonce |
| `GET /health` | None | Relay health including wallet status |

See [API docs](/docs) for full request/response schemas.

---

*Closes [#179](https://github.com/aibtcdev/x402-sponsor-relay/issues/179)*
