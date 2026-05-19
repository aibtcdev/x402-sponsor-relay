/**
 * Unit tests for parseBroadcastOutcome + decideBroadcastAction.
 *
 * Full matrix: (reason ∈ {BadNonce, ConflictingNonceInMempool, TooMuchChaining})
 *              × (is_origin ∈ {true, false, undefined})
 *
 * Plus additional coverage for non-nonce reasons.
 */
import { describe, expect, it } from "vitest";
import {
  parseBroadcastOutcome,
  decideBroadcastAction,
  type RawBroadcastError,
} from "../utils/broadcast-outcome";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaw(
  reason: string,
  statusOverride?: number,
  reasonData?: Record<string, unknown>
): RawBroadcastError {
  return {
    status: statusOverride ?? 400,
    reason,
    body: `{"error":"MemPoolRejection","reason":"${reason}"}`,
    reasonData,
  };
}

function pipeline(raw: RawBroadcastError) {
  const outcome = parseBroadcastOutcome(raw);
  const decision = decideBroadcastAction(outcome);
  return { outcome, decision };
}

// ---------------------------------------------------------------------------
// BadNonce matrix (3 cells: is_origin ∈ {true, false, undefined})
// ---------------------------------------------------------------------------

describe("BadNonce", () => {
  it("is_origin=true → responsible:sender, agentErrorCode:sender_nonce_confirmed", () => {
    const { decision } = pipeline(makeRaw("BadNonce", 400, { is_origin: true }));
    expect(decision.responsible).toBe("sender");
    expect(decision.action).toBe("report_to_agent");
    if (decision.responsible === "sender") {
      expect(decision.agentErrorCode).toBe("sender_nonce_confirmed");
    }
  });

  it("is_origin=false → responsible:sponsor, action:skip_nonce", () => {
    const { decision } = pipeline(makeRaw("BadNonce", 400, { is_origin: false }));
    expect(decision.responsible).toBe("sponsor");
    expect(decision.action).toBe("skip_nonce");
  });

  it("is_origin=undefined → responsible:sponsor, action:skip_nonce", () => {
    const { decision } = pipeline(makeRaw("BadNonce", 400, undefined));
    expect(decision.responsible).toBe("sponsor");
    expect(decision.action).toBe("skip_nonce");
  });
});

// ---------------------------------------------------------------------------
// ConflictingNonceInMempool matrix (3 cells)
// ---------------------------------------------------------------------------

describe("ConflictingNonceInMempool", () => {
  it("is_origin=true → responsible:sender, agentErrorCode:sender_nonce_confirmed", () => {
    const { decision } = pipeline(makeRaw("ConflictingNonceInMempool", 400, { is_origin: true }));
    expect(decision.responsible).toBe("sender");
    expect(decision.action).toBe("report_to_agent");
    if (decision.responsible === "sender") {
      expect(decision.agentErrorCode).toBe("sender_nonce_confirmed");
    }
  });

  it("is_origin=false → responsible:sponsor, action:skip_nonce", () => {
    const { decision } = pipeline(makeRaw("ConflictingNonceInMempool", 400, { is_origin: false }));
    expect(decision.responsible).toBe("sponsor");
    expect(decision.action).toBe("skip_nonce");
  });

  it("is_origin=undefined → responsible:sponsor, action:skip_nonce", () => {
    const { decision } = pipeline(makeRaw("ConflictingNonceInMempool", 400, undefined));
    expect(decision.responsible).toBe("sponsor");
    expect(decision.action).toBe("skip_nonce");
  });
});

// ---------------------------------------------------------------------------
// TooMuchChaining matrix (3 cells)
// ---------------------------------------------------------------------------

describe("TooMuchChaining", () => {
  it("is_origin=true → responsible:sender, agentErrorCode:origin_chaining_limit", () => {
    const { decision } = pipeline(
      makeRaw("TooMuchChaining", 400, {
        is_origin: true,
        principal: "SP1234",
        expected: 25,
        actual: 26,
      })
    );
    expect(decision.responsible).toBe("sender");
    expect(decision.action).toBe("report_to_agent");
    if (decision.responsible === "sender") {
      expect(decision.agentErrorCode).toBe("origin_chaining_limit");
    }
  });

  it("is_origin=false → responsible:sponsor, action:wait_for_confirmations", () => {
    const { decision } = pipeline(
      makeRaw("TooMuchChaining", 400, {
        is_origin: false,
        principal: "SP5678",
        expected: 20,
        actual: 21,
      })
    );
    expect(decision.responsible).toBe("sponsor");
    expect(decision.action).toBe("wait_for_confirmations");
  });

  it("is_origin=undefined → responsible:sponsor, action:wait_for_confirmations", () => {
    const { decision } = pipeline(
      makeRaw("TooMuchChaining", 400, {
        principal: "SP5678",
        expected: 20,
        actual: 21,
      })
    );
    expect(decision.responsible).toBe("sponsor");
    expect(decision.action).toBe("wait_for_confirmations");
  });
});

