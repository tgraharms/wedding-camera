// Optional custom-domain redirect. Set PAGES_HOST (the project's *.pages.dev
// hostname) and CANONICAL_HOST (the custom domain the QR codes point at) as
// Pages environment variables; with either unset, nothing is redirected. The
// pages.dev hostname keeps serving the same deployment but lives outside the
// custom domain's zone, so zone-level rate-limit rules never see traffic on
// it. Navigations that land on it are moved to the custom domain.
//
// /api/ is deliberately excluded. A phone that installed the PWA from
// pages.dev before the domain existed still POSTs to pages.dev/api/…; a 301
// there would turn its uploads into GETs. Those calls keep working on the old
// host, and the next time that phone opens the app it is redirected anyway.
//
// Exact host match on purpose: preview deployments (<hash>.<project>.pages.dev)
// must keep working as previews. /assets/ is also left alone: module scripts
// only load same-origin, so a phone still on pages.dev must get its assets
// from pages.dev, not a 301 to the custom domain.
export function makeHostRedirect(fromHost: string, toHost: string) {
  return async (request: Request, next: () => Promise<Response>): Promise<Response> => {
    const url = new URL(request.url);
    if (url.hostname !== fromHost || url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/")) return next();
    url.protocol = "https:";
    url.hostname = toHost;
    url.port = "";
    return Response.redirect(url.toString(), 301);
  };
}

// Pages answers an unknown path with the SPA index.html (200), and
// public/_headers marks /assets/* immutable for a year. On 2026-09-13 a request
// for a freshly deployed bundle reached an edge still on the previous
// deployment, got that HTML, and Cloudflare cached it as the .js on the custom
// domain until the next deploy. Assets therefore run through Functions now
// (public/_routes.json no longer excludes them — one invocation per edge cache
// miss, nothing on a hit) and an HTML answer under /assets/ becomes a 404 that
// neither Cloudflare nor a phone's service-worker precache will keep.
export async function guardAssets(request: Request, next: () => Promise<Response>): Promise<Response> {
  const res = await next();
  if (!new URL(request.url).pathname.startsWith("/assets/")) return res;
  const type = res.headers.get("content-type") ?? "";
  if (res.status !== 200 || !/text\/html/i.test(type)) return res;
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

type HostEnv = { PAGES_HOST?: string; CANONICAL_HOST?: string };

export const handle = (request: Request, next: () => Promise<Response>, env: HostEnv = {}) => {
  const guarded = () => guardAssets(request, next);
  return env.PAGES_HOST && env.CANONICAL_HOST
    ? makeHostRedirect(env.PAGES_HOST, env.CANONICAL_HOST)(request, guarded)
    : guarded();
};

export const onRequest: PagesFunction<HostEnv> = ({ request, next, env }) => handle(request, next, env);
