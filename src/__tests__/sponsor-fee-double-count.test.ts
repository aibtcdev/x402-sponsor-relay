/**
 * The daily fee total is booked twice for every sponsored payment.
 *
 * `POST /sponsor` charges the fee to the API key's daily spending cap so the
 * cap can enforce a real ceiling. It does so through two calls that each add
 * the same `fee` to `usage.feesPaid` of the same `usage:daily:{keyId}:{date}`
 * record:
 *
 *   src/endpoints/sponsor.ts:357  recordFeeSpent(keyId, fee)   -> feesPaid += fee
 *   src/endpoints/sponsor.ts:375  recordUsage({ ..., fee })     -> feesPaid += fee
 *
 * recordUsage is described there as being "for volume tracking", but its
 * `if (data.fee)` block also adds to feesPaid, so the second call doubles the
 * charge. checkSpendingCap and getRemainingSpendingCap both read that field,
 * so a free-tier key (100 STX/day, TIER_LIMITS.free) is refused at
 * SPENDING_CAP_EXCEEDED after half its real budget, and the dashboard's
 * totalFeesToday / per-key feesPaid report double what the sponsor paid.
 */

import { describe, expect, it } from "vitest";
import { AuthService } from "../services/auth";
import { MemoryKV } from "./helpers/memory-kv";
import type { Logger } from "../types";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const KEY_ID = "0f1e2d3c4b5a6978";
const FEE = 3000n; // µSTX, a SIP-010 transfer at the clamp ceiling

/** What src/endpoints/sponsor.ts does after a successful broadcast. */
async function bookSponsoredFee(auth: AuthService, fee: bigint): Promise<void> {
  await auth.recordFeeSpent(KEY_ID, fee);
  await auth.recordUsage(KEY_ID, {
    success: true,
    tokenType: "sBTC",
    amount: "1000",
    fee: fee.toString(),
  });
}

describe("sponsor fee accounting", () => {
  it("books one sponsored payment's fee once", async () => {
    const auth = new AuthService(new MemoryKV(), noopLogger);

    await bookSponsoredFee(auth, FEE);

    const date = new Date().toISOString().split("T")[0];
    const usage = await auth.getUsage(KEY_ID, date);

    expect(usage?.feesPaid).toBe(FEE.toString());
  });

  it("does not halve the free tier's daily cap by double-counting", async () => {
    const auth = new AuthService(new MemoryKV(), noopLogger);

    // The free tier's daily fee cap is 100_000_000 µSTX (100 STX). Spend a
    // quarter of it in two payments and the remaining capacity must be 75%.
    const cap = 100_000_000n;
    await bookSponsoredFee(auth, cap / 4n);
    await bookSponsoredFee(auth, cap / 4n);

    const remaining = await auth.getRemainingSpendingCap(KEY_ID, "free");

    expect(remaining).toBe(cap / 2n);
  });
});
