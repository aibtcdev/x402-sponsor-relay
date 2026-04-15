# Sponsor Ledger Lifecycle

Reference doc for the `@aibtc/tx-schemas@^1.0.0` two-phase broadcast integration.
Introduced in the `sponsor-ledger-integration` quest (phases 1–6, April 2026).

## Feature Flag

`USE_WALLET_CAPACITY_STATE` env var (default: on). Set to `"false"` to roll back to
legacy nonce-state reads without a schema change.

## Two-Phase Broadcast Lifecycle

Every outbound sponsor broadcast must follow this sequence — raw `status` writes are
forbidden outside the schema layer:

```
beginPendingBroadcast(entry)    → status: pending_broadcast, broadcastAt: <now ISO>
  │
  ├── broadcastTransaction()
  │
  ├─ success → resolveBroadcast(entry, { outcome: 'broadcast_sent', txid })
  │               status: broadcast_sent
  │
  └─ failure → resolveBroadcast(entry, { outcome: 'broadcast_failed', reason })
                  status: broadcast_failed
```

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

| Classification | Meaning |
|---------------|---------|
| `ours_tracked` | Occupant txid is in the ledger; normal RBF path |
| `ours_orphan` | Occupant sponsor matches ours; txid not in ledger — adopt |
| `foreign` | Occupant sender/sponsor is an external wallet — operator alert |
| `unpriceable` | Occupant fee exceeds relay ceiling; quarantine after MAX_RBF_ATTEMPTS |

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

On-demand reconcile runs at every decision point: pre-broadcast, ConflictingNonceInMempool,
`/nonce/state` reads, and pre-RBF. The alarm is a safety net for idle wallets.

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
