import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../_lib/supabase";
import { supabase } from "../../_lib/supabase";
import { json, badRequest, serverError } from "../../_lib/cors";
import { isUuid } from "../../_lib/validate";
import { makeR2Client, presignUrl } from "../../_lib/r2";
import { myPhotosLimiter } from "../../_lib/rateLimit";

export const PAGE_SIZE = 60;
const GET_URL_EXPIRY = 86400; // 1 day — same as the public gallery

interface PhotoRow {
  id: string;
  storage_key: string;
  captured_at: string;
}

interface GuestRow {
  display_name: string | null;
  message: string | null;
}

export function makeMyPhotosHandler(deps: {
  getDb: (env: Env) => SupabaseClient;
  sign: (key: string) => Promise<string>;
  checkLimit?: (request: Request) => Response | null;
}) {
  const checkLimit = deps.checkLimit ?? (() => null);
  return async (request: Request, env: Env): Promise<Response> => {
    const limited = checkLimit(request);
    if (limited) return limited;

    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    const page = Number(url.searchParams.get("page") ?? "0");
    if (!isUuid(sessionId)) return badRequest("sessionId required");
    if (!Number.isInteger(page) || page < 0) return badRequest("invalid page");

    const db = deps.getDb(env);
    const from = page * PAGE_SIZE;
    const res = await db
      .from("photos")
      // count:"exact" rides on the page query: the client mirrors this total
      // into its device-local "N gambar dihantar" counter, which otherwise
      // only ever climbs and drifts after an admin deletes photos.
      .select("id,storage_key,captured_at", { count: "exact" })
      .eq("session_id", sessionId)
      .order("captured_at", { ascending: false })
      .order("id", { ascending: true }) // secondary sort: stable ordering across pages when captured_at ties
      .range(from, from + PAGE_SIZE); // fetch pageSize+1 to probe hasMore
    if (res.error) return serverError(res.error.message);
    const rows = (res.data ?? []) as unknown as PhotoRow[];
    const hasMore = rows.length > PAGE_SIZE;
    const total = typeof res.count === "number" ? res.count : from + rows.length;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const g = await db.from("guests").select("display_name,message").eq("session_id", sessionId).maybeSingle();
    if (g.error) return serverError(g.error.message);
    const guest = (g.data ?? null) as GuestRow | null;

    const photos = [];
    for (const r of pageRows) {
      photos.push({ id: r.id, imageUrl: await deps.sign(r.storage_key), capturedAt: r.captured_at });
    }
    return json({
      photos,
      profile: { displayName: guest?.display_name ?? null, message: guest?.message ?? null },
      page,
      pageSize: PAGE_SIZE,
      hasMore,
      total,
    });
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const client = makeR2Client(env); // see share.ts: one signing-key derivation per request, not per photo
  return makeMyPhotosHandler({
    getDb: supabase,
    sign: (key) => presignUrl(client, env, key, "GET", GET_URL_EXPIRY),
    checkLimit: myPhotosLimiter,
  })(request, env);
};
