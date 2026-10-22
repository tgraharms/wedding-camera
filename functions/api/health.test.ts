import { describe, it, expect, vi } from "vitest";
import { makeHealthHandler } from "./health";

// Builds a stub matching db.from(...).select(...).limit(...)
function stubDb(result: { data?: unknown; error?: unknown }) {
  const limit = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  const select = vi.fn().mockReturnValue({ limit });
  return { from: vi.fn().mockReturnValue({ select }), _limit: limit, _select: select };
}

describe("health handler", () => {
  it("reports ok when the database answers", async () => {
    const db = stubDb({ data: [{ id: "e1" }] });
    const res = await makeHealthHandler(() => db as never)();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pages: "up", db: "up" });
  });

  it("actually touches the database — that query is what defers the idle-pause", async () => {
    const db = stubDb({ data: [] });
    await makeHealthHandler(() => db as never)();

    expect(db.from).toHaveBeenCalledWith("events");
    expect(db._limit).toHaveBeenCalled();
  });

  it("returns 503 and names the database as the failing layer", async () => {
    const db = stubDb({ error: { message: "connection refused" } });
    const res = await makeHealthHandler(() => db as never)();

    expect(res.status).toBe(503);
    // 'pages: up' is the whole point: the Function ran, so the edge is fine and
    // only the database is down. A bare 500 cannot express that distinction.
    expect(await res.json()).toMatchObject({ ok: false, pages: "up", db: "down" });
  });

  it("treats a thrown client error as a database failure rather than crashing", async () => {
    const db = { from: () => { throw new Error("client blew up"); } };
    const res = await makeHealthHandler(() => db as never)();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: "down" });
  });

  it("does not leak database error detail to the caller", async () => {
    const db = stubDb({ error: { message: "password authentication failed for user postgres" } });
    const res = await makeHealthHandler(() => db as never)();

    expect(JSON.stringify(await res.json())).not.toContain("password");
  });
});
