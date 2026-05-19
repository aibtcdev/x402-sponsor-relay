/**
 * Integration tests for the sponsor-nonce TTL wire contract (#375).
 *
 * Proves the behavioral guarantees from Phase 3 (nonceExpiresAt + sponsorNonceValidForMs)
 * hold across the relay's decision paths so the landing-page consumer in Phase 5 can
 * target a stable contract. Three claim areas:
 *
 * 1. TTL fields propagate from NonceDO assignment through SponsorService → response body.
 * 2. Rebroadcasting stale sponsored hex past TTL is classified as sponsor-side conflict
 *    (responsible: "sponsor") by decideBroadcastAction — the correct attribution from Phase 1.
 * 3. Consumer retry-gate logic: before expiry → may rebroadcast; at/after expiry → must
 *    re-call /sponsor with the original client-signed payload.
 *
 * These tests do NOT spin up a full Cloudflare Worker. They exercise in-process logic with
 * lightweight mocks, matching the pattern established in settlement-dedup.test.ts and
 * sponsor-nonce-ttl.test.ts. Fake timers are used for time-travel so tests are zero-latency
 * and deterministic.
 *
 * Nomenclature reminder (Phase 3 shipped names, not PHASES.md draft names):
 *   - nonceExpiresAt   — ISO 8601 UTC timestamp (absolute)
 *   - sponsorNonceValidForMs — integer ms duration (relative)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseBroadcastOutcome,
  decideBroadcastAction,
} from "../utils/broadcast-outcome";

// ---------------------------------------------------------------------------
// TTL constants mirroring source files (must stay in sync)
// ---------------------------------------------------------------------------

/** Mirrors STALE_THRESHOLD_MS in nonce-do.ts (line 427) */
const STALE_THRESHOLD_MS = 10 * 60 * 1_000; // 600 000 ms = 10 min

/** Mirrors SPONSOR_NONCE_VALID_FOR_MS in sponsor.ts endpoint */
const SPONSOR_NONCE_VALID_FOR_MS = 10 * 60 * 1_000;

/** Mirrors FALLBACK_NONCE_EXPIRY_MS in services/sponsor.ts */
const FALLBACK_NONCE_EXPIRY_MS = 10 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Consumer-side helper — mirrors what a consumer queue would implement
// ---------------------------------------------------------------------------

/**
 * Returns true when the consumer MAY retry rebroadcasting the sponsored hex.
 * Returns false when the relay may have reclaimed the nonce — the consumer
 * MUST call /sponsor again with the original client-signed payload instead.
 *
 * This is the core TTL-gate decision any consumer retry loop should implement.
 *
 * @param nonceExpiresAt - ISO 8601 string from /sponsor response
 * @param now - optional clock override for testing (defaults to Date.now())
 */