// ---------------------------------------------------------------------------
// Non-nonce reasons
// ---------------------------------------------------------------------------

describe("FeeTooLow", () => {
  it("→ responsible:sponsor, action:retry_with_higher_fee", () => {
    const { decision } = pipeline(
      makeRaw("FeeTooLow", 400, { expected: 2000, actual: 1000 })
    );
    expect(decision.responsible).toBe("sponsor");
    expect(decision.action).toBe("retry_with_higher_fee");
  });
});

describe("NotEnoughFunds", () => {
  it("→ responsible:sponsor, action:skip_nonce (sponsor covers fees; insufficient_funds is sponsor-side)", () => {
    // In a sponsored transaction the relay (sponsor) is responsible for ensuring
    // the sender has sufficient balance before broadcasting. The stacks-core
    // NotEnoughFunds maps to insufficient_funds → sponsor responsible.
    const { decision } = pipeline(
      makeRaw("NotEnoughFunds", 400, { expected: 5000000, actual: 0 })
    );
    expect(decision.responsible).toBe("sponsor");
    expect(decision.action).toBe("skip_nonce");
  });
});

describe("Deserialization", () => {
  it("→ responsible:sender, action:report_to_agent, code:invalid_transaction", () => {
    const { decision } = pipeline(makeRaw("Deserialization", 400));
    expect(decision.responsible).toBe("sender");
    expect(decision.action).toBe("report_to_agent");
    if (decision.responsible === "sender") {
      expect(decision.agentErrorCode).toBe("invalid_transaction");
    }
  });
});

describe("HTTP 5xx (server_error)", () => {
  it("→ responsible:network, action:retry_after_delay, retryAfterMs:10000", () => {
    const { decision } = pipeline(makeRaw("InternalError", 500));
    expect(decision.responsible).toBe("network");
    expect(decision.action).toBe("retry_after_delay");
    if (decision.responsible === "network") {
      expect(decision.retryAfterMs).toBe(10_000);
    }
  });
});

describe("HTTP 429 (rate_limited)", () => {
  it("→ responsible:network, action:retry_after_delay, retryAfterMs:30000", () => {
    const { decision } = pipeline(makeRaw("RateLimited", 429));
    expect(decision.responsible).toBe("network");
    expect(decision.action).toBe("retry_after_delay");
    if (decision.responsible === "network") {
      expect(decision.retryAfterMs).toBe(30_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-checks: parseBroadcastOutcome outcome field
// ---------------------------------------------------------------------------

describe("parseBroadcastOutcome outcomes", () => {
  it("BadNonce is_origin=true → outcome:nonce_conflict, isOrigin:true", () => {
    const outcome = parseBroadcastOutcome(makeRaw("BadNonce", 400, { is_origin: true }));
    expect(outcome.outcome).toBe("nonce_conflict");
    if (outcome.outcome === "nonce_conflict") {
      expect(outcome.isOrigin).toBe(true);
    }
  });

  it("BadNonce is_origin=false → outcome:nonce_too_low", () => {
    const outcome = parseBroadcastOutcome(makeRaw("BadNonce", 400, { is_origin: false }));
    expect(outcome.outcome).toBe("nonce_too_low");
  });

  it("ConflictingNonceInMempool is_origin=true → outcome:nonce_conflict, isOrigin:true", () => {
    const outcome = parseBroadcastOutcome(makeRaw("ConflictingNonceInMempool", 400, { is_origin: true }));
    expect(outcome.outcome).toBe("nonce_conflict");
    if (outcome.outcome === "nonce_conflict") {
      expect(outcome.isOrigin).toBe(true);
    }
  });

  it("ConflictingNonceInMempool is_origin=false → outcome:nonce_conflict, isOrigin:false", () => {
    const outcome = parseBroadcastOutcome(makeRaw("ConflictingNonceInMempool", 400, { is_origin: false }));
    expect(outcome.outcome).toBe("nonce_conflict");
    if (outcome.outcome === "nonce_conflict") {
      expect(outcome.isOrigin).toBe(false);
    }
  });
});
