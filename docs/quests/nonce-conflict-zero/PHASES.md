# Phases: nonce-conflict-zero

## Phase 1 -- Add nonce lifecycle observability

**Status:** `pending`

**Goal:** Instrument the nonce lifecycle so every nonce assignment, release, conflict, and resync produces a structured log entry with full context. Currently, nonce conflict warnings have `null` data fields in production logs, making root cause analysis dependent on manual log correlation. This phase makes every nonce event self-contained and machine-queryable.

**Dependencies:** None

**Why first:** We cannot fix what we cannot measure. The current logs show _that_ conflicts happen but not _why_ (which nonce, which wallet, what the pool state was, what Hiro reported). Every subsequent phase depends on being able to verify its effect from production logs.

**Key files:**
- `src/durable-objects/nonce-do.ts` -- `assignNonce()`, `releaseNonce()`, `reconcileNonceForWallet()`, `alarm()`
- `src/services/sponsor.ts` -- `resyncNonceDO()`, `resyncNonceDODelayed()`
- `src/endpoints/relay.ts` -- nonce conflict response path (line ~383)
- `src/endpoints/sponsor.ts` -- nonce conflict response path (line ~308)
- `src/services/settlement.ts` -- `broadcastAndConfirm()` nonce conflict detection (line ~593)

**Changes:**

1. **NonceDO: Log every assignment with pool snapshot**
   In `assignNonce()`, after the nonce is assigned (line ~865), add a structured log:
   ```
   this.log("info", "nonce_assigned", {
     walletIndex,
     nonce: assignedNonce,
     poolAvailable: pool.available.length,
     poolReserved: pool.reserved.length,
     maxNonce: pool.maxNonce,
   });
   ```

2. **NonceDO: Log every release with outcome**
   In `releaseNonce()`, after the nonce is removed from reserved (line ~907), add:
   ```
   this.log("info", "nonce_released", {
     walletIndex,
     nonce,
     consumed: !!txid,
     txid: txid ?? null,
     poolAvailable: pool.available.length,
     poolReserved: pool.reserved.length,
   });
   ```

3. **NonceDO: Log reconciliation outcomes with Hiro data**
   In `reconcileNonceForWallet()`, at each return point that indicates a change, include the raw Hiro data:
   ```
   // At GAP RECOVERY return (~line 1066):
   this.log("warn", "nonce_reconcile_gap_recovery", {
     walletIndex,
     previousNonce,
     newNonce: lowestGap,
     gaps: sortedGaps,
     hiroNextNonce: possible_next_nonce,
     hiroMissingNonces: detected_missing_nonces,
     poolReserved: pool?.reserved.length ?? 0,
   });

   // At FORWARD BUMP return (~line 1121):
   this.log("warn", "nonce_reconcile_forward_bump", {
     walletIndex,
     previousNonce: effectivePreviousNonce,
     newNonce: possible_next_nonce,
     hiroNextNonce: possible_next_nonce,
     poolReserved: poolHead?.reserved.length ?? 0,
     poolAvailable: poolHead?.available.length ?? 0,
   });

   // At STALE DETECTION return (~line 1148):
   this.log("warn", "nonce_reconcile_stale", {
     walletIndex,
     previousNonce: effectivePreviousNonce,
     newNonce: possible_next_nonce,
     idleSeconds: Math.round(idleMs / 1000),
     hiroNextNonce: possible_next_nonce,
   });
   ```

4. **Endpoints: Include nonce context in conflict responses**
   In `relay.ts` (line ~383) and `sponsor.ts` (line ~312), when returning a NONCE_CONFLICT error, log the assigned nonce, wallet index, and broadcast error details:
   ```
   logger.warn("Nonce conflict returned to agent", {
     sponsorNonce,
     walletIndex: sponsorWalletIndex,
     broadcastDetails: broadcastResult.details,
   });
   ```

5. **Settlement: Include nonce in conflict detection log**
   In `settlement.ts` `broadcastAndConfirm()` (line ~598), the existing warn log says "Broadcast rejected due to nonce conflict" but does not include the nonce value. The nonce is not available in `SettlementService` since it operates on the deserialized transaction. Add the sponsor nonce to the log context by extracting it from the transaction's sponsor spending condition before broadcast:
   ```
   // Before the broadcast attempt, extract sponsor nonce for logging
   const sponsorNonceForLog = transaction.auth.authType === AuthType.Sponsored
     && "sponsorSpendingCondition" in transaction.auth
     ? Number(transaction.auth.sponsorSpendingCondition.nonce)
     : null;
   ```
   Then include `sponsorNonce: sponsorNonceForLog` in the conflict warn log.

