// One-off: hash an admin password (PBKDF2, matching functions/_lib/password.ts) and
// upsert it into admin_users via the Supabase REST API using the service-role key.
// Usage: node scripts/seed-admin.mjs <username> <password>
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .dev.vars (or ENV_FILE, e.g.
// ENV_FILE=.dev.vars.demo for the demo environment).
import { readFileSync } from "node:fs";

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error("Usage: node scripts/seed-admin.mjs <username> <password>");
  process.exit(1);
}
// Session tokens are "<username>.<expiry>.<hmac>" and are split on "." — a dotted
// username logs in (200 + cookie) then 401s on every request. Refuse it up front.
if (username.includes(".")) {
  console.error("Refusing: username must not contain a dot (it breaks session tokens).");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(process.env.ENV_FILE || ".dev.vars", "utf8")
    .split("\n")
    .filter((l) => l && !l.trimStart().startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const ITERATIONS = 100000;
const enc = new TextEncoder();
const toB64 = (bytes) => Buffer.from(bytes).toString("base64");

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = new Uint8Array(
  await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, key, 256)
);
const passwordHash = `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;

const res = await fetch(`${env.SUPABASE_URL}/rest/v1/admin_users?on_conflict=username`, {
  method: "POST",
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    Prefer: "resolution=merge-duplicates",
  },
  body: JSON.stringify({ username, password_hash: passwordHash }),
});
console.log("seed-admin:", res.status, res.ok ? "OK" : await res.text());
