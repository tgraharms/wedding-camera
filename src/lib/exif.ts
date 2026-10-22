// Returns the EXIF orientation (1-8), or 1 if none/unreadable.
export async function readOrientation(blob: Blob): Promise<number> {
  try {
    const view = new DataView(await blob.arrayBuffer());
    if (view.byteLength < 2 || view.getUint16(0) !== 0xffd8) return 1; // not JPEG

    let offset = 2;
    while (offset + 4 < view.byteLength) {
      const marker = view.getUint16(offset);
      if (marker === 0xffe1) {
        // APP1 — look for "Exif\0\0"
        const app1Start = offset + 4;
        if (view.getUint32(app1Start) !== 0x45786966) return 1; // "Exif"
        const tiff = app1Start + 6;
        const little = view.getUint16(tiff) === 0x4949;
        const firstIFD = view.getUint32(tiff + 4, little);
        const dirStart = tiff + firstIFD;
        const entries = view.getUint16(dirStart, little);
        for (let i = 0; i < entries; i++) {
          const entry = dirStart + 2 + i * 12;
          if (view.getUint16(entry, little) === 0x0112) {
            return view.getUint16(entry + 8, little);
          }
        }
        return 1;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      offset += 2 + view.getUint16(offset + 2);
    }
    return 1;
  } catch {
    return 1;
  }
}
