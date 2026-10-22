import { describe, it, expect, vi } from "vitest";
import { makeProfileHandler } from "./profile";
import { LIMITS } from "../../_lib/validate";

const SS = "22222222-2222-4222-8222-222222222222";
const dbCapture = () => {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  return { db: { from: vi.fn().mockReturnValue({ upsert }) }, upsert };
};
const req = (body: unknown) => new Request("https://x", { method: "POST", body: JSON.stringify(body) });

describe("makeProfileHandler", () => {
  it("upserts clamped displayName and message", async () => {
    const c = dbCapture();
    const res = await makeProfileHandler(() => c.db as never)(
      req({ sessionId: SS, displayName: "  Aminah  ", message: "x".repeat(LIMITS.message + 50) }), {} as never);
    expect(res.status).toBe(200);
    const row = c.upsert.mock.calls[0][0] as { display_name: string; message: string };
    expect(row.display_name).toBe("Aminah");
    expect(row.message).toHaveLength(LIMITS.message);
  });
  it("blank fields store null; bad sessionId 400s", async () => {
    const c = dbCapture();
    await makeProfileHandler(() => c.db as never)(req({ sessionId: SS, displayName: "  " }), {} as never);
    expect(c.upsert.mock.calls[0][0]).toMatchObject({ display_name: null });
    expect((await makeProfileHandler(() => c.db as never)(req({ sessionId: "x" }), {} as never)).status).toBe(400);
  });
  it("rejects non-string fields with 400", async () => {
    const c = dbCapture();
    const res = await makeProfileHandler(() => c.db as never)(
      req({ sessionId: SS, displayName: 123 }), {} as never);
    expect(res.status).toBe(400);
    expect(c.upsert).not.toHaveBeenCalled();
  });
});
