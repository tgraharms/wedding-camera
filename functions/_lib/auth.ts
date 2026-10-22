import type { Env } from "./supabase";
import { verifySession, parseCookie } from "./adminSession";

export const ADMIN_COOKIE = "admin_session";

// Returns the authenticated admin username, or null if the request is unauthenticated.
export async function requireAdmin(request: Request, env: Env): Promise<string | null> {
  const token = parseCookie(request.headers.get("Cookie"))[ADMIN_COOKIE];
  if (!token) return null;
  return verifySession(token, env.SESSION_SECRET);
}
