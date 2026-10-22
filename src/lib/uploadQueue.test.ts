import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  UploadQueue,
  backoffMs,
  MAX_ATTEMPTS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from "./uploadQueue";
import type { QueueItem } from "./types";

function makeItem(id: string): Omit<QueueItem, "status" | "attempts" | "nextAttemptAt"> {
  return {
    id,
    eventId: "evt-1",
    blob: new Blob(["x"], { type: "image/jpeg" }),
    metadata: {
      sessionId: "sess-1",
      capturedAt: "2026-06-12T12:30:00.000Z",
    },
  };
}

// drainPass logs every upload failure, and most tests below fail uploads on
// purpose. Silenced so the suite's output stays clean; the tests that care about
// the log read this spy directly.
const spyConsoleError = () => vi.spyOn(console, "error").mockImplementation(() => {});
let errorLog: ReturnType<typeof spyConsoleError>;

beforeEach(async () => {
  indexedDB.deleteDatabase("wc-uploads");
  errorLog = spyConsoleError();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backoffMs", () => {
  it("doubles from the base delay and caps at MAX_BACKOFF_MS", () => {
    const noJitter = () => 1;
    expect(backoffMs(1, noJitter)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(2, noJitter)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(3, noJitter)).toBe(BASE_BACKOFF_MS * 4);
    expect(backoffMs(20, noJitter)).toBe(MAX_BACKOFF_MS);
  });

  it("keeps jitter inside ±20%", () => {
    expect(backoffMs(1, () => 0.8)).toBe(Math.round(BASE_BACKOFF_MS * 0.8));
    expect(backoffMs(1, () => 1.2)).toBe(Math.round(BASE_BACKOFF_MS * 1.2));
    for (let i = 0; i < 50; i++) {
      const v = backoffMs(1); // default random jitter
      expect(v).toBeGreaterThanOrEqual(BASE_BACKOFF_MS * 0.8);
      expect(v).toBeLessThanOrEqual(BASE_BACKOFF_MS * 1.2);
    }
  });
});

