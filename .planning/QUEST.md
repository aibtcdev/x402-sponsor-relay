# Programmatic API Key Provisioning via BTC Signature

Add `POST /keys/provision` endpoint enabling agents to self-provision free-tier API keys by proving Bitcoin address ownership via BIP-137 signature verification.

**Status:** active
**Created:** 2026-02-12
**Repos:** aibtcdev/x402-sponsor-relay
**Issue:** [#30](https://github.com/aibtcdev/x402-sponsor-relay/issues/30)

## Goal

Enable programmatic API key provisioning for two paths:

1. **Registration path** (via Landing Page): Agent signs `"Bitcoin will be the currency of AIs"` during landing page registration. Landing page forwards signature + BTC address to relay. No timestamp needed.

2. **Self-service path** (Agent Direct): Agent signs `"Bitcoin will be the currency of AIs | {ISO-timestamp}"` with BTC key. Relay verifies signature + timestamp freshness (within 5 min).

Both paths produce a free-tier API key (`x402_sk_test_{32-char-hex}`) with 30-day expiration, enabling the agent to use `POST /sponsor` for gasless transactions.

## Requirements

1. `POST /keys/provision` endpoint accepts btcAddress + signature
2. Verifies BTC signature (BIP-137) against message
3. Registration path accepts bare message (no timestamp)
4. Self-service path validates timestamp within 5 minutes
5. Generates API key in standard format, free tier limits
6. Stores metadata in KV with hashed key + btc:{address} mapping
7. Returns error if BTC address already has a key
8. OpenAPI documented with Chanfana
9. No authentication required (signature IS the auth)
