import { describe, expect, it } from "vitest";
import { Health, buildNonceHealthState } from "../endpoints/health";

describe("buildNonceHealthState", () => {
  it("reports poolAvailabilityRatio instead of effectiveCapacity", () => {
    const state = buildNonceHealthState(
      {
        poolAvailable: 15,
        poolReserved: 2,
        conflictsDetected: 0,
        lastGapDetected: null,
      },
      Date.parse("2026-03-30T18:20:10.000Z")
    );

    expect(state.poolAvailabilityRatio).toBe(0.88);
    expect(state.poolStatus).toBe("healthy");
    expect(state).not.toHaveProperty("effectiveCapacity");
  });

  it("opens the circuit breaker when a recent conflict drained the pool", () => {
    const state = buildNonceHealthState(
      {
        poolAvailable: 0,
        poolReserved: 0,
        conflictsDetected: 2,
        lastGapDetected: "2026-03-30T18:19:55.000Z",
      },
      Date.parse("2026-03-30T18:20:10.000Z")
    );

    expect(state.poolAvailabilityRatio).toBe(1);
    expect(state.circuitBreakerOpen).toBe(true);
    expect(state.poolStatus).toBe("critical");
  });
});

describe("Health schema", () => {
  it("documents poolAvailabilityRatio on the thin nonce summary", () => {
    const endpoint = new Health();
    const nonceProperties =
      endpoint.schema.responses["200"].content["application/json"].schema.properties.nonce.properties;

    expect(nonceProperties).toHaveProperty("poolAvailabilityRatio");
    expect(nonceProperties).not.toHaveProperty("effectiveCapacity");
  });
});
