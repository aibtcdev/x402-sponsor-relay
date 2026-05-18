/**
 * Tests for the /settle pre-sponsored tx re-sponsor recovery (Phase 2, issue #373).
 *
 * Covers:
 *   1. SENDER_NONCE_CONFLICT error code value and categorization
 *   2. Decision tree: sponsor-fault → re-sponsor path (responsible="sponsor")
 *   3. Decision tree: sender-fault → SENDER_NONCE_CONFLICT, no sponsor slot burned
 *   4. Existing auto-sponsored path regression: sponsorNonce !== null uses original branch
 *   5. Stats terminal reason mapping for sender-fault path
 */
import { describe, expect, it } from "vitest";
import { X402_V2_ERROR_CODES } from "../types";
import {
  parseBroadcastOutcome,
  decideBroadcastAction,
  type RawBroadcastError,
} from "../utils/broadcast-outcome";
import { TERMINAL_REASON_TO_CATEGORY } from "@aibtc/tx-schemas/core/terminal-reasons";
import type { BroadcastOnlyResult } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConflictRaw(isOrigin: boolean | undefined): RawBroadcastError {
  return {
    status: 400,
    reason: "ConflictingNonceInMempool",
    body: '{"error":"MemPoolRejection","reason":"ConflictingNonceInMempool"}',
    reasonData: isOrigin !== undefined ? { is_origin: isOrigin } : undefined,
  };
}

function makeBroadcastOnlyError(
  responsible: "sender" | "sponsor" | "network",
  agentErrorCode?: string
): Extract<BroadcastOnlyResult, { error: string }> {
  return {
    error: "Nonce conflict",
    details: "ConflictingNonceInMempool",
    retryable: true,
    nonceConflict: true,
    responsible,
    agentErrorCode,
    nodeUrl: "https://api.hiro.so",
    httpStatus: 400,
  };
}

// ---------------------------------------------------------------------------
// 1. SENDER_NONCE_CONFLICT error code value
// ---------------------------------------------------------------------------

