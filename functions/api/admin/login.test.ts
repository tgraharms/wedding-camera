import { describe, it, expect, vi } from "vitest";
import { makeLoginHandler } from "./login";
import { rateLimited } from "../../_lib/rateLimit";

function req(body: unknown): Request {
  return new Request("https://x/api/admin/login", { method: "POST", body: JSON.stringify(body) });
}

function dbWithUser(user: { username: string; password_hash: string } | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: user, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  return { from: vi.fn().mockReturnValue({ select }) };
}

describe("login handler", () => {
  it("400s on missing fields", async () => {
    const handler = makeLoginHandler(() => dbWithUser(null) as never, async () => true, async () => "tok");
    const res = await handler(req({ username: "admin" }), { SESSION_SECRET: "s" } as never);
    expect(res.status).toBe(400);
  });

  it("401s on unknown user", async () => {
    const handler = makeLoginHandler(() => dbWithUser(null) as never, async () => true, async () => "tok");
    const res = await handler(req({ username: "admin", password: "p" }), { SESSION_SECRET: "s" } as never);
    expect(res.status).toBe(401);
  });

  it("401s on wrong password", async () => {
    const db = dbWithUser({ username: "admin", password_hash: "stored" });
    const handler = makeLoginHandler(() => db as never, async () => false, async () => "tok");
    const res = await handler(req({ username: "admin", password: "bad" }), { SESSION_SECRET: "s" } as never);
    expect(res.status).toBe(401);
  });

  it("200s and sets an HttpOnly cookie on success", async () => {
    const db = dbWithUser({ username: "admin", password_hash: "stored" });
    const handler = makeLoginHandler(() => db as never, async () => true, async () => "signed-token");
    const res = await handler(req({ username: "admin", password: "good" }), { SESSION_SECRET: "s" } as never);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=signed-token");
    expect(cookie).toContain("HttpOnly");
  });

  describe("rate limiting", () => {
    // The whole point of limiting this endpoint: every attempt against a real
    // username costs a PBKDF2-SHA256 x100,000 derivation on the edge worker,
    // so the limiter has to short-circuit before `verify` is ever reached.
    it("429s before running the password verification", async () => {
      const db = dbWithUser({ username: "admin", password_hash: "stored" });
      const verify = vi.fn().mockResolvedValue(true);
      const handler = makeLoginHandler(
        () => db as never,
        verify,
        async () => "tok",
        () => rateLimited(60_000)
      );
      const res = await handler(req({ username: "admin", password: "p" }), { SESSION_SECRET: "s" } as never);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(verify).not.toHaveBeenCalled();
      expect(db.from).not.toHaveBeenCalled();
    });

    it("logs in normally when under the limit", async () => {
      const db = dbWithUser({ username: "admin", password_hash: "stored" });
      const handler = makeLoginHandler(() => db as never, async () => true, async () => "tok", () => null);
      const res = await handler(req({ username: "admin", password: "good" }), { SESSION_SECRET: "s" } as never);
      expect(res.status).toBe(200);
    });
  });
});
