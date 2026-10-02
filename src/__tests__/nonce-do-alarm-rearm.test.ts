import { describe, expect, it, vi } from "vitest";
import { NonceDO } from "../durable-objects/nonce-do";

/**
 * A dropped alarm must be re-armed by the next request. Without the alarm, queued
 * entries are never broadcast and every payment holds on "capacity" indefinitely.
 */

function makeDouble(currentAlarm: number | null) {
  const setAlarm = vi.fn(async () => {});
  const log = vi.fn();
  const double = {
    state: { storage: { getAlarm: vi.fn(async () => currentAlarm), setAlarm } },
    log,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scheduleAlarm: (NonceDO as any).prototype.scheduleAlarm,
  };
  return { double, setAlarm, log };
}

const run = (double: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NonceDO as any).prototype.ensureAlarm.call(double);

describe("NonceDO ensureAlarm", () => {
  it("re-arms the alarm at the active interval when none is scheduled", async () => {
    const { double, setAlarm, log } = makeDouble(null);
    const before = Date.now();

    await run(double);

    expect(setAlarm).toHaveBeenCalledTimes(1);
    const at = setAlarm.mock.calls[0][0] as number;
    expect(at).toBeGreaterThan(before);
    expect(at - before).toBeLessThanOrEqual(5 * 60_000);
    expect(log).toHaveBeenCalledWith("warn", "nonce_alarm_rearmed", {});
  });

  it("leaves a scheduled alarm alone", async () => {
    const { double, setAlarm, log } = makeDouble(Date.now() + 30_000);

    await run(double);

    expect(setAlarm).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
