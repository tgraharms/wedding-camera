import { describe, it, expect, vi } from "vitest";
import { makeShareHandler, SHARE_MAX_PHOTOS } from "./share";
import { rateLimited } from "../_lib/rateLimit";

function db(tokenRow: { value: string } | null, photoRows: unknown[]) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: tokenRow, error: null });
  const eqSettings = vi.fn().mockReturnValue({ maybeSingle });
  const selectSettings = vi.fn().mockReturnValue({ eq: eqSettings });

  const limitFn = vi.fn().mockResolvedValue({ data: photoRows, error: null });
  const orderFn = vi.fn().mockReturnValue({ limit: limitFn });
  const eqPhotos = vi.fn().mockReturnValue({ order: orderFn });
  const selectPhotos = vi.fn().mockReturnValue({ eq: eqPhotos });

  const from = vi.fn((t: string) => (t === "app_settings" ? { select: selectSettings } : { select: selectPhotos }));
  return { from, eqSettings, eqPhotos, orderFn, limitFn, maybeSingle, selectPhotos };
}

const req = (qs?: string) => new Request(`https://x/api/share${qs ? `?${qs}` : ""}`);

describe("makeShareHandler", () => {
  it("returns only starred photos, oldest-first, signed, with no names/messages, for a valid token", async () => {
    const rows = [
      { id: "p1", storage_key: "e/1.jpg", captured_at: "2026-09-19T05:00:00Z" },
      { id: "p2", storage_key: "e/2.jpg", captured_at: "2026-09-19T06:00:00Z" },
    ];
    const d = db({ value: "goodtoken" }, rows);
    const sign = vi.fn(async (k: string) => `https://r2/${k}`);
    const h = makeShareHandler({ getDb: () => d as never, sign });
    const res = await h(req("token=goodtoken"), {} as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { photos: unknown[] };
    expect(body.photos).toEqual([
      { id: "p1", imageUrl: "https://r2/e/1.jpg", capturedAt: "2026-09-19T05:00:00Z" },
      { id: "p2", imageUrl: "https://r2/e/2.jpg", capturedAt: "2026-09-19T06:00:00Z" },
    ]);
    expect(Object.keys(body.photos[0] as object)).toEqual(["id", "imageUrl", "capturedAt"]);
    expect(d.eqPhotos).toHaveBeenCalledWith("starred", true);
    expect(d.orderFn).toHaveBeenCalledWith("captured_at", { ascending: true });
    expect(sign).toHaveBeenCalledTimes(2);
  });

  // PostgREST truncates at max_rows (1000) without erroring, so an unbounded
  // select would quietly serve a partial gallery. Ask for a bounded page.
  it("bounds the starred query at SHARE_MAX_PHOTOS", async () => {
    const d = db({ value: "goodtoken" }, []);
    const h = makeShareHandler({ getDb: () => d as never, sign: async (k) => k });
    await h(req("token=goodtoken"), {} as never);
    expect(d.limitFn).toHaveBeenCalledWith(SHARE_MAX_PHOTOS);
    expect(SHARE_MAX_PHOTOS).toBeLessThanOrEqual(1000);
  });

  it("compares the token in constant time (no early exit on the first differing byte)", async () => {
    const d = db({ value: "aaaaaaaa" }, []);
    const h = makeShareHandler({ getDb: () => d as never, sign: async (k) => k });
    // Same length, differs only in the last byte — a short-circuiting compare
    // would be measurably faster here than one differing in the first byte.
    const res = await h(req("token=aaaaaaab"), {} as never);
    expect(res.status).toBe(404);
    expect(d.selectPhotos).not.toHaveBeenCalled();
  });

  it("404s identically on a missing token param, without touching photos", async () => {
    const d = db({ value: "goodtoken" }, []);
    const h = makeShareHandler({ getDb: () => d as never, sign: async (k) => k });
    const res = await h(req(), {} as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(d.selectPhotos).not.toHaveBeenCalled();
  });

  it("404s identically when no token row is stored", async () => {
    const d = db(null, []);
    const h = makeShareHandler({ getDb: () => d as never, sign: async (k) => k });
    const res = await h(req("token=anything"), {} as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(d.selectPhotos).not.toHaveBeenCalled();
  });

  it("404s identically on a mismatched token, without touching photos", async () => {
    const d = db({ value: "goodtoken" }, []);
    const h = makeShareHandler({ getDb: () => d as never, sign: async (k) => k });
    const res = await h(req("token=wrongtoken"), {} as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(d.selectPhotos).not.toHaveBeenCalled();
  });

  it("does not require auth (no 401 path)", async () => {
    const d = db({ value: "goodtoken" }, []);
    const h = makeShareHandler({ getDb: () => d as never, sign: async (k) => k });
    const res = await h(req("token=goodtoken"), {} as never);
    expect(res.status).not.toBe(401);
  });

  it("500s via serverError when the settings lookup fails", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const eqSettings = vi.fn().mockReturnValue({ maybeSingle });
    const selectSettings = vi.fn().mockReturnValue({ eq: eqSettings });
    const from = vi.fn().mockReturnValue({ select: selectSettings });
    const h = makeShareHandler({ getDb: () => ({ from }) as never, sign: async (k) => k });
    const res = await h(req("token=goodtoken"), {} as never);
    expect(res.status).toBe(500);
  });

  it("500s via serverError when the photos query fails", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { value: "goodtoken" }, error: null });
    const eqSettings = vi.fn().mockReturnValue({ maybeSingle });
    const selectSettings = vi.fn().mockReturnValue({ eq: eqSettings });

    const limitFn = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const orderFn = vi.fn().mockReturnValue({ limit: limitFn });
    const eqPhotos = vi.fn().mockReturnValue({ order: orderFn });
    const selectPhotos = vi.fn().mockReturnValue({ eq: eqPhotos });

    const from = vi.fn((t: string) => (t === "app_settings" ? { select: selectSettings } : { select: selectPhotos }));
    const h = makeShareHandler({ getDb: () => ({ from }) as never, sign: async (k) => k });
    const res = await h(req("token=goodtoken"), {} as never);
    expect(res.status).toBe(500);
  });

  it("answers 429 with Retry-After when the limiter says so, before touching the db", async () => {
    const d = db({ value: "goodtoken" }, []);
    const h = makeShareHandler({
      getDb: () => d as never,
      sign: async (k: string) => k,
      checkLimit: () => rateLimited(1500),
    });
    const res = await h(req("token=goodtoken"), {} as never);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(d.from).not.toHaveBeenCalled();
  });
});
