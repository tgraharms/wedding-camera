import type { SupabaseClient } from "@supabase/supabase-js";
import { json, badRequest, serverError } from "../../_lib/cors";
import { supabase, type Env } from "../../_lib/supabase";
import { requireAdmin } from "../../_lib/auth";
import { overlaps, type WindowEvent } from "../../_lib/windows";

const MAX_NAME_LENGTH = 80;
const EVENT_COLS = "id,name,window_start,window_end";

interface EventRow {
  id: string;
  name: string;
  window_start: string | null;
  window_end: string | null;
}

interface Body {
  eventId?: string;
  name?: string;
  windowStart?: string;
  windowEnd?: string;
  delete?: boolean;
}

function isIsoString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));
}

async function handleDelete(db: SupabaseClient, eventId: string): Promise<Response> {
  // Head count, same pattern as _lib/photoCounts.ts — existence is all we need.
  const photos = await db.from("photos").select("id", { count: "exact", head: true }).eq("event_id", eventId);
  if (photos.error) return serverError(photos.error.message);
  if (photos.count === null || photos.count === undefined) return serverError("photo count unavailable");
  if (photos.count > 0) return json({ error: "event has photos" }, 409);
  const del = await db.from("events").delete().eq("id", eventId);
  if (del.error) return serverError(del.error.message);
  return json({ ok: true });
}

export function makeEventUpdateHandler(
  auth: (request: Request, env: Env) => Promise<string | null>,
  getDb: (env: Env) => SupabaseClient
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const user = await auth(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const body = (await request.json().catch(() => ({}))) as Body;
    if (!body.eventId) return badRequest("eventId required");

    const db = getDb(env);
    if (body.delete === true) return handleDelete(db, body.eventId);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > MAX_NAME_LENGTH) return badRequest("invalid name");
      patch.name = name;
    }
    if (body.windowStart !== undefined) {
      if (!isIsoString(body.windowStart)) return badRequest("invalid windowStart");
      patch.window_start = body.windowStart;
    }
    if (body.windowEnd !== undefined) {
      if (!isIsoString(body.windowEnd)) return badRequest("invalid windowEnd");
      patch.window_end = body.windowEnd;
    }
    if (Object.keys(patch).length === 0) return badRequest("no fields to update");

    const current = await db.from("events").select(EVENT_COLS).eq("id", body.eventId).maybeSingle();
    if (current.error) return serverError(current.error.message);
    if (!current.data) return badRequest("event not found");
    const currentRow = current.data as unknown as EventRow;

    const resultStart = (patch.window_start as string | undefined) ?? currentRow.window_start ?? undefined;
    const resultEnd = (patch.window_end as string | undefined) ?? currentRow.window_end ?? undefined;
    if (resultStart && resultEnd) {
      if (Date.parse(resultEnd) <= Date.parse(resultStart)) {
        return badRequest("windowEnd must be after windowStart");
      }
      const others = await db.from("events").select(EVENT_COLS).neq("id", body.eventId);
      if (others.error) return serverError(others.error.message);
      const candidate: WindowEvent = { id: body.eventId, name: "", window_start: resultStart, window_end: resultEnd };
      const conflicts = ((others.data ?? []) as unknown as EventRow[]).some((e) => overlaps(candidate, e));
      if (conflicts) return json({ error: "windows overlap" }, 409);
    }

    const { error } = await db.from("events").update(patch).eq("id", body.eventId);
    if (error) return serverError(error.message);
    return json({ ok: true });
  };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  return makeEventUpdateHandler(requireAdmin, supabase)(request, env);
};
