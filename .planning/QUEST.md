# General Transaction Sponsorship

Expand the x402 sponsor relay to support general transaction sponsorship with API key authentication.

**Status:** active
**Created:** 2026-02-01
**Repos:** aibtcdev/x402-sponsor-relay
**Branch:** feat/general-sponsorship

## Goal

Transform the x402 sponsor relay from an x402-only service into a general-purpose transaction sponsorship relay. Any authenticated agent with an API key can submit pre-signed sponsored transactions for sponsorship and broadcast.

## Requirements

1. New `/sponsor` endpoint for general transaction sponsorship (any Stacks tx)
2. API key authentication with configurable per-key rate limiting and spending caps
3. Tight fee monitoring and tracking per key
4. Consistent `ok()`/`err()` response format across all endpoints
5. `ok()` responses include: txid, explorer link, internal UUID
6. Comprehensive logging of key stats and usage info
7. Dashboard updates to show API key statistics
8. Bug fix: facilitator health check should use `/health` endpoint
9. Designed for high traffic - API keys will be handed out for testing

## Related Issues

- #16 - Add API key authentication for external applications
- #23 - Sponsor relay flow: API cannot verify txid-based payment proof