**Verify:**
- `npm run check` passes
- `grep -c "nonce_assigned\|nonce_released\|nonce_reconcile" src/durable-objects/nonce-do.ts` returns >= 5
- Every nonce lifecycle event has a distinct log message with walletIndex and nonce fields
- No `console.log` or `console.warn` calls remain in the modified files (already addressed by prior PR)

---

## Phase 2 -- Fix resync to account for mempool state

**Status:** `pending`

**Goal:** Fix the root cause of pool/chain divergence by making `reconcileNonceForWallet()` aware of which nonces are still pending in the mempool. Currently, resync uses `possible_next_nonce` from Hiro which includes mempool pending txs, but `resetPoolAvailableForWallet()` blindly replaces the available range starting from the new head without checking whether those nonces overlap with already-reserved (in-flight) nonces. This creates duplicate nonce assignments.

**Dependencies:** Phase 1 (observability needed to verify the fix in production)

**Why this is the root cause:**

The production data shows pools 18-19 nonces ahead of confirmed state. Here is the failure sequence:

1. Pool has nonces [520-539] in `available[]` and [500-519] in `reserved[]` (broadcast, pending confirmation)
2. Alarm fires, calls `reconcileNonceForWallet()`
3. Hiro returns `possible_next_nonce: 520` (confirms 500-519 are still pending in mempool)
4. Reconciliation sees `effectivePreviousNonce (520) === possible_next_nonce (520)` -- no change needed, returns "consistent"
5. BUT: if any of the 20 reserved nonces (500-519) get dropped by the node (mempool eviction, RBF), the next resync sees `possible_next_nonce` drop to, say, 515
6. Reconciliation triggers FORWARD BUMP... but nonces 515-519 are still in `reserved[]`
7. `resetPoolAvailableForWallet(walletIndex, pool, 515)` creates `available = [515, 516, 517, ...]`
8. Nonces 515-519 now exist in BOTH `reserved[]` AND `available[]`
9. Next assignment hands out nonce 515 from `available[]`, but 515 was already broadcast from `reserved[]`
10. Broadcast returns `ConflictingNonceInMempool`

The second failure mode is simpler:
1. Nonce N is in `reserved[]`, was broadcast, but transaction gets dropped
2. Stale reservation cleanup (after 10 min) returns N to `available[]` because `hasTxidForNonce(N)` returns true (txid WAS recorded)
3. Wait -- `hasTxidForNonce` returning true means stale cleanup does NOT reclaim it. So the nonce stays in `reserved[]` indefinitely until alarm resync clears it
4. But the alarm resync resets `available[]` to start from `possible_next_nonce` which may now be <= N
5. If `possible_next_nonce` is lower than some reserved nonces (because those txs were dropped), the new available range overlaps with reserved

**Key files:**
- `src/durable-objects/nonce-do.ts` -- `reconcileNonceForWallet()`, `resetPoolAvailableForWallet()`

**Changes:**

1. **`resetPoolAvailableForWallet`: Exclude reserved nonces from the new available range**

   Current code blindly generates `[newHead, newHead+1, ..., newHead+availableSlots-1]`. Change it to skip any nonces that are currently in `reserved[]`:

   ```typescript
   private async resetPoolAvailableForWallet(
     walletIndex: number,
     pool: PoolState,
     newHead: number
   ): Promise<void> {
     const targetSize = Math.max(1, POOL_SEED_SIZE - pool.reserved.length);
     const reservedSet = new Set(pool.reserved);
     const newAvailable: number[] = [];
     let candidate = newHead;
     while (newAvailable.length < targetSize) {
       if (!reservedSet.has(candidate)) {
         newAvailable.push(candidate);
       }
       candidate++;
     }
     pool.available = newAvailable;
     pool.maxNonce = candidate - 1;
     await this.savePoolForWallet(walletIndex, pool);
   }
   ```

   This is the core fix. If nonce 515 is in `reserved[]` because it was already broadcast, it will be skipped in the new available range. The available pool gets [520, 521, 522...] instead, avoiding the conflict.

