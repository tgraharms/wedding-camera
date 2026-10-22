// v2 status probe.
export type StatusInfo =
  | { state: "open"; eventId: string; eventName: string }
  | { state: "before" }
  | { state: "ended" };

// Upload metadata — all uploadOrchestrator.uploadOne needs.
export interface UploadMeta {
  sessionId: string;
  capturedAt: string;
}

export type QueueItemStatus = "pending" | "uploading" | "done" | "failed";

export interface QueueItem {
  id: string;
  eventId: string;
  blob: Blob;
  metadata: UploadMeta;
  status: QueueItemStatus;
  attempts: number;
  /** Epoch ms; the item is not retried before this. 0 = eligible immediately. */
  nextAttemptAt: number;
  /**
   * Set once the bytes are confirmed in R2, so a retry can skip straight to
   * registration instead of re-presigning a fresh key and re-uploading.
   *
   * Without this, an upload whose PUT succeeded but whose /api/photos call did
   * not (a 429, or the radio dying between the two requests) re-runs all three
   * steps on the next attempt: it mints a NEW storage key, pushes the blob
   * again, and strands the first object in R2 forever with nothing referencing
   * it. Absent on items enqueued by an older bundle, which simply take the full
   * path — so this is safe to deploy over a queue that already has work in it.
   */
  uploaded?: { storageKey: string; eventId: string };
}

export interface MyPhoto {
  id: string;
  imageUrl: string;
  capturedAt: string;
}

export interface MyProfile {
  displayName: string | null;
  message: string | null;
}

// v2 admin gallery photo shape — starred replaces v1's isHidden/isPrivate,
// message replaces caption, guestName is nullable.
export interface AdminPhoto {
  guestId?: string;
  id: string;
  eventId: string;
  eventName: string;
  guestName: string | null;
  message: string | null;
  imageUrl: string;
  starred: boolean;
  capturedAt: string;
}

// v2 event shape — windowStart/windowEnd/count replace v1's isRevealed/isActive.
export interface EventInfo {
  id: string;
  name: string;
  windowStart: string | null;
  windowEnd: string | null;
  count: number;
}

export interface AdminWish { guestId: string; guestName: string | null; message: string; }
