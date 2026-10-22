import type { Env } from "../../_lib/supabase";
import { supabase } from "../../_lib/supabase";
import { json, badRequest, serverError } from "../../_lib/cors";
import { makeR2Client, presignPutWithLength } from "../../_lib/r2";
import { LATE_MS, type WindowEvent } from "../../_lib/windows";
import { isUuid, isStorageKeyFor } from "../../_lib/validate";
import { originalsLimiter } from "../../_lib/rateLimit";
import { getEventsCached } from "../../_lib/events";

// Private originals (2026-10-01): the untouched file a guest picked, kept for
// the couple's archive. Large enough for a 200MP Android JPEG. Mirrored
// client-side as ORIGINAL_MAX_BYTES in src/lib/originalsQueue.ts.
export const ORIGINAL_MAX_BYTES = 64 * 1024 * 1024;

// Derived from the display key, so no database column is needed and a retry
// overwrites the same object instead of orphaning one. No extension: the type
// varies by phone, and nothing ever serves these objects to a browser.
//
// The strip is case-sensitive on purpose (unlike isStorageKeyFor's /i):
// storage keys are minted lowercase and the ownership lookup matches them
// exactly, so a case-insensitive strip would let a crafted ".JPG" key collide
// with another photo's original key.
export function originalKeyFor(storageKey: string): string {
  return `originals/${storageKey.replace(/\.jpg$/, "")}`;
}

export interface OriginalsPresignDeps {
  getEvents: (env: Env) => Promise<WindowEvent[]>;
  /** The registered photo with this key AND session, or null. */
  findPhoto: (env: Env, storageKey: string, sessionId: string) => Promise<{ eventId: string } | null>;
  sign: (key: string, contentLength: number) => Promise<string>;
  now?: () => number;
  checkLimit?: (request: Request) => Response | null;
}

export function makeOriginalsPresignHandler(deps: OriginalsPresignDeps) {
  const now = deps.now ?? Date.now;
  const checkLimit = deps.checkLimit ?? (() => null);
  return async (request: Request, env: Env): Promise<Response> => {
    const limited = checkLimit(request);
    if (limited) return limited;

    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const storageKey = url.searchParams.get("storageKey") ?? "";
    if (!isUuid(sessionId)) return badRequest("invalid or missing fields");
    if (!isStorageKeyFor(storageKey.split("/")[0], storageKey)) return badRequest("invalid or missing fields");
    const size = Number(url.searchParams.get("size"));
    if (!Number.isInteger(size) || size <= 0) return badRequest("size required");
    if (size > ORIGINAL_MAX_BYTES) return badRequest("file too large");

    // Ownership, not just shape: storage keys are visible to anyone holding a
    // signed image URL (share-link viewers included).
    const photo = await deps.findPhoto(env, storageKey, sessionId);
    if (!photo) return json({ error: "photo not found" }, 404);

    // Same straggler allowance registration gets: a phone that was offline
    // when the window closed still has LATE_MS to send its originals.
    const ev = (await deps.getEvents(env)).find((e) => e.id === photo.eventId);
    if (!ev?.window_end || now() >= Date.parse(ev.window_end) + LATE_MS) {
      return json({ error: "window closed" }, 403);
    }

    const uploadUrl = await deps.sign(originalKeyFor(storageKey), size);
    return json({ uploadUrl });
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  try {
    return await makeOriginalsPresignHandler({
      getEvents: (e) => getEventsCached(e, { allowStale: true }),
      findPhoto: async (e, storageKey, sessionId) => {
        const { data, error } = await supabase(e)
          .from("photos")
          .select("event_id")
          .eq("storage_key", storageKey)
          .eq("session_id", sessionId)
          .limit(1);
        if (error) throw new Error(error.message);
        const row = (data ?? [])[0] as { event_id: string } | undefined;
        return row ? { eventId: row.event_id } : null;
      },
      sign: (key, len) => presignPutWithLength(makeR2Client(env), env, key, len),
      checkLimit: originalsLimiter,
    })(request, env);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
};
