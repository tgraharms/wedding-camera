import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import * as api from "./lib/apiClient";
import * as session from "./lib/session";
import { UploadQueue } from "./lib/uploadQueue";
import { OriginalsQueue } from "./lib/originalsQueue";

vi.mock("./lib/imageProcessor", () => ({
  processImage: vi.fn().mockResolvedValue(new Blob(["stamped"], { type: "image/jpeg" })),
  UPLOAD_MAX_DIMENSION: 4096,
}));

// The real module dynamically imports a 3 MB WASM decoder; the tests only care
// that App reaches for it at the right moment.
vi.mock("./lib/heic", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/heic")>();
  return { ...real, heicToJpeg: vi.fn() };
});

beforeEach(() => {
  localStorage.clear();
  indexedDB.deleteDatabase("wc-uploads");
  indexedDB.deleteDatabase("wc-originals");
  // vi.spyOn returns the existing spy when a method is already spied, so call
  // history would otherwise accumulate across tests in this file.
  vi.clearAllMocks();
  vi.spyOn(api, "getStatus").mockResolvedValue({ state: "open", eventId: "e1", eventName: "Akad" });
});

afterEach(() => {
  vi.useRealTimers();
});

// Retry delays are collapsed to zero so these tests don't wait out the real 1s/2s/4s ladder.
const fastRetry = { baseDelayMs: 0, sleep: async () => {} };

describe("App boot", () => {
  it("boots to Landing when getStatus resolves open", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /muat naik (gambar|lagi)/i })).toBeInTheDocument();
  });

  it("shows a retry screen instead of hanging on 'Memuatkan…' when status fails to load", async () => {
    vi.spyOn(api, "getStatus").mockRejectedValue(new Error("network down"));

    render(<App retryOpts={fastRetry} />);

    expect(await screen.findByRole("button", { name: /cuba lagi/i })).toBeInTheDocument();
    // Exact match: the error copy also contains "memuatkan", so a regex would
    // match the error paragraph rather than the loading placeholder.
    expect(screen.queryByText("Memuatkan…")).not.toBeInTheDocument();
  });

  it("recovers when the guest presses the retry button", async () => {
    vi.spyOn(api, "getStatus").mockRejectedValue(new Error("still down"));
    render(<App retryOpts={fastRetry} />);
    const retry = await screen.findByRole("button", { name: /cuba lagi/i });

    vi.spyOn(api, "getStatus").mockResolvedValue({ state: "open", eventId: "e1", eventName: "Akad" });
    await userEvent.click(retry);

    expect(await screen.findByRole("button", { name: /muat naik (gambar|lagi)/i })).toBeInTheDocument();
  });
});

describe("App upload path", () => {
  it("processes a picked file and enqueues it for upload", async () => {
    const enqueueSpy = vi.spyOn(UploadQueue.prototype, "enqueue");
    render(<App />);
    const input = await screen.findByTestId("upload-input");
    const file = new File(["x"], "p.jpg", { type: "image/jpeg" });

    await userEvent.upload(input, file);

    await vi.waitFor(() => expect(enqueueSpy).toHaveBeenCalled());
    const { processImage } = await import("./lib/imageProcessor");
    // 4096px long edge (2026-10-01, was 3200px): 1600px looked visibly soft once the
    // gallery overlay let guests pinch-zoom.
    expect(processImage).toHaveBeenCalledWith(file, { maxDimension: 4096 });
    const enqueued = enqueueSpy.mock.calls[0][0];
    expect(enqueued.metadata).toEqual({
      sessionId: session.getSessionId(),
      capturedAt: expect.any(String),
    });
  });
});

