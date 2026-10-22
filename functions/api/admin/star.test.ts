import { describe, it, expect, vi } from "vitest";
import { makeStarHandler } from "./star";

const PID = "11111111-1111-4111-8111-111111111111";

function req(body: unknown): Request {
  return new Request("https://x/api/admin/star", { method: "POST", body: JSON.stringify(body) });
}

function dbCapture() {
  const eq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ update });
  return { db: { from }, from, update, eq };
}

describe("star handler", () => {
  it("401s when not authed", async () => {
    const { db } = dbCapture();
    const handler = makeStarHandler(async () => null, () => db as never);
    expect((await handler(req({ photoId: PID, starred: true }), {} as never)).status).toBe(401);
  });

  it("400s when photoId is not a uuid", async () => {
    const { db } = dbCapture();
    const handler = makeStarHandler(async () => "admin", () => db as never);
    expect((await handler(req({ photoId: "nope", starred: true }), {} as never)).status).toBe(400);
  });

  it("400s when starred is not a boolean", async () => {
    const { db } = dbCapture();
    const handler = makeStarHandler(async () => "admin", () => db as never);
    expect((await handler(req({ photoId: PID }), {} as never)).status).toBe(400);
  });

  it("updates starred for the photo when authed", async () => {
    const { db, from, update, eq } = dbCapture();
    const handler = makeStarHandler(async () => "admin", () => db as never);
    const res = await handler(req({ photoId: PID, starred: true }), {} as never);
    expect(res.status).toBe(200);
    expect(from).toHaveBeenCalledWith("photos");
    expect(update).toHaveBeenCalledWith({ starred: true });
    expect(eq).toHaveBeenCalledWith("id", PID);
  });
});
