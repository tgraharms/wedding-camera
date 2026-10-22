import { describe, it, expect } from "vitest";
import { readOrientation } from "./exif";

// Minimal JPEG with an APP1/EXIF block declaring Orientation = 6.
function jpegWithOrientation(orientation: number): ArrayBuffer {
  const bytes = [
    0xff, 0xd8, // SOI
    0xff, 0xe1, // APP1
    0x00, 0x16, // length = 22
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, // TIFF big-endian header
    0x00, 0x00, 0x00, 0x08, // offset to first IFD
    0x00, 0x01, // 1 entry
    0x01, 0x12, // tag = orientation
    0x00, 0x03, // type = SHORT
    0x00, 0x00, 0x00, 0x01, // count = 1
    (orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00, // value
  ];
  return new Uint8Array(bytes).buffer;
}

describe("readOrientation", () => {
  it("reads orientation 6 from EXIF", async () => {
    const blob = new Blob([jpegWithOrientation(6)], { type: "image/jpeg" });
    expect(await readOrientation(blob)).toBe(6);
  });

  it("defaults to 1 when no EXIF is present", async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
    expect(await readOrientation(blob)).toBe(1);
  });

  it("falls back to 1 on a truncated EXIF segment", async () => {
    // Valid SOI + APP1 + "Exif\0\0" but the buffer ends before the TIFF header.
    const bytes = [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x16, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    const blob = new Blob([new Uint8Array(bytes).buffer], { type: "image/jpeg" });
    expect(await readOrientation(blob)).toBe(1);
  });

  it("falls back to 1 on a corrupt IFD offset", async () => {
    const bytes = [
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x16,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
      0x4d, 0x4d, 0x00, 0x2a,             // TIFF big-endian
      0xff, 0xff, 0xff, 0xff,             // corrupt/oversized first-IFD offset
    ];
    const blob = new Blob([new Uint8Array(bytes).buffer], { type: "image/jpeg" });
    expect(await readOrientation(blob)).toBe(1);
  });
});
