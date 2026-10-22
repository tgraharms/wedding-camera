import { describe, it, expect, vi } from "vitest";
import { makePresignHandler, GUEST_PHOTO_CAP } from "./presign";
import { rateLimited } from "../_lib/rateLimit";

const SESSION = "22222222-2222-4222-8222-222222222222";

const akad = { id: "11111111-1111-4111-8111-111111111111", name: "Akad", window_start: "2026-09-19T03:00:00Z", window_end: "2026-09-19T10:00:00Z" };
const deps = (over: Partial<Parameters<typeof makePresignHandler>[0]> = {}) => ({
  getEvents: async () => [akad],
  sign: vi.fn().mockResolvedValue("https://r2/signed"),
  now: () => Date.parse("2026-09-19T05:00:00Z"),
  ...over,
});
const req = (qs: string) => new Request(`https://x/api/presign?${qs}`);

describe("makePresignHandler", () => {
  it("presigns inside a window and returns the routed eventId", async () => {
    const d = deps();
    const res = await makePresignHandler(d)(req("size=1000"), {} as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { eventId: string; storageKey: string };
    expect(body.eventId).toBe(akad.id);
    expect(body.storageKey.startsWith(`${akad.id}/`)).toBe(true);
    expect(d.sign).toHaveBeenCalledWith(body.storageKey, 1000);
  });
  it("403s with window closed outside every window+grace", async () => {
    const res = await makePresignHandler(deps({ now: () => Date.parse("2026-09-20T05:00:00Z") }))(req("size=1000"), {} as never);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "window closed" });
  });
  it("late straggler: capturedAt inside a window presigns after grace", async () => {
    const res = await makePresignHandler(deps({ now: () => Date.parse("2026-09-19T20:00:00Z") }))(
      req(`size=1000&capturedAt=${encodeURIComponent("2026-09-19T05:30:00Z")}`), {} as never);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { eventId: string }).eventId).toBe(akad.id);
  });
  it("keeps the size gates: missing, non-numeric, zero, oversize", async () => {
    // 16 MiB: a 4096px / q0.92 re-encode of a detailed frame can reach ~6 MB,
    // and the ≤cap unprocessed-original fallback needs room for a 24MP+
    // camera JPEG.
    for (const qs of ["", "size=abc", "size=0", `size=${16 * 1024 * 1024 + 1}`]) {
      expect((await makePresignHandler(deps())(req(qs), {} as never)).status).toBe(400);
    }
    expect((await makePresignHandler(deps())(req(`size=${16 * 1024 * 1024}`), {} as never)).status).toBe(200);
  });

  describe("global photo cap", () => {
    it("403s with 'event full' when the cap is reached, without signing", async () => {
      const d = deps({ capReached: async () => true });
      const res = await makePresignHandler(d)(req("size=1000"), {} as never);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "event full" });
      expect(d.sign).not.toHaveBeenCalled();
    });

    it("signs as usual when the cap is not reached", async () => {
      const res = await makePresignHandler(deps({ capReached: async () => false }))(req("size=1000"), {} as never);
      expect(res.status).toBe(200);
    });

    it("is absent by default, so a handler without the dep still signs", async () => {
      expect((await makePresignHandler(deps())(req("size=1000"), {} as never)).status).toBe(200);
    });
  });

  describe("per-guest fair-use cap", () => {
    it("403s with 'guest quota' once the guest is at the cap, without signing", async () => {
      const d = deps({ countForGuest: async () => GUEST_PHOTO_CAP });
      const res = await makePresignHandler(d)(req(`size=1000&sessionId=${SESSION}`), {} as never);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "guest quota" });
      expect(d.sign).not.toHaveBeenCalled();
    });

    it("allows the guest right below the cap", async () => {
      const d = deps({ countForGuest: async () => GUEST_PHOTO_CAP - 1 });
      const res = await makePresignHandler(d)(req(`size=1000&sessionId=${SESSION}`), {} as never);
      expect(res.status).toBe(200);
    });

    // An older cached bundle predates the sessionId param. It must keep
    // uploading on the day rather than 400ing on a field it never learned to
    // send — the cap is fair use, not a security boundary worth an outage.
    it("skips the check when sessionId is absent or malformed", async () => {
      const countForGuest = vi.fn().mockResolvedValue(GUEST_PHOTO_CAP);
      const d = deps({ countForGuest });
      expect((await makePresignHandler(d)(req("size=1000"), {} as never)).status).toBe(200);
      expect((await makePresignHandler(d)(req("size=1000&sessionId=nope"), {} as never)).status).toBe(200);
      expect(countForGuest).not.toHaveBeenCalled();
    });

    it("allows the upload when the count query fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const d = deps({
        countForGuest: async () => {
          throw new Error("supabase down");
        },
      });
      const res = await makePresignHandler(d)(req(`size=1000&sessionId=${SESSION}`), {} as never);
      expect(res.status).toBe(200);
      errorSpy.mockRestore();
    });

    it("counts against the guest's own sessionId", async () => {
      const countForGuest = vi.fn().mockResolvedValue(0);
      await makePresignHandler(deps({ countForGuest }))(req(`size=1000&sessionId=${SESSION}`), {} as never);
      expect(countForGuest).toHaveBeenCalledWith(expect.anything(), SESSION);
    });
  });

  describe("rate limiting", () => {
    it("returns the limiter's 429 before doing any work", async () => {
      const getEvents = vi.fn().mockResolvedValue([akad]);
      const d = deps({ getEvents, checkLimit: () => rateLimited(5000) });
      const res = await makePresignHandler(d)(req("size=1000"), {} as never);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(getEvents).not.toHaveBeenCalled();
      expect(d.sign).not.toHaveBeenCalled();
    });

    it("proceeds when the limiter allows the request", async () => {
      const res = await makePresignHandler(deps({ checkLimit: () => null }))(req("size=1000"), {} as never);
      expect(res.status).toBe(200);
    });
  });
});
