import { describe, expect, it } from "vitest";
import { AuthService, type UsageData } from "../services/auth";
import { MemoryKV } from "./helpers/memory-kv";
import type { Logger } from "../types";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const KEY_ID = "0f1e2d3c4b5a6978";
const FEE = 3000n;

function sponsoredUsage(fee: bigint): UsageData & { fee: string } {
  return {
    success: true,
    tokenType: "sBTC",
    amount: "1000",
    fee: fee.toString(),
  };
}

async function todayUsage(auth: AuthService) {
  const date = new Date().toISOString().split("T")[0];
  return auth.getUsage(KEY_ID, date);
}

describe("sponsor fee accounting", () => {
  it("recordUsage tracks volume without applying a fee field", async () => {
    const auth = new AuthService(new MemoryKV(), noopLogger);

    await auth.recordUsage(KEY_ID, sponsoredUsage(FEE));

    const usage = await todayUsage(auth);
    expect(usage?.feesPaid).toBe("0");
    expect(usage?.volume.sBTC).toBe("1000");
    expect(usage?.success).toBe(1);
  });

  it("books one sponsored payment's fee once", async () => {
    const auth = new AuthService(new MemoryKV(), noopLogger);

    await auth.recordFeeSpent(KEY_ID, FEE);
    await auth.recordUsage(KEY_ID, sponsoredUsage(FEE));

    const usage = await todayUsage(auth);
    expect(usage?.feesPaid).toBe(FEE.toString());
  });

  it("does not halve the free tier's daily cap by double-counting", async () => {
    const auth = new AuthService(new MemoryKV(), noopLogger);
    const cap = 100_000_000n;

    for (const quarter of [cap / 4n, cap / 4n]) {
      await auth.recordFeeSpent(KEY_ID, quarter);
      await auth.recordUsage(KEY_ID, sponsoredUsage(quarter));
    }

    expect(await auth.getRemainingSpendingCap(KEY_ID, "free")).toBe(cap / 2n);
  });
});
