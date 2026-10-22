// Mobile Safari handles a programmatic anchor click asynchronously and ignores
// anchors that aren't in the document. Revoking the object URL on the next line —
// as this used to — can cancel the download before it ever starts.
const REVOKE_DELAY_MS = 60_000;

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }, REVOKE_DELAY_MS);
}
