import type { SupabaseClient } from "@supabase/supabase-js";
import { json, badRequest, serverError } from "../../_lib/cors";
import { supabase, type Env } from "../../_lib/supabase";
import { requireAdmin } from "../../_lib/auth";

const PAGE_SIZE = 200;
export function makeAdminWishesHandler(
  auth: (request: Request, env: Env) => Promise<string | null>,
  getDb: (env: Env) => SupabaseClient,
) {
  return async (request: Request, env: Env): Promise<Response> => {
    if (!await auth(request, env)) return json({ error: "unauthorized" }, 401);
    const page = Number(new URL(request.url).searchParams.get("page") ?? "0");
    if (!Number.isSafeInteger(page) || page < 0) return badRequest("invalid page");
    const { data, error } = await getDb(env).from("guests")
      .select("session_id,display_name,message").not("message", "is", null)
      .order("created_at", { ascending: false }).order("session_id", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    if (error) return serverError(error.message);
    const rows = (data ?? []) as { session_id: string; display_name: string | null; message: string }[];
    return json({
      wishes: rows.slice(0, PAGE_SIZE).filter(row => row.message.trim()).map(row => ({
        guestId: row.session_id, guestName: row.display_name ?? null, message: row.message,
      })),
      hasMore: rows.length > PAGE_SIZE,
    });
  };
}
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  makeAdminWishesHandler(requireAdmin, supabase)(request, env);