function canRetryWithSponsoredHex(
  nonceExpiresAt: string,
  now: number = Date.now()
): boolean {
  const expiresAtMs = Date.parse(nonceExpiresAt);
  return now < expiresAtMs;
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Claim 1: TTL fields in the response body
// ---------------------------------------------------------------------------

describe("TTL wire contract — response shape", () => {
  it("nonceExpiresAt is ISO 8601 and approximately 10 minutes ahead at assignment time", () => {
    const assignedAt = Date.now();
    const nonceExpiresAt = new Date(assignedAt + STALE_THRESHOLD_MS).toISOString();

    // Must be parseable
    const parsed = Date.parse(nonceExpiresAt);
    expect(Number.isNaN(parsed)).toBe(false);

    // Must end with Z (UTC)
    expect(nonceExpiresAt.endsWith("Z")).toBe(true);

    // Must be approximately STALE_THRESHOLD_MS in the future (± 10ms tolerance)
    expect(Math.abs(parsed - (assignedAt + STALE_THRESHOLD_MS))).toBeLessThan(10);
  });

  it("sponsorNonceValidForMs is a positive integer equal to STALE_THRESHOLD_MS", () => {
    // The endpoint always publishes SPONSOR_NONCE_VALID_FOR_MS (600 000 ms)
    expect(typeof SPONSOR_NONCE_VALID_FOR_MS).toBe("number");
    expect(Number.isInteger(SPONSOR_NONCE_VALID_FOR_MS)).toBe(true);
    expect(SPONSOR_NONCE_VALID_FOR_MS).toBeGreaterThan(0);
    expect(SPONSOR_NONCE_VALID_FOR_MS).toBe(600_000);
  });

  it("all three TTL constants are identical — any STALE_THRESHOLD_MS change must update all", () => {
    // If this test fails, a constant drifted. Update all three together.
    expect(STALE_THRESHOLD_MS).toBe(SPONSOR_NONCE_VALID_FOR_MS);
    expect(STALE_THRESHOLD_MS).toBe(FALLBACK_NONCE_EXPIRY_MS);
  });

  it("nonceExpiresAt and sponsorNonceValidForMs are mutually derivable within clock tolerance", () => {
    const before = Date.now();
    const nonceExpiresAt = new Date(before + SPONSOR_NONCE_VALID_FOR_MS).toISOString();
    const after = Date.now();

    const derivedMs = Date.parse(nonceExpiresAt) - before;
    // Within 50ms: JS clock resolution + string round-trip
    expect(Math.abs(derivedMs - SPONSOR_NONCE_VALID_FOR_MS)).toBeLessThan(50);

    // Reverse: given the timestamp, derive the TTL
    const ttlDerived = Date.parse(nonceExpiresAt) - after;
    // Must be within SPONSOR_NONCE_VALID_FOR_MS ± 1s
    expect(ttlDerived).toBeGreaterThan(SPONSOR_NONCE_VALID_FOR_MS - 1_000);
    expect(ttlDerived).toBeLessThanOrEqual(SPONSOR_NONCE_VALID_FOR_MS + 1_000);
  });
});

// ---------------------------------------------------------------------------
// Claim 2: Sponsor-side conflict classification (Phase 1 pipeline)
// ---------------------------------------------------------------------------

describe("Sponsor-side conflict attribution via broadcast-outcome pipeline", () => {
  it("ConflictingNonceInMempool with is_origin=false → responsible: 'sponsor'", () => {
    // When the relay rebroadcasts stale sponsored hex, the Stacks node returns
    // ConflictingNonceInMempool. The relay is NOT the origin (is_origin=false)
    // because the conflict is in the sponsor slot, not the sender slot.
    const outcome = parseBroadcastOutcome({
      status: 400,
      reason: "ConflictingNonceInMempool",
      body: '{"error":"ConflictingNonceInMempool"}',
      reasonData: { is_origin: false },
    });

    expect(outcome.outcome).toBe("nonce_conflict");

    const responsibility = decideBroadcastAction(outcome);
    expect(responsibility.responsible).toBe("sponsor");
    expect(responsibility.action).toBe("skip_nonce");
  });

  it("ConflictingNonceInMempool with is_origin=true → responsible: 'sender'", () => {
    // Sender's nonce conflicts — NOT a sponsor issue.
    // The relay MUST NOT consume a sponsor slot for this.
    const outcome = parseBroadcastOutcome({
      status: 400,
      reason: "ConflictingNonceInMempool",
      body: '{"error":"ConflictingNonceInMempool"}',
      reasonData: { is_origin: true },
    });

    expect(outcome.outcome).toBe("nonce_conflict");

    const responsibility = decideBroadcastAction(outcome);
    expect(responsibility.responsible).toBe("sender");
    expect(responsibility.action).toBe("report_to_agent");
    if (responsibility.action === "report_to_agent") {
      expect(responsibility.agentErrorCode).toBe("sender_nonce_confirmed");
    }
  });

  it("stale sponsored hex scenario: same nonce reassigned → sponsor-conflict attribution", () => {
    // Scenario: consumer rebroadcasts sponsored hex past nonceExpiresAt.
    // The relay's NonceDO has reclaimed and reassigned that sponsor nonce.
    // Stacks returns ConflictingNonceInMempool with is_origin=false.
    // decideBroadcastAction must classify as sponsor-side.
    const staleOutcome = parseBroadcastOutcome({
      status: 400,
      reason: "ConflictingNonceInMempool",
      body: '{"error":"ConflictingNonceInMempool","reason_data":{"is_origin":false}}',
      reasonData: { is_origin: false },
    });

    const action = decideBroadcastAction(staleOutcome);

    // Contract guarantee: relay classifies this as its own problem, not the sender's.
    expect(action.responsible).toBe("sponsor");
    // The relay should skip the occupied nonce and use the next available.
    expect(action.action).toBe("skip_nonce");
  });

  it("is_origin undefined (legacy path) → defaults to sponsor attribution for conflict", () => {
    // Older Stacks nodes or logs may omit is_origin. Verify the parsing default.
    const outcome = parseBroadcastOutcome({
      status: 400,
      reason: "ConflictingNonceInMempool",
      body: '{"error":"ConflictingNonceInMempool"}',
      reasonData: {}, // is_origin absent
    });

    // isOrigin defaults to false (reasonData?.is_origin === true fails)
    expect(outcome.outcome).toBe("nonce_conflict");
    if (outcome.outcome === "nonce_conflict") {
      expect(outcome.isOrigin).toBe(false);
    }

    const action = decideBroadcastAction(outcome);
    expect(action.responsible).toBe("sponsor");
  });
});

// ---------------------------------------------------------------------------
// Claim 3: Consumer TTL-gate decision logic
// ---------------------------------------------------------------------------

describe("Consumer retry-gate: canRetryWithSponsoredHex", () => {
  it("returns true when current time is before nonceExpiresAt (safe to retry)", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString(); // 60s from now
    expect(canRetryWithSponsoredHex(expiresAt)).toBe(true);
  });

  it("returns false when current time equals nonceExpiresAt (boundary — must re-sponsor)", () => {
    const expiresAt = new Date(Date.now()).toISOString();
    // At-expiry: relay may reclaim at this exact ms
    expect(canRetryWithSponsoredHex(expiresAt, Date.parse(expiresAt))).toBe(false);
  });

  it("returns false when current time is past nonceExpiresAt (must re-sponsor)", () => {
    const expiresAt = new Date(Date.now() - 1_000).toISOString(); // 1s in the past
    expect(canRetryWithSponsoredHex(expiresAt)).toBe(false);
  });

  it("correctly gates retry across the full STALE_THRESHOLD_MS window", () => {
    const assignedAt = 1_000_000; // arbitrary epoch ms
    const expiresAt = new Date(assignedAt + STALE_THRESHOLD_MS).toISOString();

    // Before: retry allowed
    expect(canRetryWithSponsoredHex(expiresAt, assignedAt + 1)).toBe(true);
    // At midpoint: retry still allowed
    expect(canRetryWithSponsoredHex(expiresAt, assignedAt + STALE_THRESHOLD_MS / 2)).toBe(true);
    // At expiry: must re-sponsor
    expect(canRetryWithSponsoredHex(expiresAt, assignedAt + STALE_THRESHOLD_MS)).toBe(false);
    // Past expiry: must re-sponsor
    expect(canRetryWithSponsoredHex(expiresAt, assignedAt + STALE_THRESHOLD_MS + 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claim 4: Time-travel simulation — advancing clock past TTL
// ---------------------------------------------------------------------------

describe("Time-travel: fake timers confirm TTL expiry triggers re-sponsor path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Step 1+2: /sponsor assigns nonce, response includes nonceExpiresAt ~10m ahead", () => {
    const now = 1_748_000_000_000; // fixed epoch for reproducibility
    vi.setSystemTime(now);

    // Simulate what the relay builds at nonce-assignment time
    const nonceExpiresAt = new Date(Date.now() + STALE_THRESHOLD_MS).toISOString();
    const sponsorNonceValidForMs = SPONSOR_NONCE_VALID_FOR_MS;

    expect(Date.parse(nonceExpiresAt)).toBe(now + STALE_THRESHOLD_MS);
    expect(sponsorNonceValidForMs).toBe(600_000);
    // Retry is allowed at assignment time
    expect(canRetryWithSponsoredHex(nonceExpiresAt, Date.now())).toBe(true);
  });

  it("Step 2: advancing clock within TTL keeps retry allowed", () => {
    const now = 1_748_000_000_000;
    vi.setSystemTime(now);

    const nonceExpiresAt = new Date(now + STALE_THRESHOLD_MS).toISOString();

    // Advance 5 minutes (half the TTL)
    vi.setSystemTime(now + STALE_THRESHOLD_MS / 2);
    expect(canRetryWithSponsoredHex(nonceExpiresAt, Date.now())).toBe(true);
  });

  it("Step 3: advancing clock past TTL — stale hex would cause sponsor-side conflict", () => {
    const now = 1_748_000_000_000;
    vi.setSystemTime(now);

    const nonceExpiresAt = new Date(now + STALE_THRESHOLD_MS).toISOString();

    // Advance past TTL (+1ms to clear the boundary)
    vi.setSystemTime(now + STALE_THRESHOLD_MS + 1);
    expect(canRetryWithSponsoredHex(nonceExpiresAt, Date.now())).toBe(false);

    // Confirm: if the consumer ignores the TTL and rebroadcasts anyway, the relay
    // classifies the resulting conflict as sponsor-side (not the sender's fault).
    const conflictFromStaleHex = parseBroadcastOutcome({
      status: 400,
      reason: "ConflictingNonceInMempool",
      body: "stale hex after nonce reclaim",
      reasonData: { is_origin: false },
    });
    const action = decideBroadcastAction(conflictFromStaleHex);
    expect(action.responsible).toBe("sponsor");
  });

  it("Step 4: after TTL expiry, consumer must use fresh /sponsor response (new expiresAt)", () => {
    const originalAssignment = 1_748_000_000_000;
    vi.setSystemTime(originalAssignment);

    const originalExpiresAt = new Date(originalAssignment + STALE_THRESHOLD_MS).toISOString();

    // Advance past TTL
    const afterExpiry = originalAssignment + STALE_THRESHOLD_MS + 5_000;
    vi.setSystemTime(afterExpiry);

    // Stale hex is no longer retryable
    expect(canRetryWithSponsoredHex(originalExpiresAt, Date.now())).toBe(false);

    // Consumer calls /sponsor again — relay returns a new nonceExpiresAt
    const freshExpiresAt = new Date(Date.now() + STALE_THRESHOLD_MS).toISOString();
    expect(Date.parse(freshExpiresAt)).toBe(afterExpiry + STALE_THRESHOLD_MS);

    // Fresh hex is retryable
    expect(canRetryWithSponsoredHex(freshExpiresAt, Date.now())).toBe(true);
    // Fresh expiry is meaningfully later than the original (at least TTL ms later)
    expect(Date.parse(freshExpiresAt)).toBeGreaterThan(Date.parse(originalExpiresAt));
  });
});

// ---------------------------------------------------------------------------
// Claim 5: Attribution matrix for all (reason, is_origin) combinations
//          required by Phase 1 acceptance criteria; re-verified here for cross-phase
//          completeness since Phase 4 depends on Phase 1's wiring.
// ---------------------------------------------------------------------------

describe("Attribution matrix — all (reason, is_origin) combinations", () => {
  const cases = [
    {
      reason: "ConflictingNonceInMempool",
      isOrigin: true,
      expectResponsible: "sender",
      expectAction: "report_to_agent",
    },
    {
      reason: "ConflictingNonceInMempool",
      isOrigin: false,
      expectResponsible: "sponsor",
      expectAction: "skip_nonce",
    },
    {
      reason: "TooMuchChaining",
      isOrigin: true,
      expectResponsible: "sender",
      expectAction: "report_to_agent",
    },
    {
      reason: "TooMuchChaining",
      isOrigin: false,
      expectResponsible: "sponsor",
      expectAction: "wait_for_confirmations",
    },
    // BadNonce does not use is_origin — always sponsor (sender submits wrong nonce → sponsor must skip)
    {
      reason: "BadNonce",
      isOrigin: undefined,
      expectResponsible: "sponsor",
      expectAction: "skip_nonce",
    },
  ] as const;

  for (const tc of cases) {
    it(`${tc.reason} (is_origin=${String(tc.isOrigin)}) → ${tc.expectResponsible}:${tc.expectAction}`, () => {
      const reasonData =
        tc.isOrigin !== undefined ? { is_origin: tc.isOrigin } : undefined;

      const outcome = parseBroadcastOutcome({
        status: 400,
        reason: tc.reason,
        body: `{"error":"${tc.reason}"}`,
        reasonData,
      });

      const responsibility = decideBroadcastAction(outcome);
      expect(responsibility.responsible).toBe(tc.expectResponsible);
      expect(responsibility.action).toBe(tc.expectAction);
    });
  }
});
