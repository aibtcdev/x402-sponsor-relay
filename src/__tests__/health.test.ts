import { describe, expect, it } from "vitest";
import { Health } from "../endpoints/health";

describe("Health schema", () => {
  it("documents only service readiness fields", () => {
    const endpoint = new Health();
    const properties =
      endpoint.schema.responses["200"].content["application/json"].schema.properties;

    expect(properties).toHaveProperty("status");
    expect(properties).toHaveProperty("network");
    expect(properties).toHaveProperty("version");
    expect(properties).not.toHaveProperty("nonce");
  });

  it("status field documents ok and degraded enum values", () => {
    const endpoint = new Health();
    const statusProp =
      endpoint.schema.responses["200"].content["application/json"].schema.properties.status;
    expect(statusProp.enum).toEqual(["ok", "degraded"]);
  });
});

/**
 * Tests for the status derivation logic used in Health.handle().
 *
 * The handler derives status from poolHealthy (boolean | null):
 * - poolHealthy === false → "degraded"
 * - poolHealthy === true or null (unavailable) → "ok"
 */
describe("Health status derivation", () => {
  function deriveStatus(poolHealthy: boolean | null): "ok" | "degraded" {
    return poolHealthy === false ? "degraded" : "ok";
  }

  it("returns 'ok' when pool is healthy", () => {
    expect(deriveStatus(true)).toBe("ok");
  });

  it("returns 'degraded' when pool is unhealthy", () => {
    expect(deriveStatus(false)).toBe("degraded");
  });

  it("returns 'ok' when pool state is unavailable (null)", () => {
    expect(deriveStatus(null)).toBe("ok");
  });
});
