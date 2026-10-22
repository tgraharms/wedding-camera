import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { UploadQueue, MAX_BACKOFF_MS } from "./uploadQueue";
import type { QueueItem } from "./types";

// Chaos run: a reception's worth of photos through a queue whose network,
// storage engine and UI callbacks all misbehave at once. Deterministic (seeded)
// so a failure is reproducible. The invariant under test is the only one that
// matters on the day: every photo is delivered exactly once, and the queue ends
// empty — no duplicates, no orphans, no wedged timer.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeItem(id: string): Omit<QueueItem, "status" | "attempts" | "nextAttemptAt"> {
  return {
    id,
    eventId: "evt-1",
    blob: new Blob([id], { type: "image/jpeg" }),
    metadata: { sessionId: "sess-1", capturedAt: "2026-09-19T05:00:00.000Z" },
  };
}

beforeEach(() => {
  indexedDB.deleteDatabase("wc-uploads");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("UploadQueue under chaos", () => {
  for (const seed of [1, 2, 3]) {
    it(`delivers every photo exactly once with a flaky network, failing storage writes and throwing callbacks (seed ${seed})`, async () => {
      const rand = mulberry32(seed);
      const N = 120;
      let clock = 1_000_000;
      let online = true;
      let injectStorageFaults = false;

      const delivered = new Map<string, number>(); // id → onDone count
      const uploadedAfterDelivery: string[] = [];
      let onChangeCalls = 0;

      // Storage chaos: ~3% of drain bookkeeping writes (checkpoints, failure
      // records) throw the way a full or evicted store does. Fresh-item writes
      // are exempt: an enqueue that fails is the *visible* "gambar tidak dapat
      // disimpan" path and a retryAllNow that fails is logged by App — both
      // outside this test's contract, which is about the drain never wedging.
      const realPut = IDBObjectStore.prototype.put;
      const isFreshWrite = (rec: unknown) => {
        const r = rec as Partial<QueueItem>;
        return r.status === "pending" && r.attempts === 0 && r.nextAttemptAt === 0 && !r.uploaded;
      };
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
        if (injectStorageFaults && !isFreshWrite(args[0]) && rand() < 0.03) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        return realPut.apply(this, args as [unknown]);
      });

      const q: UploadQueue = new UploadQueue({
        uploadFn: async (item, onCheckpoint) => {
          if (delivered.has(item.id)) uploadedAfterDelivery.push(item.id);
          await sleep(Math.floor(rand() * 3));
          const roll = rand();
          if (roll < 0.1) {
            // Got the bytes to R2, then died before registration: checkpoint,
            // then fail — the next attempt must resume, not re-upload.
            await onCheckpoint({ storageKey: `${item.eventId}/${item.id}.jpg`, eventId: item.eventId });
            throw new Error("net after put");
          }
          if (roll < 0.4) throw new Error("net");
          return "ok";
        },
        onDone: (id) => {
          delivered.set(id, (delivered.get(id) ?? 0) + 1);
          if (rand() < 0.1) throw new Error("done-counter write refused");
        },
        onChange: () => {
          onChangeCalls++;
          // Exactly what App.tsx does: two more IndexedDB opens per change, fire-and-forget.
          void q.pendingCount().catch(() => {});
          void q.failedCount().catch(() => {});
        },
        now: () => clock,
        jitter: () => 1,
        setTimer: () => 0, // the test drives time itself
        clearTimer: () => {},
        isOnline: () => online,
      });

      // Shoot in bursts while drains are in flight, the way a table of guests does.
      let shot = 0;
      while (shot < N) {
        const burst = 1 + Math.floor(rand() * 8);
        const inFlight = q.drain();
        for (let i = 0; i < burst && shot < N; i++) {
          await q.enqueue(makeItem(`photo-${String(shot++).padStart(3, "0")}`));
          void q.drain().catch(() => {});
        }
        await inFlight;
        injectStorageFaults = true;
      }

      // Time passes: cross every backoff window, drop offline now and then, and
      // press the guest's retry button occasionally. Bounded so a wedge fails
      // the test instead of hanging it.
      for (let round = 0; round < 200; round++) {
        if ((await q.pendingCount()) === 0 && (await q.failedCount()) === 0) break;
        clock += MAX_BACKOFF_MS + 1;
        online = rand() > 0.15;
        if (rand() < 0.1) await q.retryAllNow();
        else await q.drain();
      }
      injectStorageFaults = false;
      online = true;
      // Anything that exhausted its ladder gets the guest's "cuba lagi" — as on the day.
      for (let round = 0; round < 50 && (await q.failedCount()) > 0; round++) {
        clock += MAX_BACKOFF_MS + 1;
        await q.retryAllNow();
      }

      expect(await q.pendingCount()).toBe(0);
      expect(await q.failedCount()).toBe(0);
      expect(delivered.size).toBe(N);
      expect([...delivered.values()].every((n) => n === 1)).toBe(true);
      expect(uploadedAfterDelivery).toEqual([]);
      expect(onChangeCalls).toBeGreaterThan(N);
    }, 60_000);
  }
});
