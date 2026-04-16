# Sponsor Ledger Lifecycle

Reference doc for the `@aibtc/tx-schemas@^1.0.0` two-phase broadcast integration.
Introduced in the `sponsor-ledger-integration` quest (phases 1–6, April 2026).

## Feature Flag

`USE_WALLET_CAPACITY_STATE` env var (default: on). Set to `"false"` to roll back to
legacy nonce-state reads without a schema change.

## Two-Phase Broadcast Lifecycle

New broadcast paths (gap-fill RBF, bounded-broadcast) route `status` writes through
`writeLedgerPendingBroadcast()` / `writeLedgerResolvedBroadcast()` which enforce
the valid transition order and emit `nonce_events` for each step.

Legacy paths (the original `broadcastAndRecord*` family, expiry backfill, on-chain
abort detection) still update `nonce_intents.status` directly via dual-write
statements that keep `state` and `status` in sync. These will be migrated to the
helper functions when Phase 6 retires the legacy decision tree.

```
writeLedgerPendingBroadcast(walletIndex, nonce, txid, now)
                                → status: pending_broadcast, broadcast_at: <now ISO>, txid: <real txid>
  │
  ├── broadcastTransaction()
  │
  ├─ success → writeLedgerResolvedBroadcast(..., 'sent', txid)
  │               status: broadcast_sent
  │
  └─ failure → writeLedgerResolvedBroadcast(..., 'failed', undefined, reason)
                  status: broadcast_failed
```

The tx-schemas lifecycle helpers (`beginPendingBroadcast` / `resolveBroadcast`) remain
imported and will be substituted for the relay's thin wrappers when Phase 6 flips the
flag to production.

`LedgerTransitionError` is thrown on invalid transitions (e.g. resolving an already-
resolved entry). The relay catches and logs this; it does not swallow it.

## decideBroadcast Variants

| Variant | Meaning |
|---------|---------|
| `broadcast` | No occupant; proceed with normal dispatch |
| `rebid` | Relay-owned occupant; escalate fee (RBF) |
| `adopt` | Relay-owned orphan not in ledger; import via `adoptOrphan` |
| `quarantine` | Occupant cannot be outbid; quarantine slot, advance head |
| `hold` | Occupant is foreign; escalate to operator alert, hold dispatch |
| `await_pending_broadcast` | A ledger entry is mid-write (`pending_broadcast`); short-circuit all decisions |

`await_pending_broadcast` is the schema-layer hard invariant against silent double-
broadcast. No code path may proceed while any entry is unresolved.

## classifyOccupant Outputs

Matches `OccupantClassification.kind` in `@aibtc/tx-schemas`:

| Kind | Meaning |
|------|---------|
| `sponsor_owned_in_ledger` | Occupant sponsor matches ours AND txid is in the ledger; normal RBF path |
| `sponsor_owned_orphan` | Occupant sponsor matches ours but txid is not in the ledger — adopt |
| `foreign` | Occupant sender/sponsor is an external wallet — operator alert + hold |
| `untraceable` | No Hiro record for the slot (404 / parse error / no known txid) |

## Reconcile Flow

```
alarm() or on-demand trigger
  │
  ├── fetchMempoolForSponsor(address)       → mempool snapshot keyed by nonce
  │     fail → log reconcile_skipped_api_blind, return (fail-open)
  │
  ├── reconcile(ledger, snapshot, { justBroadcastGraceSeconds: 30 })
  │     └─ for each ledger entry vs mempool entry:
  │           classifyOccupant → decideBroadcast → apply
  │
  ├── inFlightPendingIndex                  → entries broadcast within grace window
  │     skip adoption/quarantine for these entries; re-check next cycle
  │
  ├── unpriceableOrphans                    → quarantine + operator alert
  │
  └── auto-promote pending_broadcast → broadcast_sent on mempool confirm
        pending_broadcast > PENDING_BROADCAST_SWEEP_TIMEOUT_MS → broadcast_failed
```

On-demand reconcile runs at the request-path decision points: pre-broadcast,
`ConflictingNonceInMempool`, and pre-RBF. `/nonce/state` reads no longer fan out
one Hiro call per occupied nonce — the alarm-driven reconcile covers that ground
with a single address-filtered mempool snapshot per cycle.

## Grace Window

`justBroadcastGraceSeconds: 30` (default). Entries broadcast within this window appear
in `ReconcileResult.inFlightPendingIndex` and are never prematurely adopted or quarantined.
This handles Hiro indexer lag for freshly-broadcast transactions.

## nonce_reconcile_forward_bump Cause Annotations

| Cause | Meaning |
|-------|---------|
| `untracked_broadcast` | Hiro frontier > local ledger, but no orphan found |
| `do_cold_start` | DO storage empty on cold start; Hiro nonce > 0 |
| `external_wallet_op` | Sponsor address used outside the relay |

## Storage Migration

`stuck_tx:{walletIndex}:{nonce}` DO-storage keys (Phase 2 dual-write) are swept by
`sweepStuckTxStorage()` on each alarm cycle until exhausted. The method copies
`StuckTxState.rbfAttempts` into `nonce_intents.gap_fill_attempts` before deleting
each key. Safe to run repeatedly (idempotent). Logs `stuck_tx_storage_swept` with count.