describe("App library upload path", () => {
  it("processes a multi-file pick one at a time, in order, and enqueues each", async () => {
    const { processImage } = await import("./lib/imageProcessor");
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(processImage).mockImplementation(async (blob) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Blob([`processed:${(blob as File).name}`], { type: "image/jpeg" });
    });
    const enqueueSpy = vi.spyOn(UploadQueue.prototype, "enqueue");

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    const files = ["a.jpg", "b.jpg", "c.jpg"].map((n) => new File([n], n, { type: "image/jpeg" }));

    await userEvent.upload(input, files);

    await vi.waitFor(() => expect(enqueueSpy).toHaveBeenCalledTimes(3));
    expect(maxInFlight).toBe(1);
    const order = await Promise.all(enqueueSpy.mock.calls.map((c) => c[0].blob.text()));
    expect(order).toEqual(["processed:a.jpg", "processed:b.jpg", "processed:c.jpg"]);
  });

  it("converts a HEIC the browser cannot decode through the WASM decoder, then processes the JPEG", async () => {
    const { processImage } = await import("./lib/imageProcessor");
    const { heicToJpeg } = await import("./lib/heic");
    const converted = new Blob(["jpeg-from-heic"], { type: "image/jpeg" });
    vi.mocked(processImage)
      .mockRejectedValueOnce(new Error("The source image could not be decoded."))
      .mockResolvedValueOnce(new Blob(["processed"], { type: "image/jpeg" }));
    vi.mocked(heicToJpeg).mockResolvedValueOnce(converted);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const enqueueSpy = vi.spyOn(UploadQueue.prototype, "enqueue");

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    const heic = new File(["heic"], "IMG_0001.HEIC", { type: "image/heic" });
    await userEvent.upload(input, heic);

    await vi.waitFor(() => expect(enqueueSpy).toHaveBeenCalledOnce());
    expect(heicToJpeg).toHaveBeenCalledWith(heic);
    expect(vi.mocked(processImage).mock.calls[1][0]).toBe(converted);
    expect(await enqueueSpy.mock.calls[0][0].blob.text()).toBe("processed");
    expect(screen.queryByTestId("format-error")).not.toBeInTheDocument();
  });

  it("does not touch the WASM decoder when native HEIC decode succeeds", async () => {
    const { heicToJpeg } = await import("./lib/heic");
    const enqueueSpy = vi.spyOn(UploadQueue.prototype, "enqueue");

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    await userEvent.upload(input, new File(["heic"], "IMG_0001.heic", { type: "image/heic" }));

    await vi.waitFor(() => expect(enqueueSpy).toHaveBeenCalledOnce());
    expect(heicToJpeg).not.toHaveBeenCalled();
  });

  it("tells the guest the format is unsupported when a HEIC fails both decoders, and uploads nothing", async () => {
    const { processImage } = await import("./lib/imageProcessor");
    const { heicToJpeg } = await import("./lib/heic");
    vi.mocked(processImage).mockRejectedValueOnce(new Error("decode failed"));
    vi.mocked(heicToJpeg).mockRejectedValueOnce(new Error("ERR_LIBHEIF format not supported"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const enqueueSpy = vi.spyOn(UploadQueue.prototype, "enqueue");

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    await userEvent.upload(input, new File(["heic"], "IMG_0001.heic", { type: "image/heic" }));

    expect(await screen.findByTestId("format-error")).toBeInTheDocument();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  // The raw fallback exists for a corrupt JPEG. A PNG that fails to decode is
  // not something we can safely push under a .jpg key.
  it("never uploads a non-JPEG original raw when processing fails", async () => {
    const { processImage } = await import("./lib/imageProcessor");
    vi.mocked(processImage).mockRejectedValueOnce(new Error("decode failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const enqueueSpy = vi.spyOn(UploadQueue.prototype, "enqueue");

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    await userEvent.upload(input, new File(["png"], "shot.png", { type: "image/png" }));

    expect(await screen.findByTestId("format-error")).toBeInTheDocument();
    expect(screen.queryByText(/gambar gagal diproses/i)).not.toBeInTheDocument();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("clears the format error on the next successful pick", async () => {
    const { processImage } = await import("./lib/imageProcessor");
    vi.mocked(processImage).mockRejectedValueOnce(new Error("decode failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(UploadQueue.prototype, "enqueue");

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    await userEvent.upload(input, new File(["png"], "shot.png", { type: "image/png" }));
    expect(await screen.findByTestId("format-error")).toBeInTheDocument();

    await userEvent.upload(input, new File(["jpg"], "ok.jpg", { type: "image/jpeg" }));
    await vi.waitFor(() => expect(screen.queryByTestId("format-error")).not.toBeInTheDocument());
  });
});

describe("App upload error handling", () => {
  it("falls back to enqueuing the original file when processImage fails and it's small enough", async () => {
    const { processImage } = await import("./lib/imageProcessor");
    vi.mocked(processImage).mockRejectedValueOnce(new Error("decode failed"));
    const enqueueSpy = vi.spyOn(UploadQueue.prototype, "enqueue");

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    const file = new File(["x"], "p.jpg", { type: "image/jpeg" }); // tiny, well under the 5MiB cap

    await userEvent.upload(input, file);

    await vi.waitFor(() => expect(enqueueSpy).toHaveBeenCalled());
    expect(enqueueSpy.mock.calls[0][0].blob).toBe(file);
    expect(screen.queryByText(/gambar gagal diproses/i)).not.toBeInTheDocument();
  });

  it("still falls back to a 12 MiB original, now that the upload cap is 16 MiB", async () => {
    const { processImage } = await import("./lib/imageProcessor");
    vi.mocked(processImage).mockRejectedValueOnce(new Error("decode failed"));
    const enqueueSpy = vi.spyOn(UploadQueue.prototype, "enqueue");

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    const file = new File(["x"], "p.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: 12 * 1024 * 1024 });

    await userEvent.upload(input, file);

    await vi.waitFor(() => expect(enqueueSpy).toHaveBeenCalled());
    expect(enqueueSpy.mock.calls[0][0].blob).toBe(file);
  });

  it("shows the error copy and does not enqueue when processImage fails and the original is over the size cap", async () => {
    const { processImage } = await import("./lib/imageProcessor");
    vi.mocked(processImage).mockRejectedValueOnce(new Error("decode failed"));
    const enqueueSpy = vi.spyOn(UploadQueue.prototype, "enqueue");

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    const file = new File(["x"], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: 16 * 1024 * 1024 + 1 });

    await userEvent.upload(input, file);

    expect(await screen.findByText(/gambar gagal diproses/i)).toBeInTheDocument();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  // Safari private mode rejects the IndexedDB write. Before this the thumbnail was
  // painted first and the rejection only reached the console, so a lost photo
  // looked identical to a sent one (2026-09-04 smoke test).
  //
  // A refused save is retried once after the stored originals are shed, so
  // the queue refuses BOTH attempts here: a photo IndexedDB will not take at
  // all must still reach the guest as an error, never as a thumbnail.
  it("tells the guest and paints no thumbnail when the queue refuses to store the photo", async () => {
    vi.spyOn(UploadQueue.prototype, "enqueue")
      .mockRejectedValueOnce(new Error("UnknownError: private mode"))
      .mockRejectedValueOnce(new Error("UnknownError: private mode"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<App />);
    const input = await screen.findByTestId("upload-input");
    await userEvent.upload(input, new File(["x"], "p.jpg", { type: "image/jpeg" }));

    expect(await screen.findByTestId("save-error")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    // The thumbnail has alt="" (role "presentation"), which the role query
    // above cannot see; look for the element itself.
    expect(document.querySelector("img.status__thumb")).toBeNull();
    expect(errorLog).toHaveBeenCalled();
  });

  // Originals are parked before the display copy is saved, so on a nearly
  // full phone they can be what pushes the display save over the edge. A
  // best-effort original must never cost a guest their photo: shed them and
  // try once more before telling the guest anything.
  it("sheds stored originals and saves the photo on a second try when the queue refuses it once", async () => {
    const enqueue = vi.spyOn(UploadQueue.prototype, "enqueue").mockRejectedValueOnce(new Error("QuotaExceededError"));
    const shed = vi.spyOn(OriginalsQueue.prototype, "shed");
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<App />);
    const sid = session.getSessionId();
    await userEvent.upload(await screen.findByTestId("upload-input"), new File(["x"], "p.jpg", { type: "image/jpeg" }));

    await vi.waitFor(() => expect(document.querySelector("img.status__thumb")).not.toBeNull());
    const mine = enqueue.mock.calls.flatMap((c, i) => (c[0].metadata.sessionId === sid ? [i] : []));
    expect(mine).toHaveLength(2);
    expect(enqueue.mock.calls[mine[1]][0].id).toBe(enqueue.mock.calls[mine[0]][0].id);
    expect(shed).toHaveBeenCalledTimes(1);
    const shedOrder = shed.mock.invocationCallOrder[0];
    expect(shedOrder).toBeGreaterThan(enqueue.mock.invocationCallOrder[mine[0]]);
    expect(shedOrder).toBeLessThan(enqueue.mock.invocationCallOrder[mine[1]]);
    expect(screen.queryByTestId("save-error")).not.toBeInTheDocument();
  });

  it("tells the guest when the retry after shedding originals is refused too, and sheds only once", async () => {
    const enqueue = vi.spyOn(UploadQueue.prototype, "enqueue")
      .mockRejectedValueOnce(new Error("QuotaExceededError"))
      .mockRejectedValueOnce(new Error("QuotaExceededError"));
    const shed = vi.spyOn(OriginalsQueue.prototype, "shed");
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<App />);
    const sid = session.getSessionId();
    await userEvent.upload(await screen.findByTestId("upload-input"), new File(["x"], "p.jpg", { type: "image/jpeg" }));

    expect(await screen.findByTestId("save-error")).toBeInTheDocument();
    expect(enqueue.mock.calls.filter((c) => c[0].metadata.sessionId === sid)).toHaveLength(2);
    expect(shed).toHaveBeenCalledTimes(1);
    expect(document.querySelector("img.status__thumb")).toBeNull();
  });
});

describe("App gallery", () => {
  beforeEach(() => {
    // Gallery interactions require an existing uploaded photo.
    session.bumpDoneCount();
  });

  it("loads getMyPhotos with the stored sessionId and renders MyGallery", async () => {
    const sessionId = session.getSessionId();
    vi.spyOn(api, "getMyPhotos").mockResolvedValue({
      photos: [{ id: "p1", imageUrl: "https://r2/1.jpg", capturedAt: "2026-06-01T00:00:00Z" }],
      profile: { displayName: null, message: null },
      hasMore: false,
      total: 1,
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /galeri saya/i }));

    expect(await screen.findByRole("img")).toHaveAttribute("src", "https://r2/1.jpg");
    expect(api.getMyPhotos).toHaveBeenCalledWith(sessionId, 0);
  });

  it("requests the next 0-based page and appends when Lagi is pressed", async () => {
    const sessionId = session.getSessionId();
    vi.spyOn(api, "getMyPhotos")
      .mockResolvedValueOnce({
        photos: [{ id: "p1", imageUrl: "https://r2/1.jpg", capturedAt: "2026-06-01T00:00:00Z" }],
        profile: { displayName: null, message: null },
        hasMore: true,
        total: 2,
      })
      .mockResolvedValueOnce({
        photos: [{ id: "p2", imageUrl: "https://r2/2.jpg", capturedAt: "2026-06-02T00:00:00Z" }],
        profile: { displayName: null, message: null },
        hasMore: false,
        total: 2,
      });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /galeri saya/i }));
    await screen.findByRole("img");

    await userEvent.click(await screen.findByRole("button", { name: /lagi/i }));

    expect(api.getMyPhotos).toHaveBeenNthCalledWith(1, sessionId, 0);
    expect(api.getMyPhotos).toHaveBeenNthCalledWith(2, sessionId, 1);
    await vi.waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
  });

  it("saves the profile both remotely and locally when a field is blurred", async () => {
    vi.spyOn(api, "getMyPhotos").mockResolvedValue({
      photos: [],
      profile: { displayName: null, message: null },
      hasMore: false,
      total: 0,
    });
    const saveProfileSpy = vi.spyOn(api, "saveProfile").mockResolvedValue(undefined);
    const saveProfileLocalSpy = vi.spyOn(session, "saveProfileLocal");

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /galeri saya/i }));
    const name = await screen.findByLabelText(/nama anda/i);
    await userEvent.type(name, "Aminah");
    await userEvent.tab();

    await vi.waitFor(() => expect(saveProfileSpy).toHaveBeenCalled());
    expect(saveProfileSpy).toHaveBeenCalledWith({
      sessionId: session.getSessionId(),
      displayName: "Aminah",
      message: null,
    });
    expect(saveProfileLocalSpy).toHaveBeenCalledWith({ displayName: "Aminah", message: null });
  });
});

describe("App status polling", () => {
  it("re-polls status every 60s", async () => {
    vi.useFakeTimers();
    const getStatus = vi
      .spyOn(api, "getStatus")
      .mockResolvedValue({ state: "open", eventId: "e1", eventName: "Akad" });

    render(<App />);
    await vi.advanceTimersByTimeAsync(0);
    expect(getStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps the last-known state (no LoadError) when a poll fails after a successful boot", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const getStatus = vi
      .spyOn(api, "getStatus")
      .mockResolvedValueOnce({ state: "open", eventId: "e1", eventName: "Akad" })
      .mockRejectedValueOnce(new Error("wifi dropped"));

    render(<App />);
    await vi.advanceTimersByTimeAsync(0);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /muat naik (gambar|lagi)/i })).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /muat naik (gambar|lagi)/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cuba lagi/i })).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("polls with a single attempt: a failing poll after boot calls getStatus once per tick", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const getStatus = vi
      .spyOn(api, "getStatus")
      .mockResolvedValueOnce({ state: "open", eventId: "e1", eventName: "Akad" })
      .mockRejectedValue(new Error("wifi dropped"));

    render(<App retryOpts={fastRetry} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(getStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getStatus).toHaveBeenCalledTimes(2); // not 5
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getStatus).toHaveBeenCalledTimes(3);
    consoleError.mockRestore();
  });

  it("still retries the first load four times before LoadError", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const getStatus = vi.spyOn(api, "getStatus").mockRejectedValue(new Error("down"));
    render(<App retryOpts={fastRetry} />);
    expect(await screen.findByRole("button", { name: /cuba lagi/i })).toBeInTheDocument();
    expect(getStatus).toHaveBeenCalledTimes(4);
    consoleError.mockRestore();
  });

  it("skips the poll while the page is hidden", async () => {
    vi.useFakeTimers();
    const getStatus = vi
      .spyOn(api, "getStatus")
      .mockResolvedValue({ state: "open", eventId: "e1", eventName: "Akad" });
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      render(<App />);
      await vi.advanceTimersByTimeAsync(0);
      expect(getStatus).toHaveBeenCalledTimes(1); // boot still loads
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getStatus).toHaveBeenCalledTimes(1); // no poll while hidden
    } finally {
      hidden.mockRestore();
    }
  });

  it("refreshes status once when the page becomes visible", async () => {
    const getStatus = vi
      .spyOn(api, "getStatus")
      .mockResolvedValue({ state: "open", eventId: "e1", eventName: "Akad" });
    render(<App />);
    await screen.findByRole("button", { name: /muat naik (gambar|lagi)/i });
    getStatus.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
  });
});

