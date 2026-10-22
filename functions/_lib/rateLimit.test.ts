import { describe, it, expect } from "vitest";
import { makeRateLimiter, clientIp, rateLimited, limitByIp } from "./rateLimit";

const reqFrom = (ip?: string) =>
  new Request("https://x/api/presign", { headers: ip ? { "CF-Connecting-IP": ip } : {} });

describe("makeRateLimiter", () => {
  it("allows requests up to the limit", () => {
    const l = makeRateLimiter({ limit: 3, now: () => 0 });
    expect(l.check("a").ok).toBe(true);
    expect(l.check("a").ok).toBe(true);
    expect(l.check("a").ok).toBe(true);
  });

  it("rejects the request past the limit, with a retry hint", () => {
    let t = 0;
    const l = makeRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
    l.check("a");
    l.check("a");
    t = 10_000;
    const verdict = l.check("a");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.retryAfterMs).toBe(50_000);
  });

  it("starts a fresh window once the old one expires", () => {
    let t = 0;
    const l = makeRateLimiter({ limit: 1, windowMs: 60_000, now: () => t });
    expect(l.check("a").ok).toBe(true);
    expect(l.check("a").ok).toBe(false);
    t = 60_000;
    expect(l.check("a").ok).toBe(true);
  });

  it("counts each key independently", () => {
    const l = makeRateLimiter({ limit: 1, now: () => 0 });
    expect(l.check("a").ok).toBe(true);
    expect(l.check("b").ok).toBe(true);
    expect(l.check("a").ok).toBe(false);
  });

  // The venue is behind one NAT, so the failure that actually matters is
  // throttling real guests. When the map is saturated it must forget counts,
  // never start refusing.
  it("keeps admitting traffic when the key map saturates", () => {
    const l = makeRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    for (let i = 0; i < 6000; i++) l.check(`ip-${i}`);
    expect(l.check("ip-new").ok).toBe(true);
  });
});

describe("clientIp", () => {
  it("reads CF-Connecting-IP", () => {
    expect(clientIp(reqFrom("203.0.113.7"))).toBe("203.0.113.7");
  });

  it("falls back to a constant when the header is absent", () => {
    expect(clientIp(reqFrom())).toBe("unknown");
  });
});

describe("rateLimited", () => {
  it("is a 429 carrying Retry-After in whole seconds", async () => {
    const res = rateLimited(1500);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(await res.json()).toEqual({ error: "rate limited" });
  });

  it("never advertises a Retry-After of 0", () => {
    expect(rateLimited(0).headers.get("Retry-After")).toBe("1");
  });
});

describe("limitByIp", () => {
  it("returns null while under the limit and a 429 past it", () => {
    const check = limitByIp(makeRateLimiter({ limit: 1, now: () => 0 }));
    expect(check(reqFrom("1.1.1.1"))).toBeNull();
    expect(check(reqFrom("1.1.1.1"))?.status).toBe(429);
    // A different guest on a different IP is unaffected.
    expect(check(reqFrom("2.2.2.2"))).toBeNull();
  });
});
