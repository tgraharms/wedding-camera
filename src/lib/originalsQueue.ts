import * as defaultApi from "./apiClient";
import { TerminalUploadError } from "./apiClient";
import { backoffMs, MAX_ATTEMPTS, MAX_BACKOFF_MS } from "./uploadQueue";

// Private originals (2026-10-01): the untouched file a guest picked, sent to
// R2 for the couple's archive after the display copy has registered. Entirely
// best-effort — nothing here may fail, delay or alter the display upload, so
// every public method resolves and only logs. Deliberately separate from
// UploadQueue, which carries the event-day hardening and stays untouched.

// Mirrors ORIGINAL_MAX_BYTES in functions/api/originals/presign.ts.
export const ORIGINAL_MAX_BYTES = 64 * 1024 * 1024;
export const ORIGINALS_DB = "wc-originals";
// The real bound on what originals may hold on the phone: the sum of every
// stored original (parked or released) plus the new one. Past it the original
// is skipped and the archive gets the display copy instead.
export const ORIGINALS_BUDGET_BYTES = 200 * 1024 * 1024;
// An extra guard only. estimate().quota is a policy ceiling the browser derives
// from TOTAL disk, not free space, so on a nearly-full phone this check passes
// while the disk itself is out of room. ORIGINALS_BUDGET_BYTES bounds originals;
// shed() — called by App when the display queue refuses a photo — is what
// guarantees a display copy always wins over a best-effort original.
export const QUOTA_SHARE = 0.5;

const META = "meta";
const BYTES = "bytes";
const OPEN_TIMEOUT_MS = 5_000;

/** Small per-original record; scans read only these, never the bytes. */
export interface OriginalMeta {
  /** The display item's queue id — the link between the two queues. */
  id: string;
  sessionId: string;
  size: number;
  type: string;
  /** null = parked: the display copy has not registered yet. */
  storageKey: string | null;
  attempts: number;
  nextAttemptAt: number;
  addedAt: number;
}

interface StoredBytes {
  bytes: ArrayBuffer;
  type: string;
}

export interface OriginalsApi {
  presignOriginal: (storageKey: string, sessionId: string, size: number) => Promise<{ uploadUrl: string }>;
  putOriginal: (uploadUrl: string, blob: Blob) => Promise<void>;
}

type Estimate = { usage?: number; quota?: number } | undefined;

export interface OriginalsQueueOpts {
  api?: OriginalsApi;
  estimate?: () => Promise<Estimate>;
  now?: () => number;
  jitter?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  isOnline?: () => boolean;
}

// Looked up per call so test spies on the apiClient module take effect.
const liveApi: OriginalsApi = {
  presignOriginal: (...a) => defaultApi.presignOriginal(...a),
  putOriginal: (...a) => defaultApi.putOriginal(...a),
};
const defaultEstimate = async (): Promise<Estimate> =>
  typeof navigator !== "undefined" && navigator.storage?.estimate ? navigator.storage.estimate() : undefined;
const defaultIsOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Set by whichever outcome lands first (timeout, success, error, blocked).
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`originals IndexedDB did not open within ${OPEN_TIMEOUT_MS} ms`));
    }, OPEN_TIMEOUT_MS);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(ORIGINALS_DB, 1);
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META, { keyPath: "id" });
      req.result.createObjectStore(BYTES);
    };
    req.onsuccess = () => {
      // The caller already gave up (timeout or blocked), so nobody else will
      // ever close this late connection.
      if (settled) return req.result.close();
      settled = true;
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error);
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("originals IndexedDB open blocked"));
    };
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function committed(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export class OriginalsQueue {
  private api: OriginalsApi;
  private estimate: () => Promise<Estimate>;
  private now: () => number;
  private jitter: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (handle: unknown) => void;
  private isOnline: () => boolean;
  private isBusy: () => boolean = () => false;
  private draining = false;
  private drainRequested = false;
  private stopped = false;
  private timer: unknown = null;
  /** The record attempt() is uploading right now; shed() spares it. */
  private inFlightId: string | null = null;

  constructor(opts: OriginalsQueueOpts = {}) {
    this.api = opts.api ?? liveApi;
    this.estimate = opts.estimate ?? defaultEstimate;
    this.now = opts.now ?? (() => Date.now());
    this.jitter = opts.jitter ?? (() => 0.8 + Math.random() * 0.4);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.isOnline = opts.isOnline ?? defaultIsOnline;
  }

  /** Parks the original. false = not kept (too big, over budget, no headroom, storage refused). */
  async add(id: string, file: Blob, sessionId: string): Promise<boolean> {
    try {
      if (file.size > ORIGINAL_MAX_BYTES) return false;
      const stored = (await this.records()).reduce((sum, r) => sum + r.size, 0);
      if (stored + file.size > ORIGINALS_BUDGET_BYTES) return false;
      const est = await this.estimate();
      if (typeof est?.usage !== "number" || typeof est?.quota !== "number") return false;
      if (est.usage + file.size > est.quota * QUOTA_SHARE) return false;
      const bytes = await file.arrayBuffer();
      const meta: OriginalMeta = {
        id, sessionId, size: file.size, type: file.type,
        storageKey: null, attempts: 0, nextAttemptAt: 0, addedAt: this.now(),
      };
      await withDb(async (db) => {
        const t = db.transaction([META, BYTES], "readwrite");
        t.objectStore(BYTES).put({ bytes, type: file.type } satisfies StoredBytes, id);
        t.objectStore(META).put(meta);
        await committed(t);
      });
      return true;
    } catch (err) {
      console.error(`original not kept (id=${id}):`, err);
      return false;
    }
  }

  /** The display copy registered under storageKey: the original may now go. */
  async release(id: string, storageKey: string): Promise<void> {
    try {
      await withDb(async (db) => {
        const t = db.transaction(META, "readwrite");
        const store = t.objectStore(META);
        const rec = await request<OriginalMeta | undefined>(store.get(id));
        if (rec) store.put({ ...rec, storageKey, nextAttemptAt: 0 });
        await committed(t);
      });
    } catch (err) {
      console.error(`original release failed (id=${id}):`, err);
    }
  }

  async records(): Promise<OriginalMeta[]> {
    return withDb((db) => request<OriginalMeta[]>(db.transaction(META, "readonly").objectStore(META).getAll()));
  }

  /** Drops parked originals added before `before` whose display item is gone. */
  async reconcile(liveIds: Set<string>, before: number): Promise<void> {
    try {
      const stale = (await this.records()).filter(
        (r) => r.storageKey === null && r.addedAt < before && !liveIds.has(r.id)
      );
      if (stale.length === 0) return;
      await withDb(async (db) => {
        const t = db.transaction([META, BYTES], "readwrite");
        for (const r of stale) {
          t.objectStore(META).delete(r.id);
          t.objectStore(BYTES).delete(r.id);
        }
        await committed(t);
      });
    } catch (err) {
      console.error("originals reconcile failed:", err);
    }
  }

  /**
   * Gives back every byte held for originals, except the one uploading right
   * now (its bytes are already in memory, and it finishes on its own). App
   * calls this when the display queue refuses a photo: a best-effort original
   * must never cost a guest their display copy.
   */
  async shed(): Promise<void> {
    try {
      const all = await this.records();
      await withDb(async (db) => {
        // Read after the scan: an attempt may have started meanwhile.
        const victims = all.filter((r) => r.id !== this.inFlightId);
        if (victims.length === 0) return;
        const t = db.transaction([META, BYTES], "readwrite");
        for (const r of victims) {
          t.objectStore(META).delete(r.id);
          t.objectStore(BYTES).delete(r.id);
        }
        await committed(t);
      });
    } catch (err) {
      console.error("originals shed failed:", err);
    }
  }

  async drain(opts: { isBusy?: () => boolean } = {}): Promise<void> {
    if (opts.isBusy) this.isBusy = opts.isBusy;
    this.stopped = false;
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainRequested = false;
        const end = await this.pass();
        // A pass that yielded to the display queue is re-triggered by App when
        // that queue goes idle; scheduling here would compete with it.
        if (end !== "busy") await this.schedule(end === "offline");
      } while (this.drainRequested);
    } catch (err) {
      console.error("originals drain failed:", err);
    } finally {
      this.draining = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  /**
   * "busy" = stopped early because the display queue became busy; "offline" =
   * stopped before attempting anything because there is no connectivity.
   */
  private async pass(): Promise<"done" | "busy" | "offline"> {
    const due = (await this.records()).filter((r) => r.storageKey !== null && r.nextAttemptAt <= this.now());
    for (const rec of due) {
      if (this.isBusy()) return "busy";
      // An offline attempt can only fail, and it would first clone up to
      // 64 MiB out of IndexedDB for nothing. Stop; schedule() arms the timer,
      // and App's `online` / visibility retries re-trigger a drain sooner.
      if (!this.isOnline()) return "offline";
      await this.attempt(rec);
    }
    return "done";
  }

  private async attempt(rec: OriginalMeta): Promise<void> {
    this.inFlightId = rec.id;
    try {
      // Presign before reading the bytes: a refused or failed presign then
      // costs no byte read at all.
      const { uploadUrl } = await this.api.presignOriginal(rec.storageKey as string, rec.sessionId, rec.size);
      const stored = await withDb((db) =>
        request<StoredBytes | undefined>(db.transaction(BYTES, "readonly").objectStore(BYTES).get(rec.id))
      );
      if (!stored) {
        await this.remove(rec.id);
        return;
      }
      await this.api.putOriginal(uploadUrl, new Blob([stored.bytes], { type: stored.type }));
      await this.remove(rec.id);
    } catch (err) {
      if (err instanceof TerminalUploadError) {
        console.error(`original refused, dropping (id=${rec.id}):`, err);
        await this.remove(rec.id);
        return;
      }
      // Same rule as the display queue: a failure with no connectivity says
      // nothing about the original, so it must not spend an attempt.
      const online = this.isOnline();
      const attempts = online ? rec.attempts + 1 : rec.attempts;
      if (attempts >= MAX_ATTEMPTS) {
        console.error(`original gave up after ${attempts} attempts (id=${rec.id}):`, err);
        await this.remove(rec.id);
        return;
      }
      console.error(
        `original upload failed (id=${rec.id}, attempt ${attempts}/${MAX_ATTEMPTS}${online ? "" : ", offline — not counted"}):`,
        err
      );
      await this.put({ ...rec, attempts, nextAttemptAt: this.now() + backoffMs(Math.max(attempts, 1), this.jitter) });
    } finally {
      this.inFlightId = null;
    }
  }

  private async schedule(offline = false): Promise<void> {
    this.cancelTimer();
    const waiting = (await this.records()).filter((r) => r.storageKey !== null);
    if (waiting.length === 0 || this.stopped) return;
    const earliest = Math.min(...waiting.map((r) => r.nextAttemptAt));
    // Clamped: setTimeout treats anything above 2^31 ms as 0, and a clock that
    // jumps backwards must not produce a days-long (or instant) wake-up.
    let delay = Math.min(Math.max(0, earliest - this.now()), MAX_BACKOFF_MS);
    // An offline pass left its due records due, so the delay above is 0 and
    // the timer would spin against a dead radio. Wait the first backoff rung,
    // what an offline failure cost before offline passes stopped attempting.
    if (offline) delay = Math.max(delay, backoffMs(1, this.jitter));
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.drain();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private remove(id: string): Promise<void> {
    return withDb(async (db) => {
      const t = db.transaction([META, BYTES], "readwrite");
      t.objectStore(META).delete(id);
      t.objectStore(BYTES).delete(id);
      await committed(t);
    });
  }

  private put(rec: OriginalMeta): Promise<void> {
    return withDb(async (db) => {
      const t = db.transaction(META, "readwrite");
      t.objectStore(META).put(rec);
      await committed(t);
    });
  }
}