describe("UploadQueue storage shape", () => {
  // WebKit will not persist a Blob in a private session, so the queue stores raw
  // bytes and rebuilds the Blob on the way out. The uploader must see a Blob with
  // the original bytes and MIME type; the record on disk must hold no Blob.
  it("stores bytes + type, never a Blob, and rehydrates an equivalent Blob", async () => {
    const seen: QueueItem[] = [];
    const q = new UploadQueue({
      uploadFn: async (item) => { seen.push(item); return "ok"; },
      onDone: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const original = new Blob(["hello-bytes"], { type: "image/webp" });
    await q.enqueue({ ...makeItem("b1"), blob: original });

    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("wc-uploads", 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const raw = await new Promise<Record<string, unknown>>((res, rej) => {
      const r = db.transaction("items", "readonly").objectStore("items").get("b1");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    expect(raw.blob).toBeUndefined();
    // Structured clone hands back an ArrayBuffer from another realm under jsdom,
    // so check the shape rather than the constructor.
    expect(Object.prototype.toString.call(raw.bytes)).toBe("[object ArrayBuffer]");
    expect((raw.bytes as ArrayBuffer).byteLength).toBe("hello-bytes".length);
    expect(raw.type).toBe("image/webp");

    await q.drain();
    expect(seen).toHaveLength(1);
    expect(seen[0].blob).toBeInstanceOf(Blob);
    expect(seen[0].blob.type).toBe("image/webp");
    expect(await seen[0].blob.text()).toBe("hello-bytes");
  });

  it("still reads a legacy record that stored a Blob directly", async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("wc-uploads", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("items", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise<void>((res, rej) => {
      const r = db.transaction("items", "readwrite").objectStore("items")
        .put({ ...makeItem("old1"), blob: new Blob(["legacy"], { type: "image/jpeg" }), status: "pending", attempts: 0, nextAttemptAt: 0 });
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
    db.close();
    const seen: QueueItem[] = [];
    const q = new UploadQueue({
      uploadFn: async (item) => { seen.push(item); return "ok"; },
      onDone: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(await q.pendingCount()).toBe(1);
    await q.drain();
    // fake-indexeddb clones a Blob's identity but not its bytes, so only the
    // shape is checkable here; the real browser round-trips the content.
    expect(seen[0].blob).toBeInstanceOf(Blob);
    expect(seen[0].blob.type).toBe("image/jpeg");
  });
});

describe("UploadQueue", () => {
  it("enqueues and uploads successfully, calling onDone", async () => {
    const uploadFn = vi.fn().mockResolvedValue(undefined);
    const onDone = vi.fn();
    const q = new UploadQueue({ uploadFn, onDone });
    await q.enqueue(makeItem("a"));
    await q.drain();
    expect(uploadFn).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith("a", undefined);
    expect(await q.pendingCount()).toBe(0);
  });

  it("waits for the backoff window before retrying a failed upload", async () => {
    let clock = 1_000_000;
    const uploadFn = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined);
    const q = new UploadQueue({ uploadFn, onDone: vi.fn(), now: () => clock, jitter: () => 1 });
    await q.enqueue(makeItem("b"));

    await q.drain();
    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(await q.pendingCount()).toBe(1);

    await q.drain(); // still inside the 30s window — must not retry yet
    expect(uploadFn).toHaveBeenCalledTimes(1);

    clock += BASE_BACKOFF_MS;
    await q.drain();
    expect(uploadFn).toHaveBeenCalledTimes(2);
    expect(await q.pendingCount()).toBe(0);
  });

  it("gives up after MAX_ATTEMPTS and marks the item failed", async () => {
    let clock = 1_000_000;
    const uploadFn = vi.fn().mockRejectedValue(new Error("net"));
    const q = new UploadQueue({ uploadFn, onDone: vi.fn(), now: () => clock, jitter: () => 1 });
    await q.enqueue(makeItem("e"));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await q.drain();
      clock += MAX_BACKOFF_MS; // always past the next window
    }
    expect(uploadFn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(await q.pendingCount()).toBe(0);
    expect(await q.failedCount()).toBe(1);
  });

  it("never retries an item that has already failed", async () => {
    let clock = 1_000_000;
    const uploadFn = vi.fn().mockRejectedValue(new Error("net"));
    const q = new UploadQueue({ uploadFn, onDone: vi.fn(), now: () => clock, jitter: () => 1 });
    await q.enqueue(makeItem("f"));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await q.drain();
      clock += MAX_BACKOFF_MS;
    }
    uploadFn.mockClear();
    clock += MAX_BACKOFF_MS * 100;
    await q.drain();
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it("removes an item on cancel before upload", async () => {
    const q = new UploadQueue({ uploadFn: vi.fn(), onDone: vi.fn() });
    await q.enqueue(makeItem("c"));
    await q.cancel("c");
    expect(await q.pendingCount()).toBe(0);
  });

  it("does not double-process when drains overlap (re-entrant guard)", async () => {
    const onDone = vi.fn();
    let calls = 0;
    let reentered = false;
    let q: UploadQueue;
    const uploadFn = vi.fn().mockImplementation(async () => {
      calls++;
      // While this upload is in-flight (item not yet deleted), fire a second
      // concurrent drain exactly once. The in-progress guard must make it a no-op;
      // without the guard, the item is still pending so it would be processed again.
      if (!reentered) {
        reentered = true;
        await q!.drain();
      }
    });
    q = new UploadQueue({ uploadFn, onDone });
    await q.enqueue(makeItem("d"));
    await q.drain();
    expect(calls).toBe(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(await q.pendingCount()).toBe(0);
  });

  it("uploads an item enqueued while a drain is in flight (stranded-last-photo bug)", async () => {
    const onDone = vi.fn();
    let q: UploadQueue;
    let enqueuedSecond = false;
    const uploadFn = vi.fn().mockImplementation(async (item: QueueItem) => {
      if (item.id === "first" && !enqueuedSecond) {
        enqueuedSecond = true;
        // Simulates the Caption screen confirming another photo mid-upload:
        // enqueue + drain while the first drain is still running.
        await q!.enqueue(makeItem("second"));
        void q!.drain();
      }
    });
    q = new UploadQueue({ uploadFn, onDone });
    await q.enqueue(makeItem("first"));
    await q.drain();
    expect(uploadFn).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledWith("second", undefined);
    expect(await q.pendingCount()).toBe(0);
  });

  it("schedules its own retry for when the backoff window opens", async () => {
    let clock = 1_000_000;
    const scheduled: { fn: () => void; ms: number }[] = [];
    const uploadFn = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined);
    const q = new UploadQueue({
      uploadFn,
      onDone: vi.fn(),
      now: () => clock,
      jitter: () => 1,
      setTimer: (fn, ms) => {
        scheduled.push({ fn, ms });
        return scheduled.length;
      },
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("g"));
    await q.drain();

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(BASE_BACKOFF_MS);

    clock += BASE_BACKOFF_MS;
    scheduled[0].fn(); // the timer firing
    await vi.waitFor(async () => {
      expect(await q.pendingCount()).toBe(0);
    });
    expect(uploadFn).toHaveBeenCalledTimes(2);
  });

  it("schedules nothing once the queue is drained", async () => {
    const scheduled: number[] = [];
    const q = new UploadQueue({
      uploadFn: vi.fn().mockResolvedValue(undefined),
      onDone: vi.fn(),
      setTimer: (_fn, ms) => {
        scheduled.push(ms);
        return 0;
      },
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("h"));
    await q.drain();
    expect(scheduled).toEqual([]);
  });

  it("retryAllNow puts failed items back in the queue and uploads them", async () => {
    let clock = 1_000_000;
    const uploadFn = vi.fn().mockRejectedValue(new Error("net"));
    const q = new UploadQueue({
      uploadFn,
      onDone: vi.fn(),
      now: () => clock,
      jitter: () => 1,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("i"));
    for (let k = 0; k < MAX_ATTEMPTS; k++) {
      await q.drain();
      clock += MAX_BACKOFF_MS;
    }
    expect(await q.failedCount()).toBe(1);

    uploadFn.mockResolvedValue(undefined);
    await q.retryAllNow();
    expect(await q.failedCount()).toBe(0);
    expect(await q.pendingCount()).toBe(0);
  });

  it("does not spend an attempt on a failure while the device is offline", async () => {
    let clock = 1_000_000;
    const scheduled: number[] = [];
    const uploadFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const q = new UploadQueue({
      uploadFn,
      onDone: vi.fn(),
      now: () => clock,
      jitter: () => 1,
      isOnline: () => false,
      setTimer: (_fn, ms) => {
        scheduled.push(ms);
        return 0;
      },
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("deadspot"));

    // Three times the whole attempt budget, each drain past the previous window:
    // the 36-55 minutes of open-app use in a venue dead spot that used to mark
    // every queued photo `failed`.
    for (let k = 0; k < MAX_ATTEMPTS * 3; k++) {
      await q.drain();
      clock += MAX_BACKOFF_MS;
    }

    expect(uploadFn).toHaveBeenCalledTimes(MAX_ATTEMPTS * 3);
    // The photo is still recoverable: never written off on evidence that says
    // nothing about the photo.
    expect(await q.failedCount()).toBe(0);
    expect(await q.pendingCount()).toBe(1);
    // nextAttemptAt advanced on every uncounted failure too, so scheduleNextDrain
    // never computes a zero delay and spins the timer hot against a dead radio.
    expect(scheduled).toHaveLength(MAX_ATTEMPTS * 3);
    expect(scheduled.every((ms) => ms >= BASE_BACKOFF_MS)).toBe(true);
  });

  it("counts the attempt again as soon as the device is back online", async () => {
    let clock = 1_000_000;
    let online = false;
    const uploadFn = vi.fn().mockRejectedValue(new Error("net"));
    const q = new UploadQueue({
      uploadFn,
      onDone: vi.fn(),
      now: () => clock,
      jitter: () => 1,
      isOnline: () => online,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("mixed"));
    await q.drain();
    clock += MAX_BACKOFF_MS;
    expect(await q.failedCount()).toBe(0);

    online = true;
    for (let k = 0; k < MAX_ATTEMPTS; k++) {
      await q.drain();
      clock += MAX_BACKOFF_MS;
    }
    expect(await q.failedCount()).toBe(1);
  });

  it("revives failed and backed-off items when the reconnect path runs (dead-spot loss scenario)", async () => {
    let clock = 1_000_000;
    const onDone = vi.fn();
    const uploadFn = vi.fn().mockRejectedValue(new Error("net"));
    const q = new UploadQueue({
      uploadFn,
      onDone,
      now: () => clock,
      jitter: () => 1,
      // navigator.onLine reports "has a network interface", not "has internet", so
      // it happily says true inside a venue dead spot. That is why reviving items
      // on reconnect is still needed even though offline failures are uncounted.
      isOnline: () => true,
      setTimer: () => 0,
      clearTimer: () => {},
    });

    // The guest's first photo caps out while they keep shooting.
    await q.enqueue(makeItem("early"));
    for (let k = 0; k < MAX_ATTEMPTS; k++) {
      await q.drain();
      clock += MAX_BACKOFF_MS;
    }
    expect(await q.failedCount()).toBe(1);

    // A later photo is still pending, but deep in its backoff ladder.
    await q.enqueue(makeItem("later"));
    await q.drain();
    expect(await q.pendingCount()).toBe(1);

    // They flow through email → done, then wifi comes back. A plain drain — what
    // the `online` listener used to do — reaches neither item.
    uploadFn.mockClear();
    await q.drain();
    expect(uploadFn).not.toHaveBeenCalled();

    // The reconnect path App.tsx's `online` listener now calls.
    uploadFn.mockResolvedValue(undefined);
    await q.retryAllNow();

    expect(uploadFn).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledWith("early", undefined);
    expect(onDone).toHaveBeenCalledWith("later", undefined);
    expect(await q.failedCount()).toBe(0);
    expect(await q.pendingCount()).toBe(0);
  });

  it("logs why an upload failed, with the item id and attempt number", async () => {
    let clock = 1_000_000;
    const uploadFn = vi.fn().mockRejectedValue(new Error("413 payload too large"));
    const q = new UploadQueue({
      uploadFn,
      onDone: vi.fn(),
      now: () => clock,
      jitter: () => 1,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("loud"));
    await q.drain();

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`upload failed (id=loud, attempt 1/${MAX_ATTEMPTS})`),
      expect.any(Error)
    );
    // The cause itself must be in the log, not just the fact that it failed —
    // diagnosing a 413 or a malformed blob is the whole point.
    expect(errorLog.mock.calls[0][1]).toHaveProperty("message", "413 payload too large");
  });

  it("says in the log when a failure was offline and therefore not counted", async () => {
    let clock = 1_000_000;
    const q = new UploadQueue({
      uploadFn: vi.fn().mockRejectedValue(new Error("net")),
      onDone: vi.fn(),
      now: () => clock,
      jitter: () => 1,
      isOnline: () => false,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("quiet"));
    await q.drain();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("offline — attempt not counted"),
      expect.any(Error)
    );
  });

  it("onChange fires after a drain so the UI can re-read counts", async () => {
    const onChange = vi.fn();
    const q = new UploadQueue({
      uploadFn: vi.fn().mockResolvedValue(undefined),
      onDone: vi.fn(),
      onChange,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("j"));
    await q.drain();
    expect(onChange).toHaveBeenCalled();
  });

  it("coalesces overlapping drains so every scheduled timer stays cancellable", async () => {
    let clock = 1_000_000;
    let handles = 0;
    const onChange = vi.fn();
    const scheduled: { handle: string; fn: () => void; ms: number }[] = [];
    const cleared: string[] = [];
    // What was still armed each time a new timer was scheduled. A non-empty
    // entry means two timers were live at once, and only one of them can be
    // in this.timer — the other can never be handed to clearTimer.
    const armedAtSchedule: string[][] = [];
    let overlappingDrain: Promise<void> | null = null;
    let q: UploadQueue;

    const stillArmed = () =>
      scheduled.filter((s) => !cleared.includes(s.handle)).map((s) => s.handle);

    const uploadFn = vi.fn().mockRejectedValue(new Error("net"));
    q = new UploadQueue({
      uploadFn,
      onDone: vi.fn(),
      onChange,
      now: () => clock,
      jitter: () => 1,
      // The race this guards against is a concurrent trigger (an `online`
      // listener, a fresh capture's drain) landing *inside* scheduleNextDrain()
      // — specifically between its cancelTimer() and its setTimer(), while the
      // scan's two awaits are outstanding. Only there can two schedulers
      // interleave: the intruder runs its own full scheduler and stores its
      // handle in this.timer, then the original's setTimer return value
      // overwrites it, orphaning a live timer stop() can never reach.
      //
      // clearTimer is the injection point that lands in exactly that window:
      // cancelTimer() calls it as the first statement of scheduleNextDrain(),
      // before openDb()/getAll(). (setTimer is too late — by then the scan is
      // over and this.timer is assigned synchronously on return, so the two
      // schedulers can never overlap and the orphan is unreachable. onChange is
      // later still, firing only once `draining` is back to false.)
      //
      // clearTimer only fires when a timer is already armed, hence the shape
      // below: fail once to arm a timer, cross the backoff window, then drain
      // again so the second scheduleNextDrain() has a live handle to clear.
      setTimer: (fn, ms) => {
        armedAtSchedule.push(stillArmed());
        const handle = `h${++handles}`;
        scheduled.push({ handle, fn, ms });
        return handle;
      },
      clearTimer: (h) => {
        cleared.push(h as string);
        if (!overlappingDrain) overlappingDrain = q!.drain();
      },
    });

    await q.enqueue(makeItem("overlap"));
    await q.drain(); // fails the item and arms h1 for the 30s window
    expect(scheduled.map((s) => s.handle)).toEqual(["h1"]);

    clock += BASE_BACKOFF_MS;
    await q.drain(); // retries, fails again; its reschedule clears h1 → overlap fires
    await overlappingDrain;
    q.stop();

    // Soft, so a regression reports every invariant it broke rather than only
    // the first — which of these fail together is what identifies the fault.
    //
    // The coalesced request must be served by a real extra pass of the *same*
    // drain() — its own scan and reschedule — not silently dropped and not run
    // as a second concurrent drain. Two more timers after h1: one from the pass
    // that cleared h1, one from the extra pass the request bought.
    expect.soft(scheduled.map((s) => s.handle)).toEqual(["h1", "h2", "h3"]);
    // Never two live timers at once. If scheduleNextDrain() ran outside the
    // re-entrancy guard, the overlapping drain would arm its own timer over the
    // top of this one's and the loser's handle would be untracked from here on.
    expect.soft(armedAtSchedule).toEqual([[], [], []]);
    // And stop() reached every handle that was ever created.
    expect.soft(stillArmed()).toEqual([]);
    // The overlapping drain was absorbed by the in-flight one rather than
    // running its own drain to completion, so it must not report a drain of its
    // own. onChange fires once for the enqueue, once per item attempt that
    // settled (two real attempts), and once at the end of each explicit
    // drain() above — five — and nothing for the intruder.
    expect.soft(onChange).toHaveBeenCalledTimes(5);
    // Two real upload attempts (one per explicit drain); the extra pass finds
    // the item backed off again and correctly leaves it alone.
    expect.soft(uploadFn).toHaveBeenCalledTimes(2);
  });

  it("logs and recovers when the timer-driven drain rejects, instead of dying silently", async () => {
    let clock = 1_000_000;
    const scheduled: { fn: () => void; ms: number }[] = [];
    const uploadFn = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined);
    const q = new UploadQueue({
      uploadFn,
      onDone: vi.fn(),
      now: () => clock,
      jitter: () => 1,
      setTimer: (fn, ms) => {
        scheduled.push({ fn, ms });
        return scheduled.length;
      },
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("m"));
    await q.drain();
    expect(scheduled).toHaveLength(1);

    clock += BASE_BACKOFF_MS;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Simulate IndexedDB failing outright (Safari private mode, storage
    // eviction) for exactly the drain the timer fires with no user action
    // behind it.
    const openSpy = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      throw new Error("IDB unavailable");
    });

    scheduled[0].fn(); // the timer fires the un-awaited internal drain()
    // Rejection must be observed (logged), never an unhandled rejection.
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("scheduled drain failed:", expect.any(Error));
    });
    openSpy.mockRestore();

    // The self-healing chain must not be dead: a later explicit drain still
    // processes the item once IndexedDB works again.
    await q.drain();
    expect(uploadFn).toHaveBeenCalledTimes(2);
    expect(await q.pendingCount()).toBe(0);

    errorSpy.mockRestore();
  });

  it("stop() cancels for good even after a timer fired and re-entered drain()", async () => {
    let clock = 1_000_000;
    let handles = 0;
    const scheduled: { fn: () => void; ms: number }[] = [];
    const uploadFn = vi.fn().mockRejectedValue(new Error("net"));
    const q = new UploadQueue({
      uploadFn,
      onDone: vi.fn(),
      now: () => clock,
      jitter: () => 1,
      setTimer: (fn, ms) => {
        scheduled.push({ fn, ms });
        return `h${++handles}`;
      },
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("teardown"));
    await q.drain();
    expect(scheduled).toHaveLength(1);

    clock += BASE_BACKOFF_MS;
    scheduled[0].fn(); // the timer fires: it nulls this.timer and re-enters drain()
    q.stop(); // teardown (React effect cleanup) while that drain is in flight

    await vi.waitFor(() => {
      expect(uploadFn).toHaveBeenCalledTimes(2);
    });
    // The in-flight drain must not arm a fresh timer behind stop()'s back.
    expect(scheduled).toHaveLength(1);

    // ...but stop() is not permanently sticky: an explicit drain re-arms it.
    clock += MAX_BACKOFF_MS;
    await q.drain();
    expect(scheduled).toHaveLength(2);
  });

  it("a WindowClosedError fails the item immediately, skipping the retry ladder", async () => {
    const err = Object.assign(new Error("window closed"), { name: "WindowClosedError" });
    const q = new UploadQueue({ uploadFn: vi.fn().mockRejectedValue(err), onDone: vi.fn(), now: () => 0, jitter: () => 1 });
    await q.enqueue({ id: "w1", eventId: "", blob: new Blob(["x"]), metadata: { sessionId: "s", capturedAt: "c" } as never });
    await q.drain();
    expect(await q.failedCount()).toBe(1);
    // retryAllNow must NOT resurrect it into the ladder more than once —
    // it re-fails immediately on the next attempt too (server still closed).
  });

  it("a QuotaError fails the item immediately and reports it as a quota", async () => {
    const err = Object.assign(new Error("guest quota reached"), { name: "QuotaError" });
    const onQuota = vi.fn();
    const q = new UploadQueue({
      uploadFn: vi.fn().mockRejectedValue(err),
      onDone: vi.fn(),
      onQuota,
      now: () => 0,
      jitter: () => 1,
    });
    await q.enqueue({ id: "q9", eventId: "", blob: new Blob(["x"]), metadata: { sessionId: "s", capturedAt: "c" } as never });
    await q.drain();
    expect(await q.failedCount()).toBe(1);
    expect(onQuota).toHaveBeenCalledTimes(1);
  });

  it("does not report a quota for an ordinary window closure", async () => {
    const err = Object.assign(new Error("window closed"), { name: "WindowClosedError" });
    const onQuota = vi.fn();
    const q = new UploadQueue({
      uploadFn: vi.fn().mockRejectedValue(err),
      onDone: vi.fn(),
      onQuota,
      now: () => 0,
      jitter: () => 1,
    });
    await q.enqueue({ id: "w2", eventId: "", blob: new Blob(["x"]), metadata: { sessionId: "s", capturedAt: "c" } as never });
    await q.drain();
    expect(onQuota).not.toHaveBeenCalled();
  });

  it("stop() cancels the pending timer", async () => {
    let clock = 1_000_000;
    const cleared: unknown[] = [];
    const q = new UploadQueue({
      uploadFn: vi.fn().mockRejectedValue(new Error("net")),
      onDone: vi.fn(),
      now: () => clock,
      jitter: () => 1,
      setTimer: () => "handle-1",
      clearTimer: (h) => cleared.push(h),
    });
    await q.enqueue(makeItem("k"));
    await q.drain();
    q.stop();
    expect(cleared).toContain("handle-1");
  });
});

describe("checkpoint persistence", () => {
  // Guards a bug that was live for one commit during development: every failure
  // path re-puts a spread of the `item` read BEFORE the attempt, so a checkpoint
  // written mid-attempt was overwritten by the write recording the failure —
  // and the retry then re-presigned, re-uploaded, and orphaned the first object.
  it("keeps a mid-attempt checkpoint after the attempt fails", async () => {
    let clock = 0;
    const seen: (QueueItem["uploaded"] | undefined)[] = [];
    const uploadFn = vi
      .fn()
      .mockImplementationOnce(async (item: QueueItem, onCheckpoint: (c: NonNullable<QueueItem["uploaded"]>) => Promise<void>) => {
        seen.push(item.uploaded);
        await onCheckpoint({ storageKey: "evt-1/abc.jpg", eventId: "evt-1" });
        throw new Error("savePhoto failed: 429");
      })
      .mockImplementationOnce(async (item: QueueItem) => {
        seen.push(item.uploaded);
      });

    const q = new UploadQueue({ uploadFn, onDone: vi.fn(), now: () => clock, jitter: () => 1 });
    await q.enqueue(makeItem("q1"));
    await q.drain();
    expect(uploadFn).toHaveBeenCalledTimes(1);

    clock += BASE_BACKOFF_MS + 1;
    await q.drain();
    expect(uploadFn).toHaveBeenCalledTimes(2);

    // First attempt saw no checkpoint; the retry saw the persisted one.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual({ storageKey: "evt-1/abc.jpg", eventId: "evt-1" });
  });

  it("keeps the checkpoint when the attempt fails terminally", async () => {
    const uploadFn = vi.fn().mockImplementation(
      async (_item: QueueItem, onCheckpoint: (c: NonNullable<QueueItem["uploaded"]>) => Promise<void>) => {
        await onCheckpoint({ storageKey: "evt-1/def.jpg", eventId: "evt-1" });
        const e = new Error("window closed");
        e.name = "WindowClosedError";
        throw e;
      }
    );
    const q = new UploadQueue({ uploadFn, onDone: vi.fn() });
    await q.enqueue(makeItem("q2"));
    await q.drain();

    // Revive it and confirm the retry is handed the checkpoint, so a terminal
    // failure that is later retried still cannot orphan a second object.
    const revived: (QueueItem["uploaded"] | undefined)[] = [];
    uploadFn.mockImplementation(async (item: QueueItem) => { revived.push(item.uploaded); });
    await q.retryAllNow();
    expect(revived[0]).toEqual({ storageKey: "evt-1/def.jpg", eventId: "evt-1" });
  });
});

// 2026-09-04 findings, Tier A. Each of these was a way for a photo to look lost
// (or actually stay stuck) on ordinary venue wifi, not just in private mode.
describe("UploadQueue announces progress and survives its own failures", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueue fires onChange so the pending count can appear before the first drain finishes", async () => {
    const onChange = vi.fn();
    const q = new UploadQueue({
      uploadFn: vi.fn(() => new Promise(() => {})), // never settles — a saturated network
      onDone: vi.fn(),
      onChange,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("p1"));
    expect(onChange).toHaveBeenCalled();
  });

  it("fires onChange as each item settles during a drain, not only when the whole pass ends", async () => {
    let release!: () => void;
    const gate = new Promise<unknown>((r) => { release = () => r("ok"); });
    const onChange = vi.fn();
    const uploadFn = vi.fn().mockImplementationOnce(async () => "ok").mockImplementationOnce(() => gate);
    const q = new UploadQueue({ uploadFn, onDone: vi.fn(), onChange, setTimer: () => 0, clearTimer: () => {} });
    await q.enqueue(makeItem("s1"));
    await q.enqueue(makeItem("s2"));
    onChange.mockClear();

    const drain = q.drain();
    try {
      await vi.waitFor(() => expect(uploadFn).toHaveBeenCalledTimes(2));
      // s1 is delivered and s2 is still in flight: the UI must already know about s1.
      expect(onChange).toHaveBeenCalled();
    } finally {
      // Always let the drain finish: a stuck drain keeps its IndexedDB connection
      // open, which blocks the next test's deleteDatabase and cascades timeouts.
      release();
      await drain;
    }
  });

  it("a storage write failure while recording one item's failure does not stop the pass or the reschedule", async () => {
    const uploadFn = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce("ok");
    const setTimer = vi.fn(() => 0);
    const q = new UploadQueue({
      uploadFn,
      onDone: vi.fn(),
      now: () => 1_000_000,
      jitter: () => 1,
      setTimer,
      clearTimer: () => {},
    });
    await q.enqueue(makeItem("w1"));
    await q.enqueue(makeItem("w2"));
    // The very next put — the one that records w1's failure — throws the way a
    // full or evicted store does.
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    await expect(q.drain()).resolves.toBeUndefined();
    expect(uploadFn).toHaveBeenCalledTimes(2); // w2 was still attempted
    expect(setTimer).toHaveBeenCalled(); // w1 is still pending, so the wake-up was armed
    expect(errorLog).toHaveBeenCalled();
    // w1's failure record never landed, so its nextAttemptAt is still in the
    // past. Rescheduling from that value would be a 0 ms timer — a hot loop of
    // attempt → fail → refused write → attempt, at tens of Hz offline and at
    // several requests/second against the shared venue presign budget online.
    // The wake-up must be floored at the base backoff instead.
    const [, ms] = setTimer.mock.calls[setTimer.mock.calls.length - 1] as unknown as [unknown, number];
    expect(ms).toBeGreaterThanOrEqual(BASE_BACKOFF_MS);
  });

  it("closes a connection that opens after the time-box already gave up", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const spy = vi.spyOn(indexedDB, "open").mockImplementation(
      () => ({ onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: { close } }) as unknown as IDBOpenDBRequest
    );
    const q = new UploadQueue({ uploadFn: vi.fn(), onDone: vi.fn() });
    const pending = q.enqueue(makeItem("late"));
    const assertion = expect(pending).rejects.toThrow(/IndexedDB/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    const req = spy.mock.results[0].value as IDBOpenDBRequest;
    req.onsuccess!(new Event("success"));
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("counts() reads pending and failed in one pass over the store", async () => {
    let clock = 1_000_000;
    const uploadFn = vi.fn().mockRejectedValue(new Error("net"));
    const q = new UploadQueue({ uploadFn, onDone: vi.fn(), now: () => clock, jitter: () => 1, setTimer: () => 0, clearTimer: () => {} });
    await q.enqueue(makeItem("c1"));
    await q.enqueue(makeItem("c2"));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await q.drain();
      clock += MAX_BACKOFF_MS;
    }
    await q.enqueue(makeItem("c3"));
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    expect(await q.counts()).toEqual({ pending: 1, failed: 2 });
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it("a throwing onDone does not resurrect a photo that was already delivered", async () => {
    const uploadFn = vi.fn().mockResolvedValue("ok");
    const onDone = vi.fn(() => {
      throw new Error("localStorage blocked");
    });
    const q = new UploadQueue({ uploadFn, onDone, setTimer: () => 0, clearTimer: () => {} });
    await q.enqueue(makeItem("d1"));
    await q.drain();
    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(await q.pendingCount()).toBe(0);
    expect(await q.failedCount()).toBe(0);
    expect(errorLog).toHaveBeenCalled();
  });
});

describe("openDb is time-boxed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function neverSettlingOpen() {
    return vi.spyOn(indexedDB, "open").mockImplementation(
      () => ({ onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null }) as unknown as IDBOpenDBRequest
    );
  }

  it("rejects after 5 s instead of hanging onFile forever", async () => {
    vi.useFakeTimers();
    neverSettlingOpen();
    const q = new UploadQueue({ uploadFn: vi.fn(), onDone: vi.fn() });
    const pending = q.enqueue(makeItem("t1"));
    const assertion = expect(pending).rejects.toThrow(/IndexedDB/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("rejects when the open request is blocked by another connection", async () => {
    const spy = neverSettlingOpen();
    const q = new UploadQueue({ uploadFn: vi.fn(), onDone: vi.fn() });
    const pending = q.enqueue(makeItem("t2"));
    const assertion = expect(pending).rejects.toThrow(/blocked/i);
    const req = spy.mock.results[0].value as IDBOpenDBRequest;
    await vi.waitFor(() => expect(req.onblocked).toBeTypeOf("function"));
    req.onblocked!(new Event("blocked") as IDBVersionChangeEvent);
    await assertion;
  });
});

describe("retryAllNow survives a failing revive write", () => {
  it("keeps reviving the other items and still drains when one write throws", async () => {
    let clock = 1_000_000;
    // Both items fail once and back off, so both need reviving.
    const uploadFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValue("ok");
    const onDone = vi.fn();
    const q = new UploadQueue({ uploadFn, onDone, now: () => clock, jitter: () => 1, setTimer: () => 0, clearTimer: () => {} });
    await q.enqueue(makeItem("r1"));
    await q.enqueue(makeItem("r2"));
    await q.drain();
    expect(await q.pendingCount()).toBe(2); // both backed off, neither eligible yet

    // The first revive write (r1) throws; r2's must still happen and the drain must still run.
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await expect(q.retryAllNow()).resolves.toBeUndefined();
    expect(onDone).toHaveBeenCalledWith("r2", "ok");
    expect(errorLog).toHaveBeenCalled();
  });
});


describe("UploadQueue.ids", () => {
  // Used by the originals queue to find parked originals whose display item is
  // gone. getAll() would clone every queued photo's bytes just to read ids.
  it("lists queued ids via keys only, never cloning records", async () => {
    const q = new UploadQueue({ uploadFn: vi.fn(), onDone: vi.fn() });
    expect(await q.ids()).toEqual(new Set());
    await q.enqueue(makeItem("a"));
    await q.enqueue(makeItem("b"));
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    expect(await q.ids()).toEqual(new Set(["a", "b"]));
    expect(getAll).not.toHaveBeenCalled();
  });
});
