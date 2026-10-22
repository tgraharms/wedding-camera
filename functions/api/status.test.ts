import { describe, it, expect, vi } from "vitest";
import { makeStatusHandler } from "./status";

const akad = { id: "a", name: "Akad", window_start: "2026-09-19T03:00:00Z", window_end: "2026-09-19T10:00:00Z" };
const env = {} as never;

describe("makeStatusHandler", () => {
  it("returns open with event name inside a window", async () => {
    const h = makeStatusHandler(async () => [akad], () => Date.parse("2026-09-19T05:00:00Z"));
    const res = await h(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "open", eventId: "a", eventName: "Akad" });
  });

  it("returns ended after all windows", async () => {
    const h = makeStatusHandler(async () => [akad], () => Date.parse("2026-09-20T05:00:00Z"));
    expect(await (await h(env)).json()).toEqual({ state: "ended" });
  });

  it("500s when the events getter throws (cold cache, db down)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeStatusHandler(async () => { throw new Error("boom"); }, Date.now);
    expect((await h(env)).status).toBe(500);
    consoleError.mockRestore();
  });

  it("asks the getter for stale-allowed events", async () => {
    const getEvents = vi.fn().mockResolvedValue([akad]);
    await makeStatusHandler(getEvents, () => Date.parse("2026-09-19T05:00:00Z"))(env);
    expect(getEvents).toHaveBeenCalledWith(env, { allowStale: true });
  });
});
