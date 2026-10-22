import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  adminLogin,
  adminLogout,
  getAdminEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getAdminPhotos,
  setStarred,
  getShareLink,
  regenerateShareLink,
  UnauthorizedError,
} from "./adminClient";

beforeEach(() => vi.restoreAllMocks());

describe("adminClient", () => {
  it("adminLogin posts credentials and reports ok on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await adminLogin("admin", "pw")).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/login", expect.objectContaining({ method: "POST" }));
  });

  it("adminLogin reports invalid credentials on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    expect(await adminLogin("admin", "bad")).toBe("invalid");
  });

  // The login endpoint is limited to 5 attempts/min/IP (and the zone WAF rule
  // adds its own 429s). On 2026-09-04 that came out as the same "gagal" text as
  // a wrong password, so the admin kept retrying and kept extending the block.
  it("adminLogin reports rate-limited on 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));
    expect(await adminLogin("admin", "pw")).toBe("rate-limited");
  });

  it("adminLogin reports error on a 5xx or a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    expect(await adminLogin("admin", "pw")).toBe("error");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await adminLogin("admin", "pw")).toBe("error");
  });

  it("adminLogout posts to the logout endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await adminLogout();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/logout", expect.objectContaining({ method: "POST" }));
  });

  it("getAdminEvents fetches and unwraps the events list", async () => {
    const events = [{ id: "e1", name: "Akad", windowStart: null, windowEnd: null, count: 0 }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ events }), { status: 200 })));
    expect(await getAdminEvents()).toEqual(events);
  });

  it("getAdminEvents throws UnauthorizedError on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await expect(getAdminEvents()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("createEvent posts the name and window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await createEvent({ name: "Akad", windowStart: "2026-07-01T00:00:00.000Z", windowEnd: "2026-07-01T04:00:00.000Z" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/events",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Akad", windowStart: "2026-07-01T00:00:00.000Z", windowEnd: "2026-07-01T04:00:00.000Z" }),
      })
    );
  });

  it("createEvent throws the server's overlap message on 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "windows overlap" }), { status: 409 }))
    );
    await expect(
      createEvent({ name: "Akad", windowStart: "2026-07-01T00:00:00.000Z", windowEnd: "2026-07-01T04:00:00.000Z" })
    ).rejects.toThrow("windows overlap");
  });

  it("updateEvent posts eventId with the patch fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await updateEvent({ eventId: "e1", name: "Akad Nikah" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/event",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ eventId: "e1", name: "Akad Nikah" }) })
    );
  });

  it("deleteEvent posts eventId with delete: true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await deleteEvent("e1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/event",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ eventId: "e1", delete: true }) })
    );
  });

  it("deleteEvent surfaces the server's message on 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "event has photos" }), { status: 409 }))
    );
    await expect(deleteEvent("e1")).rejects.toThrow("event has photos");
  });

  it("getAdminPhotos fetches the page and eventId filter", async () => {
    const body = { photos: [{ id: "p1" }], hasMore: true, counts: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getAdminPhotos(1, "e1")).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/photos?page=1&eventId=e1");
  });

  it("setStarred posts photoId and starred", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await setStarred("p1", true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/star",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ photoId: "p1", starred: true }) })
    );
  });

  it("getShareLink GETs the share endpoint", async () => {
    const body = { token: "tok", url: "https://x/share/tok", starredCount: 4 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getShareLink()).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/share");
  });

  it("regenerateShareLink POSTs to the share endpoint", async () => {
    const body = { token: "tok2", url: "https://x/share/tok2", starredCount: 4 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await regenerateShareLink()).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/share", expect.objectContaining({ method: "POST" }));
  });
});

 it("collects wishes across every API page, including an empty page with more results", async () => {
   const { getAdminWishes } = await import("./adminClient");
   const wish = { guestId: "g1", guestName: "Ahmad", message: "Tahniah" };
   const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ wishes: [], hasMore: true }))
     .mockResolvedValueOnce(Response.json({ wishes: [wish], hasMore: false }));
   vi.stubGlobal("fetch", fetchMock);
   expect(await getAdminWishes()).toEqual([wish]);
   expect(fetchMock).toHaveBeenLastCalledWith("/api/admin/wishes?page=1");
 });

it("does not repeat a guest wish when live additions shift an API page boundary", async () => {
  const { getAdminWishes } = await import("./adminClient");
  const first = { guestId: "g1", guestName: "Ahmad", message: "Tahniah" };
  const second = { guestId: "g2", guestName: "Siti", message: "Bahagia selalu" };
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ wishes: [first], hasMore: true }))
    .mockResolvedValueOnce(Response.json({ wishes: [first, second], hasMore: false })));
  expect(await getAdminWishes()).toEqual([first, second]);
});
