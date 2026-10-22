import type { QueueItem } from "./types";

const DB_NAME = "wc-uploads";
const STORE = "items";

// An open request that never settles — seen as a hard hang in onFile with not
// even a console line — is worse than a rejection: a rejection at least reaches
// App's saveError notice. So the open is time-boxed, and `blocked` (another
// tab holding an older version) is treated as a failure rather than a wait.
export const OPEN_DB_TIMEOUT_MS = 5_000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`IndexedDB did not open within ${OPEN_DB_TIMEOUT_MS} ms`));
    }, OPEN_DB_TIMEOUT_MS);
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      // The caller has already been told "no"; don't leak the handle that
      // eventually showed up anyway.
      if (timedOut) return req.result.close();
      settle(() => resolve(req.result));
    };
    req.onerror = () => settle(() => reject(req.error));
    req.onblocked = () => settle(() => reject(new Error("IndexedDB open blocked by another connection")));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE, mode).objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// What actually sits in IndexedDB. The photo is stored as raw bytes, not as a
// Blob: WebKit refuses to persist a Blob in a private (ephemeral) session, and
// the 2026-09-04 smoke test showed that failure mode as three silently lost
// photos. Bytes store everywhere. Older bundles wrote `blob` directly, so a
// record may still carry one — read both shapes, always write bytes.
interface StoredItem extends Omit<QueueItem, "blob"> {
  bytes?: ArrayBuffer;
  type?: string;
  blob?: Blob;
}

async function toStored(item: QueueItem): Promise<StoredItem> {
  const { blob, ...rest } = item;
  return { ...rest, bytes: await blob.arrayBuffer(), type: blob.type };
}

function fromStored(rec: StoredItem): QueueItem {
  const { bytes, type, blob, ...rest } = rec;
  if (blob instanceof Blob) return { ...rest, blob };
  return { ...rest, blob: new Blob([bytes ?? new ArrayBuffer(0)], { type: type ?? "image/jpeg" }) };
}

async function getAll(db: IDBDatabase): Promise<QueueItem[]> {
  const recs = await tx<StoredItem[]>(db, "readonly", (s) => s.getAll());
  return recs.map(fromStored);
}

async function putItem(db: IDBDatabase, item: QueueItem): Promise<void> {
  const rec = await toStored(item);
  await tx(db, "readwrite", (s) => s.put(rec));
}

export const MAX_ATTEMPTS = 8;
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 15 * 60_000;

const defaultJitter = () => 0.8 + Math.random() * 0.4;

// `navigator.onLine` is absent outside a browser (and in some non-DOM test
// environments). Absent must mean "online", never "offline": reading it as
// offline would make drainPass stop counting attempts entirely, so a genuinely
// broken photo would retry forever and never surface to the guest as failed.
const defaultIsOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

// 30s → 60s → 120s … capped at 15 min. Jittered ±20% because a venue-wide signal
// drop would otherwise make every guest's phone retry in the same instant.
export function backoffMs(attempts: number, jitter: () => number = defaultJitter): number {
  const raw = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  return Math.round(raw * jitter());
}

export interface UploadQueueOpts {
  /**
   * Performs one upload attempt. `onCheckpoint` is handed in so the uploader can
   * report progress that must outlive a failed attempt — see `QueueItem.uploaded`.
   */
  uploadFn: (
    item: QueueItem,
    onCheckpoint: (c: NonNullable<QueueItem["uploaded"]>) => Promise<void>
  ) => Promise<unknown>;
  onDone: (id: string, result: unknown) => void;
  /**
   * Called whenever the queue's contents change — after an enqueue, after each
   * item settles during a drain, and after every completed drain — so the UI
   * can re-read counts. Per-item, not per-pass: on a saturated network a pass
   * over three photos can take minutes, and a guest staring at a thumbnail with
   * no "menunggu" count for that long concludes the photo is lost.
   */
  onChange?: () => void;
  /**
   * Called when an upload is rejected because the guest reached their fair-use
   * allowance. Distinct from a plain failure: the standard "try sending again"
   * notice is wrong advice here, since retrying cannot help.
   */
  onQuota?: () => void;
  /** Injected in tests so backoff windows can be crossed without waiting. */
  now?: () => number;
  /** Returns a multiplier in [0.8, 1.2). Injected in tests for determinism. */
  jitter?: () => number;
  /** Injected in tests. Defaults to setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Whether the device currently has connectivity. Injected in tests; defaults
   * to `navigator.onLine`, treating an absent value as online.
   */
  isOnline?: () => boolean;
}

