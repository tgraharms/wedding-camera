import { describe, it, expect, vi } from "vitest";
import { makeEventsCache } from "./events";

const env = {} as never;
const akad = { id: "a", name: "Akad", window_start: "2026-09-19T03:00:00Z", window_end: "2026-09-19T10:00:00Z" };

describe("makeEventsCache", () => {
  it("serves 100 calls inside one TTL from a single fetch", async () => {
    const fetchEvents = vi.fn().mockResolvedValue([akad]);
    const get = makeEventsCache(fetchEvents, { ttlMs: 15_000, now: () => 1000 });
    for (let i = 0; i < 100; i++) expect(await get(env)).toEqual([akad]);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has passed", async () => {
    let t = 1000;
    const fetchEvents = vi.fn().mockResolvedValue([akad]);
    const get = makeEventsCache(fetchEvents, { ttlMs: 15_000, now: () => t });
    await get(env);
    t += 14_999;
    await get(env);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    t += 1;
    await get(env);
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent callers on a cold cache into one fetch", async () => {
    let resolve!: (v: unknown[]) => void;
    const fetchEvents = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    const get = makeEventsCache(fetchEvents, { ttlMs: 15_000, now: () => 1000 });
    const calls = Array.from({ length: 10 }, () => get(env));
    resolve([akad]);
    const results = await Promise.all(calls);
    expect(results.every((r) => r.length === 1)).toBe(true);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
  });

  it("serves the last-known list when a refetch throws and stale is allowed", async () => {
    let t = 1000;
    const fetchEvents = vi.fn().mockResolvedValueOnce([akad]).mockRejectedValueOnce(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const get = makeEventsCache(fetchEvents, { ttlMs: 15_000, now: () => t });
    await get(env);
    t += 15_000;
    expect(await get(env, { allowStale: true })).toEqual([akad]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Proves the contract fetchEventsFromDb's abortSignal(AbortSignal.timeout(...))
  // relies on: the stale fallback only helps once the refetch SETTLES. A refetch
  // that eventually rejects (rather than hangs forever) still serves the
  // last-known list to every caller waiting on it.
  it("serves the last-known list when a warm cache's refetch rejects after a delay", async () => {
    vi.useFakeTimers();
    try {
      let t = 1000;
      const fetchEvents = vi
        .fn()
        .mockResolvedValueOnce([akad])
        .mockImplementationOnce(
          () => new Promise((_, reject) => setTimeout(() => reject(new Error("query timed out")), 5_000))
        );
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const get = makeEventsCache(fetchEvents, { ttlMs: 15_000, now: () => t });
      await get(env, { allowStale: true });
      t += 15_000;
      const pending = get(env, { allowStale: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual([akad]);
      consoleError.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows on a cold cache, and when stale is not allowed", async () => {
    const cold = makeEventsCache(vi.fn().mockRejectedValue(new Error("db down")), { now: () => 1000 });
    await expect(cold(env, { allowStale: true })).rejects.toThrow("db down");

    let t = 1000;
    const fetchEvents = vi.fn().mockResolvedValueOnce([akad]).mockRejectedValueOnce(new Error("db down"));
    const warm = makeEventsCache(fetchEvents, { ttlMs: 15_000, now: () => t });
    await warm(env);
    t += 15_000;
    await expect(warm(env, { allowStale: false })).rejects.toThrow("db down");
  });

  it("defaults allowStale to false: a warm cache with no options rejects on a failed refetch", async () => {
    let t = 1000;
    const fetchEvents = vi.fn().mockResolvedValueOnce([akad]).mockRejectedValueOnce(new Error("db down"));
    const get = makeEventsCache(fetchEvents, { ttlMs: 15_000, now: () => t });
    await get(env);
    t += 15_000;
    await expect(get(env)).rejects.toThrow("db down");
  });

  it("retries the fetch on the next call after a failure (no poisoned in-flight promise)", async () => {
    const fetchEvents = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce([akad]);
    const get = makeEventsCache(fetchEvents, { now: () => 1000 });
    await expect(get(env)).rejects.toThrow("db down");
    expect(await get(env)).toEqual([akad]);
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });
});
