import type { SupabaseClient } from "@supabase/supabase-js";
import { json, badRequest, serverError } from "../../_lib/cors";
import { supabase, type Env } from "../../_lib/supabase";
import { requireAdmin } from "../../_lib/auth";
import { overlaps, type WindowEvent } from "../../_lib/windows";
import { countPhotosByEvent } from "../../_lib/photoCounts";

const MAX_NAME_LENGTH = 80;

interface EventRow {
  id: string;
  name: string;
  window_start: string | null;
  window_end: string | null;
}

interface CreateBody {
  name?: string;
  windowStart?: string;
  windowEnd?: string;
}

function isIsoString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));
}

export function makeEventsListHandler(
  auth: (request: Request, env: Env) => Promise<string | null>,
  getDb: (env: Env) => SupabaseClient
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const user = await auth(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const db = getDb(env);
    const eventsRes = await db.from("events").select("id,name,window_start,window_end").order("created_at", { ascending: true });
    if (eventsRes.error) return serverError(eventsRes.error.message);
    const rows = (eventsRes.data ?? []) as unknown as EventRow[];

    const { counts, error: countsError } = await countPhotosByEvent(db, rows.map((r) => r.id));
    if (countsError) return serverError(countsError);

    const events = rows.map((r) => ({
      id: r.id,
      name: r.name,
      windowStart: r.window_start,
      windowEnd: r.window_end,
      count: counts.get(r.id) ?? 0,
    }));
    return json({ events });
  };
}

export function makeEventsCreateHandler(
  auth: (request: Request, env: Env) => Promise<string | null>,
  getDb: (env: Env) => SupabaseClient
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const user = await auth(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const body = (await request.json().catch(() => ({}))) as CreateBody;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) return badRequest("name required");
    if (!isIsoString(body.windowStart) || !isIsoString(body.windowEnd)) {
      return badRequest("windowStart and windowEnd required");
    }
    if (Date.parse(body.windowEnd) <= Date.parse(body.windowStart)) {
      return badRequest("windowEnd must be after windowStart");
    }

    const db = getDb(env);
    const existing = await db.from("events").select("id,name,window_start,window_end");
    if (existing.error) return serverError(existing.error.message);
    const candidate: WindowEvent = { id: "new", name, window_start: body.windowStart, window_end: body.windowEnd };
    const conflicts = ((existing.data ?? []) as unknown as EventRow[]).some((e) => overlaps(candidate, e));
    if (conflicts) return json({ error: "windows overlap" }, 409);

    const ins = await db
      .from("events")
      .insert({ name, window_start: body.windowStart, window_end: body.windowEnd })
      .select("id")
      .single();
    if (ins.error) return serverError(ins.error.message);
    const id = (ins.data as { id: string }).id;
    return json({ id, name, windowStart: body.windowStart, windowEnd: body.windowEnd, count: 0 }, 201);
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  return makeEventsListHandler(requireAdmin, supabase)(request, env);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  return makeEventsCreateHandler(requireAdmin, supabase)(request, env);
};
