import { describe, it, expect, vi } from "vitest";
import { makePhotosHandler } from "./photos";
import { rateLimited } from "../_lib/rateLimit";

const AK = "11111111-1111-4111-8111-111111111111";
const RS = "44444444-4444-4444-8444-444444444444";
const SS = "22222222-2222-4222-8222-222222222222";
const akad = { id: AK, name: "Akad", window_start: "2026-09-19T03:00:00Z", window_end: "2026-09-19T10:00:00Z" };
const resepsi = { id: RS, name: "Reception", window_start: "2026-09-19T10:00:00Z", window_end: "2026-09-19T16:00:00Z" };
const NOW = Date.parse("2026-09-19T05:00:00Z");
const key = `${AK}/33333333-3333-4333-8333-333333333333.jpg`;

function dbCapture(insertError: unknown = null) {
  const photoInsert = vi.fn().mockResolvedValue({ error: insertError });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) =>
    table === "guests" ? { upsert } : { insert: photoInsert });
  return { db: { from }, from, upsert, photoInsert };
}
const req = (body: unknown) =>
  new Request("https://x/api/photos", { method: "POST", body: JSON.stringify(body) });
const handler = (db: unknown, now = NOW, events: unknown[] = [akad]) =>
  makePhotosHandler({ getDb: () => db as never, getEvents: async () => events as never, now: () => now });

const good = { eventId: AK, storageKey: key, sessionId: SS, capturedAt: "2026-09-19T04:50:00Z" };

