import type { Env } from "../_lib/supabase";
import { supabase } from "../_lib/supabase";
import { json, badRequest, serverError } from "../_lib/cors";
import { isUuid, isStorageKeyFor, isJsonObject } from "../_lib/validate";
import { eventForRegistration, eventAcceptsRegistration, type WindowEvent } from "../_lib/windows";
import { capReached } from "../_lib/photoCap";
import { photosLimiter } from "../_lib/rateLimit";
import { getEventsCached } from "../_lib/events";

const CAPTURED_PAST_MS = 24 * 60 * 60_000;
const CAPTURED_FUTURE_MS = 15 * 60_000;

type Db = {
  from: (t: string) => {
    upsert?: (row: unknown, opts: unknown) => Promise<{ error: unknown }>;
    insert?: (row: unknown) => Promise<{ error: { code?: string; message?: string } | null }>;
  };
};

export interface PhotosDeps {
  getDb: (env: Env) => Db;
  getEvents: (env: Env) => Promise<WindowEvent[]>;
  now?: () => number;
  capReached?: (env: Env) => Promise<boolean>;
  checkLimit?: (request: Request) => Response | null;
}

export function makePhotosHandler(deps: PhotosDeps) {
  const now = deps.now ?? Date.now;
  const isCapped = deps.capReached ?? (async () => false);
  const checkLimit = deps.checkLimit ?? (() => null);
  return async (request: Request, env: Env): Promise<Response> => {
    const limited = checkLimit(request);
    if (limited) return limited;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("invalid JSON body");
    }
    if (!isJsonObject(body)) return badRequest("invalid JSON body");
    const { eventId, storageKey, sessionId, capturedAt } = body;
    if (!isUuid(eventId) || !isUuid(sessionId)) return badRequest("invalid or missing fields");
    if (!isStorageKeyFor(eventId, storageKey)) return badRequest("invalid or missing fields");
    if (typeof capturedAt !== "string" || Number.isNaN(Date.parse(capturedAt))) {
      return badRequest("invalid or missing fields");
    }

    const t = now();
    const events = await deps.getEvents(env);
    const ev = eventForRegistration(events, new Date(t), capturedAt);
    if (!ev || ev.id !== eventId) {
      // The live route didn't land on the claimed event — a contiguous
      // handover (e.g. Reception opening right as Akad's grace runs out)
      // routes eventForRegistration to the new window even though this photo
      // was legitimately in flight for the old one. Fall back to asking
      // whether the claimed event itself still justifies acceptance before
      // giving up.
      const claimed = events.find((e) => e.id === eventId);
      if (!claimed || !eventAcceptsRegistration(claimed, new Date(t), capturedAt)) {
        return json({ error: "window closed" }, 403);
      }
    }

    // Also checked at presign, but a caller can skip straight to here and mint
    // rows without ever touching R2, so the cap has to hold on this path too.
    if (await isCapped(env)) return json({ error: "event full" }, 403);

    // Out-of-window capturedAt is substituted with server time, never rejected —
    // a phone with a wrong clock must not lose every photo. Logged for forensics.
    let captured = capturedAt;
    const cap = Date.parse(capturedAt);
    if (cap < t - CAPTURED_PAST_MS || cap > t + CAPTURED_FUTURE_MS) {
      console.warn(`capturedAt out of window, substituting server time (was ${capturedAt})`);
      captured = new Date(t).toISOString();
    }

    const db = deps.getDb(env);
    const g = await db.from("guests").upsert!({ session_id: sessionId }, { onConflict: "session_id", ignoreDuplicates: true });
    if (g.error) return serverError(String((g.error as { message?: string }).message ?? g.error));
    const p = await db.from("photos").insert!({
      event_id: eventId, storage_key: storageKey, session_id: sessionId, captured_at: captured,
    });
    if (p.error && p.error.code !== "23505") return serverError(p.error.message ?? "insert failed");
    return json({ ok: true }, 201);
  };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) =>
  makePhotosHandler({
    getDb: (e) => supabase(e) as never,
    getEvents: (e) => getEventsCached(e, { allowStale: true }),
    capReached,
    checkLimit: photosLimiter,
  })(request, env);
