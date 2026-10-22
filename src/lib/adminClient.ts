import type { AdminPhoto, AdminWish, EventInfo } from "./types";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

// Why a login failed decides what the admin should do next: a wrong password
// wants another try, a 429 wants a minute of *not* trying (each attempt during
// the block extends it), a 5xx/network error wants a look at the connection.
export type LoginResult = "ok" | "invalid" | "rate-limited" | "error";

export async function adminLogin(username: string, password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return "error";
  }
  if (res.ok) return "ok";
  if (res.status === 401) return "invalid";
  if (res.status === 429) return "rate-limited";
  return "error";
}

export async function adminLogout(): Promise<void> {
  await fetch("/api/admin/logout", { method: "POST" });
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

// Server errors carry {"error": "..."} bodies (e.g. 409 "windows overlap");
// surface that message instead of a generic "request failed: 409".
async function send(url: string, method: "POST", body: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(parsed?.error ?? `request failed: ${res.status}`);
  }
}

export async function getAdminEvents(): Promise<EventInfo[]> {
  const { events } = await getJson<{ events: EventInfo[] }>("/api/admin/events");
  return events;
}

export async function createEvent(input: { name: string; windowStart: string; windowEnd: string }): Promise<void> {
  return send("/api/admin/events", "POST", input);
}

export async function updateEvent(input: {
  eventId: string;
  name?: string;
  windowStart?: string;
  windowEnd?: string;
}): Promise<void> {
  const { eventId, ...patch } = input;
  return send("/api/admin/event", "POST", { eventId, ...patch });
}

export async function deleteEvent(eventId: string): Promise<void> {
  return send("/api/admin/event", "POST", { eventId, delete: true });
}

export async function getAdminPhotos(
  page: number,
  eventId: string | "all",
  groupByGuest = false
): Promise<{ photos: AdminPhoto[]; hasMore: boolean; counts: { eventId: string; name: string; count: number }[] }> {
  return getJson(`/api/admin/photos?page=${page}&eventId=${encodeURIComponent(eventId)}${groupByGuest ? "&group=guest" : ""}`);
}

export async function setStarred(photoId: string, starred: boolean): Promise<void> {
  return send("/api/admin/star", "POST", { photoId, starred });
}

// token/url are null until one has been created — GET is a pure read, so the
// first-ever visit has nothing to report yet. Callers POST to create it.
export async function getShareLink(): Promise<{ token: string | null; url: string | null; starredCount: number }> {
  return getJson("/api/admin/share");
}

export async function regenerateShareLink(): Promise<{ token: string; url: string; starredCount: number }> {
  const res = await fetch("/api/admin/share", { method: "POST" });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

export async function getAdminWishes(): Promise<AdminWish[]> {
  const wishes = new Map<string, AdminWish>();
  for (let page = 0; ; page++) {
    const result = await getJson<{ wishes: AdminWish[]; hasMore: boolean }>(`/api/admin/wishes?page=${page}`);
    for (const wish of result.wishes) wishes.set(wish.guestId, wish);
    if (!result.hasMore) return [...wishes.values()];
  }
}
