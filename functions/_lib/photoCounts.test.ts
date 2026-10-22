import { describe, it, expect, vi } from "vitest";
import { countPhotosByEvent } from "./photoCounts";

function db(perEvent: Record<string, number>, failOn?: string) {
  const eq = vi.fn((_col: string, id: string) =>
    Promise.resolve(
      failOn === id
        ? { data: null, count: null, error: { message: "boom" } }
        : { data: null, count: perEvent[id] ?? 0, error: null }
    )
  );
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { db: { from } as never, from, select, eq };
}

describe("countPhotosByEvent", () => {
  it("returns a count per event id", async () => {
    const d = db({ e1: 3, e2: 0 });
    const { counts, error } = await countPhotosByEvent(d.db, ["e1", "e2"]);
    expect(error).toBeNull();
    expect(counts.get("e1")).toBe(3);
    expect(counts.get("e2")).toBe(0);
  });

  it("asks the database to count instead of fetching rows", async () => {
    const d = db({ e1: 1 });
    await countPhotosByEvent(d.db, ["e1"]);
    expect(d.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(d.eq).toHaveBeenCalledWith("event_id", "e1");
  });

  // The row-counting version this replaces measured data.length, which
  // PostgREST truncates at max_rows (1000) — so 1600 photos read as 1000.
  it("reports counts above the PostgREST max_rows ceiling accurately", async () => {
    const d = db({ e1: 1600 });
    const { counts } = await countPhotosByEvent(d.db, ["e1"]);
    expect(counts.get("e1")).toBe(1600);
  });

  it("surfaces a query error instead of reporting a silent zero", async () => {
    const d = db({ e1: 5, e2: 5 }, "e2");
    const { error } = await countPhotosByEvent(d.db, ["e1", "e2"]);
    expect(error).toBe("boom");
  });

  it("makes no queries for an empty event list", async () => {
    const d = db({});
    const { counts, error } = await countPhotosByEvent(d.db, []);
    expect(counts.size).toBe(0);
    expect(error).toBeNull();
    expect(d.from).not.toHaveBeenCalled();
  });

  it("treats a null count as zero", async () => {
    const eq = vi.fn().mockResolvedValue({ data: null, count: null, error: null });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    const { counts } = await countPhotosByEvent({ from } as never, ["e1"]);
    expect(counts.get("e1")).toBe(0);
  });
});
