import { describe, it, expect, vi } from "vitest";
import { makeEventsListHandler, makeEventsCreateHandler } from "./events";

const akadRow = { id: "a", name: "Akad", window_start: "2026-09-19T03:00:00Z", window_end: "2026-09-19T10:00:00Z" };
const resepsiRow = { id: "r", name: "Reception", window_start: "2026-09-19T10:00:00Z", window_end: "2026-09-19T16:00:00Z" };

const listReq = () => new Request("https://x/api/admin/events");
const createReq = (body: unknown) =>
  new Request("https://x/api/admin/events", { method: "POST", body: JSON.stringify(body) });

// Counts come back from a head-count query per event id, not from rows.
function listDb(eventRows: unknown[], counts: Record<string, number>) {
  const eventsOrder = vi.fn().mockResolvedValue({ data: eventRows, error: null });
  const eventsSelect = vi.fn().mockReturnValue({ order: eventsOrder });
  const photosEq = vi.fn((_col: string, id: string) =>
    Promise.resolve({ data: null, count: counts[id] ?? 0, error: null })
  );
  const photosSelect = vi.fn().mockReturnValue({ eq: photosEq });
  const from = vi.fn((t: string) => (t === "events" ? { select: eventsSelect } : { select: photosSelect }));
  return { from, eventsOrder, eventsSelect, photosSelect, photosEq };
}

describe("admin events list handler", () => {
  it("401s when not authed", async () => {
    const { from } = listDb([], {});
    const handler = makeEventsListHandler(async () => null, () => ({ from }) as never);
    expect((await handler(listReq(), {} as never)).status).toBe(401);
  });

  it("maps snake_case rows to camelCase and merges photo counts", async () => {
    const { from } = listDb([akadRow, resepsiRow], { a: 2, r: 1 });
    const handler = makeEventsListHandler(async () => "admin", () => ({ from }) as never);
    const res = await handler(listReq(), {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events: [
        { id: "a", name: "Akad", windowStart: akadRow.window_start, windowEnd: akadRow.window_end, count: 2 },
        { id: "r", name: "Reception", windowStart: resepsiRow.window_start, windowEnd: resepsiRow.window_end, count: 1 },
      ],
    });
  });

  it("defaults count to 0 for events with no photos", async () => {
    const { from } = listDb([akadRow], {});
    const handler = makeEventsListHandler(async () => "admin", () => ({ from }) as never);
    const body = (await (await handler(listReq(), {} as never)).json()) as { events: { count: number }[] };
    expect(body.events[0].count).toBe(0);
  });

  // A full-table select would have been truncated at PostgREST's max_rows
  // (1000) and reported 1000 here, with nothing to signal the shortfall.
  it("reports counts past the 1000-row PostgREST ceiling", async () => {
    const { from, photosSelect } = listDb([akadRow], { a: 1600 });
    const handler = makeEventsListHandler(async () => "admin", () => ({ from }) as never);
    const body = (await (await handler(listReq(), {} as never)).json()) as { events: { count: number }[] };
    expect(body.events[0].count).toBe(1600);
    expect(photosSelect).toHaveBeenCalledWith("id", { count: "exact", head: true });
  });

  it("500s when a count query fails rather than reporting zero", async () => {
    const eventsOrder = vi.fn().mockResolvedValue({ data: [akadRow], error: null });
    const eventsSelect = vi.fn().mockReturnValue({ order: eventsOrder });
    const photosSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, count: null, error: { message: "boom" } }),
    });
    const from = vi.fn((t: string) => (t === "events" ? { select: eventsSelect } : { select: photosSelect }));
    const handler = makeEventsListHandler(async () => "admin", () => ({ from }) as never);
    expect((await handler(listReq(), {} as never)).status).toBe(500);
  });
});

function createDb(existingEvents: unknown[]) {
  const eventsSelect = vi.fn().mockResolvedValue({ data: existingEvents, error: null });
  const single = vi.fn().mockResolvedValue({ data: { id: "new-id" }, error: null });
  const insertSelect = vi.fn().mockReturnValue({ single });
  const insert = vi.fn().mockReturnValue({ select: insertSelect });
  const from = vi.fn().mockReturnValue({ select: eventsSelect, insert });
  return { from, eventsSelect, insert, insertSelect, single };
}

describe("admin events create handler", () => {
  it("401s when not authed", async () => {
    const { from } = createDb([]);
    const handler = makeEventsCreateHandler(async () => null, () => ({ from }) as never);
    const res = await handler(
      createReq({ name: "Akad", windowStart: akadRow.window_start, windowEnd: akadRow.window_end }),
      {} as never
    );
    expect(res.status).toBe(401);
  });

  it("400s when name is blank", async () => {
    const { from } = createDb([]);
    const handler = makeEventsCreateHandler(async () => "admin", () => ({ from }) as never);
    const res = await handler(
      createReq({ name: "  ", windowStart: akadRow.window_start, windowEnd: akadRow.window_end }),
      {} as never
    );
    expect(res.status).toBe(400);
  });

  it("400s when name exceeds 80 characters", async () => {
    const { from } = createDb([]);
    const handler = makeEventsCreateHandler(async () => "admin", () => ({ from }) as never);
    const res = await handler(
      createReq({ name: "x".repeat(81), windowStart: akadRow.window_start, windowEnd: akadRow.window_end }),
      {} as never
    );
    expect(res.status).toBe(400);
  });

  it("400s when windowEnd <= windowStart", async () => {
    const { from } = createDb([]);
    const handler = makeEventsCreateHandler(async () => "admin", () => ({ from }) as never);
    const res = await handler(
      createReq({ name: "Akad", windowStart: akadRow.window_end, windowEnd: akadRow.window_start }),
      {} as never
    );
    expect(res.status).toBe(400);
  });

  it("400s on missing/invalid ISO windows", async () => {
    const { from } = createDb([]);
    const handler = makeEventsCreateHandler(async () => "admin", () => ({ from }) as never);
    const res = await handler(createReq({ name: "Akad", windowStart: "not-a-date", windowEnd: akadRow.window_end }), {} as never);
    expect(res.status).toBe(400);
  });

  it("409s when the new window overlaps an existing event (Task 2 fixtures)", async () => {
    const { from } = createDb([akadRow, resepsiRow]);
    const handler = makeEventsCreateHandler(async () => "admin", () => ({ from }) as never);
    const res = await handler(
      createReq({ name: "Overlap", windowStart: "2026-09-19T09:00:00Z", windowEnd: "2026-09-19T11:00:00Z" }),
      {} as never
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "windows overlap" });
  });

  it("201s and inserts when the window is clear", async () => {
    const { from, insert } = createDb([akadRow, resepsiRow]);
    const handler = makeEventsCreateHandler(async () => "admin", () => ({ from }) as never);
    const res = await handler(
      createReq({ name: "Evening", windowStart: "2026-09-19T16:00:00Z", windowEnd: "2026-09-19T20:00:00Z" }),
      {} as never
    );
    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledWith({
      name: "Evening",
      window_start: "2026-09-19T16:00:00Z",
      window_end: "2026-09-19T20:00:00Z",
    });
    const body = (await res.json()) as { id: string; name: string; count: number };
    expect(body).toEqual({
      id: "new-id",
      name: "Evening",
      windowStart: "2026-09-19T16:00:00Z",
      windowEnd: "2026-09-19T20:00:00Z",
      count: 0,
    });
  });
});
