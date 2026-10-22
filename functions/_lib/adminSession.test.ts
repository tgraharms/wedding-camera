// @vitest-environment node
import { describe, it, expect } from "vitest";
import { signSession, verifySession, serializeCookie, parseCookie } from "./adminSession";

const SECRET = "test-secret";

describe("adminSession", () => {
  it("signs and verifies a session, returning the username", async () => {
    const token = await signSession("admin", SECRET, 1000);
    expect(await verifySession(token, SECRET)).toBe("admin");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession("admin", SECRET, 1000);
    expect(await verifySession(token, "other-secret")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signSession("admin", SECRET, -1); // already expired
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const token = await signSession("editor", SECRET, 1000);
    expect(await verifySession(token + "x", SECRET)).toBeNull();
    expect(await verifySession("admin." + token.split(".").slice(1).join("."), SECRET)).toBeNull();
  });

  it("serializes an HttpOnly cookie and parses it back", () => {
    const cookie = serializeCookie("admin_session", "abc", 3600);
    expect(cookie).toContain("admin_session=abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(parseCookie("admin_session=abc; other=1")["admin_session"]).toBe("abc");
  });

  it("parseCookie returns empty object for null header", () => {
    expect(parseCookie(null)).toEqual({});
  });

  it("refuses a username containing a dot — it would produce a 4-part token", async () => {
    await expect(signSession("admin.user", "secret", 60)).rejects.toThrow(/dot/i);
  });

  it("rejects a token with a 4th segment appended, even when the first three are valid", async () => {
    // The token format is positional (username.expiry.hmac), so verifySession
    // must reject anything that isn't exactly 3 parts. This is how a dotted
    // username would surface in practice: login would 200 with a token that
    // *looks* fine, then every later request would 401 with no clue why.
    //
    // Appending a segment to an otherwise-valid token isolates the part-count
    // guard specifically: username, expiry, and signature here are all
    // genuinely correct, so the only thing that can make this fail is the
    // `parts.length !== 3` check. If that guard were removed, the naive
    // `const [username, expStr, sig] = parts` destructure would still pick up
    // the correct username/expiry/sig (the trailing segment is simply
    // dropped), the HMAC would verify, and verifySession would return "admin"
    // instead of null.
    const validToken = await signSession("admin", SECRET, 1000);
    expect(await verifySession(`${validToken}.extra`, SECRET)).toBeNull();
  });
});
