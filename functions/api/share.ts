import type { SupabaseClient } from "@supabase/supabase-js";
import { json, serverError } from "../_lib/cors";
import { supabase, type Env } from "../_lib/supabase";
import { makeR2Client, presignUrl } from "../_lib/r2";
import { timingSafeEqual } from "../_lib/adminSession";
import { shareLimiter } from "../_lib/rateLimit";

const SHARE_TOKEN_KEY = "share_token";
const GET_URL_EXPIRY = 86400; // 1 day — same expiry as the other guest-facing signed URLs

// PostgREST caps a single response at max_rows (1000). Asking for more than that
// silently truncates rather than erroring, so the cap is stated here instead of
// being discovered at the wrong moment. A curated highlights link is a handful
// of starred photos; going past 1000 would mean paginating a public gallery.
export const SHARE_MAX_PHOTOS = 1000;

const NOT_FOUND = () => json({ error: "not found" }, 404);

interface PhotoRow {
  id: string;
  storage_key: string;
  captured_at: string;
}

// Public by design (no admin/guest auth): this is the unlisted curated-share
// link handed out to non-guests. The only gate is the token itself, and a
// wrong/absent/mismatched token must be indistinguishable from a token that
// was never issued — otherwise the endpoint becomes an existence oracle for
// guessed tokens. Compared in constant time for the same reason the admin
// session is: `===` short-circuits on the first differing byte.
function tokensMatch(stored: string, supplied: string): boolean {
  return timingSafeEqual(stored, supplied);
}

export function makeShareHandler(deps: {
  getDb: (env: Env) => SupabaseClient;
  sign: (key: string) => Promise<string>;
  checkLimit?: (request: Request) => Response | null;
}) {
  const checkLimit = deps.checkLimit ?? (() => null);
  return async (request: Request, env: Env): Promise<Response> => {
    const limited = checkLimit(request);
    if (limited) return limited;

    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!token) return NOT_FOUND();

    const db = deps.getDb(env);
    const stored = await db.from("app_settings").select("value").eq("key", SHARE_TOKEN_KEY).maybeSingle();
    if (stored.error) return serverError(stored.error.message);
    const storedValue = (stored.data as { value: string } | null)?.value;
    if (!storedValue || !tokensMatch(storedValue, token)) return NOT_FOUND();

    const res = await db
      .from("photos")
      .select("id,storage_key,captured_at")
      .eq("starred", true)
      .order("captured_at", { ascending: true })
      .limit(SHARE_MAX_PHOTOS);
    if (res.error) return serverError(res.error.message);
    const rows = (res.data ?? []) as unknown as PhotoRow[];

    const photos = [];
    for (const r of rows) {
      photos.push({ id: r.id, imageUrl: await deps.sign(r.storage_key), capturedAt: r.captured_at });
    }
    return json({ photos });
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  // One client per request: aws4fetch caches the SigV4 signing key on the
  // instance, so a fresh client per photo re-derived it 60 times a page.
  const client = makeR2Client(env);
  return makeShareHandler({
    getDb: supabase,
    sign: (key) => presignUrl(client, env, key, "GET", GET_URL_EXPIRY),
    checkLimit: shareLimiter,
  })(request, env);
};
