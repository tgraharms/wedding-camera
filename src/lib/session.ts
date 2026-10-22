import type { MyProfile } from "./types";

const SESSION_ID_KEY = "wc.sessionId";
const PROFILE_KEY = "wc.profile";
const DONE_COUNT_KEY = "wc.doneCount";

// localStorage is not a given: with site data blocked, merely touching
// `window.localStorage` throws a SecurityError, and some engines throw on
// setItem in private mode. Every read/write goes through these two helpers,
// which fall back to a page-lifetime Map so the app renders and keeps a
// stable session id for the visit instead of dying with a blank page before
// the first paint (2026-09-04 findings, Tier A #4).
const memory = new Map<string, string>();

// Memory first: a value we had to park there is newer than whatever
// localStorage holds, and in the "reads work, writes throw" mode (quota full,
// older private modes) localStorage would otherwise answer null forever.
function read(key: string): string | null {
  const parked = memory.get(key);
  if (parked !== undefined) return parked;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
}

// The "N gambar dihantar ✓" strip must survive a reload — a guest who
// refreshes and sees 0 assumes their photos are gone (on-device feedback,
// 2026-09-01). Device-local by design, same trust boundary as the session id;
// corrupt or missing values read as 0, never NaN.
export function loadDoneCount(): number {
  const n = Number(read(DONE_COUNT_KEY));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function bumpDoneCount(): number {
  const next = loadDoneCount() + 1;
  write(DONE_COUNT_KEY, String(next));
  return next;
}

// Server truth wins whenever we have it (the gallery response carries the
// guest's exact photo count). Corrects the drift left behind when an admin
// deletes photos — the local counter otherwise only ever climbs.
export function syncDoneCount(total: number): number {
  const next = Number.isInteger(total) && total > 0 ? total : 0;
  write(DONE_COUNT_KEY, String(next));
  return next;
}

// Mirrors the server's profile field limits (functions/_lib/validate.ts:
// LIMITS.displayName / LIMITS.message in the v2 endpoints). Clamped here, at
// the boundary that persists the value, not just the <input> element.
const DISPLAY_NAME_MAX = 80;
const MESSAGE_MAX = 500;

export function getSessionId(): string {
  let id = read(SESSION_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    write(SESSION_ID_KEY, id);
  }
  return id;
}

// A localStorage mirror of the server-held MyProfile (displayName/message), so
// MyGallery can show the guest's last-saved name/message immediately on open
// instead of waiting on a round trip. Same defensive shape as v1's loadGuest
// used to have — clamps on both write and read, never throws on a corrupt or
// hand-edited value.
export function saveProfileLocal(p: MyProfile): void {
  const profile: MyProfile = {
    displayName: p.displayName === null ? null : p.displayName.slice(0, DISPLAY_NAME_MAX),
    message: p.message === null ? null : p.message.slice(0, MESSAGE_MAX),
  };
  write(PROFILE_KEY, JSON.stringify(profile));
}

export function loadProfile(): MyProfile | null {
  const raw = read(PROFILE_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const { displayName, message } = parsed as Record<string, unknown>;
  if (displayName !== null && displayName !== undefined && typeof displayName !== "string") {
    return null;
  }
  if (message !== null && message !== undefined && typeof message !== "string") {
    return null;
  }

  return {
    displayName: typeof displayName === "string" ? displayName.slice(0, DISPLAY_NAME_MAX) : null,
    message: typeof message === "string" ? message.slice(0, MESSAGE_MAX) : null,
  };
}
