import type { StatusInfo, MyPhoto, MyProfile } from "./types";

// Errors that retrying can never fix — the server is rejecting on state, not on
// connectivity. The queue fails these immediately instead of spending the whole
// backoff ladder on them.
export class TerminalUploadError extends Error {}

export class WindowClosedError extends TerminalUploadError {
  constructor() {
    super("window closed");
    this.name = "WindowClosedError";
  }
}

// The guest hit their own fair-use allowance. Distinct from WindowClosedError
// because the guest-facing message has to differ: "try again later" is actively
// wrong advice here.
export class QuotaError extends TerminalUploadError {
  constructor() {
    super("guest quota reached");
    this.name = "QuotaError";
  }
}

// Every call carries a deadline. The queue uploads one photo at a time, so a
// single half-open socket on flaky venue wifi would otherwise block every
// later photo on that phone until the OS gave up — minutes. JSON calls are
// tiny; the R2 PUT gets longer because a 5 MiB unprocessed fallback at
// 100 KB/s needs ~50 s, and a timeout here is a counted, retried attempt,
// not a lost photo.
export const JSON_TIMEOUT_MS = 10_000;
export const PUT_TIMEOUT_MS = 60_000;

// Reads the body inside the timed region: headers arriving and the body then
// stalling is a normal lossy-wifi failure, and it must hit the same deadline.
async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ res: Response; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    return { res, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// Both caps answer 403, as does a closed window. Read the body to tell them
// apart, and fall back to the window case if the body is unreadable — that is
// the pre-existing meaning of a bare 403 here.
function terminalFrom403(text: string): TerminalUploadError {
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { error?: string })?.error;
  } catch {
    code = undefined;
  }
  return code === "guest quota" ? new QuotaError() : new WindowClosedError();
}

export async function getStatus(): Promise<StatusInfo> {
  const { res, text } = await fetchWithTimeout("/api/status", {}, JSON_TIMEOUT_MS);
  if (!res.ok) throw new Error(`getStatus failed: ${res.status}`);
  return JSON.parse(text);
}

export async function presign(
  size: number,
  capturedAt: string,
  sessionId: string
): Promise<{ uploadUrl: string; storageKey: string; eventId: string }> {
  const { res, text } = await fetchWithTimeout(
    `/api/presign?size=${size}&capturedAt=${encodeURIComponent(capturedAt)}` +
      `&sessionId=${encodeURIComponent(sessionId)}`,
    {},
    JSON_TIMEOUT_MS
  );
  if (res.status === 403) throw terminalFrom403(text);
  if (!res.ok) throw new Error("presign failed");
  return JSON.parse(text);
}

export async function putToR2(uploadUrl: string, blob: Blob): Promise<void> {
  const { res } = await fetchWithTimeout(
    uploadUrl,
    {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: blob,
    },
    PUT_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`R2 PUT failed: ${res.status}`);
}

// Originals can be tens of MB (a 200MP Android JPEG). Five minutes covers
// 64 MiB at ~250 KB/s; a timeout is a counted, retried attempt, never a lost
// display photo — originals are best-effort by design.
export const ORIGINAL_PUT_TIMEOUT_MS = 300_000;

// 400 (malformed), 403 (window closed) and 404 (not this guest's photo) are
// decided by state, not connectivity: retrying cannot help.
export async function presignOriginal(
  storageKey: string,
  sessionId: string,
  size: number
): Promise<{ uploadUrl: string }> {
  const { res, text } = await fetchWithTimeout(
    `/api/originals/presign?storageKey=${encodeURIComponent(storageKey)}` +
      `&sessionId=${encodeURIComponent(sessionId)}&size=${size}`,
    {},
    JSON_TIMEOUT_MS
  );
  if (res.status === 400 || res.status === 403 || res.status === 404) {
    throw new TerminalUploadError(`original presign refused: ${res.status}`);
  }
  if (!res.ok) throw new Error(`original presign failed: ${res.status}`);
  // A 2xx that is not JSON is not this API answering: a Pages rollback to a
  // build without the route serves the SPA's index.html fallback (200) for
  // it. Retrying cannot help, so the original is dropped — never the display
  // copy, which does not come through here.
  try {
    return JSON.parse(text);
  } catch {
    throw new TerminalUploadError("original presign unavailable");
  }
}

export async function putOriginal(uploadUrl: string, blob: Blob): Promise<void> {
  const { res } = await fetchWithTimeout(
    uploadUrl,
    { method: "PUT", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob },
    ORIGINAL_PUT_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`R2 original PUT failed: ${res.status}`);
}

// v2 shape.
export async function savePhoto(meta: {
  eventId: string;
  storageKey: string;
  sessionId: string;
  capturedAt: string;
}): Promise<void> {
  const { res } = await fetchWithTimeout(
    "/api/photos",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(meta),
    },
    JSON_TIMEOUT_MS
  );
  if (res.status === 403) throw new WindowClosedError();
  if (!res.ok) throw new Error(`savePhoto failed: ${res.status}`);
}

export async function getMyPhotos(
  sessionId: string,
  page: number
): Promise<{ photos: MyPhoto[]; profile: MyProfile; hasMore: boolean; total: number }> {
  const { res, text } = await fetchWithTimeout(
    `/api/me/photos?sessionId=${encodeURIComponent(sessionId)}&page=${page}`,
    {},
    JSON_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`getMyPhotos failed: ${res.status}`);
  return JSON.parse(text);
}

export async function getShare(token: string): Promise<{ photos: MyPhoto[] }> {
  const { res, text } = await fetchWithTimeout(
    `/api/share?token=${encodeURIComponent(token)}`,
    {},
    JSON_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`getShare failed: ${res.status}`);
  return JSON.parse(text);
}

export async function saveProfile(input: {
  sessionId: string;
  displayName: string | null;
  message: string | null;
}): Promise<void> {
  const { res } = await fetchWithTimeout(
    "/api/me/profile",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    JSON_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`saveProfile failed: ${res.status}`);
}