export class UploadQueue {
  private draining = false;
  private drainRequested = false;
  private stopped = false;
  private now: () => number;
  private jitter: () => number;
  private timer: unknown = null;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (handle: unknown) => void;
  private isOnline: () => boolean;
  // Set when a drain pass could not persist an item's failure record. That
  // item still has a nextAttemptAt in the past, so a reschedule computed from
  // it would be a 0 ms timer and the queue would spin: attempt → fail →
  // refused write → attempt, at tens of Hz offline and at several
  // requests/second against the shared venue presign budget online.
  private bookkeepingFailed = false;

  constructor(private opts: UploadQueueOpts) {
    this.now = opts.now ?? (() => Date.now());
    this.jitter = opts.jitter ?? defaultJitter;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.isOnline = opts.isOnline ?? defaultIsOnline;
  }

  async enqueue(item: Omit<QueueItem, "status" | "attempts" | "nextAttemptAt">): Promise<void> {
    const db = await openDb();
    try {
      await putItem(db, { ...item, status: "pending", attempts: 0, nextAttemptAt: 0 });
    } finally {
      db.close();
    }
    this.opts.onChange?.();
  }

  async cancel(id: string): Promise<void> {
    const db = await openDb();
    try {
      await tx(db, "readwrite", (s) => s.delete(id));
    } finally {
      db.close();
    }
  }

  async pendingCount(): Promise<number> {
    return this.countWhere((i) => i.status === "pending");
  }

  async failedCount(): Promise<number> {
    return this.countWhere((i) => i.status === "failed");
  }

  /**
   * Both counts from one read. getAll() clones every record — photo bytes
   * included — so the UI's onChange handler, which now runs after every item,
   * should pay for that once per change rather than once per count.
   */
  async counts(): Promise<{ pending: number; failed: number }> {
    const db = await openDb();
    try {
      let pending = 0;
      let failed = 0;
      for (const i of await getAll(db)) {
        if (i.status === "pending") pending++;
        else if (i.status === "failed") failed++;
      }
      return { pending, failed };
    } finally {
      db.close();
    }
  }

  /**
   * Every queued item's id, read with getAllKeys() so no record — and no photo
   * bytes — is cloned. The originals queue uses it to spot parked originals
   * whose display item has already left.
   */
  async ids(): Promise<Set<string>> {
    const db = await openDb();
    try {
      const keys = await tx<IDBValidKey[]>(db, "readonly", (s) => s.getAllKeys());
      return new Set(keys.map(String));
    } finally {
      db.close();
    }
  }

  private async countWhere(pred: (i: QueueItem) => boolean): Promise<number> {
    const db = await openDb();
    try {
      return (await getAll(db)).filter(pred).length;
    } finally {
      db.close();
    }
  }

  async drain(): Promise<void> {
    // An explicit drain request re-arms scheduling after a stop(): the caller
    // wants the queue working again, whether or not a drain is already running.
    this.stopped = false;
    if (this.draining) {
      // A drain is running; make it do another pass before it finishes so
      // items enqueued mid-drain are never stranded.
      this.drainRequested = true;
      return;
    }
    this.draining = true;
    try {
      // Rescheduling lives *inside* the guard: scheduleNextDrain() awaits twice
      // before it stores the timer handle, so if `draining` were already false a
      // concurrent drain (online event, fresh capture, our own timer) would run
      // its own scheduleNextDrain, both would call setTimer, and the loser's
      // handle would be untracked — a live timer stop() can never cancel.
      // Because the loop condition is re-tested after scheduling, a request that
      // arrives during the scan is served by another pass instead of being
      // dropped, and that pass reschedules from a fresh scan.
      do {
        this.drainRequested = false;
        await this.drainPass();
        await this.scheduleNextDrain();
      } while (this.drainRequested);
    } finally {
      this.draining = false;
    }
    this.opts.onChange?.();
  }

