// @vitest-environment node
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password", () => {
  it("hashes into the pbkdf2 format and verifies the correct password", async () => {
    const stored = await hashPassword("s3cret-pass");
    expect(stored.startsWith("pbkdf2$")).toBe(true);
    expect(stored.split("$")).toHaveLength(4);
    expect(await verifyPassword("s3cret-pass", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("right");
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("produces a different salt/hash each time", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("returns false on a malformed stored value", async () => {
    expect(await verifyPassword("x", "not-a-valid-hash")).toBe(false);
  });

  it("returns false (not throws) on a 4-part value with non-base64 salt/hash", async () => {
    await expect(verifyPassword("x", "pbkdf2$100000$!!!notb64!!!$alsobad")).resolves.toBe(false);
  });
});