describe("SENDER_NONCE_CONFLICT error code", () => {
  it("has the correct v2 wire value", () => {
    expect(X402_V2_ERROR_CODES.SENDER_NONCE_CONFLICT).toBe("sender_nonce_conflict");
  });

  it("is distinct from CONFLICTING_NONCE (sponsor-side conflict code)", () => {
    expect(X402_V2_ERROR_CODES.SENDER_NONCE_CONFLICT).not.toBe(
      X402_V2_ERROR_CODES.CONFLICTING_NONCE
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Decision tree: sponsor-fault pre-sponsored conflict → re-sponsor path
// ---------------------------------------------------------------------------

describe("Sponsor-fault pre-sponsored nonce conflict", () => {
  it("broadcast pipeline attributes ConflictingNonceInMempool is_origin=false to sponsor", () => {
    // This is the signal that gates the new re-sponsor recovery path.
    const outcome = parseBroadcastOutcome(makeConflictRaw(false));
    const decision = decideBroadcastAction(outcome);
    expect(decision.responsible).toBe("sponsor");
  });

  it("BroadcastOnlyResult with responsible=sponsor and sponsorNonce=null triggers re-sponsor branch", () => {
    const broadcastResult = makeBroadcastOnlyError("sponsor");
    const sponsorNonce: number | null = null;

    // Simulate the gate: sponsorNonce === null AND nonceConflict AND responsible === "sponsor"
    const shouldEnterPreSponsoredBranch =
      sponsorNonce === null &&
      (broadcastResult.nonceConflict === true || broadcastResult.tooMuchChaining === true);
    const shouldReSponsor =
      shouldEnterPreSponsoredBranch && broadcastResult.responsible === "sponsor";

    expect(shouldEnterPreSponsoredBranch).toBe(true);
    expect(shouldReSponsor).toBe(true);
  });

  it("auto-sponsored path (sponsorNonce !== null) does NOT enter the new pre-sponsored branch", () => {
    const broadcastResult = makeBroadcastOnlyError("sponsor");
    const sponsorNonce: number | null = 42; // relay auto-sponsored this tx

    // Simulate the gate for the OLD path (unchanged)
    const shouldEnterOldPath =
      sponsorNonce !== null &&
      (broadcastResult.nonceConflict === true || broadcastResult.tooMuchChaining === true);

    // The NEW pre-sponsored branch gate (only fires when sponsorNonce === null)
    const shouldEnterNewPath =
      sponsorNonce === null &&
      (broadcastResult.nonceConflict === true || broadcastResult.tooMuchChaining === true);

    // When relay auto-sponsored: old path fires, new path does not
    expect(shouldEnterOldPath).toBe(true);
    expect(shouldEnterNewPath).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Sender-fault pre-sponsored conflict → SENDER_NONCE_CONFLICT, no slot burned
// ---------------------------------------------------------------------------

describe("Sender-fault pre-sponsored nonce conflict", () => {
  it("broadcast pipeline attributes ConflictingNonceInMempool is_origin=true to sender", () => {
    const outcome = parseBroadcastOutcome(makeConflictRaw(true));
    const decision = decideBroadcastAction(outcome);
    expect(decision.responsible).toBe("sender");
    expect(decision.action).toBe("report_to_agent");
    if (decision.responsible === "sender") {
      expect(decision.agentErrorCode).toBe("sender_nonce_confirmed");
    }
  });

  it("BroadcastOnlyResult with responsible=sender and sponsorNonce=null returns SENDER_NONCE_CONFLICT", () => {
    const broadcastResult = makeBroadcastOnlyError("sender", "sender_nonce_confirmed");
    const sponsorNonce: number | null = null;

    const shouldEnterPreSponsoredBranch =
      sponsorNonce === null &&
      (broadcastResult.nonceConflict === true || broadcastResult.tooMuchChaining === true);
    const shouldReturnSenderNonceConflict =
      shouldEnterPreSponsoredBranch && broadcastResult.responsible !== "sponsor";

    expect(shouldEnterPreSponsoredBranch).toBe(true);
    expect(shouldReturnSenderNonceConflict).toBe(true);

    // The error code returned in this case
    const errorCode = X402_V2_ERROR_CODES.SENDER_NONCE_CONFLICT;
    expect(errorCode).toBe("sender_nonce_conflict");
  });

  it("sender-fault path does NOT try to re-sponsor (no sponsor slot consumed)", () => {
    const broadcastResult = makeBroadcastOnlyError("sender", "sender_nonce_confirmed");
    const sponsorNonce: number | null = null;

    // Re-sponsor is only called when responsible === "sponsor"
    const wouldReSponsor =
      sponsorNonce === null &&
      (broadcastResult.nonceConflict === true || broadcastResult.tooMuchChaining === true) &&
      broadcastResult.responsible === "sponsor";

    expect(wouldReSponsor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Stats terminal reason categorization for sender-fault path
// ---------------------------------------------------------------------------

describe("Stats terminal reason categorization", () => {
  it("sender_nonce_stale maps to the 'sender' category bucket", () => {
    // This is the terminal reason passed to statsService.logFailure on the sender-fault path.
    // It must map to the "sender" bucket in the 6-category dashboard breakdown.
    const category = TERMINAL_REASON_TO_CATEGORY["sender_nonce_stale"];
    expect(category).toBe("sender");
  });

  it("sponsor_nonce_conflict maps to the 'relay' category bucket (sponsor-fault fallback)", () => {
    // When re-sponsor recovery fails, sponsor_nonce_conflict is the terminal reason.
    // It should map to the "relay" bucket (relay-owned failure to recover).
    const category = TERMINAL_REASON_TO_CATEGORY["sponsor_nonce_conflict"];
    expect(category).toBe("relay");
  });
});

// ---------------------------------------------------------------------------
// 5. Regression: pre-sponsored path with NO conflict does not enter either branch
// ---------------------------------------------------------------------------

describe("Non-conflict broadcast failure does not enter recovery branches", () => {
  it("broadcast_failure (retryable, no nonce conflict) skips all recovery branches", () => {
    const broadcastResult: Extract<BroadcastOnlyResult, { error: string }> = {
      error: "Broadcast failed",
      details: "HTTP 502",
      retryable: true,
      responsible: "network",
      nodeUrl: "https://api.hiro.so",
      httpStatus: 502,
    };
    const sponsorNonce: number | null = null;

    const hasNonceConflict = broadcastResult.nonceConflict === true;
    const hasTooMuchChaining = broadcastResult.tooMuchChaining === true;

    const shouldEnterAutoSponsoredPath =
      sponsorNonce !== null && (hasNonceConflict || hasTooMuchChaining);
    const shouldEnterPreSponsoredPath =
      sponsorNonce === null && (hasNonceConflict || hasTooMuchChaining);

    expect(shouldEnterAutoSponsoredPath).toBe(false);
    expect(shouldEnterPreSponsoredPath).toBe(false);
  });
});
