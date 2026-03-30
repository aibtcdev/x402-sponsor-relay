/**
 * Unit tests for payment validation logic.
 *
 * Covers:
 * - SettlementService.validateSettleOptions — required fields, format, and token type checks
 * - SettlementService.mapAssetToTokenType — asset string to TokenType mapping
 * - stripHexPrefix utility — 0x prefix stripping
 *
 * These methods are pure (no I/O, no KV, no network) so they run without any
 * Cloudflare Worker runtime and without mocking fetch.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SettlementService } from "../services/settlement";
import { stripHexPrefix } from "../utils/stacks";
import type { Env, Logger } from "../types";

// ---------------------------------------------------------------------------
// Minimal test doubles
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeService(network: "mainnet" | "testnet" = "testnet"): SettlementService {
  const env: Partial<Env> = { STACKS_NETWORK: network };
  return new SettlementService(env as Env, noopLogger);
}

// ---------------------------------------------------------------------------
// stripHexPrefix
// ---------------------------------------------------------------------------

describe("stripHexPrefix", () => {
  it("strips the 0x prefix when present", () => {
    expect(stripHexPrefix("0xdeadbeef")).toBe("deadbeef");
  });

  it("returns the string unchanged when no 0x prefix", () => {
    expect(stripHexPrefix("deadbeef")).toBe("deadbeef");
  });

  it("handles an empty string without throwing", () => {
    expect(stripHexPrefix("")).toBe("");
  });

  it("does not strip 0X (case-sensitive)", () => {
    expect(stripHexPrefix("0Xdeadbeef")).toBe("0Xdeadbeef");
  });
});

// ---------------------------------------------------------------------------
// SettlementService.validateSettleOptions
// ---------------------------------------------------------------------------

describe("SettlementService.validateSettleOptions", () => {
  let service: SettlementService;

  beforeEach(() => {
    service = makeService();
  });

  it("accepts a valid STX settle request", () => {
    const result = service.validateSettleOptions({
      expectedRecipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
      minAmount: "1000000",
      tokenType: "STX",
    });
    expect(result).toEqual({ valid: true });
  });

  it("accepts a valid sBTC settle request", () => {
    const result = service.validateSettleOptions({
      expectedRecipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
      minAmount: "100",
      tokenType: "sBTC",
    });
    expect(result).toEqual({ valid: true });
  });

  it("defaults tokenType to STX when omitted", () => {
    const result = service.validateSettleOptions({
      expectedRecipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
      minAmount: "500",
    });
    expect(result).toEqual({ valid: true });
  });

  it("rejects when expectedRecipient is missing", () => {
    const result = service.validateSettleOptions({
      expectedRecipient: "",
      minAmount: "1000000",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.details).toMatch(/required/i);
    }
  });

  it("rejects when minAmount is missing", () => {
    const result = service.validateSettleOptions({
      expectedRecipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
      minAmount: "",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.details).toMatch(/required/i);
    }
  });

  it("rejects a non-numeric minAmount", () => {
    const result = service.validateSettleOptions({
      expectedRecipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
      minAmount: "not-a-number",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(/amount/i);
    }
  });

  it("rejects a decimal minAmount", () => {
    const result = service.validateSettleOptions({
      expectedRecipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
      minAmount: "100.5",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects an unsupported tokenType", () => {
    const result = service.validateSettleOptions({
      expectedRecipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
      minAmount: "1000",
      tokenType: "DOGE" as "STX",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.details).toMatch(/unsupported token type/i);
    }
  });

  it("accepts zero as a valid minAmount (free relay)", () => {
    const result = service.validateSettleOptions({
      expectedRecipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
      minAmount: "0",
    });
    expect(result).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// SettlementService.mapAssetToTokenType
// ---------------------------------------------------------------------------

describe("SettlementService.mapAssetToTokenType", () => {
  let service: SettlementService;

  beforeEach(() => {
    service = makeService("mainnet");
  });

  it("maps 'STX' to TokenType STX", () => {
    expect(service.mapAssetToTokenType("STX")).toBe("STX");
  });

  it("maps 'sBTC' (case-insensitive) to TokenType sBTC", () => {
    expect(service.mapAssetToTokenType("sBTC")).toBe("sBTC");
    expect(service.mapAssetToTokenType("SBTC")).toBe("sBTC");
  });

  it("maps 'USDCx' (case-insensitive) to TokenType USDCx", () => {
    expect(service.mapAssetToTokenType("USDCx")).toBe("USDCx");
    expect(service.mapAssetToTokenType("USDCX")).toBe("USDCx");
  });

  it("maps the mainnet sBTC bare contract principal to sBTC", () => {
    // SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
    expect(
      service.mapAssetToTokenType(
        "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token"
      )
    ).toBe("sBTC");
  });

  it("maps the Circle USDCx bare contract principal to USDCx", () => {
    expect(
      service.mapAssetToTokenType(
        "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx"
      )
    ).toBe("USDCx");
  });

  it("maps the aeUSDC contract principal to USDCx", () => {
    expect(
      service.mapAssetToTokenType(
        "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-aeusdc"
      )
    ).toBe("USDCx");
  });

  it("maps a CAIP-19 STX FT identifier for sBTC to sBTC", () => {
    expect(
      service.mapAssetToTokenType(
        "stacks:1/sip010:SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token.sbtc-token"
      )
    ).toBe("sBTC");
  });

  it("returns null for an unknown contract", () => {
    expect(service.mapAssetToTokenType("SP123.unknown-token")).toBeNull();
  });

  it("returns null for a completely unrecognized string", () => {
    expect(service.mapAssetToTokenType("BANANA")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(service.mapAssetToTokenType("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SettlementService.awaitConfirmationPublic
// ---------------------------------------------------------------------------

describe("SettlementService.awaitConfirmationPublic", () => {
  let service: SettlementService;

  beforeEach(() => {
    service = makeService("mainnet");
  });

  it("returns immediately when the first Hiro status check is already confirmed", async () => {
    const fetchSpy = vi
      .spyOn(service, "fetchHiroTxStatus")
      .mockResolvedValue({ txStatus: "success", blockHeight: 12345 });
    const pollSpy = vi.spyOn(service, "pollForConfirmationPublic");

    await expect(service.awaitConfirmationPublic("0xabc")).resolves.toEqual({
      txid: "0xabc",
      status: "confirmed",
      blockHeight: 12345,
    });

    expect(fetchSpy).toHaveBeenCalledWith("0xabc");
    expect(pollSpy).not.toHaveBeenCalled();
  });

  it("returns immediately when the first Hiro status check is already aborted", async () => {
    const fetchSpy = vi
      .spyOn(service, "fetchHiroTxStatus")
      .mockResolvedValue({ txStatus: "abort_by_response" });
    const pollSpy = vi.spyOn(service, "pollForConfirmationPublic");

    await expect(service.awaitConfirmationPublic("0xdef")).resolves.toEqual({
      error: "Transaction failed on-chain",
      details: "tx_status: abort_by_response",
      retryable: false,
    });

    expect(fetchSpy).toHaveBeenCalledWith("0xdef");
    expect(pollSpy).not.toHaveBeenCalled();
  });

  it("clamps the fallback poll budget to the caller budget for very small waits", async () => {
    vi.spyOn(service, "fetchHiroTxStatus").mockResolvedValue({ txStatus: "pending" });
    const pollSpy = vi
      .spyOn(service, "pollForConfirmationPublic")
      .mockResolvedValue({ txid: "0xsmall", status: "pending" });

    await expect(service.awaitConfirmationPublic("0xsmall", 5_000)).resolves.toEqual({
      txid: "0xsmall",
      status: "pending",
    });

    expect(pollSpy).toHaveBeenCalledWith("0xsmall", 5_000);
  });
});
