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
});
