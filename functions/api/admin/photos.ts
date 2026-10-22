import type { SupabaseClient } from "@supabase/supabase-js";
import { json, badRequest, serverError } from "../../_lib/cors";
import { supabase, type Env } from "../../_lib/supabase";
import { requireAdmin } from "../../_lib/auth";
import { makeR2Client, presignUrl } from "../../_lib/r2";
import { countPhotosByEvent } from "../../_lib/photoCounts";
import type { AdminPhoto } from "../../../src/lib/types";

export const PAGE_SIZE = 60;
const GET_URL_EXPIRY = 86400;
const SELECT_COLS = "id,session_id,event_id,storage_key,captured_at,starred,events(name),guests(display_name,message)";

interface PhotoRow {
  session_id: string;
  id: string;
  event_id: string;
  storage_key: string;
  captured_at: string;
  starred: boolean;
  events: { name: string } | null;
  guests: { display_name: string | null; message: string | null } | null;
}

export function makeAdminPhotosHandler(
  auth: (request: Request, env: Env) => Promise<string | null>,
  getDb: (env: Env) => SupabaseClient,
  sign: (key: string) => Promise<string>
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const user = await auth(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);

    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "0");
    if (!Number.isInteger(page) || page < 0) return badRequest("invalid page");
    const eventId = url.searchParams.get("eventId") ?? "all";

    const db = getDb(env);
    const from = page * PAGE_SIZE;
    let query = db.from("photos").select(SELECT_COLS);
    if (eventId !== "all") query = query.eq("event_id", eventId);
    if (url.searchParams.get("group") === "guest") query = query.order("session_id", { ascending: true });
    const res = await query
      .order("captured_at", { ascending: false })
      .order("id", { ascending: true }) // secondary sort: stable ordering across pages when captured_at ties
      .range(from, from + PAGE_SIZE);
    if (res.error) return serverError(res.error.message);
    const rows = (res.data ?? []) as unknown as PhotoRow[];
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const photos: AdminPhoto[] = [];
    for (const r of pageRows) {
      photos.push({
        id: r.id,
        guestId: r.session_id,
        eventId: r.event_id,
        eventName: r.events?.name ?? "",
        guestName: r.guests?.display_name ?? null,
        message: r.guests?.message ?? null,
        imageUrl: await sign(r.storage_key),
        starred: r.starred,
        capturedAt: r.captured_at,
      });
    }

    const eventsRes = await db.from("events").select("id,name");
    if (eventsRes.error) return serverError(eventsRes.error.message);
    const eventRows = (eventsRes.data ?? []) as { id: string; name: string }[];
    const { counts: countMap, error: countsError } = await countPhotosByEvent(db, eventRows.map((e) => e.id));
    if (countsError) return serverError(countsError);
    const counts = eventRows.map((e) => ({
      eventId: e.id,
      name: e.name,
      count: countMap.get(e.id) ?? 0,
    }));

    return json({ photos, hasMore, counts });
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const client = makeR2Client(env);
  return makeAdminPhotosHandler(
    requireAdmin,
    supabase,
    (key) => presignUrl(client, env, key, "GET", GET_URL_EXPIRY)
  )(request, env);
};
