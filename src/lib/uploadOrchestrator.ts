import type { QueueItem } from "./types";
import * as defaultApi from "./apiClient";

export interface UploadApi {
  presign: (
    size: number,
    capturedAt: string,
    sessionId: string
  ) => Promise<{ uploadUrl: string; storageKey: string; eventId: string }>;
  putToR2: (uploadUrl: string, blob: Blob) => Promise<void>;
  savePhoto: (meta: { eventId: string; storageKey: string; sessionId: string; capturedAt: string }) => Promise<void>;
}

/** Where the bytes ended up, once R2 has confirmed them. */
export interface UploadCheckpoint {
  storageKey: string;
  eventId: string;
}

/**
 * presign → PUT → register, resumable at the register step.
 *
 * The three steps are not equally repeatable. Re-running presign mints a *new*
 * storage key, so re-running the whole chain after a failed registration pushes
 * the blob a second time under a different name and abandons the first object in
 * R2 with no row referencing it. `onCheckpoint` is therefore called the instant
 * the PUT resolves, letting the caller persist the key before the fragile step
 * runs; a later attempt that already has one skips straight to registration.
 *
 * The practical win is not the storage — orphans are pennies — it is that a
 * retry stops re-sending several hundred KB over whatever network just failed,
 * which on a saturated venue wifi is the difference that matters.
 */
export async function uploadOne(
  item: QueueItem,
  api: UploadApi = defaultApi,
  onCheckpoint?: (c: UploadCheckpoint) => Promise<void> | void
): Promise<{ storageKey: string }> {
  let done = item.uploaded;
  if (!done) {
    const { uploadUrl, storageKey, eventId } = await api.presign(
      item.blob.size,
      item.metadata.capturedAt,
      item.metadata.sessionId
    );
    await api.putToR2(uploadUrl, item.blob);
    done = { storageKey, eventId };
    // Deliberately awaited before registering: a checkpoint written after the
    // step it is meant to protect would be pointless.
    await onCheckpoint?.(done);
  }
  await api.savePhoto({
    eventId: done.eventId,
    storageKey: done.storageKey,
    sessionId: item.metadata.sessionId,
    capturedAt: item.metadata.capturedAt,
  });
  return { storageKey: done.storageKey };
}
