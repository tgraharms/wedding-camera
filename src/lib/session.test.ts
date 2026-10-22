import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSessionId, loadProfile, saveProfileLocal } from "./session";

beforeEach(() => localStorage.clear());

describe("session", () => {
  it("creates a stable session id that persists", () => {
    const a = getSessionId();
    const b = getSessionId();
    expect(a).toBe(b);
    expect(a).toMatch(/[0-9a-f-]{36}/);
  });

  describe("profile (loadProfile/saveProfileLocal)", () => {
    it("profile round-trips and clamps", () => {
      saveProfileLocal({ displayName: "x".repeat(200), message: "y".repeat(900) });
      const p = loadProfile()!;
      expect(p.displayName).toHaveLength(80);
      expect(p.message).toHaveLength(500);
    });

    it("returns null when nothing is saved", () => {
      expect(loadProfile()).toBeNull();
    });

    it("stores null fields as null", () => {
      saveProfileLocal({ displayName: null, message: null });
      expect(loadProfile()).toEqual({ displayName: null, message: null });
    });

    it("corrupt stored profile returns null instead of throwing", () => {
      localStorage.setItem("wc.profile", "{nope");
      expect(loadProfile()).toBeNull();
      localStorage.setItem("wc.profile", JSON.stringify({ displayName: 5 }));
      expect(loadProfile()).toBeNull();
    });
  });
});

describe("done counter persistence", () => {
  it("starts at 0, increments, and survives a reload (fresh read)", async () => {
    const { loadDoneCount, bumpDoneCount } = await import("./session");
    expect(loadDoneCount()).toBe(0);
    expect(bumpDoneCount()).toBe(1);
    expect(bumpDoneCount()).toBe(2);
    expect(loadDoneCount()).toBe(2);
  });

  it("treats corrupt stored values as 0 instead of NaN", async () => {
    const { loadDoneCount, bumpDoneCount } = await import("./session");
    localStorage.setItem("wc.doneCount", "garbage");
    expect(loadDoneCount()).toBe(0);
    expect(bumpDoneCount()).toBe(1);
  });
  it("syncDoneCount replaces the local counter with the server's total, in both directions", async () => {
    const { loadDoneCount, bumpDoneCount, syncDoneCount } = await import("./session");
    bumpDoneCount(); bumpDoneCount();
    expect(syncDoneCount(18)).toBe(18);
    expect(loadDoneCount()).toBe(18);
    expect(syncDoneCount(3)).toBe(3);
    expect(loadDoneCount()).toBe(3);
    expect(syncDoneCount(-1)).toBe(0);
    expect(loadDoneCount()).toBe(0);
  });
});

// A guest with site data blocked (or a storage engine that throws on touch)
// used to get a blank white page: `localStorage` was read unguarded during
// App's first render. Everything here must degrade to in-memory for the page's
// lifetime and never throw.
describe("session when localStorage is unavailable", () => {
  let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
  });

  it("falls back to memory: stable session id, done count bumps, profile round-trips, nothing throws", async () => {
    const { getSessionId, loadDoneCount, bumpDoneCount, saveProfileLocal, loadProfile } = await import("./session");
    const a = getSessionId();
    expect(a).toMatch(/[0-9a-f-]{36}/);
    expect(getSessionId()).toBe(a);

    const before = loadDoneCount();
    expect(bumpDoneCount()).toBe(before + 1);
    expect(loadDoneCount()).toBe(before + 1);

    expect(() => saveProfileLocal({ displayName: "Aminah", message: null })).not.toThrow();
    expect(loadProfile()).toEqual({ displayName: "Aminah", message: null });
  });
});

// The other half of "storage is not a given": some engines let getItem work
// while setItem throws (quota full; older private modes). A read that trusts
// localStorage's null over a value we just had to park in memory would mint a
// new session id on every call and pin the done counter at 0.
describe("session when localStorage accepts reads but refuses writes", () => {
  let setItem: typeof Storage.prototype.setItem;
  beforeEach(() => {
    localStorage.clear();
    setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    };
  });
  afterEach(() => {
    Storage.prototype.setItem = setItem;
  });

  it("keeps one session id and a moving done counter for the page", async () => {
    const { getSessionId, loadDoneCount, bumpDoneCount, saveProfileLocal, loadProfile } = await import("./session");
    const a = getSessionId();
    expect(getSessionId()).toBe(a);
    const before = loadDoneCount();
    bumpDoneCount();
    bumpDoneCount();
    expect(loadDoneCount()).toBe(before + 2);
    saveProfileLocal({ displayName: "Aminah", message: "hai" });
    expect(loadProfile()).toEqual({ displayName: "Aminah", message: "hai" });
  });
});
