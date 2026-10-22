import { describe, it, expect } from "vitest";
import {
  GRACE_MS, LATE_MS, eventForUpload, eventForRegistration, eventAcceptsRegistration, statusFor, overlaps,
  type WindowEvent,
} from "./windows";

const akad: WindowEvent = { id: "a", name: "Akad", window_start: "2026-09-19T03:00:00Z", window_end: "2026-09-19T10:00:00Z" };
const resepsi: WindowEvent = { id: "r", name: "Reception", window_start: "2026-09-19T10:00:00Z", window_end: "2026-09-19T16:00:00Z" };
const untimed: WindowEvent = { id: "u", name: "Draft", window_start: null, window_end: null };
const evs = [akad, resepsi, untimed];
const at = (iso: string) => new Date(iso);

describe("eventForUpload", () => {
  it("routes to the open window", () => {
    expect(eventForUpload(evs, at("2026-09-19T05:00:00Z"))?.id).toBe("a");
    expect(eventForUpload(evs, at("2026-09-19T12:00:00Z"))?.id).toBe("r");
  });
  it("window start is inclusive, end exclusive (contiguous windows never double-match)", () => {
    expect(eventForUpload(evs, at("2026-09-19T10:00:00Z"))?.id).toBe("r");
  });
  it("grace: within 30min after end routes to the just-ended event", () => {
    expect(eventForUpload(evs, at("2026-09-19T16:29:59Z"))?.id).toBe("r");
  });
  it("grace boundary: exactly GRACE_MS after end is rejected", () => {
    expect(eventForUpload(evs, new Date(Date.parse(resepsi.window_end!) + GRACE_MS))).toBeNull();
  });
  it("before any window, and untimed events, never match", () => {
    expect(eventForUpload(evs, at("2026-09-19T01:00:00Z"))).toBeNull();
    expect(eventForUpload([untimed], at("2026-09-19T05:00:00Z"))).toBeNull();
  });
});

describe("eventForRegistration (late straggler)", () => {
  it("falls back to the event whose window contains capturedAt, within LATE_MS of its end", () => {
    const ev = eventForRegistration(evs, at("2026-09-19T20:00:00Z"), "2026-09-19T12:30:00Z");
    expect(ev?.id).toBe("r");
  });
  it("rejects when capturedAt matches but the late window has passed", () => {
    const tooLate = new Date(Date.parse(resepsi.window_end!) + LATE_MS + 1000);
    expect(eventForRegistration(evs, tooLate, "2026-09-19T12:30:00Z")).toBeNull();
  });
  it("rejects when capturedAt is outside every window", () => {
    expect(eventForRegistration(evs, at("2026-09-19T20:00:00Z"), "2026-09-18T12:00:00Z")).toBeNull();
  });
  it("prefers the upload-time route when one exists", () => {
    expect(eventForRegistration(evs, at("2026-09-19T05:00:00Z"), "2026-09-19T12:30:00Z")?.id).toBe("a");
  });
});

describe("statusFor", () => {
  it("open inside a window (no grace)", () => {
    expect(statusFor(evs, at("2026-09-19T05:00:00Z"))).toEqual({ state: "open", eventId: "a", eventName: "Akad" });
  });
  it("closed at window end sharp, even inside grace", () => {
    expect(statusFor(evs, at("2026-09-19T16:05:00Z"))).toEqual({ state: "ended" });
  });
  it("before when a window is still upcoming", () => {
    expect(statusFor(evs, at("2026-09-19T01:00:00Z"))).toEqual({ state: "before" });
    expect(statusFor([akad, resepsi], at("2026-09-19T10:30:00Z")).state).toBe("open");
  });
  it("ended when no timed windows exist at all", () => {
    expect(statusFor([untimed], at("2026-09-19T05:00:00Z"))).toEqual({ state: "ended" });
  });
});

describe("eventAcceptsRegistration", () => {
  it("accepts while the event's own window is open", () => {
    expect(eventAcceptsRegistration(akad, at("2026-09-19T05:00:00Z"), "2026-09-19T05:00:00Z")).toBe(true);
  });
  it("accepts within the event's own grace after it closed, even if a different window is now live", () => {
    // This is the handover case: Reception opens the instant Akad's grace starts.
    expect(eventAcceptsRegistration(akad, at("2026-09-19T10:00:05Z"), "2026-09-19T09:59:50Z")).toBe(true);
  });
  it("rejects once the event's own grace has fully elapsed with no late-straggler match", () => {
    expect(eventAcceptsRegistration(akad, new Date(Date.parse(akad.window_end!) + GRACE_MS + 1), "2026-09-18T12:00:00Z")).toBe(false);
  });
  it("accepts a late straggler whose capturedAt sits inside the event's window, within LATE_MS", () => {
    const lateNow = new Date(Date.parse(akad.window_end!) + LATE_MS - 1000);
    expect(eventAcceptsRegistration(akad, lateNow, "2026-09-19T05:00:00Z")).toBe(true);
  });
  it("rejects a late straggler past LATE_MS", () => {
    const tooLate = new Date(Date.parse(akad.window_end!) + LATE_MS + 1000);
    expect(eventAcceptsRegistration(akad, tooLate, "2026-09-19T05:00:00Z")).toBe(false);
  });
  it("rejects a cross-event claim: capturedAt outside the claimed event's window entirely", () => {
    expect(eventAcceptsRegistration(resepsi, at("2026-09-21T05:00:00Z"), "2026-09-19T05:00:00Z")).toBe(false);
  });
  it("rejects untimed events", () => {
    expect(eventAcceptsRegistration(untimed, at("2026-09-19T05:00:00Z"), "2026-09-19T05:00:00Z")).toBe(false);
  });
});

describe("overlaps", () => {
  it("contiguous windows do not overlap; crossing ones do; untimed never do", () => {
    expect(overlaps(akad, resepsi)).toBe(false);
    expect(overlaps(akad, { ...resepsi, window_start: "2026-09-19T09:00:00Z" })).toBe(true);
    expect(overlaps(akad, untimed)).toBe(false);
  });
});