describe("makePhotosHandler", () => {
  it("upserts the guest then inserts the photo, 201", async () => {
    const c = dbCapture();
    const res = await handler(c.db)(req(good), {} as never);
    expect(res.status).toBe(201);
    expect(c.upsert).toHaveBeenCalledWith({ session_id: SS }, { onConflict: "session_id", ignoreDuplicates: true });
    expect(c.photoInsert).toHaveBeenCalledWith({
      event_id: AK, storage_key: key, session_id: SS, captured_at: "2026-09-19T04:50:00Z",
    });
    // Order matters, not just that both were called: the photo insert has an FK on
    // guests.session_id, so a future edit that swapped the awaits (insert before
    // upsert) would break at runtime while an args-only assertion stays green.
    expect(c.upsert.mock.invocationCallOrder[0]).toBeLessThan(c.photoInsert.mock.invocationCallOrder[0]);
  });
  it("403s window closed when the eventId is not routable now", async () => {
    const res = await handler(dbCapture().db, Date.parse("2026-09-21T05:00:00Z"))(req(good), {} as never);
    expect(res.status).toBe(403);
  });
  it("rejects a storageKey that does not belong to the eventId", async () => {
    const res = await handler(dbCapture().db)(req({ ...good, storageKey: `${SS}/x.jpg` }), {} as never);
    expect(res.status).toBe(400);
  });
  it("substitutes server time for an out-of-window capturedAt instead of rejecting", async () => {
    const c = dbCapture();
    await handler(c.db)(req({ ...good, capturedAt: "1970-01-01T00:00:00Z" }), {} as never);
    expect(c.photoInsert).toHaveBeenCalledWith(expect.objectContaining({ captured_at: new Date(NOW).toISOString() }));
  });
  it("400s on invalid JSON, non-object body, bad uuids", async () => {
    const h = handler(dbCapture().db);
    expect((await h(new Request("https://x", { method: "POST", body: "{" }), {} as never)).status).toBe(400);
    expect((await h(req([1]), {} as never)).status).toBe(400);
    expect((await h(req({ ...good, sessionId: "nope" }), {} as never)).status).toBe(400);
  });
  it("swallows 23505 duplicate as 201 (idempotent retries)", async () => {
    const res = await handler(dbCapture({ code: "23505", message: "dup" }).db)(req(good), {} as never);
    expect(res.status).toBe(201);
  });
  it("routes a late straggler by the pre-substitution capturedAt (now past grace, within LATE_MS)", async () => {
    // now = window_end + 1h: past the 30-min grace, still inside the 24h late-straggler
    // window. capturedAt sits inside the event window and is also within the
    // [now-24h, now+15min] plausible-clock range, so it must reach eventForRegistration
    // unmodified for the late-straggler match to succeed, and must then be stored
    // unchanged (not substituted).
    const lateNow = Date.parse("2026-09-19T11:00:00Z");
    const capturedAt = "2026-09-19T05:00:00Z";
    const c = dbCapture();
    const res = await handler(c.db, lateNow)(req({ ...good, capturedAt }), {} as never);
    expect(res.status).toBe(201);
    expect(c.photoInsert).toHaveBeenCalledWith(expect.objectContaining({ event_id: AK, captured_at: capturedAt }));
  });
  it("accepts a handover claim: Akad just closed within grace while Reception is the live window", async () => {
    // now = Akad's window_end + 5s: eventForRegistration routes live to Reception
    // (its window opened at exactly that instant), so the naive check would 403
    // this photo even though it was presigned for, and captured inside, Akad —
    // still within Akad's own 30-min grace.
    const handoverNow = Date.parse("2026-09-19T10:00:05Z");
    const capturedAt = "2026-09-19T09:59:50Z";
    const c = dbCapture();
    const res = await handler(c.db, handoverNow, [akad, resepsi])(req({ ...good, capturedAt }), {} as never);
    expect(res.status).toBe(201);
    expect(c.photoInsert).toHaveBeenCalledWith(expect.objectContaining({ event_id: AK, captured_at: capturedAt }));
  });
  it("still 403s a cross-event garbage claim that the claimed event doesn't justify either", async () => {
    // Claim Reception, but both now and capturedAt are two days later, well past
    // Reception's window, its grace, and its late-straggler allowance.
    const farLater = Date.parse("2026-09-21T05:00:00Z");
    const res = await handler(dbCapture().db, farLater, [akad, resepsi])(
      req({ ...good, eventId: RS, storageKey: `${RS}/33333333-3333-4333-8333-333333333333.jpg`, capturedAt: "2026-09-19T04:50:00Z" }),
      {} as never
    );
    expect(res.status).toBe(403);
  });

  describe("global photo cap", () => {
    it("403s with 'event full' when the cap is reached, without inserting", async () => {
      const c = dbCapture();
      const h = makePhotosHandler({
        getDb: () => c.db as never,
        getEvents: async () => [akad] as never,
        now: () => NOW,
        capReached: async () => true,
      });
      const res = await h(req(good), {} as never);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "event full" });
      expect(c.photoInsert).not.toHaveBeenCalled();
    });

    // A caller can skip presign entirely and POST straight here, so the cap
    // has to hold on this path too rather than only in front of R2.
    it("holds even though presign already checks it", async () => {
      const c = dbCapture();
      const capReached = vi.fn().mockResolvedValue(true);
      const h = makePhotosHandler({
        getDb: () => c.db as never,
        getEvents: async () => [akad] as never,
        now: () => NOW,
        capReached,
      });
      await h(req(good), {} as never);
      expect(capReached).toHaveBeenCalled();
    });

    it("inserts as usual below the cap, and with no cap dep at all", async () => {
      const c1 = dbCapture();
      const under = makePhotosHandler({
        getDb: () => c1.db as never,
        getEvents: async () => [akad] as never,
        now: () => NOW,
        capReached: async () => false,
      });
      expect((await under(req(good), {} as never)).status).toBe(201);
      const c2 = dbCapture();
      expect((await handler(c2.db)(req(good), {} as never)).status).toBe(201);
    });
  });

  describe("rate limiting", () => {
    it("returns the limiter's 429 before parsing or inserting", async () => {
      const c = dbCapture();
      const getEvents = vi.fn().mockResolvedValue([akad]);
      const h = makePhotosHandler({
        getDb: () => c.db as never,
        getEvents,
        now: () => NOW,
        checkLimit: () => rateLimited(3000),
      });
      const res = await h(req(good), {} as never);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("3");
      expect(getEvents).not.toHaveBeenCalled();
      expect(c.photoInsert).not.toHaveBeenCalled();
    });
  });
});
