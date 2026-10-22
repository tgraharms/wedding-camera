import { describe, it, expect, vi } from "vitest";
import { makeOriginalsPresignHandler, originalKeyFor, ORIGINAL_MAX_BYTES } from "./presign";
import { rateLimited } from "../../_lib/rateLimit";
import { LATE_MS } from "../../_lib/windows";

const SESSION = "22222222-2222-4222-8222-222222222222";
const EVENT = "11111111-1111-4111-8111-111111111111";
const FILE = "33333333-3333-4333-8333-333333333333";
const KEY = `${EVENT}/${FILE}.jpg`;
const week = { id: EVENT, name: "Upload Gambar", window_start: "2026-10-01T03:00:00Z", window_end: "2026-10-08T16:00:00Z" };

const deps = (over: Partial<Parameters<typeof makeOriginalsPresignHandler>[0]> = {}) => ({
  getEvents: async () => [week],
  findPhoto: vi.fn().mockResolvedValue({ eventId: EVENT }),
  sign: vi.fn().mockResolvedValue("https://r2/signed-original"),
  now: () => Date.parse("2026-10-02T05:00:00Z"),
  ...over,
});
const query = (over: Record<string, string> = {}) =>
  new URLSearchParams({ storageKey: KEY, sessionId: SESSION, size: "5000000", ...over }).toString();
const req = (qs: string) => new Request(`https://x/api/originals/presign?${qs}`);
const env = {} as never;

describe("originalKeyFor", () => {
  it("maps a display key to its private sibling, without the extension", () => {
    expect(originalKeyFor(KEY)).toBe(`originals/${EVENT}/${FILE}`);
  });
});

describe("makeOriginalsPresignHandler", () => {
  it("presigns a length-bound PUT on the private key for the photo's owner", async () => {
    const d = deps();
    const res = await makeOriginalsPresignHandler(d)(req(query()), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uploadUrl: "https://r2/signed-original" });
    expect(d.findPhoto).toHaveBeenCalledWith(env, KEY, SESSION);
    expect(d.sign).toHaveBeenCalledWith(`originals/${EVENT}/${FILE}`, 5000000);
  });

  it("400s on malformed input without touching the database", async () => {
    const bad = [
      { sessionId: "" },
      { sessionId: "not-a-uuid" },
      { storageKey: "" },
      { storageKey: `${EVENT}/../${FILE}.jpg` },
      { storageKey: `${EVENT}/${FILE}.png` },
      { storageKey: `originals/${EVENT}/${FILE}` },
      { size: "" },
      { size: "abc" },
      { size: "0" },
      { size: "-1" },
      { size: "1.5" },
      { size: String(ORIGINAL_MAX_BYTES + 1) },
    ];
    for (const over of bad) {
      const d = deps();
      const res = await makeOriginalsPresignHandler(d)(req(query(over as unknown as Record<string, string>)), env);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(d.findPhoto).not.toHaveBeenCalled();
      expect(d.sign).not.toHaveBeenCalled();
    }
  });

  it("accepts exactly ORIGINAL_MAX_BYTES (64 MiB)", async () => {
    expect(ORIGINAL_MAX_BYTES).toBe(64 * 1024 * 1024);
    const res = await makeOriginalsPresignHandler(deps())(req(query({ size: String(ORIGINAL_MAX_BYTES) })), env);
    expect(res.status).toBe(200);
  });

  // A share-link viewer can read storage keys out of signed image URLs; this
  // check is what stops them overwriting someone else's original.
  it("404s when the photo is not registered to this session", async () => {
    const d = deps({ findPhoto: vi.fn().mockResolvedValue(null) });
    const res = await makeOriginalsPresignHandler(d)(req(query()), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "photo not found" });
    expect(d.sign).not.toHaveBeenCalled();
  });

  it("accepts until window_end + LATE_MS, then 403s", async () => {
    const end = Date.parse(week.window_end);
    const before = await makeOriginalsPresignHandler(deps({ now: () => end + LATE_MS - 1 }))(req(query()), env);
    expect(before.status).toBe(200);
    const after = await makeOriginalsPresignHandler(deps({ now: () => end + LATE_MS }))(req(query()), env);
    expect(after.status).toBe(403);
    expect(await after.json()).toEqual({ error: "window closed" });
  });

  it("403s when the photo's event no longer exists", async () => {
    const res = await makeOriginalsPresignHandler(deps({ getEvents: async () => [] }))(req(query()), env);
    expect(res.status).toBe(403);
  });

  it("is rate limited before any work", async () => {
    const d = deps({ checkLimit: () => rateLimited(1000) });
    const res = await makeOriginalsPresignHandler(d)(req(query()), env);
    expect(res.status).toBe(429);
    expect(d.findPhoto).not.toHaveBeenCalled();
  });
});