describe("App reconnect wiring", () => {
  // The blocking leg of the silent-photo-loss bug: the `online` listener used to
  // call plain drain(), which only picks up `pending` items whose backoff window
  // has already opened — so items that capped out to `failed` in a venue dead
  // spot, and pending ones mid-ladder, were never revisited when wifi returned.
  it("revives everything rather than just re-draining when connectivity returns", async () => {
    const retryAllNow = vi
      .spyOn(UploadQueue.prototype, "retryAllNow")
      .mockResolvedValue(undefined);
    const drain = vi.spyOn(UploadQueue.prototype, "drain");
    try {
      render(<App />);
      await screen.findByRole("button", { name: /muat naik (gambar|lagi)/i });
      drain.mockClear();

      window.dispatchEvent(new Event("online"));

      expect(retryAllNow).toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
    } finally {
      retryAllNow.mockRestore();
      drain.mockRestore();
    }
  });

  // iOS Safari frequently never fires `online` after an airplane-mode toggle
  // (seen on-device 2026-09-01: two queued photos sat "menunggu" for minutes
  // with wifi back). What iOS does fire reliably is `visibilitychange` — and a
  // guest returning to the app after toggling a setting, or just unlocking
  // their phone, is exactly the moment everything deserves another go.
  it("revives everything when the page becomes visible while online", async () => {
    const retryAllNow = vi
      .spyOn(UploadQueue.prototype, "retryAllNow")
      .mockResolvedValue(undefined);
    try {
      render(<App />);
      await screen.findByRole("button", { name: /muat naik (gambar|lagi)/i });
      retryAllNow.mockClear();

      document.dispatchEvent(new Event("visibilitychange"));

      expect(retryAllNow).toHaveBeenCalled();
    } finally {
      retryAllNow.mockRestore();
    }
  });

  it("does not retry on visibilitychange while offline", async () => {
    const retryAllNow = vi
      .spyOn(UploadQueue.prototype, "retryAllNow")
      .mockResolvedValue(undefined);
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    try {
      render(<App />);
      await screen.findByRole("button", { name: /muat naik (gambar|lagi)/i });
      retryAllNow.mockClear();

      document.dispatchEvent(new Event("visibilitychange"));

      expect(retryAllNow).not.toHaveBeenCalled();
    } finally {
      retryAllNow.mockRestore();
      onLine.mockRestore();
    }
  });
});

