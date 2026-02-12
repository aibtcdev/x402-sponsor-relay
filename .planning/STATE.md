# Quest State

**Current Phase:** 2
**Phase Status:** pending
**Retry Count:** 0
**Last Completed:** Phase 1 (commit db74853)

## Decisions Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-02-12 | Setup | 4-phase sequential plan | Each phase atomic, buildable, type-safe |
| 2026-02-12 | Phase 1 | Try bitcoinjs-message first, noble fallback if needed | CF Workers has nodejs_compat_v2 with Buffer support |
| 2026-02-12 | Phase 2 | Set appName to `btc:{address_prefix}` | Keeps existing list/admin tools working |
| 2026-02-12 | Phase 3 | Skip provisionMethod tracking | Both paths produce identical keys, keep it simple |
| 2026-02-12 | Phase 4 | Derive BTC key from AGENT_MNEMONIC | Consistent with existing test scripts |

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| BTC signature library | `bitcoinjs-message` npm package | Handles all BIP-137 address types; `nodejs_compat_v2` provides Buffer support |
| Fallback if library fails in CF Workers | `@noble/secp256k1` (already transitive dep) | Pure JS, no Node.js APIs needed |
| `ApiKeyMetadata` schema | Add optional `btcAddress` field only (no provisionMethod) | Non-breaking; keep it simple per user decision |
| Duplicate prevention | New KV mapping `btc:{address} -> keyId` | O(1) lookup, matches existing `app:{name} -> keyId` pattern |
| `provisionKey()` method | Separate from `createKey()` | Different identity models, different KV mappings, avoids admin flow risk |
| HTTP 409 for duplicates | `ALREADY_PROVISIONED` error code | Distinguishes from 400 -- request was valid but address is taken |
| No auth middleware | Signature is the authentication | Per issue spec |
