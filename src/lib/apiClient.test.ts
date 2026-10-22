import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  putToR2,
  getStatus, presign, savePhoto, getMyPhotos, saveProfile, getShare,
  presignOriginal, putOriginal, ORIGINAL_PUT_TIMEOUT_MS,
  WindowClosedError, QuotaError, TerminalUploadError,
  JSON_TIMEOUT_MS, PUT_TIMEOUT_MS,
} from "./apiClient";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("apiClient", () => {
  it("putToR2 PUTs the blob and rejects on non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await putToR2("https://r2/u", new Blob(["x"], { type: "image/jpeg" }));
    expect(fetchMock).toHaveBeenCalledWith("https://r2/u", expect.objectContaining({ method: "PUT" }));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(putToR2("https://r2/u", new Blob(["x"]))).rejects.toThrow();
  });

  it("getStatus fetches /api/status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ state: "open", eventId: "e1", eventName: "Akad" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await getStatus()).toEqual({ state: "open", eventId: "e1", eventName: "Akad" });
    expect(fetchMock).toHaveBeenCalledWith("/api/status", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("presign hits /api/presign with size, capturedAt and sessionId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ uploadUrl: "u", storageKey: "k", eventId: "e1" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await presign(1000, "T", "s1")).toEqual({ uploadUrl: "u", storageKey: "k", eventId: "e1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/presign?size=1000&capturedAt=T&sessionId=s1",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("presign throws WindowClosedError on a bare 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(presign(1000, "T", "s1")).rejects.toThrow(WindowClosedError);
  });

  it("presign throws WindowClosedError on a 403 that names a closed window", async () => {
    const body = JSON.stringify({ error: "window closed" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 403 })));
    await expect(presign(1000, "T", "s1")).rejects.toThrow(WindowClosedError);
  });

  // Both answer 403, but only one of them means "retrying will never help, and
  // telling the guest to try again is wrong".
  it("presign throws QuotaError on a 403 that names the guest quota", async () => {
    const body = JSON.stringify({ error: "guest quota" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 403 })));
    await expect(presign(1000, "T", "s1")).rejects.toThrow(QuotaError);
  });

  it("presign treats the global cap as a closed window, not a guest quota", async () => {
    const body = JSON.stringify({ error: "event full" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 403 })));
    await expect(presign(1000, "T", "s1")).rejects.toThrow(WindowClosedError);
  });

  // 429 must stay retryable — the queue's jittered backoff is what spreads a
  // venue-wide burst out, so mapping it to a terminal error would lose photos.
  it("presign throws a plain retryable error on 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));
    const err = await presign(1000, "T", "s1").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TerminalUploadError);
  });

  it("savePhoto throws a plain retryable error on 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));
    const meta = { eventId: "e1", storageKey: "k", sessionId: "s1", capturedAt: "T" };
    const err = await savePhoto(meta).catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(TerminalUploadError);
  });

  it("savePhoto POSTs camelCase body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await savePhoto({ eventId: "e1", storageKey: "k", sessionId: "s1", capturedAt: "2026-06-12T12:30:00.000Z" });
    expect(fetchMock).toHaveBeenCalledWith("/api/photos", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ eventId: "e1", storageKey: "k", sessionId: "s1", capturedAt: "2026-06-12T12:30:00.000Z" }),
    }));
  });

  it("savePhoto throws WindowClosedError on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(
      savePhoto({ eventId: "e1", storageKey: "k", sessionId: "s1", capturedAt: "2026-06-12T12:30:00.000Z" })
    ).rejects.toThrow(WindowClosedError);
  });

  it("getMyPhotos hits /api/me/photos with sessionId and page", async () => {
    const body = { photos: [], profile: { displayName: null, message: null }, page: 1, pageSize: 20, hasMore: false, total: 0 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getMyPhotos("id", 1)).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/photos?sessionId=id&page=1",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("saveProfile POSTs to /api/me/profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await saveProfile({ sessionId: "s1", displayName: "Ahmad", message: null });
    expect(fetchMock).toHaveBeenCalledWith("/api/me/profile", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sessionId: "s1", displayName: "Ahmad", message: null }),
    }));
  });

  it("getShare hits /api/share with the token", async () => {
    const body = { photos: [{ id: "p1", imageUrl: "https://r2/1.jpg", capturedAt: "2026-09-19T05:00:00Z" }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getShare("tok en")).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/share?token=tok%20en",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("getShare throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    await expect(getShare("bad")).rejects.toThrow();
  });

  // A fetch that only settles when its signal aborts — models a half-open socket.
  const hangingFetch = () =>
    vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })
    );

  it("getStatus gives up after JSON_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", hangingFetch());
      const p = getStatus();
      const settled = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(JSON_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("putToR2 waits PUT_TIMEOUT_MS, longer than a JSON call", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = hangingFetch();
      vi.stubGlobal("fetch", fetchMock);
      let rejected = false;
      const p = putToR2("https://r2/u", new Blob(["x"])).catch(() => { rejected = true; });
      await vi.advanceTimersByTimeAsync(JSON_TIMEOUT_MS);
      expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(PUT_TIMEOUT_MS - JSON_TIMEOUT_MS);
      await p;
      expect(rejected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fetch that settles in time resolves and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: "ended" }), { status: 200 })));
      expect(await getStatus()).toEqual({ state: "ended" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Headers can arrive fine while the body then stalls (a normal lossy-wifi
  // failure). The deadline has to cover the body read too, not just headers —
  // fetch() is mocked here, so the response's own text() is made to hang until
  // the timeout's AbortController fires, modeling that stall.
  it("getStatus gives up after JSON_TIMEOUT_MS when the body stalls, not just the headers", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        const res = new Response(new ReadableStream({ start() {} }), { status: 200 });
        Object.defineProperty(res, "text", {
          value: () =>
            new Promise((_, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
            }),
        });
        return Promise.resolve(res);
      });
      vi.stubGlobal("fetch", fetchMock);
      const p = getStatus();
      const settled = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(JSON_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("presignOriginal hits /api/originals/presign with storageKey, sessionId and size", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ uploadUrl: "u" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await presignOriginal("e1/k.jpg", "s1", 5)).toEqual({ uploadUrl: "u" });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/originals/presign?storageKey=${encodeURIComponent("e1/k.jpg")}&sessionId=s1&size=5`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("presignOriginal treats 400/403/404 as terminal and anything else as retryable", async () => {
    for (const status of [400, 403, 404]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
      await expect(presignOriginal("e1/k.jpg", "s1", 5)).rejects.toBeInstanceOf(TerminalUploadError);
    }
    for (const status of [429, 500]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
      const err = await presignOriginal("e1/k.jpg", "s1", 5).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TerminalUploadError);
    }
  });

  // A Pages rollback to a build without this route answers it with the SPA's
  // index.html — a 200. Retrying that cannot help, so the original is dropped.
  it("presignOriginal treats a 2xx whose body is not JSON as terminal", async () => {
    const html = "<!doctype html><html><head><title>Kamera Majlis</title></head><body></body></html>";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })
    ));
    const err = await presignOriginal("e1/k.jpg", "s1", 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalUploadError);
    expect((err as Error).message).toBe("original presign unavailable");
  });

  it("putOriginal PUTs the bytes with their own type and rejects on non-2xx", async () => {
    expect(ORIGINAL_PUT_TIMEOUT_MS).toBe(300_000);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const heic = new Blob(["h"], { type: "image/heic" });
    await putOriginal("https://r2/o", heic);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://r2/o",
      expect.objectContaining({ method: "PUT", body: heic, headers: { "content-type": "image/heic" } })
    );
    await putOriginal("https://r2/o", new Blob(["?"]));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://r2/o",
      expect.objectContaining({ headers: { "content-type": "application/octet-stream" } })
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(putOriginal("https://r2/o", heic)).rejects.toThrow();
  });
});
