import { describe, it, expect, vi } from "vitest";
import { makeMyPhotosHandler } from "./photos";

const SS = "22222222-2222-4222-8222-222222222222";
function db(photoRows: unknown[], guestRow: unknown | null) {
  const rangeFn = vi.fn().mockResolvedValue({ data: photoRows, error: null });
  const orderChain: { order: ReturnType<typeof vi.fn>; range: typeof rangeFn } = {
    order: vi.fn(),
    range: rangeFn,
  };
  const order = vi.fn().mockReturnValue(orderChain);
  orderChain.order.mockReturnValue(orderChain);
  const eqPhotos = vi.fn().mockReturnValue({ order });
  const maybeSingle = vi.fn().mockResolvedValue({ data: guestRow, error: null });
  const eqGuests = vi.fn().mockReturnValue({ maybeSingle });
  const from = vi.fn((t: string) =>
    t === "photos" ? { select: vi.fn().mockReturnValue({ eq: eqPhotos }) }
                   : { select: vi.fn().mockReturnValue({ eq: eqGuests }) });
  return { from, rangeFn, eqPhotos, eqGuests };
}
const req = (qs: string) => new Request(`https://x/api/me/photos?${qs}`);

describe("makeMyPhotosHandler", () => {
  it("returns signed photos newest-first plus profile, hasMore=false", async () => {
    const rows = [{ id: "p1", storage_key: "e/1.jpg", captured_at: "2026-09-19T05:00:00Z" }];
    const d = db(rows, { display_name: "Aminah", message: "Tahniah" });
    const h = makeMyPhotosHandler({ getDb: () => d as never, sign: async (k) => `https://r2/${k}` });
    const body = (await (await h(req(`sessionId=${SS}&page=0`), {} as never)).json()) as Record<string, unknown>;
    expect(body.photos).toEqual([{ id: "p1", imageUrl: "https://r2/e/1.jpg", capturedAt: "2026-09-19T05:00:00Z" }]);
    expect(body.profile).toEqual({ displayName: "Aminah", message: "Tahniah" });
    expect(body.hasMore).toBe(false);
    expect(d.rangeFn).toHaveBeenCalledWith(0, 60); // pageSize+1 probe
    // The sole privacy boundary: a service-role client bypasses RLS, so these
    // .eq("session_id", ...) calls are what stops one guest's session from
    // reading another guest's photos/profile. Pin them explicitly.
    expect(d.eqPhotos).toHaveBeenCalledWith("session_id", SS);
    expect(d.eqGuests).toHaveBeenCalledWith("session_id", SS);
  });
  it("hasMore=true when a 61st row comes back, and trims it", async () => {
    const rows = Array.from({ length: 61 }, (_, i) => ({ id: `p${i}`, storage_key: `e/${i}.jpg`, captured_at: "2026-09-19T05:00:00Z" }));
    const d = db(rows, null);
    const h = makeMyPhotosHandler({ getDb: () => d as never, sign: async (k) => k });
    const body = (await (await h(req(`sessionId=${SS}&page=0`), {} as never)).json()) as Record<string, unknown>;
    expect(body.photos).toHaveLength(60);
    expect(body.hasMore).toBe(true);
    expect(body.profile).toEqual({ displayName: null, message: null });
    expect(d.eqPhotos).toHaveBeenCalledWith("session_id", SS);
    expect(d.eqGuests).toHaveBeenCalledWith("session_id", SS);
  });
  it("returns the guest's total photo count from the same query so the client can reconcile its local counter", async () => {
    const rows = [{ id: "p1", storage_key: "e/1.jpg", captured_at: "2026-09-19T05:00:00Z" }];
    const d = db(rows, null);
    d.rangeFn.mockResolvedValue({ data: rows, count: 3, error: null });
    const h = makeMyPhotosHandler({ getDb: () => d as never, sign: async (k) => k });
    const body = (await (await h(req(`sessionId=${SS}&page=0`), {} as never)).json()) as Record<string, unknown>;
    expect(body.total).toBe(3);
    const select = (d.from.mock.results[0].value as { select: ReturnType<typeof vi.fn> }).select;
    expect(select).toHaveBeenCalledWith("id,storage_key,captured_at", { count: "exact" });
  });
  it("400s on bad sessionId or negative page", async () => {
    const h = makeMyPhotosHandler({ getDb: () => db([], null) as never, sign: async (k) => k });
    expect((await h(req("sessionId=nope"), {} as never)).status).toBe(400);
    expect((await h(req(`sessionId=${SS}&page=-1`), {} as never)).status).toBe(400);
  });
});
