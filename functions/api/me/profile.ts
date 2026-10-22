import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../_lib/supabase";
import { supabase } from "../../_lib/supabase";
import { json, badRequest, serverError } from "../../_lib/cors";
import { isUuid, isJsonObject, LIMITS } from "../../_lib/validate";
import { profileLimiter } from "../../_lib/rateLimit";

// `bounded()` in _lib/validate.ts rejects (returns undefined for) an overlong
// string — the right call for /api/photos and /api/email, which are called once
// per action and should surface a clear error rather than silently mangle a
// caption. The v2 profile form is edited live in a text box on every keystroke;
// rejecting there means the guest's save fails with no visible reason once they
// cross 80/500 chars. So this endpoint clamps instead of rejecting, matching the
// "clamp on the client, bound on the server" convention: absent/blank -> null,
// non-string -> undefined (400), overlong -> truncated to `max`.
function clamped(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t.length === 0) return null;
  return t.length > max ? t.slice(0, max) : t;
}

export function makeProfileHandler(
  getDb: (env: Env) => SupabaseClient,
  checkLimit: (request: Request) => Response | null = () => null
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const limited = checkLimit(request);
    if (limited) return limited;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("invalid JSON body");
    }
    if (!isJsonObject(body) || !isUuid(body.sessionId)) return badRequest("sessionId required");
    const displayName = clamped(body.displayName, LIMITS.displayName);
    const message = clamped(body.message, LIMITS.message);
    if (displayName === undefined || message === undefined) return badRequest("invalid fields");
    const { error } = await getDb(env)
      .from("guests")
      .upsert({ session_id: body.sessionId, display_name: displayName, message }, { onConflict: "session_id" });
    if (error) return serverError(error.message ?? "upsert failed");
    return json({ ok: true });
  };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) =>
  makeProfileHandler(supabase, profileLimiter)(request, env);
