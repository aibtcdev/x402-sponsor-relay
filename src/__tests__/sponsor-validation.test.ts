import { beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeTransaction } from "@stacks/transactions";
import { SponsorService } from "../services/sponsor";
import type { Env, Logger } from "../types";

vi.mock("@stacks/transactions", async () => {
  const actual = await vi.importActual<typeof import("@stacks/transactions")>("@stacks/transactions");
  return {
    ...actual,
    deserializeTransaction: vi.fn(() => {
      throw new Error("mock deserialize failure");
    }),
  };
});

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeService(network: "mainnet" | "testnet" = "mainnet"): SponsorService {
  const env: Partial<Env> = { STACKS_NETWORK: network };
  return new SponsorService(env as Env, noopLogger);
}

describe("SponsorService transaction header pre-validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a standard-auth mainnet header to reach deserialization", () => {
    const service = makeService("mainnet");

    // version=0x00, chain_id=0x00000001, auth_type=0x04 (Standard)
    const result = service.validateNonSponsoredTransaction("000000000104");

    expect(deserializeTransaction).toHaveBeenCalledWith("000000000104");
    expect(result).toEqual({
      valid: false,
      error: "Invalid transaction",
      details: "Could not deserialize transaction hex",
    });
  });

  it("allows a sponsored-auth mainnet header to reach deserialization", () => {
    const service = makeService("mainnet");

    // version=0x00, chain_id=0x00000001, auth_type=0x05 (Sponsored)
    const result = service.validateTransaction("000000000105");

    expect(deserializeTransaction).toHaveBeenCalledWith("000000000105");
    expect(result).toEqual({
      valid: false,
      error: "Invalid transaction",
      details: "Could not deserialize transaction hex",
    });
  });
});
