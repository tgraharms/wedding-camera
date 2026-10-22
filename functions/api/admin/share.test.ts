import { describe, it, expect, vi } from "vitest";
import { makeShareGetHandler, makeShareRegenerateHandler } from "./share";

const req = () => new Request("https://my-project.pages.dev/api/admin/share");

function dbCapture(existing: { value: string } | null, starredCount = 0) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: existing, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const upsert = vi.fn().mockResolvedValue({ error: null });

  // head:true — the count comes back as `count`, with no rows attached.
  const eqPhotos = vi.fn().mockResolvedValue({ data: null, count: starredCount, error: null });
  const selectPhotos = vi.fn().mockReturnValue({ eq: eqPhotos });

  const from = vi.fn((table: string) => (table === "photos" ? { select: selectPhotos } : { select, upsert }));
  return { db: { from }, from, select, eq, maybeSingle, upsert, selectPhotos, eqPhotos };
}

describe("share GET handler", () => {
  it("401s when not authed", async () => {
    const { db } = dbCapture(null);
    const handler = makeShareGetHandler(async () => null, () => db as never);
    expect((await handler(req(), {} as never)).status).toBe(401);
  });

  it("returns the stored token without writing anything", async () => {
    const { db, upsert, select } = dbCapture({ value: "existingtoken" }, 5);
    const handler = makeShareGetHandler(async () => "admin", () => db as never);
    const res = await handler(req(), {} as never);
    expect(res.status).toBe(200);
    expect(select).toHaveBeenCalledWith("value");
    expect(await res.json()).toEqual({
      token: "existingtoken",
      url: "https://my-project.pages.dev/share/existingtoken",
      starredCount: 5,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  // GET is reachable by top-level navigation, which SameSite=Lax still sends
  // the admin cookie on. Creating a token there would make a read a write.
  it("reports a null token when none exists yet, and still does not write", async () => {
    const { db, upsert } = dbCapture(null, 0);
    const handler = makeShareGetHandler(async () => "admin", () => db as never);
    const res = await handler(req(), {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null, url: null, starredCount: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("counts starred photos with a head count rather than fetching rows", async () => {
    const { db, selectPhotos, eqPhotos } = dbCapture({ value: "existingtoken" }, 7);
    const handler = makeShareGetHandler(async () => "admin", () => db as never);
    const res = await handler(req(), {} as never);
    const body = (await res.json()) as { starredCount: number };
    expect(body.starredCount).toBe(7);
    expect(selectPhotos).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(eqPhotos).toHaveBeenCalledWith("starred", true);
  });

  // The old row-counting version measured data.length, which PostgREST caps at
  // max_rows (1000) — so a genuinely larger count silently reported as 1000.
  it("reports counts above the PostgREST max_rows ceiling accurately", async () => {
    const { db } = dbCapture({ value: "existingtoken" }, 1600);
    const handler = makeShareGetHandler(async () => "admin", () => db as never);
    const body = (await (await handler(req(), {} as never)).json()) as { starredCount: number };
    expect(body.starredCount).toBe(1600);
  });
});

describe("share POST (regenerate) handler", () => {
  it("401s when not authed", async () => {
    const { db } = dbCapture(null);
    const handler = makeShareRegenerateHandler(async () => null, () => db as never);
    expect((await handler(req(), {} as never)).status).toBe(401);
  });

  it("regenerates unconditionally, producing a different token on each call", async () => {
    const { db, upsert } = dbCapture({ value: "oldtoken" }, 3);
    const uuidSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      .mockReturnValueOnce("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
      .mockReturnValueOnce("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    const handler = makeShareRegenerateHandler(async () => "admin", () => db as never);
    const first = (await (await handler(req(), {} as never)).json()) as { token: string; url: string; starredCount: number };
    const second = (await (await handler(req(), {} as never)).json()) as { token: string; url: string; starredCount: number };
    expect(first.token).not.toBe(second.token);
    expect(first.url).toBe(`https://my-project.pages.dev/share/${first.token}`);
    expect(second.url).toBe(`https://my-project.pages.dev/share/${second.token}`);
    // Same response shape as GET — the couple regenerating the link shouldn't
    // also lose the starred count they were just looking at.
    expect(first.starredCount).toBe(3);
    expect(second.starredCount).toBe(3);
    expect(upsert).toHaveBeenCalledTimes(2);
    uuidSpy.mockRestore();
  });
});
