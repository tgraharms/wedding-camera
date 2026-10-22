import type { Env } from "../../_lib/supabase";
import { serializeCookie } from "../../_lib/adminSession";
import { ADMIN_COOKIE } from "../../_lib/auth";

export const onRequestPost: PagesFunction<Env> = async () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "Set-Cookie": serializeCookie(ADMIN_COOKIE, "", 0),
    },
  });
};
