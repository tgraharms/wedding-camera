import type { Env } from "../_lib/supabase";
import { json, serverError } from "../_lib/cors";
import { statusFor, type WindowEvent } from "../_lib/windows";
import { getEventsCached } from "../_lib/events";

// Polled every 60 s by every open guest app. Served from the per-isolate
// events cache; during a database blip a warm isolate keeps answering with
// the last-known windows instead of sending every arriving guest to the
// LoadError screen.
export function makeStatusHandler(
  getEvents: (env: Env, o?: { allowStale?: boolean }) => Promise<WindowEvent[]>,
  now: () => number = Date.now
) {
  return async (env: Env): Promise<Response> => {
    let events: WindowEvent[];
    try {
      events = await getEvents(env, { allowStale: true });
    } catch (err) {
      return serverError(err instanceof Error ? err.message : String(err));
    }
    return json(statusFor(events, new Date(now())));
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => makeStatusHandler(getEventsCached)(env);
