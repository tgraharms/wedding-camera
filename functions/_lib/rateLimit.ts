import { json } from "./cors";

// Best-effort, per-isolate rate limiting.
//
// Cloudflare's real rate-limiting rules are zone-scoped (custom domains only),
// and KV counters were rejected — the free tier's 1,000 writes/day is below a single
// reception's presign volume, so it would fail closed mid-event. What is left
// is an in-memory counter per isolate: it resets on isolate recycle and does
// not coordinate across colos, so a determined attacker spreads across it.
//
// That is accepted. This exists to blunt a naive single-source flood and to
// stop /api/admin/login being a free PBKDF2 oracle. The hard ceiling on abuse
// is the global photo cap in photoCap.ts, not this.
//
// It is structurally fail-open: no I/O, no awaits, nothing that can throw, and
// when the map grows past MAX_KEYS it forgets counts rather than blocking.
const MAX_KEYS = 5000;

export interface RateLimiter {
  check(key: string): { ok: true } | { ok: false; retryAfterMs: number };
}

export function makeRateLimiter(opts: { limit: number; windowMs?: number; now?: () => number }): RateLimiter {
  const limit = opts.limit;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key: string) {
      const t = now();
      const entry = hits.get(key);
      if (!entry || t >= entry.resetAt) {
        if (hits.size >= MAX_KEYS) {
          for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
          // Still full of live entries: drop everything rather than grow without
          // bound. Forgetting counts lets traffic through; it never blocks.
          if (hits.size >= MAX_KEYS) hits.clear();
        }
        hits.set(key, { count: 1, resetAt: t + windowMs });
        return { ok: true as const };
      }
      entry.count++;
      if (entry.count > limit) return { ok: false as const, retryAfterMs: entry.resetAt - t };
      return { ok: true as const };
    },
  };
}

// Cloudflare sets this on every request and it cannot be spoofed by the client
// (an inbound CF-Connecting-IP header is overwritten at the edge).
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export function rateLimited(retryAfterMs: number): Response {
  const res = json({ error: "rate limited" }, 429);
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return res;
}

// Turns a limiter into the `checkLimit` dep the handlers take.
export function limitByIp(limiter: RateLimiter): (request: Request) => Response | null {
  return (request) => {
    const verdict = limiter.check(clientIp(request));
    return verdict.ok ? null : rateLimited(verdict.retryAfterMs);
  };
}

// Limits are per IP per minute, and the binding constraint is that a whole
// venue sits behind one NAT. ~200 guests on one wifi IP, all capturing during
// the same moment (the akad, the cake) is ~200 presigns and ~200 registrations
// in a minute through a single IP. 300 holds that with headroom, while the
// day-long average is nearer 4/min. Anything over the line gets a 429 that the
// client's existing jittered retry queue absorbs — photos are delayed, never
// lost.
//
// Keyed by IP rather than sessionId deliberately: sessionIds are self-issued
// and free to rotate, so a per-session limit bounds nothing an attacker does
// while risking throttling a legitimate device.
export const presignLimiter = limitByIp(makeRateLimiter({ limit: 300 }));
// One original per registered photo, minted after the display copy lands, so
// it tracks presign's traffic one-for-one.
export const originalsLimiter = limitByIp(makeRateLimiter({ limit: 300 }));
export const photosLimiter = limitByIp(makeRateLimiter({ limit: 300 }));
export const myPhotosLimiter = limitByIp(makeRateLimiter({ limit: 300 }));
export const profileLimiter = limitByIp(makeRateLimiter({ limit: 120 }));

// The highlights link is public and unlisted, and it gets broadcast — the
// couple sends one URL to a group chat, and everyone who opens it that
// evening is often behind the same carrier NAT as a non-guest. SharePage
// cannot distinguish a 429 from a bad link, so this matches the other guest
// limiters rather than trying to be stricter; the real abuse ceiling is the
// global photo cap in photoCap.ts, not this.
export const shareLimiter = limitByIp(makeRateLimiter({ limit: 300 }));

// Only the couple ever logs in, from their own phones, never from the venue
// burst path — so this one can be strict. Each attempt costs a PBKDF2-SHA256
// x100,000 derivation on the edge worker, which is exactly what makes an
// unlimited login endpoint worth closing.
export const loginLimiter = limitByIp(makeRateLimiter({ limit: 5 }));
