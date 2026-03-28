/**
 * Unit tests for /health status derivation logic.
 *
 * Covers:
 * - derivePoolStatus — maps (effectiveCapacity, circuitBreakerOpen) → PoolStatus
 * - top-level status derivation — "ok" vs "degraded" based on poolStatus
 *
 * Pure functions inlined here (no Worker runtime, no crypto dependencies).
 * Mirrors the logic in src/endpoints/health.ts exactly.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Inline mirrors of health.ts pure logic
// These must stay in sync with src/endpoints/health.ts
// ---------------------------------------------------------------------------

const CAPACITY_HEALTHY_THRESHOLD = 0.6;
const CAPACITY_CRITICAL_THRESHOLD = 0.2;

type PoolStatus = "healthy" | "degraded" | "critical";

function derivePoolStatus(effectiveCapacity: number, circuitBreakerOpen: boolean): PoolStatus {
  if (circuitBreakerOpen || effectiveCapacity < CAPACITY_CRITICAL_THRESHOLD) {
    return "critical";
  }
  if (effectiveCapacity < CAPACITY_HEALTHY_THRESHOLD) {
    return "degraded";
  }
  return "healthy";
}

function deriveTopLevelStatus(poolStatus: PoolStatus | null): "ok" | "degraded" {
  // Mirrors Health.handle():
  //   const status = nonceState !== null && nonceState.poolStatus !== "healthy" ? "degraded" : "ok";
  return poolStatus !== null && poolStatus !== "healthy" ? "degraded" : "ok";
}

// ---------------------------------------------------------------------------
// derivePoolStatus
// ---------------------------------------------------------------------------

describe("derivePoolStatus", () => {
  it("returns 'healthy' when capacity ≥ 60% and circuit breaker closed", () => {
    expect(derivePoolStatus(1.0, false)).toBe("healthy");
    expect(derivePoolStatus(0.6, false)).toBe("healthy");
    expect(derivePoolStatus(0.75, false)).toBe("healthy");
  });

  it("returns 'degraded' when capacity is between 20% and 60% and circuit breaker closed", () => {
    expect(derivePoolStatus(0.59, false)).toBe("degraded");
    expect(derivePoolStatus(0.4, false)).toBe("degraded");
    expect(derivePoolStatus(0.2, false)).toBe("degraded");
  });

  it("returns 'critical' when capacity < 20%", () => {
    expect(derivePoolStatus(0.19, false)).toBe("critical");
    expect(derivePoolStatus(0.0, false)).toBe("critical");
  });

  it("returns 'critical' when circuit breaker is open regardless of capacity", () => {
    expect(derivePoolStatus(1.0, true)).toBe("critical");
    expect(derivePoolStatus(0.6, true)).toBe("critical");
    expect(derivePoolStatus(0.3, true)).toBe("critical");
    expect(derivePoolStatus(0.0, true)).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// top-level status derivation
// ---------------------------------------------------------------------------

describe("top-level status derivation", () => {
  it("returns 'ok' when poolStatus is 'healthy'", () => {
    expect(deriveTopLevelStatus("healthy")).toBe("ok");
  });

  it("returns 'degraded' when poolStatus is 'degraded'", () => {
    expect(deriveTopLevelStatus("degraded")).toBe("degraded");
  });

  it("returns 'degraded' when poolStatus is 'critical'", () => {
    // Both 'degraded' and 'critical' pool states map to top-level "degraded"
    // so consumers checking status === "ok" correctly detect any degradation.
    expect(deriveTopLevelStatus("critical")).toBe("degraded");
  });

  it("returns 'ok' when nonce state is unavailable (null)", () => {
    // When the NonceDO coordinator is unreachable, we stay 'ok' and degrade
    // gracefully — coordinator unavailability is logged separately.
    expect(deriveTopLevelStatus(null)).toBe("ok");
  });
});
