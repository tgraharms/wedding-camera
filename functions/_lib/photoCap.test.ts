import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeCapGuard, GLOBAL_PHOTO_CAP } from "./photoCap";

const env = {} as never;

describe("makeCapGuard", () => {
  it("allows uploads below the cap", async () => {
    const guard = makeCapGuard(async () => 10, { cap: 100 });
    expect(await guard(env)).toBe(false);
  });

  it("reports capped at and above the cap", async () => {
    expect(await makeCapGuard(async () => 100, { cap: 100 })(env)).toBe(true);
    expect(await makeCapGuard(async () => 101, { cap: 100 })(env)).toBe(true);
  });

  it("caches the count for the TTL instead of counting per call", async () => {
    let t = 1000;
    const count = vi.fn().mockResolvedValue(5);
    const guard = makeCapGuard(count, { cap: 100, ttlMs: 30_000, now: () => t });
    await guard(env);
    await guard(env);
    t += 29_999;
    await guard(env);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("re-counts once the TTL expires", async () => {
    let t = 1000;
    const count = vi.fn().mockResolvedValue(5);
    const guard = makeCapGuard(count, { cap: 100, ttlMs: 30_000, now: () => t });
    await guard(env);
    t += 30_000;
    await guard(env);
    expect(count).toHaveBeenCalledTimes(2);
  });

  it("picks up a crossing of the cap on the next refresh", async () => {
    let t = 1000;
    const count = vi.fn().mockResolvedValueOnce(99).mockResolvedValueOnce(100);
    const guard = makeCapGuard(count, { cap: 100, ttlMs: 1000, now: () => t });
    expect(await guard(env)).toBe(false);
    t += 1000;
    expect(await guard(env)).toBe(true);
  });

  describe("when the count query fails", () => {
    beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
    afterEach(() => vi.restoreAllMocks());

    // Availability beats the abuse ceiling: a Supabase blip mid-reception must
    // not stop guests uploading. Losing the cap briefly is the cheaper failure.
    it("fails open rather than blocking uploads", async () => {
      const guard = makeCapGuard(async () => {
        throw new Error("supabase down");
      }, { cap: 1 });
      expect(await guard(env)).toBe(false);
    });

    it("does not re-run a failing count inside the TTL (fails open once per TTL, not once per call)", async () => {
      let t = 1000;
      const count = vi.fn().mockRejectedValue(new Error("db down"));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const guard = makeCapGuard(count, { cap: 100, ttlMs: 30_000, now: () => t });
      expect(await guard(env)).toBe(false);
      t += 29_999;
      expect(await guard(env)).toBe(false);
      expect(await guard(env)).toBe(false);
      expect(count).toHaveBeenCalledTimes(1);
      consoleError.mockRestore();
    });

    it("re-tries the count once the failure TTL has passed", async () => {
      let t = 1000;
      const count = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(100);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const guard = makeCapGuard(count, { cap: 100, ttlMs: 30_000, now: () => t });
      expect(await guard(env)).toBe(false);
      t += 30_000;
      expect(await guard(env)).toBe(true);
      expect(count).toHaveBeenCalledTimes(2);
      consoleError.mockRestore();
    });
  });

  // ~1,600 photos are projected. The cap only earns its keep if a busier than
  // expected reception cannot reach it by accident — several times projected
  // volume, so only deliberate abuse gets there.
  it("defaults to a cap several times the ~1600 projected photos", () => {
    expect(GLOBAL_PHOTO_CAP).toBeGreaterThanOrEqual(1600 * 4);
  });

  // Every other test injects `cap`, so without this the wiring from
  // GLOBAL_PHOTO_CAP into the default guard would go unexercised.
  it("uses GLOBAL_PHOTO_CAP when no cap is supplied", async () => {
    expect(await makeCapGuard(async () => GLOBAL_PHOTO_CAP - 1)(env)).toBe(false);
    expect(await makeCapGuard(async () => GLOBAL_PHOTO_CAP)(env)).toBe(true);
  });
});
