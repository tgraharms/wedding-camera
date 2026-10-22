// Pure helpers for download-originals.mjs, kept separate so they can be tested.

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

export function sniffExt(b) {
  const s = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && s(1, 4) === "PNG") return "png";
  if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "webp";
  if (s(4, 8) === "ftyp") {
    const brand = s(8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (HEIF_BRANDS.has(brand)) return "heic";
  }
  return "bin";
}

// A guest or event name as one folder name. Edge dots and whitespace are
// stripped after the length cut, so no name can be "." or "..", walk out of
// the archive, or become a hidden file.
export function safeName(s) {
  const cleaned = String(s ?? "")
    .normalize("NFC")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "tanpa-nama" : cleaned;
}

// Malaysia has no DST, so a fixed +8 h is exact.
export function stampMyt(iso) {
  const d = new Date(Date.parse(iso) + 8 * 3600_000);
  return d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

// Must match originalKeyFor in functions/api/originals/presign.ts.
export function originalKeyFor(storageKey) {
  return `originals/${storageKey.replace(/\.jpg$/, "")}`;
}

// fullId: name the file by the whole uuid instead of its first 8 characters,
// for when the short name is already taken by another photo's file.
export function archivePath({ eventName, guestName, sessionId, capturedAt, storageKey }, ext, isCopy, { fullId = false } = {}) {
  const uuid = storageKey.split("/")[1].replace(/\.jpg$/, "");
  const id = fullId ? uuid : uuid.slice(0, 8);
  const guest = guestName ? safeName(guestName) : `tanpa-nama-${String(sessionId).slice(0, 8)}`;
  return `${safeName(eventName)}/${guest}/${stampMyt(capturedAt)}-${id}${isCopy ? "-copy" : ""}.${ext}`;
}

// Archive ledger (<outDir>/.downloaded): one line per finished write,
// "<storage_key>\t<orig|copy>\t<relative path>". A bare "<storage_key>" line
// (the first version's format) counts as a copy with an unknown path. The last
// line for a key wins.
export function parseLedger(text) {
  const m = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const [key, kind, rel] = line.split("\t");
    m.set(key, kind === "orig" ? { kind: "orig", rel } : { kind: "copy", rel: kind === "copy" ? rel : undefined });
  }
  return m;
}

export function ledgerLine(storageKey, kind, rel) {
  return `${storageKey}\t${kind}\t${rel}\n`;
}

// "download": not in the archive yet. "skip": the original is in, or only the
// copy exists and still no original. "upgrade": the archive holds the copy and
// the original has since arrived.
export function ledgerAction(entry, hasOriginal) {
  if (!entry) return "download";
  if (entry.kind === "orig") return "skip";
  return hasOriginal ? "upgrade" : "skip";
}

// The short name is taken by a file the ledger does not tie to this key, so
// writing there would overwrite another photo. A bare (older) line has no
// path; a file at this key's own short name was then written for this key.
export function needsFullId(entry, rel, exists) {
  if (!exists) return false;
  if (!entry) return true;
  return entry.rel !== undefined && entry.rel !== rel;
}

// A path from the ledger is deleted on upgrade only if it is a display copy
// strictly inside the archive.
export function removableCopy(rel) {
  if (typeof rel !== "string" || !rel.endsWith("-copy.jpg")) return false;
  if (rel.startsWith("/") || rel.includes("\\")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// PostgREST with Prefer: count=exact answers "0-999/8000" (or "*/0").
export function contentRangeTotal(header) {
  const m = /\/(\d+)$/.exec(String(header ?? ""));
  return m ? Number(m[1]) : null;
}

// A photos read is usable only if every page reported the same exact total
// and the rows, unique by storage key, add up to it. Returns why not, or null.
export function photoReadProblem(storageKeys, totals) {
  if (!totals.length || totals.some((t) => t === null)) return "no exact count in Content-Range";
  if (totals.some((t) => t !== totals[0])) return `photo count changed while reading (${totals.join(" -> ")})`;
  const unique = new Set(storageKeys).size;
  if (storageKeys.length !== totals[0] || unique !== totals[0]) {
    return `read ${storageKeys.length} rows (${unique} unique) of ${totals[0]}`;
  }
  return null;
}

const unxml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function parseListXml(xml) {
  return {
    keys: [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => unxml(m[1])),
    truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml),
    next: xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1],
  };
}
