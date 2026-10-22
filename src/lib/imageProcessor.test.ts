import { describe, it, expect, vi } from "vitest";
import { processImage, defaultDeps, UPLOAD_MAX_DIMENSION, type ProcessDeps } from "./imageProcessor";

function fixture(width: number, height: number) {
  const close = vi.fn();
  const decoded = { width, height, close };
  const output = new Blob(["jpeg"], { type: "image/jpeg" });
  const deps: ProcessDeps = {
    decode: vi.fn().mockResolvedValue(decoded),
    draw: vi.fn().mockReturnValue({}),
    encode: vi.fn().mockResolvedValue(output),
  };
  return { deps, close, decoded, output };
}

describe("processImage", () => {
  it.each([
    [3000, 4000, 1200, 1600],
    [4000, 3000, 1600, 1200],
    [4000, 2000, 1600, 800],
    [600, 800, 600, 800],
  ])("preserves decoded %i x %i proportions as %i x %i", async (w, h, targetW, targetH) => {
    const { deps, close, decoded, output } = fixture(w, h);
    const result = await processImage(new Blob(["raw"]), { maxDimension: 1600, deps });
    expect(result).toBe(output);
    expect(deps.draw).toHaveBeenCalledWith({ source: decoded, targetW, targetH });
    expect(close).toHaveBeenCalledOnce();
  });

  it("releases the decoded bitmap even when encoding fails", async () => {
    const { deps, close } = fixture(3000, 4000);
    vi.mocked(deps.encode).mockRejectedValue(new Error("encode failed"));
    await expect(processImage(new Blob(), { maxDimension: 1600, deps })).rejects.toThrow("encode failed");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("default encoder", () => {
  // 2026-10-01 upload week: storage is cheap, guests now send finished photos
  // from their library, so the stored copy aims for "looks like the original".
  it("re-encodes as JPEG at quality 0.92", async () => {
    const out = new Blob(["jpeg"], { type: "image/jpeg" });
    const toBlob = vi.fn((cb: (b: Blob | null) => void) => cb(out));
    expect(await defaultDeps().encode({ toBlob })).toBe(out);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.92);
  });
  // 4096 keeps every 12MP frame (4032x3024) at native resolution and stays
  // inside iOS Safari's ~16.7MP canvas ceiling.
  it("exports the 4096px upload edge the app uses", () => {
    expect(UPLOAD_MAX_DIMENSION).toBe(4096);
  });
});
