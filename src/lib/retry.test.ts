import { describe, it, expect, vi } from "vitest";
import { withRetry } from "./retry";

// A sleep stub that records the delays it was asked for instead of waiting.
function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => { delays.push(ms); } };
}

describe("withRetry", () => {
  it("returns the value without sleeping when the first call succeeds", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(withRetry(fn, { sleep })).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries after a failure and returns the eventual success", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");

    await expect(withRetry(fn, { sleep, jitter: () => 1 })).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]);
  });

  it("backs off exponentially: 1s, 2s, 4s across four total attempts", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new Error("always down"));

    await expect(withRetry(fn, { sleep, jitter: () => 1 })).rejects.toThrow("always down");

    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("rethrows the final error rather than a generic one", async () => {
    const { sleep } = recordingSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValue(new Error("last"));

    await expect(withRetry(fn, { attempts: 2, sleep })).rejects.toThrow("last");
  });

  it("honours a custom attempt count and base delay", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new Error("nope"));

    await expect(
      withRetry(fn, { attempts: 3, baseDelayMs: 50, sleep, jitter: () => 1 })
    ).rejects.toThrow("nope");

    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([50, 100]);
  });

  it("gives up immediately when shouldRetry rejects the error", async () => {
    const { delays, sleep } = recordingSleep();
    class NotTransient extends Error {}
    const fn = vi.fn().mockRejectedValue(new NotTransient("unauthorized"));

    await expect(
      withRetry(fn, { sleep, shouldRetry: (e) => !(e instanceof NotTransient) })
    ).rejects.toThrow("unauthorized");

    expect(fn).toHaveBeenCalledTimes(1); // no point retrying a 401
    expect(delays).toEqual([]);
  });

  it("applies the jitter factor to every sleep", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new Error("always down"));
    await expect(withRetry(fn, { sleep, jitter: () => 1.1 })).rejects.toThrow("always down");
    expect(delays).toEqual([1100, 2200, 4400]);
  });

  it("still retries errors that shouldRetry accepts", async () => {
    const { delays, sleep } = recordingSleep();
    class NotTransient extends Error {}
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    await expect(
      withRetry(fn, { sleep, shouldRetry: (e) => !(e instanceof NotTransient), jitter: () => 1 })
    ).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]);
  });

  it("does not sleep after the final attempt", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new Error("nope"));

    await expect(withRetry(fn, { attempts: 1, sleep, jitter: () => 1 })).rejects.toThrow("nope");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
