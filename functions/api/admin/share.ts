import type { SupabaseClient } from "@supabase/supabase-js";
import { json, serverError } from "../../_lib/cors";
import { supabase, type Env } from "../../_lib/supabase";
import { requireAdmin } from "../../_lib/auth";

const SHARE_TOKEN_KEY = "share_token";

// Not a UUID by itself (that would leak event/photo scoping conventions) —
// two concatenated v4 UUIDs, dashes stripped, for a long unguessable slug.
const newToken = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");

function shareUrl(request: Request, token: string): string {
  return `${new URL(request.url).origin}/share/${token}`;
}

// head:true counts server-side instead of shipping every starred row back and
// measuring the array — which PostgREST silently truncates at max_rows (1000).
async function countStarred(db: SupabaseClient): Promise<number> {
  const res = await db.from("photos").select("id", { count: "exact", head: true }).eq("starred", true);
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}

async function regenerate(db: SupabaseClient): Promise<string> {
  const token = newToken();
  const { error } = await db
    .from("app_settings")
    .upsert({ key: SHARE_TOKEN_KEY, value: token }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return token;
}

// Read-only: GET must not create the token. A state-changing GET is reachable
// by top-level navigation, and SameSite=Lax sends the admin cookie on exactly
// that — so any page that could get the couple to visit /api/admin/share while
// logged in could mint share tokens. POST is the sole creation path now.
async function readToken(db: SupabaseClient): Promise<string | null> {
  const stored = await db.from("app_settings").select("value").eq("key", SHARE_TOKEN_KEY).maybeSingle();
  if (stored.error) throw new Error(stored.error.message);
  return (stored.data as { value: string } | null)?.value ?? null;
}

export function makeShareGetHandler(
  auth: (request: Request, env: Env) => Promise<string | null>,
  getDb: (env: Env) => SupabaseClient
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const user = await auth(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const db = getDb(env);
    let token: string | null;
    let starredCount: number;
    try {
      token = await readToken(db);
      starredCount = await countStarred(db);
    } catch (e) {
      return serverError(e instanceof Error ? e.message : "failed to read share token");
    }
    // No token yet: the client POSTs to create one. Reporting null is honest
    // about the state instead of manufacturing it as a side effect of a read.
    return json({ token, url: token ? shareUrl(request, token) : null, starredCount });
  };
}

export function makeShareRegenerateHandler(
  auth: (request: Request, env: Env) => Promise<string | null>,
  getDb: (env: Env) => SupabaseClient
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const user = await auth(request, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const db = getDb(env);
    let token: string;
    let starredCount: number;
    try {
      token = await regenerate(db);
      starredCount = await countStarred(db);
    } catch (e) {
      return serverError(e instanceof Error ? e.message : "failed to generate share token");
    }
    return json({ token, url: shareUrl(request, token), starredCount });
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  return makeShareGetHandler(requireAdmin, supabase)(request, env);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  return makeShareRegenerateHandler(requireAdmin, supabase)(request, env);
};
