import { supabase, type Env } from "./supabase";

// ~1,600 photos are projected across both events. 8,000 is high enough that a
// busier-than-expected reception cannot bump into it, and still low enough to
// bound what an abusive client can push into R2 in an afternoon (8,000 x 5 MiB
// is the worst case, real uploads are ~200-600 KB). It is the hard backstop
// behind the best-effort rate limiter — that one is per-isolate and easy to
// spread across, this one is a single global number the whole fleet agrees on.
export const GLOBAL_PHOTO_CAP = 8000;

// A count per presign would be ~2,400 extra queries over the day for a number
// that moves slowly. 30s of staleness lets at most a small overshoot past the
// cap, which does not matter for a backstop.
export const CAP_CACHE_TTL_MS = 30_000;

export interface CapGuardOpts {
  cap?: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Returns a guard that reports whether the global photo cap has been reached.
 *
 * Fails OPEN: if the count query throws, the guard says "not capped" and the
 * upload proceeds. A Supabase blip during the reception must not turn into
 * guests unable to send photos — losing the abuse ceiling for a few seconds is
 * strictly the cheaper failure.
 */
export function makeCapGuard(
  countPhotos: (env: Env) => Promise<number>,
  opts: CapGuardOpts = {}
): (env: Env) => Promise<boolean> {
  const cap = opts.cap ?? GLOBAL_PHOTO_CAP;
  const ttlMs = opts.ttlMs ?? CAP_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: { at: number; count: number } | null = null;
  // A failing count is remembered for the same TTL. Without this, a database
  // blip made every presign and registration re-run the failing query on top
  // of everything else the blip was already costing.
  let failedAt: number | null = null;

  return async (env: Env): Promise<boolean> => {
    const t = now();
    if (!cached || t - cached.at >= ttlMs) {
      if (failedAt !== null && t - failedAt < ttlMs) return false;
      try {
        cached = { at: t, count: await countPhotos(env) };
        failedAt = null;
      } catch (err) {
        failedAt = t;
        console.error("photo cap count failed, allowing the upload:", err);
        return false;
      }
    }
    return cached.count >= cap;
  };
}

async function countAllPhotos(env: Env): Promise<number> {
  const res = await supabase(env).from("photos").select("id", { count: "exact", head: true });
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}

// One module-level instance so presign and photos share a single cached count
// per isolate rather than each paying for their own.
export const capReached = makeCapGuard(countAllPhotos);