describe("done counter persistence", () => {
  it("resets the strip to the server's total once the gallery has loaded", async () => {
    localStorage.setItem("wc.doneCount", "18");
    vi.spyOn(api, "getMyPhotos").mockResolvedValue({
      photos: [{ id: "p1", imageUrl: "https://r2/1.jpg", capturedAt: "2026-06-01T00:00:00Z" }],
      profile: { displayName: null, message: null },
      hasMore: false,
      total: 3,
    });
    render(<App />);
    await screen.findByText(/18 gambar dihantar/);
    await userEvent.click(await screen.findByRole("button", { name: /galeri saya/i }));
    await screen.findByRole("img");
    await userEvent.click(screen.getByRole("button", { name: /kembali/i }));
    expect(await screen.findByText(/3 gambar dihantar/)).toBeInTheDocument();
    expect(localStorage.getItem("wc.doneCount")).toBe("3");
  });

  it("seeds the strip from the persisted count on boot", async () => {
    localStorage.setItem("wc.doneCount", "7");
    render(<App />);
    await screen.findByRole("button", { name: /muat naik (gambar|lagi)/i });
    expect(screen.getByText(/7 gambar dihantar/)).toBeInTheDocument();
  });
});

describe("App private originals", () => {
  // Under full-suite parallelism, an earlier test's App instance can still be
  // mid-flight here: UploadQueue/OriginalsQueue methods are spied on the
  // shared prototype, and an earlier test's real (unmocked) fetch can still
  // be awaiting its up-to-JSON_TIMEOUT_MS abort, holding its IndexedDB
  // connection open and its own enqueue/add/release/reconcile calls pending.
  // Every lookup below is therefore scoped to THIS test's own session id (or,
  // for drain/reconcile, to calls made at or after this test's own render) —
  // never "the first/most-recent call" on the spy, which a leaked call from
  // another test could occupy.
  //
  // Restored after each test: the file-level beforeEach only clears call
  // history (and re-spies getStatus), so a prototype mockImplementation set
  // here would otherwise outlive its test.
  afterEach(() => vi.restoreAllMocks());

  // The OriginalsQueue / UploadQueue instance whose spied call matched this
  // test's own arguments — so later lookups can be scoped by `this`.
  const instanceOf = <T,>(spy: { mock: { calls: T[]; contexts: unknown[] } }, mine: (call: T) => boolean) => {
    const i = spy.mock.calls.findIndex(mine);
    if (i < 0) throw new Error("this test's call hasn't landed yet");
    return spy.mock.contexts[i];
  };
  // The isBusy closure App handed to this test's OriginalsQueue.drain().
  const isBusyFrom = (drain: { mock: { calls: unknown[][]; contexts: unknown[] } }, originals: unknown) => {
    const i = drain.mock.contexts.indexOf(originals);
    if (i < 0) throw new Error("no originals drain call yet for this test's App");
    return (drain.mock.calls[i][0] as { isBusy: () => boolean }).isBusy;
  };

  const pick = async (file: File) => {
    render(<App />);
    // First read of the session id since beforeEach's localStorage.clear():
    // mints and caches a fresh one before the pick that follows reads it
    // right back out.
    const sid = session.getSessionId();
    await userEvent.upload(await screen.findByTestId("upload-input"), file);
    return sid;
  };
  const heic = () => new File(["original-bytes"], "IMG_0001.HEIC", { type: "image/heic" });

  // Order matters: once the display copy is queued, a running drain can
  // deliver it and call release() at once — the original must already exist.
  it("parks the picked file as the original before queueing the display copy", async () => {
    const add = vi.spyOn(OriginalsQueue.prototype, "add").mockResolvedValue(true);
    const enqueue = vi.spyOn(UploadQueue.prototype, "enqueue");
    const file = heic();
    const sid = await pick(file);
    const enqueueCall = await vi.waitFor(() => {
      const call = enqueue.mock.calls.find((c) => c[0].metadata.sessionId === sid);
      if (!call) throw new Error("this test's enqueue call hasn't landed yet");
      return call;
    });
    const addCall = await vi.waitFor(() => {
      const call = add.mock.calls.find((c) => c[1] === file && c[2] === sid);
      if (!call) throw new Error("this test's add call hasn't landed yet");
      return call;
    });
    expect(addCall[0]).toBe(enqueueCall[0].id);
    const addOrder = add.mock.invocationCallOrder[add.mock.calls.indexOf(addCall)];
    const enqueueOrder = enqueue.mock.invocationCallOrder[enqueue.mock.calls.indexOf(enqueueCall)];
    expect(addOrder).toBeLessThan(enqueueOrder);
  });

  it("keeps no separate original when the display copy is the unprocessed file", async () => {
    const { processImage } = await import("./lib/imageProcessor");
    vi.mocked(processImage).mockRejectedValueOnce(new Error("decode failed"));
    const add = vi.spyOn(OriginalsQueue.prototype, "add");
    const enqueue = vi.spyOn(UploadQueue.prototype, "enqueue");
    const sid = await pick(new File(["x"], "p.jpg", { type: "image/jpeg" }));
    await vi.waitFor(() => {
      if (!enqueue.mock.calls.some((c) => c[0].metadata.sessionId === sid)) {
        throw new Error("this test's enqueue call hasn't landed yet");
      }
    });
    expect(add.mock.calls.some((c) => c[2] === sid)).toBe(false);
  });

  it("releases the original under the display copy's storage key once it registers", async () => {
    vi.spyOn(OriginalsQueue.prototype, "add").mockResolvedValue(true);
    const release = vi.spyOn(OriginalsQueue.prototype, "release").mockResolvedValue();
    vi.spyOn(api, "presign").mockResolvedValue({ uploadUrl: "https://r2/u", storageKey: "e1/k.jpg", eventId: "e1" });
    vi.spyOn(api, "putToR2").mockResolvedValue();
    vi.spyOn(api, "savePhoto").mockResolvedValue();
    const enqueue = vi.spyOn(UploadQueue.prototype, "enqueue");
    const sid = await pick(heic());
    const enqueueCall = await vi.waitFor(() => {
      const call = enqueue.mock.calls.find((c) => c[0].metadata.sessionId === sid);
      if (!call) throw new Error("this test's enqueue call hasn't landed yet");
      return call;
    });
    const id = enqueueCall[0].id;
    const releaseCall = await vi.waitFor(() => {
      const call = release.mock.calls.find((c) => c[0] === id);
      if (!call) throw new Error("this test's release call hasn't landed yet");
      return call;
    });
    expect(releaseCall[1]).toBe("e1/k.jpg");
  });

  it("an original that is not kept changes nothing for the guest", async () => {
    vi.spyOn(OriginalsQueue.prototype, "add").mockResolvedValue(false);
    vi.spyOn(api, "presign").mockResolvedValue({ uploadUrl: "https://r2/u", storageKey: "e1/k.jpg", eventId: "e1" });
    vi.spyOn(api, "putToR2").mockResolvedValue();
    vi.spyOn(api, "savePhoto").mockResolvedValue();
    await pick(heic());
    expect(await screen.findByText(/1 gambar dihantar/)).toBeInTheDocument();
    expect(screen.queryByTestId("save-error")).not.toBeInTheDocument();
  });

  it("drains originals only once the display queue is idle", async () => {
    const drain = vi.spyOn(OriginalsQueue.prototype, "drain").mockResolvedValue();
    // Calls already recorded (from an earlier test's still-running instance)
    // are not this test's — only a call made at or after this render counts.
    const before = drain.mock.calls.length;
    render(<App />);
    const call = await vi.waitFor(() => {
      const c = drain.mock.calls[before];
      if (!c) throw new Error("no drain call yet for this test's render");
      return c;
    });
    const opts = call[0] as { isBusy: () => boolean };
    expect(opts.isBusy()).toBe(false);
  });

  // The gate itself: the closure App hands the originals queue must read the
  // live display-queue count — busy while a guest's photo is uploading, idle
  // once it has landed.
  it("tells the originals queue the display queue is busy while a photo uploads, and idle once it lands", async () => {
    vi.spyOn(api, "presign").mockResolvedValue({ uploadUrl: "https://r2/u", storageKey: "e1/k.jpg", eventId: "e1" });
    vi.spyOn(api, "putToR2").mockResolvedValue();
    let landPhoto: (() => void) | undefined;
    const saved = new Promise<void>((r) => { landPhoto = r; });
    const savePhoto = vi.spyOn(api, "savePhoto").mockReturnValue(saved);
    const drain = vi.spyOn(OriginalsQueue.prototype, "drain").mockResolvedValue();
    vi.spyOn(OriginalsQueue.prototype, "add").mockResolvedValue(true);
    const reconcile = vi.spyOn(OriginalsQueue.prototype, "reconcile").mockResolvedValue();
    try {
      const before = Date.now();
      render(<App />);
      const sid = session.getSessionId(); // see pick()
      // This App's originals queue is the one reconciled with its own mount
      // time; its first drain comes from the mount drain, before any pick.
      const originals = await vi.waitFor(() => instanceOf(reconcile, (c) => c[1] >= before));
      const isBusy = await vi.waitFor(() => isBusyFrom(drain, originals));
      expect(isBusy()).toBe(false); // nothing queued yet

      await userEvent.upload(await screen.findByTestId("upload-input"), heic());
      await vi.waitFor(() => {
        if (!savePhoto.mock.calls.some((c) => c[0].sessionId === sid)) {
          throw new Error("this test's upload hasn't reached savePhoto yet");
        }
      });
      await vi.waitFor(() => expect(isBusy()).toBe(true)); // savePhoto still in flight

      landPhoto!();
      expect(await screen.findByText(/1 gambar dihantar/)).toBeInTheDocument();
      await vi.waitFor(() => expect(isBusy()).toBe(false));
    } finally {
      landPhoto?.();
    }
  });

  it("reconciles parked originals against the display queue on startup", async () => {
    const reconcile = vi.spyOn(OriginalsQueue.prototype, "reconcile").mockResolvedValue();
    const before = Date.now();
    render(<App />);
    const call = await vi.waitFor(() => {
      const match = reconcile.mock.calls.find((c) => c[1] >= before);
      if (!match) throw new Error("no reconcile call yet for this test's mount");
      return match;
    });
    expect(call[0]).toBeInstanceOf(Set);
  });

  // Plan-mandated (review fix round 1): retryAllNow() flips a failed item
  // back to `pending` without firing onChange — onChange only fires once an
  // attempt settles or a whole drain() completes — so a drainOriginals()
  // call made directly from the online/visibilitychange handlers would run
  // against the stale, pre-retry pendingRef and start uploading originals
  // while a display retry (a full network re-attempt) is still in flight.
  // Regression for removing those direct calls: originals must only drain
  // via retryAllNow()'s own drain() -> onChange, once the retry has
  // genuinely settled, never synchronously alongside it.
  //
  // The hung savePhoto() below never resolves while the test runs, but it is
  // settled in the finally: an attempt left hanging would keep this test's
  // UploadQueue holding its IndexedDB connection for the rest of the process,
  // which blocks the next test's deleteDatabase("wc-uploads") and every open
  // queued behind it.
  it("does not drain originals while a display retry from 'online' is still in flight", async () => {
    vi.spyOn(api, "presign").mockResolvedValue({ uploadUrl: "https://r2/u", storageKey: "e1/k.jpg", eventId: "e1" });
    vi.spyOn(api, "putToR2").mockResolvedValue();
    // Terminal, not a backoff failure: lands in `failed` on the very first
    // attempt, no window to wait out. The checkpoint written just before this
    // rejects (uploadOrchestrator persists the PUT's storage key before
    // registering) means a retry has nothing left to presign — it skips
    // straight back to savePhoto, so that is the call that must still be in
    // flight when this test checks.
    const savePhoto = vi.spyOn(api, "savePhoto").mockRejectedValueOnce(new api.WindowClosedError());
    const drain = vi.spyOn(OriginalsQueue.prototype, "drain").mockResolvedValue();
    let settleRetry: (() => void) | undefined;
    try {
      const sid = await pick(new File(["x"], "p.jpg", { type: "image/jpeg" }));
      await vi.waitFor(() => {
        if (!savePhoto.mock.calls.some((c) => c[0].sessionId === sid)) {
          throw new Error("this test's first attempt hasn't reached savePhoto yet");
        }
      });
      await screen.findByText(/1 gambar gagal dihantar/);

      const before = drain.mock.calls.length;
      // Hang the retry mid-flight: savePhoto does not resolve until the
      // finally, so retryAllNow's own drain() is still awaiting this attempt
      // when the assertion below runs.
      savePhoto.mockReturnValue(new Promise<void>((r) => { settleRetry = r; }));
      window.dispatchEvent(new Event("online"));
      await vi.waitFor(() => {
        if (savePhoto.mock.calls.filter((c) => c[0].sessionId === sid).length < 2) {
          throw new Error("the retry hasn't started yet");
        }
      });

      expect(drain.mock.calls.length).toBe(before);
    } finally {
      settleRetry?.();
    }
  });

  // retryAllNow() flips a failed item back to `pending` without firing
  // onChange, so until the retry's drain-end onChange reports the real count,
  // pendingRef still holds the stale pre-retry 0. OriginalsQueue's own backoff
  // timer (or a drain already in flight) would then read an idle display
  // queue and start an up-to-64 MiB original beside the guest's retry.
  it("reports the display queue busy while a retry from 'online' is still in flight", async () => {
    vi.spyOn(api, "presign").mockResolvedValue({ uploadUrl: "https://r2/u", storageKey: "e1/k.jpg", eventId: "e1" });
    vi.spyOn(api, "putToR2").mockResolvedValue();
    // Terminal on the first attempt (see the test above): the item lands in
    // `failed`, and its retry goes straight back to savePhoto.
    const savePhoto = vi.spyOn(api, "savePhoto").mockRejectedValueOnce(new api.WindowClosedError());
    const drain = vi.spyOn(OriginalsQueue.prototype, "drain").mockResolvedValue();
    const add = vi.spyOn(OriginalsQueue.prototype, "add").mockResolvedValue(true);
    const enqueue = vi.spyOn(UploadQueue.prototype, "enqueue");
    const displayDrain = vi.spyOn(UploadQueue.prototype, "drain");
    const counts = vi.spyOn(UploadQueue.prototype, "counts");
    let settleRetry: (() => void) | undefined;
    try {
      const file = new File(["x"], "p.jpg", { type: "image/jpeg" });
      const sid = await pick(file);
      await screen.findByText(/1 gambar gagal dihantar/);
      const originals = instanceOf(add, (c) => c[1] === file && c[2] === sid);
      const queue = instanceOf(enqueue, (c) => c[0].metadata.sessionId === sid);
      // Let every drain and count read this test's queue started settle, so
      // no stale count can land on pendingRef after the event below.
      const mine = <R,>(spy: { mock: { contexts: unknown[]; results: R[] } }) =>
        spy.mock.results.filter((_, i) => spy.mock.contexts[i] === queue);
      await Promise.allSettled(mine(displayDrain).map((r) => r.value));
      await Promise.allSettled(mine(counts).map((r) => r.value));
      const isBusy = isBusyFrom(drain, originals);
      expect(isBusy()).toBe(false); // one failed item, nothing pending

      savePhoto.mockReturnValue(new Promise<void>((r) => { settleRetry = r; }));
      window.dispatchEvent(new Event("online"));
      await vi.waitFor(() => {
        if (savePhoto.mock.calls.filter((c) => c[0].sessionId === sid).length < 2) {
          throw new Error("the retry hasn't started yet");
        }
      });

      expect(isBusy()).toBe(true);
    } finally {
      settleRetry?.();
    }
  });
});
