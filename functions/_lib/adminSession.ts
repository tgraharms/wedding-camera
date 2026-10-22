const enc = new TextEncoder();

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Token: "<username>.<expiryEpochMs>.<hmacHex>" — the format is positional, so a
// dot in the username yields a 4-part token that verifySession rejects. That
// failure mode is invisible (login 200s, every later request 401s), so refuse it here.
export async function signSession(username: string, secret: string, ttlSeconds: number): Promise<string> {
  if (username.includes(".")) throw new Error("username must not contain a dot");
  const exp = Date.now() + ttlSeconds * 1000;
  const body = `${username}.${exp}`;
  const sig = await hmacHex(body, secret);
  return `${body}.${sig}`;
}

export async function verifySession(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [username, expStr, sig] = parts;
  const expected = await hmacHex(`${username}.${expStr}`, secret);
  if (!timingSafeEqual(sig, expected)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return username;
}

export function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function parseCookie(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const i = pair.indexOf("=");
    if (i === -1) continue;
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}
