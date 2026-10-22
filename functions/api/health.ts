import type { SupabaseClient } from "@supabase/supabase-js";
import { json } from "../_lib/cors";
import { supabase, type Env } from "../_lib/supabase";

// Liveness probe with a deliberately narrow job: prove the edge is serving AND
// that the database answers, and say which one failed.
//
// The keepalive cron used to ping /api/events, which is circular — it depends on
// the very thing it is meant to protect, so once the database went down the check
// could only report the failure, never distinguish it from a Pages outage. It
// stayed red for 17 days in July 2026 with nobody able to tell at a glance which
// layer was broken.
//
// The query is not incidental: touching the database is what defers Supabase's
// free-tier idle-pause, so this endpoint is both the probe and the keepalive.
export function makeHealthHandler(getDb: (env: Env) => SupabaseClient) {
  return async (env?: Env): Promise<Response> => {
    // Reaching this line at all proves Pages and the Function runtime are up.
    try {
      const db = getDb(env as Env);
      const { error } = await db.from("events").select("id").limit(1);
      if (error) {
        console.error("health: db error:", error.message); // detail stays server-side
        return json({ ok: false, pages: "up", db: "down" }, 503);
      }
      return json({ ok: true, pages: "up", db: "up" });
    } catch (e) {
      console.error("health: db threw:", e instanceof Error ? e.message : String(e));
      return json({ ok: false, pages: "up", db: "down" }, 503);
    }
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  return makeHealthHandler(supabase)(env);
};
