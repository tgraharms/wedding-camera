import { describe, it, expect, vi } from "vitest";
import { makeAdminPhotosHandler, PAGE_SIZE } from "./photos";

const rowWithGuest = {
  id: "p1",
  session_id: "g1",
  event_id: "e1",
  storage_key: "e1/p1.jpg",
  captured_at: "2026-06-12T12:30:00.000Z",
  starred: true,
  events: { name: "Akad" },
  guests: { display_name: "Ahmad", message: "Tahniah!" },
};

const rowWithoutGuest = {
  id: "p2",
  session_id: "g2",
  event_id: "e1",
  storage_key: "e1/p2.jpg",
  captured_at: "2026-06-12T12:00:00.000Z",
  starred: false,
  events: { name: "Akad" },
  guests: null,
};

function dbReturning(
  pageRows: unknown[],
  eventRows: { id: string; name: string }[],
  counts: Record<string, number> = {}
) {
  const range = vi.fn().mockResolvedValue({ data: pageRows, error: null });
  const orderChain: { order: ReturnType<typeof vi.fn>; range: typeof range } = {
    order: vi.fn(),
    range,
  };
  const order = vi.fn().mockReturnValue(orderChain);
  orderChain.order.mockReturnValue(orderChain);
  const eq = vi.fn().mockReturnValue({ order });
  const pageSelect = vi.fn().mockReturnValue({ order, eq });

  const eventsSelect = vi.fn().mockResolvedValue({ data: eventRows, error: null });
  // After the page query, each further photos hit is a head count for one event.
  const countEq = vi.fn((_col: string, id: string) =>
    Promise.resolve({ data: null, count: counts[id] ?? 0, error: null })
  );
  const countSelect = vi.fn().mockReturnValue({ eq: countEq });

  let photosCalls = 0;
  const from = vi.fn((t: string) => {
    if (t === "events") return { select: eventsSelect };
    photosCalls++;
    return photosCalls === 1 ? { select: pageSelect } : { select: countSelect };
  });
  return { from, pageSelect, eq, order, range, eventsSelect, countSelect, countEq };
}

const req = (qs = "") => new Request(`https://x/api/admin/photos${qs ? `?${qs}` : ""}`);

describe("admin photos handler", () => {
  it("401s when not authenticated", async () => {
    const { from } = dbReturning([], []);
    const handler = makeAdminPhotosHandler(async () => null, () => ({ from }) as never, async (k) => k);
    expect((await handler(req(), {} as never)).status).toBe(401);
  });

  it("page 0 requests range(0, 60) and filters by event_id when eventId is a uuid", async () => {
    const { from, eq, range } = dbReturning([rowWithGuest], [{ id: "e1", name: "Akad" }], { e1: 1 });
    const handler = makeAdminPhotosHandler(async () => "admin", () => ({ from }) as never, async (k) => `signed:${k}`);
    const res = await handler(req("page=0&eventId=e1"), {} as never);
    expect(res.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("event_id", "e1");
    expect(range).toHaveBeenCalledWith(0, PAGE_SIZE);
  });

  it("page=1 requests range(60, 120)", async () => {
    const { from, range } = dbReturning([], []);
    const handler = makeAdminPhotosHandler(async () => "admin", () => ({ from }) as never, async (k) => k);
    await handler(req("page=1&eventId=all"), {} as never);
    expect(range).toHaveBeenCalledWith(60, 60 + PAGE_SIZE);
  });

  it("eventId=all skips the .eq filter", async () => {
    const { from, eq } = dbReturning([], []);
    const handler = makeAdminPhotosHandler(async () => "admin", () => ({ from }) as never, async (k) => k);
    await handler(req("eventId=all"), {} as never);
    expect(eq).not.toHaveBeenCalled();
  });

  it("maps guests embed to guestName/message, and null guest row to guestName: null", async () => {
    const { from } = dbReturning([rowWithGuest, rowWithoutGuest], [{ id: "e1", name: "Akad" }]);
    const handler = makeAdminPhotosHandler(async () => "admin", () => ({ from }) as never, async (k) => `signed:${k}`);
    const body = (await (await handler(req(), {} as never)).json()) as { photos: unknown[] };
    expect(body.photos).toEqual([
      {
        id: "p1", guestId: "g1", eventId: "e1", eventName: "Akad", guestName: "Ahmad", message: "Tahniah!",
        imageUrl: "signed:e1/p1.jpg", starred: true, capturedAt: "2026-06-12T12:30:00.000Z",
      },
      {
        id: "p2", guestId: "g2", eventId: "e1", eventName: "Akad", guestName: null, message: null,
        imageUrl: "signed:e1/p2.jpg", starred: false, capturedAt: "2026-06-12T12:00:00.000Z",
      },
    ]);
  });

  it("hasMore=true when a 61st row comes back, and trims it", async () => {
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({
      id: `p${i}`, event_id: "e1", storage_key: `e1/${i}.jpg`, captured_at: "2026-06-12T12:00:00.000Z",
      starred: false, events: { name: "Akad" }, guests: null,
    }));
    const { from } = dbReturning(rows, []);
    const handler = makeAdminPhotosHandler(async () => "admin", () => ({ from }) as never, async (k) => k);
    const body = (await (await handler(req(), {} as never)).json()) as { photos: unknown[]; hasMore: boolean };
    expect(body.photos).toHaveLength(PAGE_SIZE);
    expect(body.hasMore).toBe(true);
  });

  it("returns per-event counts", async () => {
    const { from, countSelect } = dbReturning(
      [],
      [{ id: "e1", name: "Akad" }, { id: "e2", name: "Reception" }],
      { e1: 2, e2: 1 }
    );
    const handler = makeAdminPhotosHandler(async () => "admin", () => ({ from }) as never, async (k) => k);
    const body = (await (await handler(req(), {} as never)).json()) as {
      counts: { eventId: string; name: string; count: number }[];
    };
    expect(body.counts).toEqual([
      { eventId: "e1", name: "Akad", count: 2 },
      { eventId: "e2", name: "Reception", count: 1 },
    ]);
    expect(countSelect).toHaveBeenCalledWith("id", { count: "exact", head: true });
  });

  // The full-table select this replaced was truncated at PostgREST's max_rows
  // (1000), so a busier event silently reported 1000 photos instead of 1600.
  it("reports counts past the 1000-row PostgREST ceiling", async () => {
    const { from } = dbReturning([], [{ id: "e1", name: "Akad" }], { e1: 1600 });
    const handler = makeAdminPhotosHandler(async () => "admin", () => ({ from }) as never, async (k) => k);
    const body = (await (await handler(req(), {} as never)).json()) as { counts: { count: number }[] };
    expect(body.counts[0].count).toBe(1600);
  });

  it("400s on a negative or non-integer page", async () => {
    const { from } = dbReturning([], []);
    const handler = makeAdminPhotosHandler(async () => "admin", () => ({ from }) as never, async (k) => k);
    expect((await handler(req("page=-1"), {} as never)).status).toBe(400);
    expect((await handler(req("page=abc"), {} as never)).status).toBe(400);
  });
});

it("orders by guest identity before time when grouping is requested", async () => {
 const { from, order } = dbReturning([], []);
 const handler = makeAdminPhotosHandler(async () => "admin", () => ({ from }) as never, async k => k);
 await handler(req("group=guest"), {} as never);
 expect(order).toHaveBeenNthCalledWith(1, "session_id", { ascending: true });
});
