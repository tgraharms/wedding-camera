import { supabase, type Env } from "./supabase";
import type { WindowEvent } from "./windows";

// The events table has three rows and changes a handful of times a day, yet
// every /api/status poll, presign and registration used to query it. On the
// day that is ~200 polls a minute for the same answer, and — worse — a
// Supabase blip turned into a 500 on /api/status, which is the LoadError
// screen for every guest who scans the QR during the blip.
//
// One instance per isolate. Fresh within TTL: no query. Stale: one query,
// shared by every concurrent caller. Query fails: serve the last-known list
// when the caller allows it (routing 15 s stale is harmless; the client polls
// every 60 s anyway), otherwise rethrow — a cold isolate behaves exactly as
// before.
export const EVENTS_CACHE_TTL_MS = 15_000;

export interface EventsCacheOpts {
  ttlMs?: number;
  now?: () => number;
}

export function makeEventsCache(
  fetchEvents: (env: Env) => Promise<WindowEvent[]>,
  opts: EventsCacheOpts = {}
): (env: Env, o?: { allowStale?: boolean }) => Promise<WindowEvent[]> {
  const ttlMs = opts.ttlMs ?? EVENTS_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: { at: number; events: WindowEvent[] } | null = null;
  let inflight: Promise<WindowEvent[]> | null = null;

  return async (env, o = {}) => {
    const allowStale = o.allowStale ?? false;
    if (cached && now() - cached.at < ttlMs) return cached.events;
    if (!inflight) {
      inflight = fetchEvents(env)
        .then((events) => {
          cached = { at: now(), events };
          return events;
        })
        .catch((err) => {
          // Logged once here, in the shared chain, rather than in the
          // per-caller catch below — N concurrent callers awaiting the same
          // `inflight` promise would otherwise each log the same failure.
          if (cached) console.error("events refetch failed, serving last-known list:", err);
          throw err;
        })
        .finally(() => {
          inflight = null;
        });
    }
    try {
      return await inflight;
    } catch (err) {
      if (allowStale && cached) return cached.events;
      throw err;
    }
  };
}

export const EVENTS_QUERY_TIMEOUT_MS = 5_000;

export async function fetchEventsFromDb(env: Env): Promise<WindowEvent[]> {
  // Bounded: the stale fallback in makeEventsCache only helps once the query
  // SETTLES. An upstream that hangs rather than errors would otherwise hold
  // every /api/status poll on a warm isolate that already has the answer.
  const { data, error } = await supabase(env)
    .from("events")
    .select("id,name,window_start,window_end")
    .abortSignal(AbortSignal.timeout(EVENTS_QUERY_TIMEOUT_MS));
  if (error) throw new Error(error.message);
  return (data ?? []) as WindowEvent[];
}

export const getEventsCached = makeEventsCache(fetchEventsFromDb);
