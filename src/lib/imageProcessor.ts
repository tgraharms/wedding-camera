interface DecodedImage {
  width: number;
  height: number;
  close: () => void;
}

interface DrawOpts {
  source: DecodedImage;
  targetW: number;
  targetH: number;
}

export interface ProcessDeps {
  // Decoding owns orientation, including mirrored EXIF variants. The returned
  // dimensions describe the upright pixels, not the raw sensor dimensions.
  decode: (blob: Blob) => Promise<DecodedImage>;
  draw: (opts: DrawOpts) => unknown;
  encode: (canvas: unknown) => Promise<Blob>;
}

// Longest edge of the stored photo. 1600px (the original setting) was fine
// for a 2-column grid but visibly soft once the gallery overlay let guests
// pinch-zoom (on-device feedback, 2026-09-13), so it went to 3200px / q0.85.
// For the upload week (2026-10-01) storage is cheap and guests send finished
// photos from their library, so the copy aims for "looks like the original":
// 4096px keeps every 12MP frame (4032x3024) at native resolution and stays
// inside iOS Safari's ~16.7MP canvas ceiling; q0.92 is visually lossless.
// Expect ~2–4 MB a photo, up to ~6 MB for a very detailed frame — inside the
// 16 MiB presign cap.
export const UPLOAD_MAX_DIMENSION = 4096;
export const JPEG_QUALITY = 0.92;

export async function processImage(
  blob: Blob,
  opts: { maxDimension: number; deps?: ProcessDeps }
): Promise<Blob> {
  const deps = opts.deps ?? defaultDeps();
  const decoded = await deps.decode(blob);
  try {
    const scale = Math.min(1, opts.maxDimension / Math.max(decoded.width, decoded.height));
    const canvas = deps.draw({
      source: decoded,
      targetW: Math.max(1, Math.round(decoded.width * scale)),
      targetH: Math.max(1, Math.round(decoded.height * scale)),
    });
    return await deps.encode(canvas);
  } finally {
    decoded.close();
  }
}

export function defaultDeps(): ProcessDeps {
  return {
    // createImageBitmap already applies EXIF orientation. Rotating again here
    // turns phone portraits sideways. Encode upright pixels once; no date burn.
    decode: (blob) => createImageBitmap(blob, { imageOrientation: "from-image" }),
    draw: ({ source, targetW, targetH }) => {
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas context unavailable");
      ctx.drawImage(source as ImageBitmap, 0, 0, targetW, targetH);
      return canvas;
    },
    encode: (canvas) =>
      new Promise<Blob>((resolve, reject) => {
        (canvas as HTMLCanvasElement).toBlob(
          (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
          "image/jpeg",
          JPEG_QUALITY
        );
      }),
  };
}