2. **`reconcileNonceForWallet`: Trim reserved nonces that Hiro confirms are below `last_executed_tx_nonce`**

   When Hiro reports `last_executed_tx_nonce: 514`, any nonces <= 514 in `reserved[]` have already been confirmed on-chain. They should be removed from `reserved[]` (consumed) to free up pool capacity:

   ```typescript
   // After fetching nonceInfo, before gap detection:
   if (nonceInfo.last_executed_tx_nonce !== null) {
     const confirmedFloor = nonceInfo.last_executed_tx_nonce;
     const staleReserved = pool.reserved.filter(n => n <= confirmedFloor);
     if (staleReserved.length > 0) {
       pool.reserved = pool.reserved.filter(n => n > confirmedFloor);
       for (const n of staleReserved) {
         delete pool.reservedAt[n];
       }
       await this.savePoolForWallet(walletIndex, pool);
       this.log("info", "reserved_nonces_confirmed", {
         walletIndex,
         confirmedFloor,
         released: staleReserved.length,
         remainingReserved: pool.reserved.length,
       });
     }
   }
   ```

   This prevents reserved nonces from accumulating indefinitely when confirmations happen between alarm cycles.

3. **`assignNonce`: Add overlap guard**

   As a safety check, refuse to assign a nonce that is already in `reserved[]` (belt-and-suspenders):

   ```typescript
   // After pool.available.shift() in assignNonce:
   if (pool.reserved.includes(assignedNonce)) {
     this.log("error", "nonce_overlap_detected", {
       walletIndex,
       nonce: assignedNonce,
       reserved: pool.reserved,
       available: pool.available,
     });
     // Skip this nonce and try the next available
     // ... (loop or extend pool)
   }
   ```

**Verify:**
- `npm run check` passes
- Code review confirms `resetPoolAvailableForWallet` skips reserved nonces
- Code review confirms `reconcileNonceForWallet` trims confirmed nonces from reserved
- Manual trace of the failure scenario above shows no overlap possible

---

## Phase 3 -- Guard against pool/chain divergence

**Status:** `pending`

**Goal:** Add runtime safeguards that prevent the pool from drifting too far ahead of confirmed chain state, and reduce the blast radius when drift does occur. The Phase 2 fix addresses the root cause, but production systems need defense in depth.

**Dependencies:** Phase 2

**Changes:**

1. **Cap pool lookahead relative to chain state**

   Add a check in `assignNonce()` that compares the nonce about to be assigned against a cached `last_executed_tx_nonce` value. If the gap exceeds CHAINING_LIMIT, refuse to assign and trigger a resync instead of blindly extending the pool:

   Add a new constant and a cached field:
   ```typescript
   /** Maximum gap between assigned nonce and last confirmed nonce.
    *  Beyond this, the risk of mempool eviction causing conflicts is too high. */
   const MAX_LOOKAHEAD = CHAINING_LIMIT; // 20
   ```

   In `assignNonce()`, before assigning:
   ```typescript
   // If we have a cached chain floor, check that assignment doesn't exceed safe lookahead
   const chainFloor = this.getStateValue(`last_confirmed:${walletIndex}`);
   if (chainFloor !== null && assignedNonce - chainFloor > MAX_LOOKAHEAD) {
     this.log("warn", "lookahead_limit_reached", {
       walletIndex,
       assignedNonce,
       chainFloor,
       gap: assignedNonce - chainFloor,
     });
     // Return the nonce to available and throw ChainingLimitError
     insertSorted(pool.available, assignedNonce);
     pool.reserved = pool.reserved.filter(n => n !== assignedNonce);
     delete pool.reservedAt[assignedNonce];
     await this.savePoolForWallet(walletIndex, pool);
     throw new ChainingLimitError(pool.reserved.length);
   }
   ```

   Update the `last_confirmed` cache during `reconcileNonceForWallet()`:
   ```typescript
   if (nonceInfo.last_executed_tx_nonce !== null) {
     this.setStateValue(`last_confirmed:${walletIndex}`, nonceInfo.last_executed_tx_nonce);
   }
   ```

2. **Do not recycle broadcast nonces into available**

   When `releaseNonce()` is called WITHOUT a txid (broadcast failed), the current code returns the nonce to `available[]` via `insertSorted`. This is correct for truly-unused nonces (e.g., the sponsoring step threw before broadcast). But for nonces where broadcast returned a non-conflict error (e.g., "TooMuchChaining"), the nonce may still reach the mempool or be partially processed.

   Add a parameter `broadcastAttempted: boolean` (default false) to `releaseNonce()`. When `broadcastAttempted` is true and `txid` is absent, do NOT return to available -- instead, just remove from reserved and discard the nonce:

   ```typescript
   if (!txid && !broadcastAttempted) {
     // Never reached broadcast -- safe to reuse
     insertSorted(pool.available, nonce);
   }
   // If broadcastAttempted but no txid: nonce is tainted, discard it
   ```

   Update callers:
   - `relay.ts` verify-failure path: `broadcastAttempted: false` (never reached broadcast)
   - `relay.ts` broadcast-failure path: `broadcastAttempted: true` (broadcast was attempted)
   - `sponsor.ts` broadcast-failure path: `broadcastAttempted: true`
   - `sponsor.ts` broadcast-exception path: `broadcastAttempted: true`

