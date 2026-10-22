// @vitest-environment node
import { describe, it, expect } from "vitest";
import { requireAdmin } from "./auth";
import { signSession } from "./adminSession";

const env = { SESSION_SECRET: "sek" } as never;

function reqWithCookie(cookie?: string): Request {
  return new Request("https://x/api/admin/photos", {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

describe("requireAdmin", () => {
  it("returns the username for a valid session cookie", async () => {
    const token = await signSession("admin", "sek", 1000);
    expect(await requireAdmin(reqWithCookie(`admin_session=${token}`), env)).toBe("admin");
  });

  it("returns null when no cookie is present", async () => {
    expect(await requireAdmin(reqWithCookie(), env)).toBeNull();
  });

  it("returns null for an invalid token", async () => {
    expect(await requireAdmin(reqWithCookie("admin_session=garbage"), env)).toBeNull();
  });
});
