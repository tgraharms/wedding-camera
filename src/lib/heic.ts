// iPhones shoot HEIC by default. Three things stand between that and a JPEG in
// R2:
//   1. iOS Safari transcodes HEIC → JPEG at pick time when the input's accept
//      is a plain image/* — most library picks never reach us as HEIC at all.
//   2. Safari 17+ decodes HEIC natively in createImageBitmap, so processImage
//      handles the "Keep Originals" iPhones on its own.
//   3. Everything else (Android and desktop Chrome, older Safari) cannot decode
//      HEIC. That is the only case this module exists for: a WASM libheif
//      build, imported lazily so no guest pays for it unless they need it.

const HEIC_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const HEIC_EXT = /\.(heic|heif|heics|heifs)$/i;

// Pickers are inconsistent about the MIME type — some hand over "" or
// application/octet-stream for HEIC — so the extension is a second signal.
export function isHeicFile(file: File): boolean {
  if (HEIC_TYPES.has(file.type.toLowerCase())) return true;
  return HEIC_EXT.test(file.name);
}

type Decoder = { heicTo: (args: { blob: Blob; type: "image/jpeg"; quality?: number }) => Promise<Blob> };

const loadDecoder = (): Promise<Decoder> => import("heic-to");

// At least processImage's quality: the result is decoded and re-encoded once
// more during the 4096px resize, and a low first pass compounds visibly.
const CONVERT_QUALITY = 0.92;

export async function heicToJpeg(blob: Blob, load: () => Promise<Decoder> = loadDecoder): Promise<Blob> {
  const { heicTo } = await load();
  return heicTo({ blob, type: "image/jpeg", quality: CONVERT_QUALITY });
}
