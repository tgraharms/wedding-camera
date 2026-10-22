import type { SupabaseClient } from "@supabase/supabase-js";

// One head count per event, instead of selecting every photo row and counting
// the array in JS. PostgREST caps a select at max_rows (1000) and truncates
// silently rather than erroring, so the row-counting version started
// under-reporting the moment the gallery passed 1000 photos — the admin would
// have read a wrong total with nothing to indicate it was wrong.
//
// This is a query per event, but there are only a handful of events and each is
// a COUNT the database answers without shipping rows, so it is cheaper than the
// full-table read it replaces.
export async function countPhotosByEvent(
  db: SupabaseClient,
  eventIds: string[]
): Promise<{ counts: Map<string, number>; error: string | null }> {
  const counts = new Map<string, number>();
  for (const id of eventIds) {
    const res = await db.from("photos").select("id", { count: "exact", head: true }).eq("event_id", id);
    if (res.error) return { counts, error: res.error.message };
    counts.set(id, res.count ?? 0);
  }
  return { counts, error: null };
}
