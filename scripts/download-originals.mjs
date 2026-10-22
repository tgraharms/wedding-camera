// Full-quality archive of every guest photo: the private original where one
// exists, the 4096px display copy otherwise. READ-ONLY against R2 and the
// database; it writes only under <outDir>. Resumable: <outDir>/.downloaded
// records each file written, and a later run replaces a -copy.jpg with its
// original once that has arrived. Run from the repo root (reads .dev.vars, or
// ENV_FILE, e.g. ENV_FILE=.dev.vars.demo for the demo environment).
//
//   node scripts/download-originals.mjs <outDir> [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import {
  sniffExt, archivePath, originalKeyFor, parseListXml,
  parseLedger, ledgerLine, ledgerAction, needsFullId, removableCopy, contentRangeTotal, photoReadProblem,
} from "./archive-helpers.mjs";

const outDir = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!outDir || outDir.startsWith("--")) {
  console.error("usage: node scripts/download-originals.mjs <outDir> [--dry-run]");
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(process.env.ENV_FILE || ".dev.vars", "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; })
);
const auth = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
const r2 = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}`;

// PostgREST caps a response at max_rows (1000), so page with Range. The exact
// count makes a short or shifting read fail loudly instead of quietly leaving
// photos out of the archive (and out of the orphan check).
async function allPhotos() {
  const rows = [];
  const totals = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/photos?select=storage_key,session_id,captured_at,events(name),guests(display_name)&order=captured_at.asc,id.asc`,
      { headers: { ...auth, Range: `${from}-${from + 999}`, "Range-Unit": "items", Prefer: "count=exact" } }
    );
    if (!r.ok) throw new Error(`photos page ${from}: ${r.status} ${await r.text()}`);
    const total = contentRangeTotal(r.headers.get("content-range"));
    totals.push(total);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000 || (total !== null && rows.length >= total)) break;
  }
  const problem = photoReadProblem(rows.map((p) => p.storage_key), totals);
  if (problem) throw new Error(`photos read incomplete (${problem}); nothing written, re-run`);
  return rows;
}

async function listOriginals() {
  const keys = new Set();
  let token;
  do {
    const u = new URL(endpoint);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", "originals/");
    if (token) u.searchParams.set("continuation-token", token);
    const r = await r2.fetch(u.toString());
    if (!r.ok) throw new Error(`R2 list: ${r.status} ${await r.text()}`);
    const page = parseListXml(await r.text());
    page.keys.forEach((k) => keys.add(k));
    token = page.truncated ? page.next : undefined;
  } while (token);
  return keys;
}

// R2 first, then photos: an original can only be presigned once its photo row
// exists, so every original in this list already has its row in the read that
// follows. The other order reports fresh uploads as orphans.
const originals = await listOriginals();
const photos = await allPhotos();
const known = new Set(photos.map((p) => originalKeyFor(p.storage_key)));
const orphans = [...originals].filter((k) => !known.has(k));
const withOriginal = photos.filter((p) => originals.has(originalKeyFor(p.storage_key))).length;
console.log(`photos: ${photos.length} | with original: ${withOriginal} | display copy only: ${photos.length - withOriginal}`);
if (orphans.length) console.log(`originals with no photo row (reported, not deleted): ${orphans.length}`, orphans.slice(0, 20));
if (!photos.length && originals.size) console.log("photos read returned 0 rows: never purge originals on an empty read");

const ledgerFile = path.join(outDir, ".downloaded");
const ledger = parseLedger(fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8") : "");
const plan = photos.map((p) => ({
  p,
  action: ledgerAction(ledger.get(p.storage_key), originals.has(originalKeyFor(p.storage_key))),
}));
const planned = (a) => plan.filter((x) => x.action === a).length;
console.log(`archive ${outDir}: to download ${planned("download")}, copies to upgrade ${planned("upgrade")}, up to date ${planned("skip")}`);
if (dryRun) process.exit(0);

fs.mkdirSync(outDir, { recursive: true });
let nOrig = 0, nCopy = 0, nUpgrade = 0, nSkip = 0, nFullId = 0, bytesTotal = 0;
const failed = [];
const copiesLeft = [];
for (const { p, action } of plan) {
  if (action === "skip") { nSkip++; continue; }
  const entry = ledger.get(p.storage_key);
  const origKey = originalKeyFor(p.storage_key);
  const isCopy = !originals.has(origKey);
  try {
    const r = await r2.fetch(`${endpoint}/${isCopy ? p.storage_key : origKey}`);
    if (!r.ok) throw new Error(`GET ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    const meta = {
      eventName: p.events?.name ?? "tanpa-majlis", guestName: p.guests?.display_name,
      sessionId: p.session_id, capturedAt: p.captured_at, storageKey: p.storage_key,
    };
    const ext = isCopy ? "jpg" : sniffExt(buf);
    let rel = archivePath(meta, ext, isCopy);
    if (needsFullId(entry, rel, fs.existsSync(path.join(outDir, rel)))) {
      rel = archivePath(meta, ext, isCopy, { fullId: true });
      nFullId++;
    }
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    if (action === "upgrade") {
      // A bare (older) ledger line has no path: a copy would be at its usual
      // name, and there may be none (that format recorded originals too).
      const old = entry.rel ?? archivePath(meta, "jpg", true);
      const oldPath = path.join(outDir, old);
      if (removableCopy(old) && old !== rel && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      else if (entry.rel !== undefined) copiesLeft.push(old);
    }
    fs.appendFileSync(ledgerFile, ledgerLine(p.storage_key, isCopy ? "copy" : "orig", rel));
    ledger.set(p.storage_key, { kind: isCopy ? "copy" : "orig", rel });
    if (action === "upgrade") nUpgrade++;
    else if (isCopy) nCopy++;
    else nOrig++;
    bytesTotal += buf.length;
  } catch (err) {
    failed.push(`${p.storage_key}: ${err.message}`);
  }
}
console.log(
  `downloaded originals: ${nOrig}, display copies: ${nCopy}, copies upgraded to originals: ${nUpgrade}, ` +
  `already had: ${nSkip}, ${(bytesTotal / 1e6).toFixed(1)} MB`
);
if (nFullId) console.log(`saved under the full uuid because the short name was taken: ${nFullId}`);
if (copiesLeft.length) console.log(`old -copy files not found or not removable (left as they are): ${copiesLeft.length}`, copiesLeft.slice(0, 20));
if (failed.length) { console.log(`failed (re-run to retry): ${failed.length}`, failed.slice(0, 20)); process.exitCode = 1; }
