import type { SupabaseClient } from "@supabase/supabase-js";
import { json, badRequest } from "../../_lib/cors";
import { supabase, type Env } from "../../_lib/supabase";
import { verifyPassword } from "../../_lib/password";
import { signSession, serializeCookie } from "../../_lib/adminSession";
import { ADMIN_COOKIE } from "../../_lib/auth";
import { loginLimiter } from "../../_lib/rateLimit";

const TTL_SECONDS = 7 * 24 * 3600;

export function makeLoginHandler(
  getDb: (env: Env) => SupabaseClient,
  verify: (password: string, stored: string) => Promise<boolean>,
  sign: (username: string, secret: string, ttl: number) => Promise<string>,
  checkLimit: (request: Request) => Response | null = () => null
) {
  return async (request: Request, env: Env): Promise<Response> => {
    // Before anything else, and specifically before `verify`: each attempt
    // against a real username costs a PBKDF2-SHA256 x100,000 derivation on the
    // edge worker, so an unlimited login endpoint is a free CPU oracle.
    const limited = checkLimit(request);
    if (limited) return limited;

    const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string };
    if (!body.username || !body.password) return badRequest("username and password required");
    const db = getDb(env);
    const { data } = await db
      .from("admin_users")
      .select("username,password_hash")
      .eq("username", body.username)
      .maybeSingle();
    const unauthorized = json({ error: "invalid credentials" }, 401);
    if (!data) return unauthorized;
    if (!(await verify(body.password, data.password_hash))) return unauthorized;
    const token = await sign(body.username, env.SESSION_SECRET, TTL_SECONDS);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Set-Cookie": serializeCookie(ADMIN_COOKIE, token, TTL_SECONDS),
      },
    });
  };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  return makeLoginHandler(supabase, verifyPassword, signSession, loginLimiter)(request, env);
};
