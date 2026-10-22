import { describe, it, expect, vi } from "vitest";
import { makeHostRedirect, handle } from "./_middleware";

const FROM = "my-project.pages.dev";
const TO = "photos.example.com";

function run(url: string) {
  const next = vi.fn().mockResolvedValue(new Response("asset", { status: 200 }));
  const mw = makeHostRedirect(FROM, TO);
  return { res: mw(new Request(url), next), next };
}

// The QR codes point at the custom domain; *.pages.dev still serves the same
// deployment but sits outside the zone, so zone rate-limit rules never see
// it. Navigations on the old hostname move to the real one; the API does not,
// because a phone that installed the PWA from pages.dev keeps POSTing to
// pages.dev/api/… and a 301 would turn those POSTs into GETs.
describe("pages.dev → custom domain redirect", () => {
  it("301s a navigation on the old hostname to the same path on the custom domain", async () => {
    const { res, next } = run(`https://${FROM}/share/abc?x=1`);
    const r = await res;
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`https://${TO}/share/abc?x=1`);
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves /api/ on the old hostname alone", async () => {
    const { res, next } = run(`https://${FROM}/api/presign?eventId=e`);
    expect((await res).status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("leaves the custom domain alone", async () => {
    const { res, next } = run(`https://${TO}/admin`);
    expect((await res).status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("leaves preview deployments alone (exact host match, not a suffix)", async () => {
    const { res, next } = run(`https://858834b2.${FROM}/`);
    expect((await res).status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("redirects nothing when the hosts are not configured", async () => {
    const next = vi.fn().mockResolvedValue(new Response("page", { status: 200 }));
    const res = await handle(new Request(`https://${FROM}/admin`), next);
    expect(res.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("redirects through handle() once the hosts are configured", async () => {
    const next = vi.fn();
    const res = await handle(new Request(`https://${FROM}/admin`), next, { PAGES_HOST: FROM, CANONICAL_HOST: TO });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://${TO}/admin`);
    expect(next).not.toHaveBeenCalled();
  });
});

// 2026-09-13: a request for a not-yet-propagated /assets/*.js on the custom
// domain was answered by the previous deployment's SPA fallback (index.html,
// 200), and public/_headers marks /assets/* immutable for a year, so Cloudflare
// cached HTML at the .js URL. Assets now run through this middleware so that
// fallback becomes an uncacheable 404 instead.
describe("assets guard", () => {
  const html = () => new Response("<!doctype html><html></html>", {
    status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
  });
  const js = () => new Response("export{}", {
    status: 200, headers: { "content-type": "application/javascript", "cache-control": "public, max-age=31536000, immutable" },
  });

  it("turns an HTML fallback under /assets/ into a 404 that nothing may cache", async () => {
    const next = vi.fn().mockResolvedValue(html());
    const res = await onRequestGuarded(`https://${TO}/assets/index-NEW.js`, next);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).not.toMatch(/html/);
  });

  it("passes a real asset through untouched, immutable header and all", async () => {
    const next = vi.fn().mockResolvedValue(js());
    const res = await onRequestGuarded(`https://${TO}/assets/index-NEW.js`, next);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("export{}");
  });

  it("serves /assets/ on the old pages.dev host instead of redirecting (module scripts are same-origin only)", async () => {
    const next = vi.fn().mockResolvedValue(js());
    const res = await onRequestGuarded(`https://${FROM}/assets/index-NEW.js`, next);
    expect(res.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not touch HTML outside /assets/ (the SPA fallback for /share and /admin must keep working)", async () => {
    const next = vi.fn().mockResolvedValue(html());
    const res = await onRequestGuarded(`https://${TO}/share/abc`, next);
    expect(res.status).toBe(200);
  });

  it("keeps /assets/* routed through Functions so the guard actually runs", async () => {
    // @ts-expect-error the Functions tsconfig only knows workers-types; vitest runs this on Node.
    const { readFileSync } = await import("node:fs");
    const routes = JSON.parse(readFileSync("public/_routes.json", "utf8")) as { exclude?: string[] };
    expect(routes.exclude ?? []).not.toContain("/assets/*");
  });
});

function onRequestGuarded(url: string, next: () => Promise<Response>) {
  return handle(new Request(url), next, { PAGES_HOST: FROM, CANONICAL_HOST: TO });
}
