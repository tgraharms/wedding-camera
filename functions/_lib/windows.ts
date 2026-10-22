export const GRACE_MS = 30 * 60_000;
export const LATE_MS = 24 * 60 * 60_000;

export interface WindowEvent {
  id: string;
  name: string;
  window_start: string | null;
  window_end: string | null;
}

export type WindowStatus =
  | { state: "open"; eventId: string; eventName: string }
  | { state: "before" }
  | { state: "ended" };

type Timed = WindowEvent & { window_start: string; window_end: string };
const timed = (events: WindowEvent[]): Timed[] =>
  events.filter((e): e is Timed => e.window_start !== null && e.window_end !== null);
const contains = (e: Timed, t: number) => t >= Date.parse(e.window_start) && t < Date.parse(e.window_end);

// Upload-time routing: the open window, else the most recently ended window
// still inside its 30-minute grace. Start inclusive, end exclusive, so
// contiguous windows hand over cleanly at the boundary instant.
export function eventForUpload(events: WindowEvent[], at: Date): WindowEvent | null {
  const t = at.getTime();
  const ts = timed(events);
  const open = ts.find((e) => contains(e, t));
  if (open) return open;
  const graced = ts
    .filter((e) => t >= Date.parse(e.window_end) && t < Date.parse(e.window_end) + GRACE_MS)
    .sort((a, b) => Date.parse(b.window_end) - Date.parse(a.window_end));
  return graced[0] ?? null;
}

// Registration additionally honors late stragglers: a photo whose capturedAt
// sits inside an event's window may register up to LATE_MS after that window
// ends — otherwise a phone offline for >30 minutes after close would lose
// real photos, which the reconnect-drains-everything queue exists to prevent.
// capturedAt is client-supplied and unverifiable; the blast radius of lying is
// one bounded-size photo landing in a finished event, which we accept.
export function eventForRegistration(events: WindowEvent[], at: Date, capturedAt: string): WindowEvent | null {
  const live = eventForUpload(events, at);
  if (live) return live;
  const cap = Date.parse(capturedAt);
  if (Number.isNaN(cap)) return null;
  const t = at.getTime();
  return timed(events).find((e) => contains(e, cap) && t < Date.parse(e.window_end) + LATE_MS) ?? null;
}

// Guest-facing state: no grace — guests read "closed" at end sharp while
// in-flight stragglers still land during grace.
export function statusFor(events: WindowEvent[], at: Date): WindowStatus {
  const t = at.getTime();
  const ts = timed(events);
  const open = ts.find((e) => contains(e, t));
  if (open) return { state: "open", eventId: open.id, eventName: open.name };
  if (ts.some((e) => Date.parse(e.window_start) > t)) return { state: "before" };
  return { state: "ended" };
}

// Handover fallback for registration: at a contiguous-window boundary, a photo
// presigned in the outgoing window can 403 at insert time because the *live*
// window has already moved on to the next event (eventForRegistration always
// prefers the live route). This checks whether the specific CLAIMED event
// independently justifies acceptance — now inside its window or its
// upload-time grace, or capturedAt inside its window and still within the
// late-straggler allowance — so a genuinely in-flight photo isn't fast-failed
// just because another event's window opened underneath it. A claim against
// an unrelated event (cross-event garbage) still gets none of these and 403s.
export function eventAcceptsRegistration(ev: WindowEvent, at: Date, capturedAt: string): boolean {
  if (!ev.window_start || !ev.window_end) return false;
  const t = at.getTime();
  const start = Date.parse(ev.window_start);
  const end = Date.parse(ev.window_end);
  if (t >= start && t < end) return true;
  if (t >= end && t < end + GRACE_MS) return true;
  const cap = Date.parse(capturedAt);
  if (!Number.isNaN(cap) && cap >= start && cap < end && t < end + LATE_MS) return true;
  return false;
}

export function overlaps(a: WindowEvent, b: WindowEvent): boolean {
  if (!a.window_start || !a.window_end || !b.window_start || !b.window_end) return false;
  return Date.parse(a.window_start) < Date.parse(b.window_end) && Date.parse(b.window_start) < Date.parse(a.window_end);
}
