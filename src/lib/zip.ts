import { downloadZip } from "client-zip";
import { triggerBlobDownload } from "./download";
import type { AdminPhoto } from "./types";

// Zips all photos client-side (zero server cost) and triggers a download.
// Each entry is named "<guestName>-<id>.jpg" ("tanpa-nama" when the guest
// left no name). For very large galleries, run on desktop.
export async function downloadGalleryZip(photos: AdminPhoto[], filename: string): Promise<void> {
  if (photos.length === 0) return;
  const entries = [];
  for (const p of photos) {
    const res = await fetch(p.imageUrl);
    if (!res.ok) continue;
    const blob = await res.clone().blob();
    entries.push({ name: `${p.guestName ?? "tanpa-nama"}-${p.id}.jpg`, input: blob });
  }
  const zipBlob = await downloadZip(entries).blob();
  triggerBlobDownload(zipBlob, filename);
}
