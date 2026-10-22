import { describe, it, expect, vi } from "vitest";
import { isHeicFile, heicToJpeg } from "./heic";

describe("isHeicFile", () => {
  it.each([
    ["image/heic", "IMG_0001.HEIC"],
    ["image/heif", "IMG_0001.heif"],
    ["image/heic-sequence", "burst.heics"],
    // Some pickers hand over HEIC with an empty MIME type; the extension is
    // then the only signal left.
    ["", "IMG_0002.heic"],
    ["", "IMG_0002.HEIF"],
    ["application/octet-stream", "photo.heic"],
  ])("recognises type=%j name=%j", (type, name) => {
    expect(isHeicFile(new File(["x"], name, { type }))).toBe(true);
  });

  it.each([
    ["image/jpeg", "IMG_0001.jpg"],
    ["image/png", "shot.png"],
    ["", "unknown.bin"],
    ["image/jpeg", "heic-in-name-only.jpg"],
  ])("rejects type=%j name=%j", (type, name) => {
    expect(isHeicFile(new File(["x"], name, { type }))).toBe(false);
  });
});

describe("heicToJpeg", () => {
  it("loads the decoder lazily and asks it for a JPEG blob", async () => {
    const out = new Blob(["jpeg"], { type: "image/jpeg" });
    const heicTo = vi.fn().mockResolvedValue(out);
    const load = vi.fn().mockResolvedValue({ heicTo });
    const input = new Blob(["heic"], { type: "image/heic" });

    const result = await heicToJpeg(input, load);

    expect(result).toBe(out);
    expect(load).toHaveBeenCalledOnce();
    expect(heicTo).toHaveBeenCalledWith({ blob: input, type: "image/jpeg", quality: expect.any(Number) });
  });

  it("propagates decoder failures so the caller can tell the guest", async () => {
    const load = vi.fn().mockResolvedValue({ heicTo: vi.fn().mockRejectedValue(new Error("not heic")) });
    await expect(heicToJpeg(new Blob(["x"]), load)).rejects.toThrow("not heic");
  });
});
