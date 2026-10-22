import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  OriginalsQueue, ORIGINAL_MAX_BYTES, ORIGINALS_BUDGET_BYTES, ORIGINALS_DB, type OriginalsQueueOpts,
} from "./originalsQueue";
import { TerminalUploadError } from "./apiClient";
import { BASE_BACKOFF_MS, MAX_ATTEMPTS, MAX_BACKOFF_MS } from "./uploadQueue";

const roomy = async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 });
const idle = { isBusy: () => false };
const file = (bytes = "orig-bytes", type = "image/heic") => new Blob([bytes], { type });

function makeQueue(over: Partial<OriginalsQueueOpts> = {}) {
  let t = 1_000_000;
  const api = {
    presignOriginal: vi.fn().mockResolvedValue({ uploadUrl: "https://r2/put" }),
    putOriginal: vi.fn().mockResolvedValue(undefined),
  };
  const setTimer = vi.fn(() => 0);
  const q = new OriginalsQueue({
    api, estimate: roomy, now: () => t, jitter: () => 1, setTimer, clearTimer: () => {}, isOnline: () => true,
    ...over,
  });
  return { q, api, setTimer, advance: (ms: number) => { t += ms; }, now: () => t };
}

// Count of rows in the bytes store, read straight from IndexedDB.
async function bytesRows(): Promise<number> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(ORIGINALS_DB, 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  try {
    return await new Promise<number>((res, rej) => {
      const r = db.transaction("bytes", "readonly").objectStore("bytes").count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } finally {
    db.close();
  }
}

beforeEach(() => {
  indexedDB.deleteDatabase(ORIGINALS_DB);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("OriginalsQueue", () => {
  it("parks an added original and never uploads it before release", async () => {
    const { q, api } = makeQueue();
    expect(await q.add("a", file(), "sess-1")).toBe(true);
    await q.drain(idle);
    expect(api.presignOriginal).not.toHaveBeenCalled();
    expect(await q.records()).toEqual([
      expect.objectContaining({ id: "a", sessionId: "sess-1", size: 10, type: "image/heic", storageKey: null, attempts: 0 }),
    ]);
  });

  it("after release, uploads the exact bytes and clears both stores", async () => {
    const { q, api } = makeQueue();
    await q.add("a", file(), "sess-1");
    await q.release("a", "e1/k.jpg");
    await q.drain(idle);
    expect(api.presignOriginal).toHaveBeenCalledWith("e1/k.jpg", "sess-1", 10);
    const [url, blob] = api.putOriginal.mock.calls[0] as [string, Blob];
    expect(url).toBe("https://r2/put");
    expect(blob.type).toBe("image/heic");
    expect(await blob.text()).toBe("orig-bytes");
    expect(await q.records()).toEqual([]);
    expect(await bytesRows()).toBe(0);
  });

  it("release without a record is a no-op", async () => {
    const { q } = makeQueue();
    await expect(q.release("ghost", "e1/k.jpg")).resolves.toBeUndefined();
    expect(await q.records()).toEqual([]);
  });

  it("stops the pass as soon as the display queue is busy", async () => {
    const { q, api } = makeQueue();
    for (const id of ["a", "b"]) {
      await q.add(id, file(), "sess-1");
      await q.release(id, `e1/${id}.jpg`);
    }
    const isBusy = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await q.drain({ isBusy });
    expect(api.putOriginal).toHaveBeenCalledTimes(1);
    expect(await q.records()).toHaveLength(1);
  });

  it("backs off after a transient failure and succeeds on a later pass", async () => {
    const { q, api, advance, now, setTimer } = makeQueue();
    api.putOriginal.mockRejectedValueOnce(new Error("network"));
    await q.add("a", file(), "sess-1");
    await q.release("a", "e1/k.jpg");
    await q.drain(idle);
    expect(await q.records()).toEqual([expect.objectContaining({ attempts: 1, nextAttemptAt: now() + BASE_BACKOFF_MS })]);
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), BASE_BACKOFF_MS);
    await q.drain(idle);
    expect(api.putOriginal).toHaveBeenCalledTimes(1);
    advance(BASE_BACKOFF_MS);
    await q.drain(idle);
    expect(api.putOriginal).toHaveBeenCalledTimes(2);
    expect(await q.records()).toEqual([]);
  });

  it("does not count a failure while offline, but still backs off", async () => {
    // Online when the attempt starts (an offline pass never attempts), and the
    // connection drops mid-upload.
    const { q, api, now } = makeQueue({ isOnline: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) });
    api.putOriginal.mockRejectedValueOnce(new Error("offline"));
    await q.add("a", file(), "sess-1");
    await q.release("a", "e1/k.jpg");
    await q.drain(idle);
    expect(await q.records()).toEqual([expect.objectContaining({ attempts: 0, nextAttemptAt: now() + BASE_BACKOFF_MS })]);
  });

  // Reads of the bytes store, i.e. a photo's worth of bytes cloned into memory.
  const bytesReads = (get: { mock: { contexts: unknown[] } }) =>
    get.mock.contexts.filter((store) => (store as IDBObjectStore).name === "bytes").length;

  // An offline attempt can only fail; reading up to 64 MiB for it, every 30 s
  // while the display queue sits idle, is pure waste on the guest's phone.
  it("does not attempt while offline: no presign, no byte read, and a timer is armed", async () => {
    let online = true;
    const { q, api, setTimer } = makeQueue({ isOnline: () => online });
    await q.add("a", file(), "sess-1");
    await q.release("a", "e1/k.jpg");
    online = false;
    const get = vi.spyOn(IDBObjectStore.prototype, "get");
    await q.drain(idle);
    expect(api.presignOriginal).not.toHaveBeenCalled();
    expect(api.putOriginal).not.toHaveBeenCalled();
    expect(bytesReads(get)).toBe(0);
    // The record is still due, so the plain delay would be 0 and the timer
    // would spin against a dead radio: it waits the first backoff rung.
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), BASE_BACKOFF_MS);
    expect(await q.records()).toEqual([expect.objectContaining({ id: "a", attempts: 0, nextAttemptAt: 0 })]);
  });

  it("a presign failure never reads the bytes store", async () => {
    const { q, api } = makeQueue();
    api.presignOriginal.mockRejectedValueOnce(new Error("network"));
    await q.add("a", file(), "sess-1");
    await q.release("a", "e1/k.jpg");
    const get = vi.spyOn(IDBObjectStore.prototype, "get");
    await q.drain(idle);
    expect(api.presignOriginal).toHaveBeenCalledTimes(1);
    expect(api.putOriginal).not.toHaveBeenCalled();
    expect(bytesReads(get)).toBe(0);
    expect(await q.records()).toEqual([expect.objectContaining({ attempts: 1 })]);
  });

  it("drops the original when the server refuses it for good", async () => {
    const { q, api } = makeQueue();
    api.presignOriginal.mockRejectedValueOnce(new TerminalUploadError("original presign refused: 404"));
    await q.add("a", file(), "sess-1");
    await q.release("a", "e1/k.jpg");
    await q.drain(idle);
    expect(api.putOriginal).not.toHaveBeenCalled();
    expect(await q.records()).toEqual([]);
    expect(await bytesRows()).toBe(0);
  });

  it("gives up after MAX_ATTEMPTS counted failures", async () => {
    const { q, api, advance } = makeQueue();
    api.putOriginal.mockRejectedValue(new Error("network"));
    await q.add("a", file(), "sess-1");
    await q.release("a", "e1/k.jpg");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await q.drain(idle);
      advance(MAX_BACKOFF_MS * 2);
    }
    expect(api.putOriginal).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(await q.records()).toEqual([]);
  });

  it("skips files over ORIGINAL_MAX_BYTES without reading them", async () => {
    const { q } = makeQueue();
    const huge = file();
    Object.defineProperty(huge, "size", { value: ORIGINAL_MAX_BYTES + 1 });
    const read = vi.spyOn(huge, "arrayBuffer");
    expect(await q.add("a", huge, "sess-1")).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(await q.records()).toEqual([]);
  });

  // An extra guard beside the byte budget: never let originals push usage past
  // half the origin quota. (Not a free-space check — see QUOTA_SHARE.)
  it("skips an original that would push usage past half the quota", async () => {
    const tight = makeQueue({ estimate: async () => ({ usage: 495, quota: 1000 }) });
    expect(await tight.q.add("a", file(), "sess-1")).toBe(false);
    const fine = makeQueue({ estimate: async () => ({ usage: 400, quota: 1000 }) });
    expect(await fine.q.add("b", file(), "sess-1")).toBe(true);
  });

  // estimate().quota is a policy ceiling derived from TOTAL disk, not free
  // space, so the quota share alone cannot protect a nearly-full phone. The
  // byte budget is what actually bounds originals.
  it("skips an original that would push stored originals past ORIGINALS_BUDGET_BYTES", async () => {
    const { q } = makeQueue();
    const sized = (mib: number) => {
      const f = file();
      Object.defineProperty(f, "size", { value: mib * 1024 * 1024 });
      return f;
    };
    expect(ORIGINALS_BUDGET_BYTES).toBe(200 * 1024 * 1024);
    for (const id of ["a", "b", "c"]) expect(await q.add(id, sized(60), "sess-1")).toBe(true);
    await q.release("c", "e1/c.jpg"); // released records still count
    expect(await q.add("over", sized(21), "sess-1")).toBe(false); // 180 + 21 > 200
    expect(await q.add("fits", sized(20), "sess-1")).toBe(true); // 180 + 20 = 200
    expect(await q.add("full", sized(1), "sess-1")).toBe(false);
    expect((await q.records()).map((r) => r.id).sort()).toEqual(["a", "b", "c", "fits"]);
  });

  it("skips when the browser cannot report a storage estimate", async () => {
    expect(await makeQueue({ estimate: async () => undefined }).q.add("a", file(), "sess-1")).toBe(false);
    expect(await makeQueue({ estimate: async () => { throw new Error("no"); } }).q.add("b", file(), "sess-1")).toBe(false);
  });

  it("reconcile removes only old parked originals whose display item is gone", async () => {
    const { q, advance, now } = makeQueue();
    await q.add("orphan", file(), "sess-1");
    await q.add("live", file(), "sess-1");
    await q.add("released", file(), "sess-1");
    await q.release("released", "e1/r.jpg");
    advance(1000);
    const mountedAt = now();
    advance(1000);
    await q.add("fresh", file(), "sess-1"); // parked during startup, display not queued yet
    await q.reconcile(new Set(["live"]), mountedAt);
    expect((await q.records()).map((r) => r.id).sort()).toEqual(["fresh", "live", "released"]);
    expect(await bytesRows()).toBe(3);
  });

  // App calls shed() when the display queue refuses a photo: every byte held
  // for an original is given back so the display copy can be saved.
  it("shed deletes every stored original, parked or released", async () => {
    const { q, api } = makeQueue();
    await q.add("parked", file(), "sess-1");
    await q.add("released", file(), "sess-1");
    await q.release("released", "e1/r.jpg");
    await q.shed();
    expect(await q.records()).toEqual([]);
    expect(await bytesRows()).toBe(0);
    await q.drain(idle);
    expect(api.presignOriginal).not.toHaveBeenCalled();
  });

  it("shed spares the original that is uploading right now", async () => {
    const { q, api } = makeQueue();
    let finishPut!: () => void;
    api.putOriginal.mockImplementationOnce(() => new Promise<void>((r) => { finishPut = r; }));
    await q.add("uploading", file(), "sess-1");
    await q.release("uploading", "e1/u.jpg");
    await q.add("waiting", file(), "sess-1");
    await q.release("waiting", "e1/w.jpg");
    await q.add("parked", file(), "sess-1");
    const draining = q.drain({ isBusy: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) });
    await vi.waitFor(() => expect(api.putOriginal).toHaveBeenCalledTimes(1));
    await q.shed();
    expect((await q.records()).map((r) => r.id)).toEqual(["uploading"]);
    expect(await bytesRows()).toBe(1);
    finishPut();
    await draining;
    expect(api.presignOriginal).toHaveBeenCalledWith("e1/u.jpg", "sess-1", 10);
    expect(await q.records()).toEqual([]);
  });

  it("never rejects when IndexedDB is unavailable", async () => {
    const { q } = makeQueue();
    vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new Error("blocked"); });
    await expect(q.add("a", file(), "sess-1")).resolves.toBe(false);
    await expect(q.release("a", "e1/k.jpg")).resolves.toBeUndefined();
    await expect(q.reconcile(new Set(), 0)).resolves.toBeUndefined();
    await expect(q.drain(idle)).resolves.toBeUndefined();
    await expect(q.shed()).resolves.toBeUndefined();
  });

  // The 5 s open timeout must not outlive an open() that never started.
  it("leaves no pending timer when indexedDB.open throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      const { q } = makeQueue();
      vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new Error("blocked"); });
      await expect(q.release("a", "e1/k.jpg")).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // setTimeout treats any delay above 2^31 ms as 0, which would spin.
  it("clamps the self-reschedule to MAX_BACKOFF_MS even if the clock jumps back", async () => {
    const { q, api, advance, setTimer } = makeQueue();
    api.putOriginal.mockRejectedValueOnce(new Error("network"));
    await q.add("a", file(), "sess-1");
    await q.release("a", "e1/k.jpg");
    await q.drain(idle);
    advance(-30 * 24 * 60 * 60_000);
    await q.drain(idle);
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), MAX_BACKOFF_MS);
  });
});