  // A backed-off item has no other trigger: `online` only fires on a connectivity
  // *change*, so a guest who regains signal without an event — or who simply stops
  // shooting — would otherwise never see the retry happen.
  private async scheduleNextDrain(): Promise<void> {
    this.cancelTimer();
    const db = await openDb();
    let earliest: number | null = null;
    try {
      for (const i of await getAll(db)) {
        if (i.status !== "pending") continue;
        if (earliest === null || i.nextAttemptAt < earliest) earliest = i.nextAttemptAt;
      }
    } finally {
      db.close();
    }
    if (earliest === null) return;
    // Re-checked after the awaits above: a stop() that landed mid-scan means the
    // caller has torn us down, and this timer would fire after teardown.
    if (this.stopped) return;
    let delay = Math.max(0, earliest - this.now());
    if (this.bookkeepingFailed) {
      this.bookkeepingFailed = false;
      delay = Math.max(delay, backoffMs(1, this.jitter));
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      // This is the one drain() call with no user action behind it, so a
      // rejection here (e.g. openDb()/getAll() failing under Safari private
      // mode or storage eviction) has nowhere else to surface. `draining` is
      // still reset by drain()'s own finally, so the queue isn't wedged —
      // but without this catch the rejection would go unhandled *and* the
      // self-rescheduling chain would end silently, with no trace.
      this.drain().catch((err) => {
        console.error("scheduled drain failed:", err);
      });
    }, delay);
  }

  /**
   * Cancels the queue's own wake-up. Also suppresses rescheduling by a drain
   * that is still in flight — a fired timer has already nulled `this.timer`, so
   * clearing the handle alone would let that drain arm a new one after teardown.
   * The next explicit `drain()` re-arms scheduling.
   */
  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * Makes every queued item eligible for upload *right now* — reviving items
   * that gave up (`status: "failed"`) and clearing any outstanding backoff
   * window on items still `pending` — then drains.
   *
   * Both halves are load-bearing. Flipping `failed` → `pending` alone is not
   * enough: `drainPass` only picks up items whose `nextAttemptAt` has passed, so
   * a pending item 15 minutes into its backoff ladder is skipped just as
   * thoroughly as a failed one. Resetting `attempts` restores the full
   * MAX_ATTEMPTS budget, which is the point — the attempts already burned are
   * evidence about a connection that has since changed, not about the photo.
   *
   * This is the single "try everything again now" path. Both triggers use it:
   * the guest's manual retry button, and App.tsx's `online` listener — the
   * moment a venue dead spot ends is exactly when everything deserves another
   * go, and a plain drain() would find nothing eligible and quietly do nothing.
   */
  async retryAllNow(): Promise<void> {
    const db = await openDb();
    try {
      for (const i of await getAll(db)) {
        if (i.status !== "failed" && i.status !== "pending") continue;
        // Already eligible with a full budget — nothing to rewrite.
        if (i.status === "pending" && i.attempts === 0 && i.nextAttemptAt === 0) continue;
        try {
          await putItem(db, { ...i, status: "pending", attempts: 0, nextAttemptAt: 0 });
        } catch (err) {
          // One refused write must not abort the revive of every other photo,
          // nor skip the drain below — this is the reconnect path, and the
          // moment the radio comes back is the worst time to do nothing.
          console.error(`revive failed (id=${i.id}), continuing:`, err);
        }
      }
    } finally {
      db.close();
    }
    await this.drain();
  }

  // One item's attempt. Everything that can throw from the uploader is caught
  // here; only the IndexedDB bookkeeping can reject out of it.
  private async attempt(db: IDBDatabase, item: QueueItem): Promise<void> {
    // Every failure path below re-puts a spread of `item`, which was read
    // before the attempt started. A checkpoint written during the attempt
    // would therefore be clobbered by the very write that records the
    // failure, so hold it here and merge it into each of those writes.
    let uploaded = item.uploaded;
    let result: unknown;
    try {
      result = await this.opts.uploadFn(item, async (c) => {
        uploaded = c;
        await putItem(db, { ...item, uploaded: c });
      });
      await tx(db, "readwrite", (s) => s.delete(item.id));
    } catch (err) {
      // A closed window or a spent quota is not a transient failure —
      // retrying it (even after the backoff ladder) will never succeed,
      // since the server rejects on state, not on connectivity. Fail it
      // immediately instead of burning MAX_ATTEMPTS worth of retries.
      const name = (err as Error)?.name;
      if (name === "WindowClosedError" || name === "QuotaError") {
        console.error(`upload failed (id=${item.id}): ${(err as Error).message}`, err);
        await putItem(db, { ...item, uploaded, status: "failed", attempts: MAX_ATTEMPTS, nextAttemptAt: 0 });
        if (name === "QuotaError") this.opts.onQuota?.();
        return;
      }
      // An upload that failed while the device has no connectivity was a
      // guaranteed failure and is no evidence at all about the photo, so it
      // must not spend one of the MAX_ATTEMPTS. Without this, ~36-55 minutes
      // of open-app use in a venue dead spot burns the whole budget and
      // marks every queued photo `failed`.
      const online = this.isOnline();
      const attempts = online ? item.attempts + 1 : item.attempts;
      const giveUp = attempts >= MAX_ATTEMPTS;
      // Why a photo failed is the one thing worth having in a phone's
      // console at the reception: a 413, a malformed blob and a dead radio
      // are indistinguishable from the guest-facing failure notice alone.
      console.error(
        `upload failed (id=${item.id}, attempt ${attempts}/${MAX_ATTEMPTS}` +
          `${online ? "" : ", offline — attempt not counted"}):`,
        err
      );
      await putItem(db, {
        ...item,
        uploaded,
        attempts,
        status: giveUp ? "failed" : "pending",
        // Advanced even when the attempt was not counted. scheduleNextDrain()
        // derives its delay from this value, so leaving it in the past would
        // compute a zero delay and spin the timer hot against a radio that is
        // still down. Math.max floors an uncounted first failure (attempts
        // still 0) at the 30s base window instead of backoffMs(0)'s 15s; on
        // the counted path `attempts` is always >= 1, so it is a no-op there.
        nextAttemptAt: giveUp ? 0 : this.now() + backoffMs(Math.max(attempts, 1), this.jitter),
      });
      return;
    }
    // Outside the try on purpose. The row is already deleted; a throwing
    // onDone (localStorage refusing the done-counter write, say) used to be
    // caught above as an *upload* failure, which re-put the delivered photo as
    // pending — resurrecting it into an endless "failed, retry" loop.
    try {
      this.opts.onDone(item.id, result);
    } catch (err) {
      console.error(`onDone threw after delivery (id=${item.id}); photo is delivered:`, err);
    }
  }

  private async drainPass(): Promise<void> {
    const db = await openDb();
    try {
      const due = (await getAll(db)).filter(
        (i) => i.status === "pending" && i.nextAttemptAt <= this.now()
      );
      for (const item of due) {
        try {
          await this.attempt(db, item);
        } catch (err) {
          // Only the bookkeeping writes can land here — the upload itself is
          // caught inside attempt(). A store that refuses the write (quota,
          // eviction) used to escape the whole pass: later photos went
          // unattempted and scheduleNextDrain never ran, so the queue sat at
          // "menunggu" with no timer to wake it. Log and move on; the item is
          // still on disk in whatever state the last successful write left it.
          console.error(`queue bookkeeping failed (id=${item.id}), continuing:`, err);
          this.bookkeepingFailed = true;
        } finally {
          this.opts.onChange?.();
        }
      }
    } finally {
      db.close();
    }
  }
}
