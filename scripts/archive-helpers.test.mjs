import { describe, it, expect } from "vitest";
import {
  sniffExt, safeName, stampMyt, originalKeyFor, archivePath, parseListXml,
  parseLedger, ledgerLine, ledgerAction, needsFullId, removableCopy, contentRangeTotal, photoReadProblem,
} from "./archive-helpers.mjs";

const bytes = (...xs) => new Uint8Array(xs);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

describe("archive helpers", () => {
  it("names files by their magic bytes", () => {
    expect(sniffExt(bytes(0xff, 0xd8, 0xff, 0xe1))).toBe("jpg");
    expect(sniffExt(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe("png");
    expect(sniffExt(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")))).toBe("webp");
    expect(sniffExt(bytes(0, 0, 0, 0x18, ...ascii("ftypheic")))).toBe("heic");
    expect(sniffExt(bytes(0, 0, 0, 0x18, ...ascii("ftypmif1")))).toBe("heic");
    expect(sniffExt(bytes(0, 0, 0, 0x18, ...ascii("ftypavif")))).toBe("avif");
    expect(sniffExt(bytes(1, 2, 3))).toBe("bin");
  });

  it("makes guest and event names safe as folder names", () => {
    expect(safeName("Mak Long / Kak Ngah")).toBe("Mak Long - Kak Ngah");
    expect(safeName("  a:b*c?  ")).toBe("a-b-c-");
    expect(safeName("")).toBe("tanpa-nama");
  });

  it("never lets a name become a dot path or a hidden file", () => {
    expect(safeName("..")).toBe("tanpa-nama");
    expect(safeName(".")).toBe("tanpa-nama");
    expect(safeName(" .hidden ")).toBe("hidden");
    expect(safeName("trailing.")).toBe("trailing");
    expect(safeName("Mak Long")).toBe("Mak Long");
    expect(safeName(" . . ")).toBe("tanpa-nama");
    // The 60-character cut can expose a trailing dot or space; strip that too.
    expect(safeName("a".repeat(59) + ". b")).toBe("a".repeat(59));
  });

  it("stamps capture times in Malaysia time", () => {
    expect(stampMyt("2026-09-19T05:30:12.000Z")).toBe("20260919-133012");
  });

  it("derives the private original key exactly like the server", () => {
    expect(originalKeyFor("e1/abc.jpg")).toBe("originals/e1/abc");
  });

  it("lays files out as event / guest / time-id", () => {
    const p = {
      eventName: "Upload Gambar", guestName: "Ali", sessionId: "22222222-aaaa",
      capturedAt: "2026-10-02T01:00:00Z", storageKey: "e1/33333333-3333-4333-8333-333333333333.jpg",
    };
    expect(archivePath(p, "heic", false)).toBe("Upload Gambar/Ali/20261002-090000-33333333.heic");
    expect(archivePath({ ...p, guestName: null }, "jpg", true)).toBe(
      "Upload Gambar/tanpa-nama-22222222/20261002-090000-33333333-copy.jpg"
    );
  });

  it("names a file by the full uuid when asked, to step around a collision", () => {
    const p = {
      eventName: "Akad", guestName: "Ali", sessionId: "22222222-aaaa",
      capturedAt: "2026-10-02T01:00:00Z", storageKey: "e1/33333333-3333-4333-8333-333333333333.jpg",
    };
    expect(archivePath(p, "heic", false, { fullId: true })).toBe(
      "Akad/Ali/20261002-090000-33333333-3333-4333-8333-333333333333.heic"
    );
    expect(archivePath(p, "jpg", true, { fullId: true })).toBe(
      "Akad/Ali/20261002-090000-33333333-3333-4333-8333-333333333333-copy.jpg"
    );
    expect(archivePath(p, "jpg", false, {})).toBe("Akad/Ali/20261002-090000-33333333.jpg");
  });

  it("uses the full uuid only when the destination exists and the ledger does not map this key to it", () => {
    const rel = "Akad/Ali/20261002-090000-33333333.heic";
    expect(needsFullId(undefined, rel, false)).toBe(false);
    expect(needsFullId(undefined, rel, true)).toBe(true);
    expect(needsFullId({ kind: "orig", rel }, rel, true)).toBe(false);
    expect(needsFullId({ kind: "copy", rel: "Akad/Ali/20261002-090000-33333333-copy.jpg" }, rel, true)).toBe(true);
    // An older bare-key line has no path. A file at this key's own name was
    // written by the old script for this same key, so it is overwritten.
    expect(needsFullId({ kind: "copy", rel: undefined }, rel, true)).toBe(false);
  });

  it("reads the ledger: kind and path per key, bare keys count as copy, last line wins", () => {
    const text =
      "e1/a.jpg\n" +
      "e1/b.jpg\tcopy\tAkad/Ali/20261002-090000-bbbbbbbb-copy.jpg\n" +
      "e1/c.jpg\tcopy\tAkad/Ali/c-copy.jpg\n" +
      "\n" +
      "e1/c.jpg\torig\tAkad/Ali/c.heic\r\n" +
      "e1/d.jpg\torig\tAkad/Ali/d.jpg\n" +
      "e1/d.jpg\tcopy\tAkad/Ali/d-copy.jpg";
    const m = parseLedger(text);
    expect(m.size).toBe(4);
    expect(m.get("e1/a.jpg")).toEqual({ kind: "copy", rel: undefined });
    expect(m.get("e1/b.jpg")).toEqual({ kind: "copy", rel: "Akad/Ali/20261002-090000-bbbbbbbb-copy.jpg" });
    expect(m.get("e1/c.jpg")).toEqual({ kind: "orig", rel: "Akad/Ali/c.heic" });
    expect(m.get("e1/d.jpg")).toEqual({ kind: "copy", rel: "Akad/Ali/d-copy.jpg" });
    expect(parseLedger("")).toEqual(new Map());
  });

  it("writes ledger lines the reader understands", () => {
    const line = ledgerLine("e1/a.jpg", "orig", "Akad/Ali/x.heic");
    expect(line).toBe("e1/a.jpg\torig\tAkad/Ali/x.heic\n");
    expect(parseLedger(line).get("e1/a.jpg")).toEqual({ kind: "orig", rel: "Akad/Ali/x.heic" });
  });

  it("skips originals, keeps copies until an original arrives, then upgrades", () => {
    expect(ledgerAction(undefined, false)).toBe("download");
    expect(ledgerAction(undefined, true)).toBe("download");
    expect(ledgerAction({ kind: "orig", rel: "x.heic" }, true)).toBe("skip");
    expect(ledgerAction({ kind: "orig", rel: "x.heic" }, false)).toBe("skip");
    expect(ledgerAction({ kind: "copy", rel: "x-copy.jpg" }, false)).toBe("skip");
    expect(ledgerAction({ kind: "copy", rel: "x-copy.jpg" }, true)).toBe("upgrade");
    expect(ledgerAction({ kind: "copy", rel: undefined }, true)).toBe("upgrade");
  });

  it("only removes a ledger path that is a display copy inside the archive", () => {
    expect(removableCopy("Akad/Ali/20261002-090000-33333333-copy.jpg")).toBe(true);
    expect(removableCopy("Akad/Ali/20261002-090000-33333333.heic")).toBe(false);
    expect(removableCopy("../elsewhere/x-copy.jpg")).toBe(false);
    expect(removableCopy("Akad/../../x-copy.jpg")).toBe(false);
    expect(removableCopy("/etc/x-copy.jpg")).toBe(false);
    expect(removableCopy("Akad\\x-copy.jpg")).toBe(false);
    expect(removableCopy("Akad//x-copy.jpg")).toBe(false);
    expect(removableCopy(undefined)).toBe(false);
  });

  it("reads the exact row total from a PostgREST Content-Range", () => {
    expect(contentRangeTotal("0-999/8000")).toBe(8000);
    expect(contentRangeTotal("*/0")).toBe(0);
    expect(contentRangeTotal("0-24/*")).toBe(null);
    expect(contentRangeTotal(null)).toBe(null);
  });

  it("accepts a photos read only when it is complete against the exact count", () => {
    expect(photoReadProblem(["a", "b", "c"], [3, 3])).toBe(null);
    expect(photoReadProblem([], [0])).toBe(null);
    expect(photoReadProblem(["a", "b"], [3])).toMatch(/2 rows .* of 3/);
    expect(photoReadProblem(["a", "b", "b"], [3, 3])).toMatch(/2 unique/);
    expect(photoReadProblem(["a", "b", "c"], [3, 4])).toMatch(/changed/);
    expect(photoReadProblem(["a"], [null])).toMatch(/exact count/);
    expect(photoReadProblem([], [])).toMatch(/exact count/);
  });

  it("parses an R2 ListObjectsV2 page", () => {
    const xml =
      "<ListBucketResult><IsTruncated>true</IsTruncated>" +
      "<Contents><Key>originals/e1/a</Key></Contents><Contents><Key>originals/e1/b&amp;c</Key></Contents>" +
      "<NextContinuationToken>tok123</NextContinuationToken></ListBucketResult>";
    expect(parseListXml(xml)).toEqual({ keys: ["originals/e1/a", "originals/e1/b&c"], truncated: true, next: "tok123" });
    expect(parseListXml("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({
      keys: [], truncated: false, next: undefined,
    });
  });
});
