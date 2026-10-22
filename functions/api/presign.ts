import type { Env } from "../_lib/supabase";
import { supabase } from "../_lib/supabase";
import { json, badRequest, serverError } from "../_lib/cors";
import { makeR2Client, presignPutWithLength } from "../_lib/r2";
import { eventForRegistration, type WindowEvent } from "../_lib/windows";
import { capReached } from "../_lib/photoCap";
import { isUuid } from "../_lib/validate";
import { presignLimiter } from "../_lib/rateLimit";
import { getEventsCached } from "../_lib/events";

// processImage caps the longest edge at 4096px / JPEG q0.92 (2026-10-01), so a
// real upload is ~2–4 MB, up to ~6 MB for a very detailed frame. 16 MiB leaves
// room for the ≤cap unprocessed-original fallback (a 24MP+ camera JPEG) while
// still bounding what an abusive client can store. Mirrored client-side as
// PROCESS_FALLBACK_MAX_BYTES in src/App.tsx.
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

// Fair use, not security: sessionId is self-issued, so clearing site data mints
// a fresh identity and a fresh allowance. What this actually stops is one
// device flooding the event — a kid with the phone, a stuck shutter — which is
// the realistic failure. A normal guest sends 10-30, so nobody legitimate is
// anywhere near 200.
export const GUEST_PHOTO_CAP = 200;

export interface PresignDeps {
  getEvents: (env: Env) => Promise<WindowEvent[]>;
  sign: (key: string, contentLength: number) => Promise<string>;
  now?: () => number;
  makeKey?: (eventId: string) => string;
  capReached?: (env: Env) => Promise<boolean>;
  countForGuest?: (env: Env, sessionId: string) => Promise<number>;
  checkLimit?: (request: Request) => Response | null;
}

export function makePresignHandler(deps: PresignDeps) {
  const now = deps.now ?? Date.now;
  const makeKey = deps.makeKey ?? ((eventId: string) => `${eventId}/${crypto.randomUUID()}.jpg`);
  const isCapped = deps.capReached ?? (async () => false);
  const checkLimit = deps.checkLimit ?? (() => null);
  return async (request: Request, env: Env): Promise<Response> => {
    const limited = checkLimit(request);
    if (limited) return limited;

    const url = new URL(request.url);
    const sizeRaw = url.searchParams.get("size");
    if (!sizeRaw) return badRequest("size required");
    const size = Number(sizeRaw);
    if (!Number.isInteger(size) || size <= 0) return badRequest("size required");
    if (size > MAX_UPLOAD_BYTES) return badRequest("file too large");

    const capturedAt = url.searchParams.get("capturedAt") ?? "";
    const events = await deps.getEvents(env);
    const ev = eventForRegistration(events, new Date(now()), capturedAt);
    if (!ev) return json({ error: "window closed" }, 403);

    if (await isCapped(env)) return json({ error: "event full" }, 403);

    // Checked here rather than at /api/photos so a capped guest never pays for
    // the R2 PUT. A missing or malformed sessionId skips the check instead of
    // failing the upload — an older cached bundle that doesn't send one yet
    // must keep working on the day.
    const sessionId = url.searchParams.get("sessionId");
    if (deps.countForGuest && sessionId && isUuid(sessionId)) {
      // Fails open, like the global cap: a fair-use ceiling is not worth
      // turning a database blip into a guest who cannot send photos.
      let sent = 0;
      try {
        sent = await deps.countForGuest(env, sessionId);
      } catch (err) {
        console.error("guest photo count failed, allowing the upload:", err);
      }
      if (sent >= GUEST_PHOTO_CAP) return json({ error: "guest quota" }, 403);
    }

    const storageKey = makeKey(ev.id);
    const uploadUrl = await deps.sign(storageKey, size);
    return json({ uploadUrl, storageKey, eventId: ev.id });
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  try {
    return await makePresignHandler({
      getEvents: (e) => getEventsCached(e, { allowStale: true }),
      sign: (key, len) => presignPutWithLength(makeR2Client(env), env, key, len),
      capReached,
      countForGuest: async (e, sessionId) => {
        const { count, error } = await supabase(e)
          .from("photos")
          .select("id", { count: "exact", head: true })
          .eq("session_id", sessionId);
        if (error) throw new Error(error.message);
        return count ?? 0;
      },
      checkLimit: presignLimiter,
    })(request, env);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
};
