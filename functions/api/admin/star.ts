import type { SupabaseClient } from "@supabase/supabase-js";
import { json, badRequest, serverError } from "../../_lib/cors";
import { supabase, type Env } from "../../_lib/supabase";
import { requireAdmin } from "../../_lib/auth";
import { isUuid } from "../../_lib/validate";

interface Body {
  photoId?: string;
  starred?: boolean;
}

export function makeStarHandler(
  auth: (request: Request, env: Env) => Promise<string | null>,
  getDb: (env: Env) => SupabaseClient
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const user = await auth(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const body = (await request.json().catch(() => ({}))) as Body;
    if (!isUuid(body.photoId) || typeof body.starred !== "boolean") {
      return badRequest("photoId and starred required");
    }
    const db = getDb(env);
    const { error } = await db.from("photos").update({ starred: body.starred }).eq("id", body.photoId);
    if (error) return serverError(error.message);
    return json({ ok: true });
  };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  return makeStarHandler(requireAdmin, supabase)(request, env);
};
