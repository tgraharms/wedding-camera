import { describe, it, expect } from "vitest";
import { json, badRequest, serverError } from "./cors";

describe("cors helpers", () => {
  it("returns JSON with 200 and content-type", async () => {
    const res = json({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("badRequest returns 400 with an error message", async () => {
    const res = badRequest("nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "nope" });
  });

  it("serverError logs the detail but hides it from the client", async () => {
    const res = serverError("pg: relation \"photos\" does not exist");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server error" });
  });
});
