import { describe, it, expect, vi } from "vitest";
import { makeEventUpdateHandler } from "./event";

const akadRow = { id: "e1", name: "Akad", window_start: "2026-09-19T03:00:00Z", window_end: "2026-09-19T10:00:00Z" };
const resepsiRow = { id: "e2", name: "Reception", window_start: "2026-09-19T10:00:00Z", window_end: "2026-09-19T16:00:00Z" };

function req(body: unknown): Request {
  return new Request("https://x/api/admin/event", { method: "POST", body: JSON.stringify(body) });
}

// Builds a db double that answers .from("events").select(...).eq(...).maybeSingle(),
// .from("events").select(...).neq(...), .from("events").update(...).eq(...),
// .from("events").delete().eq(...), and .from("photos").select(...).eq(...).
function dbCapture(opts: {
  current?: unknown;
  others?: unknown[];
  photoCount?: unknown[];
  photosResult?: { data: unknown; count: number | null; error: unknown };
} = {}) {
  const current = opts.current ?? akadRow;
  const others = opts.others ?? [];
  const photoCount = opts.photoCount ?? [];

  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  const maybeSingle = vi.fn().mockResolvedValue({ data: current, error: null });
  const selectEq = vi.fn().mockReturnValue({ maybeSingle });
  const selectNeq = vi.fn().mockResolvedValue({ data: others, error: null });
  // events select: supports either .eq(...).maybeSingle() or .neq(...)
  const eventsSelect = vi.fn().mockReturnValue({ eq: selectEq, neq: selectNeq });

  const deleteEq = vi.fn().mockResolvedValue({ error: null });
  const del = vi.fn().mockReturnValue({ eq: deleteEq });

  const photosEq = vi
    .fn()
    .mockResolvedValue(opts.photosResult ?? { data: null, count: photoCount.length, error: null });
  const photosSelect = vi.fn().mockReturnValue({ eq: photosEq });

  const from = vi.fn((t: string) =>
    t === "events" ? { select: eventsSelect, update, delete: del } : { select: photosSelect }
  );
  return { db: { from }, from, update, updateEq, eventsSelect, selectEq, maybeSingle, selectNeq, del, deleteEq, photosSelect, photosEq };
}

describe("event update/delete handler", () => {
  it("401s when not authed", async () => {
    const { db } = dbCapture();
    const handler = makeEventUpdateHandler(async () => null, () => db as never);
    expect((await handler(req({ eventId: "e1", name: "Akad Nikah" }), {} as never)).status).toBe(401);
  });

  it("400s when eventId missing", async () => {
    const { db } = dbCapture();
    const handler = makeEventUpdateHandler(async () => "admin", () => db as never);
    expect((await handler(req({ name: "x" }), {} as never)).status).toBe(400);
  });

  it("400s when no updatable field is provided", async () => {
    const { db } = dbCapture();
    const handler = makeEventUpdateHandler(async () => "admin", () => db as never);
    expect((await handler(req({ eventId: "e1" }), {} as never)).status).toBe(400);
  });

  it("patches only the provided fields, validating the resulting window", async () => {
    const { db, update, updateEq } = dbCapture({ current: akadRow, others: [resepsiRow] });
    const handler = makeEventUpdateHandler(async () => "admin", () => db as never);
    const res = await handler(req({ eventId: "e1", name: "Akad Nikah" }), {} as never);
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ name: "Akad Nikah" });
    expect(updateEq).toHaveBeenCalledWith("id", "e1");
  });

  it("400s when the resulting window has end <= start", async () => {
    const { db } = dbCapture({ current: akadRow, others: [] });
    const handler = makeEventUpdateHandler(async () => "admin", () => db as never);
    const res = await handler(
      req({ eventId: "e1", windowStart: akadRow.window_end, windowEnd: akadRow.window_start }),
      {} as never
    );
    expect(res.status).toBe(400);
  });

  it("409s when the resulting window overlaps another event", async () => {
    const { db } = dbCapture({ current: akadRow, others: [resepsiRow] });
    const handler = makeEventUpdateHandler(async () => "admin", () => db as never);
    const res = await handler(req({ eventId: "e1", windowEnd: "2026-09-19T11:00:00Z" }), {} as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "windows overlap" });
  });

  it("excludes itself from the overlap check", async () => {
    const { db, eventsSelect, selectNeq } = dbCapture({ current: akadRow, others: [] });
    const handler = makeEventUpdateHandler(async () => "admin", () => db as never);
    const res = await handler(req({ eventId: "e1", windowEnd: "2026-09-19T09:00:00Z" }), {} as never);
    expect(res.status).toBe(200);
    expect(eventsSelect).toHaveBeenCalledWith("id,name,window_start,window_end");
    expect(selectNeq).toHaveBeenCalledWith("id", "e1");
  });

  it("deletes the event when it has zero photos", async () => {
    const { db, del, deleteEq } = dbCapture({ photoCount: [] });
    const handler = makeEventUpdateHandler(async () => "admin", () => db as never);
    const res = await handler(req({ eventId: "e1", delete: true }), {} as never);
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalled();
    expect(deleteEq).toHaveBeenCalledWith("id", "e1");
  });

  it("409s deleting an event with photos", async () => {
    const { db, del } = dbCapture({ photoCount: [{ id: "p1" }] });
    const handler = makeEventUpdateHandler(async () => "admin", () => db as never);
    const res = await handler(req({ eventId: "e1", delete: true }), {} as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "event has photos" });
    expect(del).not.toHaveBeenCalled();
  });

  // photos.event_id is on delete cascade — treating an unreadable count as
  // zero could delete every photo of an event, so an unreadable count must
  // refuse rather than proceed.
  it("500s deleting when the photo count is unreadable, and never calls delete", async () => {
    const { db, del } = dbCapture({ photosResult: { data: null, count: null, error: null } });
    const handler = makeEventUpdateHandler(async () => "admin", () => db as never);
    const res = await handler(req({ eventId: "e1", delete: true }), {} as never);
    expect(res.status).toBe(500);
    expect(del).not.toHaveBeenCalled();
  });
});
