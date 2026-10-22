import { triggerBlobDownload } from "./download";

export interface SavePhotoDeps {
  fetch: (url: string) => Promise<Response>;
  canShareFiles: (file: File) => boolean;
  share: (data: { files: File[] }) => Promise<void>;
  download: (blob: Blob, filename: string) => void;
}

function defaultDeps(): SavePhotoDeps {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean; share?: (d: ShareData) => Promise<void> };
  return {
    fetch: (url) => fetch(url),
    // iOS Safari ignores `download` on a cross-origin anchor and just opens the
    // image, but its share sheet offers "Save Image" straight into Photos.
    canShareFiles: (file) => typeof nav.canShare === "function" && typeof nav.share === "function" && nav.canShare({ files: [file] }),
    share: (data) => nav.share!(data),
    download: triggerBlobDownload,
  };
}

// Puts the stored copy of a photo on the guest's device: the share sheet where
// files can be shared (iPhone), a plain download elsewhere (Android, desktop).
export async function savePhotoToDevice(url: string, filename: string, deps: SavePhotoDeps = defaultDeps()): Promise<void> {
  const res = await deps.fetch(url);
  if (!res.ok) throw new Error(`photo fetch failed: ${res.status}`);
  const blob = await res.blob();
  const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
  if (deps.canShareFiles(file)) {
    try {
      await deps.share({ files: [file] });
    } catch (err) {
      // Dismissing the sheet is not a failure.
      if (err instanceof DOMException && err.name === "AbortError") return;
      throw err;
    }
    return;
  }
  deps.download(blob, filename);
}
