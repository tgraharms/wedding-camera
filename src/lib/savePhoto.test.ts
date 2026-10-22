import { describe, it, expect, vi, beforeEach } from "vitest";
import { savePhotoToDevice } from "./savePhoto";

const blob = new Blob(["jpeg"], { type: "image/jpeg" });
const okFetch = () => vi.fn().mockResolvedValue(new Response(blob, { status: 200, headers: { "content-type": "image/jpeg" } }));

beforeEach(() => vi.restoreAllMocks());

describe("savePhotoToDevice", () => {
  it("hands the photo to the share sheet when the phone can share files (iPhone → 'Save Image')", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const download = vi.fn();
    await savePhotoToDevice("https://r2/1.jpg", "adam-hawa-1.jpg", {
      fetch: okFetch(), canShareFiles: () => true, share, download,
    });
    expect(share).toHaveBeenCalledTimes(1);
    const shared = share.mock.calls[0][0] as { files: File[] };
    expect(shared.files[0].name).toBe("adam-hawa-1.jpg");
    expect(shared.files[0].type).toBe("image/jpeg");
    expect(download).not.toHaveBeenCalled();
  });

  it("falls back to a file download where file sharing is unavailable (Android, desktop)", async () => {
    const download = vi.fn();
    await savePhotoToDevice("https://r2/1.jpg", "adam-hawa-1.jpg", {
      fetch: okFetch(), canShareFiles: () => false, share: vi.fn(), download,
    });
    expect(download).toHaveBeenCalledWith(expect.any(Blob), "adam-hawa-1.jpg");
  });

  it("treats the guest dismissing the share sheet as done, not as an error", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError"));
    await expect(savePhotoToDevice("https://r2/1.jpg", "x.jpg", {
      fetch: okFetch(), canShareFiles: () => true, share, download: vi.fn(),
    })).resolves.toBeUndefined();
  });

  it("rejects when the photo cannot be fetched", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(savePhotoToDevice("https://r2/1.jpg", "x.jpg", {
      fetch, canShareFiles: () => true, share: vi.fn(), download: vi.fn(),
    })).rejects.toThrow(/403/);
  });
});
