// /api/presign, /api/photos and /api/email are unauthenticated by design — there is
// no guest login — so every field they receive is attacker-controlled.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/i;

export const LIMITS = {
  displayName: 80,
  message: 500,
} as const;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// request.json() returns `null` for a literal `null` body (and can return an array
// or bare primitive for other malformed input). None of those are destructurable
// request bodies, so callers should treat them the same as unparseable JSON — a
// clean 400 — rather than let a property access on `null` throw outside the
// parse try/catch.
export function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A client may only claim a storage key of the shape /api/presign mints for this
// event: "<eventId>/<uuid>.jpg". Split rather than building a RegExp from eventId.
//
// Defence in depth: require eventId itself to be a real v4 uuid. Without this, a
// caller that skipped (or got wrong) its own eventId validation — e.g. passing ""
// — would see the key "/<uuid>.jpg" accepted, since "" as the first split segment
// still equals eventId. Today the single caller validates eventId first, but this
// function should not depend on that.
export function isStorageKeyFor(eventId: string, key: unknown): key is string {
  if (!isUuid(eventId)) return false;
  if (typeof key !== "string") return false;
  const parts = key.split("/");
  if (parts.length !== 2) return false;
  return parts[0] === eventId && STORAGE_FILE_RE.test(parts[1]);
}
