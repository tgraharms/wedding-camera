import { describe, it, expect, vi } from "vitest";
import { uploadOne } from "./uploadOrchestrator";
import type { QueueItem } from "./types";

const item: QueueItem = {
  id: "q1", eventId: "", blob: new Blob(["x"]), status: "pending", attempts: 0, nextAttemptAt: 0,
  metadata: { sessionId: "22222222-2222-4222-8222-222222222222", capturedAt: "2026-09-19T05:00:00Z" },
};

describe("uploadOrchestrator", () => {
  it("presigns with size+capturedAt, PUTs, saves with the routed eventId", async () => {
    const api = {
      presign: vi.fn().mockResolvedValue({ uploadUrl: "u", storageKey: "e/1.jpg", eventId: "ev1" }),
      putToR2: vi.fn().mockResolvedValue(undefined),
      savePhoto: vi.fn().mockResolvedValue(undefined),
    };
    const result = await uploadOne(item, api);
    expect(api.presign).toHaveBeenCalledWith(
      item.blob.size,
      item.metadata.capturedAt,
      item.metadata.sessionId
    );
    expect(api.putToR2).toHaveBeenCalledWith("u", item.blob);
    expect(api.savePhoto).toHaveBeenCalledWith({
      eventId: "ev1", storageKey: "e/1.jpg", sessionId: item.metadata.sessionId, capturedAt: item.metadata.capturedAt,
    });
    expect(result).toEqual({ storageKey: "e/1.jpg" });
  });

  // The orphan-generating path: PUT lands, registration does not. Without
  // checkpointing, the retry mints a fresh key and re-pushes the blob, leaving
  // the first object in R2 with nothing pointing at it.
  it("checkpoints the storage key as soon as the PUT succeeds", async () => {
    const onPutComplete = vi.fn();
    const api = {
      presign: vi.fn().mockResolvedValue({ uploadUrl: "u", storageKey: "e/1.jpg", eventId: "ev1" }),
      putToR2: vi.fn().mockResolvedValue(undefined),
      savePhoto: vi.fn().mockRejectedValue(new Error("savePhoto failed: 429")),
    };
    await expect(uploadOne(item, api, onPutComplete)).rejects.toThrow("429");
    expect(onPutComplete).toHaveBeenCalledWith({ storageKey: "e/1.jpg", eventId: "ev1" });
  });

  it("skips presign and PUT when the item already has confirmed bytes in R2", async () => {
    const api = {
      presign: vi.fn(),
      putToR2: vi.fn(),
      savePhoto: vi.fn().mockResolvedValue(undefined),
    };
    const resumed: QueueItem = { ...item, uploaded: { storageKey: "e/1.jpg", eventId: "ev1" } };
    const result = await uploadOne(resumed, api);
    expect(api.presign).not.toHaveBeenCalled();
    expect(api.putToR2).not.toHaveBeenCalled();
    expect(api.savePhoto).toHaveBeenCalledWith({
      eventId: "ev1", storageKey: "e/1.jpg", sessionId: item.metadata.sessionId, capturedAt: item.metadata.capturedAt,
    });
    expect(result).toEqual({ storageKey: "e/1.jpg" });
  });

  it("does not re-checkpoint on a resumed attempt", async () => {
    const onPutComplete = vi.fn();
    const api = {
      presign: vi.fn(),
      putToR2: vi.fn(),
      savePhoto: vi.fn().mockResolvedValue(undefined),
    };
    await uploadOne({ ...item, uploaded: { storageKey: "e/1.jpg", eventId: "ev1" } }, api, onPutComplete);
    expect(onPutComplete).not.toHaveBeenCalled();
  });

  // An older bundle's queue items have no `uploaded` field at all; they must
  // still take the full path rather than throwing on a missing key.
  it("takes the full path for a legacy item with no uploaded field", async () => {
    const api = {
      presign: vi.fn().mockResolvedValue({ uploadUrl: "u", storageKey: "e/2.jpg", eventId: "ev1" }),
      putToR2: vi.fn().mockResolvedValue(undefined),
      savePhoto: vi.fn().mockResolvedValue(undefined),
    };
    const legacy = { ...item } as QueueItem;
    delete (legacy as { uploaded?: unknown }).uploaded;
    await uploadOne(legacy, api);
    expect(api.presign).toHaveBeenCalled();
    expect(api.putToR2).toHaveBeenCalled();
  });
});
