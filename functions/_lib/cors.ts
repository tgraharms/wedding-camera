export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

export function serverError(detail: string): Response {
  console.error("server error:", detail); // visible in wrangler/Pages logs only
  return json({ error: "server error" }, 500);
}