3. **Reduce alarm interval during active traffic**

   When the relay is under active traffic (assignments within last 2 minutes), reduce the alarm interval from 5 minutes to 1 minute. This makes resync catch dropped transactions faster:

   ```typescript
   private getAlarmIntervalMs(): number {
     const lastAssigned = this.getStateValue(STATE_KEYS.lastAssignedAt);
     if (lastAssigned !== null && Date.now() - lastAssigned < 2 * 60 * 1000) {
       return 60 * 1000; // 1 minute during active traffic
     }
     return ALARM_INTERVAL_MS; // 5 minutes when idle
   }
   ```

   Replace both `scheduleAlarm()` calls to use `this.getAlarmIntervalMs()`.

**Verify:**
- `npm run check` passes
- `releaseNonceDO` callers in relay.ts and sponsor.ts pass `broadcastAttempted` correctly
- Alarm interval logic returns 1 minute when `lastAssignedAt` is recent, 5 minutes otherwise
- The `MAX_LOOKAHEAD` guard prevents nonces from getting too far ahead of confirmed state

---

## Phase 4 -- Validate and harden under load

**Status:** `pending`

**Goal:** Deploy phases 1-3 to staging, validate with production traffic, and add a targeted integration test that exercises the exact failure scenario from the production data. This phase is verification and cleanup -- no new features, just confidence.

**Dependencies:** Phase 3

**Changes:**

1. **Create nonce pool state diagnostic endpoint**

   Add a `GET /nonce/pool` admin endpoint (requires API key) that returns the raw pool state for all wallets: `available[]`, `reserved[]`, `reservedAt`, `maxNonce`, and the current Hiro nonce info side-by-side. This enables on-demand verification that pools are not diverged:

   ```typescript
   // For each wallet:
   {
     walletIndex: 0,
     pool: { available: [520,521,...], reserved: [515,516,...], maxNonce: 539 },
     hiro: { last_executed_tx_nonce: 514, possible_next_nonce: 520, detected_missing_nonces: [] },
     overlap: [],  // nonces in both available and reserved (should be empty)
     chainGap: 5,  // maxNonce - last_executed_tx_nonce
   }
   ```

2. **Add alarm self-test**

   In `alarm()`, after reconciliation, verify the pool invariant that `available` and `reserved` have no overlapping nonces. If overlap is detected, log an error and fix it by removing overlapping nonces from `available`:

   ```typescript
   // Post-reconciliation invariant check
   const pool = await this.loadPoolForWallet(walletIndex);
   if (pool) {
     const reservedSet = new Set(pool.reserved);
     const overlap = pool.available.filter(n => reservedSet.has(n));
     if (overlap.length > 0) {
       this.log("error", "pool_invariant_violation", {
         walletIndex,
         overlap,
         availableCount: pool.available.length,
         reservedCount: pool.reserved.length,
       });
       pool.available = pool.available.filter(n => !reservedSet.has(n));
       await this.savePoolForWallet(walletIndex, pool);
     }
   }
   ```

3. **Deploy and monitor checklist**

   After deploying to staging:
   - Run `npm run test:relay -- https://x402-relay.aibtc.dev` x20 and verify zero NONCE_CONFLICT
   - Check `GET /nonce/pool` to verify no overlap between available and reserved
   - Monitor production logs for 4 hours and count nonce_conflict_returned_to_agent events
   - Compare with baseline: was ~1 conflict per 35 minutes, target is zero

4. **Create PR for the full quest**

   Single PR covering all phases (one commit per phase for clean bisect), targeting main.

**Verify:**
- `npm run check` passes
- `npm run deploy:dry-run` succeeds
- `GET /nonce/pool` returns valid JSON with overlap=[] for all wallets
- Zero `pool_invariant_violation` errors in logs after 4 hours of traffic
- Zero agent-visible NONCE_CONFLICT errors under normal traffic
