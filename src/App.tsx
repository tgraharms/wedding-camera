import { useCallback, useEffect, useRef, useState } from "react";
import { Landing } from "./screens/Landing";
import { MyGallery } from "./screens/MyGallery";
import { LoadError } from "./screens/LoadError";
import { withRetry, type RetryOpts } from "./lib/retry";
import { getSessionId, loadProfile, saveProfileLocal, loadDoneCount, bumpDoneCount, syncDoneCount } from "./lib/session";
import { processImage, UPLOAD_MAX_DIMENSION } from "./lib/imageProcessor";
import { isHeicFile, heicToJpeg } from "./lib/heic";
import { UploadQueue } from "./lib/uploadQueue";
import { OriginalsQueue } from "./lib/originalsQueue";
import { uploadOne } from "./lib/uploadOrchestrator";
import { getStatus, getMyPhotos, saveProfile } from "./lib/apiClient";
import type { StatusInfo, MyPhoto, MyProfile } from "./lib/types";

type Screen = "landing" | "gallery";

const STATUS_POLL_MS = 60_000;

// An unprocessed photo beats a lost photo: if processImage throws on a JPEG
// (a corrupt capture), fall back to enqueuing the original file as-is rather
// than losing it — but only up to a size the upload path can reasonably absorb
// unprocessed. Past that, tell the guest instead of silently dropping their
// photo. Only JPEG qualifies: the storage key is minted as .jpg and the PUT
// declares image/jpeg, so raw HEIC or PNG bytes under that name would be an
// object Android and Chrome cannot render in the gallery.
const PROCESS_FALLBACK_MAX_BYTES = 16 * 1024 * 1024; // mirrors MAX_UPLOAD_BYTES in functions/api/presign.ts

// Every queue call below is fire-and-forget: nothing awaits it and no UI state
// depends on it resolving. An IndexedDB failure (Safari private mode, storage
// eviction) would otherwise become an unhandled rejection with nothing naming
// which call site produced it. Same one-line treatment the queue already applies
// to its own timer-driven drain.
const logFailure = (what: string) => (err: unknown) => {
  console.error(`${what}:`, err);
};

export default function App({ retryOpts }: { retryOpts?: RetryOpts } = {}) {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [screen, setScreen] = useState<Screen>("landing");
  const [doneCount, setDoneCount] = useState(() => loadDoneCount());
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [lastThumbUrl, setLastThumbUrl] = useState<string | null>(null);
  const [processError, setProcessError] = useState(false);
  const [formatError, setFormatError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [quotaReached, setQuotaReached] = useState(false);
  const [photos, setPhotos] = useState<MyPhoto[]>([]);
  const [profile, setProfile] = useState<MyProfile>(() => loadProfile() ?? { displayName: null, message: null });
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);
  const queueRef = useRef<UploadQueue | null>(null);
  const originalsRef = useRef<OriginalsQueue | null>(null);
  // Display-queue pending count, readable from the originals queue's isBusy
  // without re-running effects.
  const pendingRef = useRef(0);

  // Held in a ref so refreshStatus keeps a stable identity — a fresh options
  // object on every render would otherwise re-fire the effects below in a loop.
  const retryRef = useRef(retryOpts);
  retryRef.current = retryOpts;

  // Also held in a ref for the same reason: refreshStatus needs to see the
  // *current* status inside a stable (deps: []) callback, not the one from
  // whatever render closed over it.
  const statusRef = useRef(status);
  statusRef.current = status;

  // `retry` is true only for a first load (and the LoadError button): four
  // attempts are what stand between a venue wifi blip and an error screen.
  // Background polls are single-shot — a failed poll keeps the last-known
  // state anyway, and 200 phones each retrying a poll four times is exactly
  // the extra load an already-struggling API does not need.
  const refreshStatus = useCallback(async ({ retry }: { retry: boolean }) => {
    setLoadFailed(false);
    try {
      const s = retry ? await withRetry(() => getStatus(), retryRef.current) : await getStatus();
      setStatus(s);
    } catch (err) {
      // Only surface the full-screen error when there is no last-known status
      // (the initial load). A poll that fails mid-session — a wifi drop — must
      // not replace the landing screen (and its offline queue / hero button)
      // with LoadError; keep showing the last-known state and log instead.
      if (statusRef.current === null) {
        setLoadFailed(true);
      } else {
        console.error("status refresh failed, keeping last-known state:", err);
      }
    }
  }, []);

  useEffect(() => {
    void refreshStatus({ retry: true });
  }, [refreshStatus]);

  // The window can open/close server-side without any client action, so the
  // guest's screen must re-probe on its own. Not while hidden: a backgrounded
  // tab polling for nobody is pure load, and the visibilitychange handler
  // below refreshes the moment the guest comes back.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshStatus({ retry: false });
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    // Private originals for the couple's archive (2026-10-01). Best-effort:
    // its methods never reject, and it only uploads while the display queue
    // is idle so it never competes with photos the guest is waiting on.
    const originals = new OriginalsQueue();
    originalsRef.current = originals;
    const drainOriginals = () => {
      void originals.drain({ isBusy: () => pendingRef.current > 0 });
    };
    const mountedAt = Date.now();
    const q = new UploadQueue({
      // Not `uploadFn: uploadOne` — uploadOne's second parameter is its API
      // seam, so passing the queue's callback straight through would land the
      // checkpoint in the `api` slot and replace the real client.
      uploadFn: async (item, onCheckpoint) => {
        const result = await uploadOne(item, undefined, onCheckpoint);
        // Cannot throw. A release that fails leaves the original parked;
        // reconcile clears it on a later load. The display copy is delivered.
        await originals.release(item.id, result.storageKey);
        return result;
      },
      onDone: () => {
        setDoneCount(bumpDoneCount());
      },
      onQuota: () => {
        setQuotaReached(true);
      },
      onChange: () => {
        void queueRef.current
          ?.counts()
          .then(({ pending, failed }) => {
            setPendingCount(pending);
            setFailedCount(failed);
            pendingRef.current = pending;
            if (pending === 0) drainOriginals();
          })
          .catch(logFailure("queue count read failed"));
      },
    });
    queueRef.current = q;
    // Regaining connectivity must make *everything* eligible again, not just
    // re-run a drain: a plain drain() only picks up `pending` items whose backoff
    // window has already opened, so items that capped out to `failed` in the dead
    // spot — and pending ones mid-ladder — would never be revisited, and the
    // guest would read "Terima kasih!" over photos still sitting in IndexedDB.
    const onOnline = () => {
      // No direct drainOriginals() here: retryAllNow() flips failed items
      // back to pending without firing onChange, so a drain call made right
      // now would see the stale pre-retry pendingRef and start uploading
      // originals while display retries are still in flight. retryAllNow()
      // always ends in drain(), whose own onChange sees pending === 0 once
      // those retries have genuinely settled and triggers the originals
      // drain then — later, but never racing a display upload.
      //
      // For the same reason, mark the display queue busy before every
      // retryAllNow(): it flips failed→pending without onChange, so until its
      // drain-end onChange reports the real count, pendingRef would read the
      // stale 0 to OriginalsQueue's own backoff timer or an in-flight drain.
      pendingRef.current = Math.max(pendingRef.current, 1);
      void q.retryAllNow().catch(logFailure("reconnect retry failed"));
    };
    window.addEventListener("online", onOnline);
    // iOS Safari frequently never fires `online` after an airplane-mode toggle
    // (seen on-device: queued photos sat "menunggu" for minutes with wifi back,
    // because the ladder had backed off and the instant-retry signal never
    // came). `visibilitychange` IS reliable there, and returning to the app —
    // from the settings toggle, or just unlocking the phone — is a genuine user
    // moment, so spending a fresh attempt budget on it is the right trade. The
    // onLine guard keeps a still-offline unlock from burning attempts.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (navigator.onLine === false) return;
      // Busy until retryAllNow's drain-end onChange reports the real count
      // (see onOnline).
      pendingRef.current = Math.max(pendingRef.current, 1);
      void q.retryAllNow().catch(logFailure("visibility retry failed"));
      void refreshStatus({ retry: false });
    };
    document.addEventListener("visibilitychange", onVisible);
    // Mount stays a plain drain — this effect now runs once (events are
    // server-side, so there's no per-event identity to key it on); `online` is
    // the real connectivity-change signal, a re-render is not.
    void q.drain().catch(logFailure("startup drain failed"));
    // Parked originals whose display item left without a release (the tab
    // died in between). mountedAt spares anything picked during startup.
    void q
      .ids()
      .then((ids) => originals.reconcile(ids, mountedAt))
      .catch(logFailure("originals reconcile failed"));
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      q.stop();
      // stop() alone doesn't guarantee the old instance goes quiet: a
      // retryAllNow() already in flight on `q` ends in its own drain() call,
      // which unconditionally clears q's stopped latch and can arm a fresh
      // timer on this now-discarded instance. Dropping the ref here can't
      // cancel that in-flight promise chain, but it does make onChange's
      // queueRef.current?.failedCount() a no-op once the old instance's
      // trailing work finally resolves, instead of updating state for a
      // queue nobody points to anymore.
      if (queueRef.current === q) queueRef.current = null;
      originals.stop();
      if (originalsRef.current === originals) originalsRef.current = null;
    };
  }, [refreshStatus]);

  // Same path the `online` listener uses — one "make everything eligible and
  // drain" code path, shared by every screen that shows the failure notice.
  const onRetryFailed = () => {
    // retryAllNow flips failed→pending without onChange, so mark the display
    // queue busy until its drain-end onChange reports the real count.
    pendingRef.current = Math.max(pendingRef.current, 1);
    void queueRef.current?.retryAllNow().catch(logFailure("manual retry failed"));
  };

  // Library picks arrive as a batch. Decoding a full-size photo is the
  // memory-heavy step, so run them one at a time — twenty concurrent
  // createImageBitmap calls on a mid-range phone is a tab crash, and a crashed
  // tab loses every photo not yet persisted to the queue.
  const onFiles = async (files: File[]) => {
    for (const file of files) await onFile(file);
  };

  // Native decode first; a HEIC that the browser cannot decode itself goes
  // through the lazily loaded WASM decoder and then the same resize path.
  const toJpeg = async (file: File): Promise<Blob> => {
    try {
      return await processImage(file, { maxDimension: UPLOAD_MAX_DIMENSION });
    } catch (err) {
      if (!isHeicFile(file)) throw err;
      console.warn("native HEIC decode failed, converting with the WASM decoder:", err);
      return processImage(await heicToJpeg(file), { maxDimension: UPLOAD_MAX_DIMENSION });
    }
  };

  const onFile = async (file: File) => {
    // Clear on every new attempt (success or otherwise) rather than leaving a
    // stale error up once the guest tries again.
    setProcessError(false);
    setFormatError(false);
    setSaveError(false);
    const capturedAt = new Date().toISOString();
    let processed: Blob;
    try {
      processed = await toJpeg(file);
    } catch (err) {
      if (file.type !== "image/jpeg") {
        console.error("processImage failed on a non-JPEG file; nothing safe to upload:", err);
        setFormatError(true);
        return;
      }
      if (file.size > PROCESS_FALLBACK_MAX_BYTES) {
        console.error("processImage failed and the original file is too large to fall back to:", err);
        setProcessError(true);
        return;
      }
      console.error("processImage failed, enqueuing the original file unprocessed:", err);
      processed = file;
    }
    const id = crypto.randomUUID();
    // The untouched original, for the couple's archive only — never shown to
    // guests. Parked BEFORE the display copy is queued: once that copy is in
    // the queue, a running drain can deliver it and call release() at once,
    // and release() needs this record to exist. Never throws. Skipped on the
    // unprocessed fallback path, where the display copy IS the original.
    if (processed !== file) await originalsRef.current?.add(id, file, getSessionId());
    // Persist first, paint the thumbnail second. The thumbnail is the guest's
    // most affirmative signal that the photo is safe, so it must never appear
    // for a photo that IndexedDB refused (Safari private mode, storage
    // eviction) — that is exactly how three photos vanished on 2026-09-04.
    const item = { id, eventId: "", blob: processed, metadata: { sessionId: getSessionId(), capturedAt } };
    try {
      try {
        await queueRef.current!.enqueue(item);
      } catch (err) {
        // A best-effort original must never cost a guest their photo. On a
        // nearly full phone the originals parked here (this pick's included)
        // can be what the display copy is missing, so give their space back
        // and try the save once more before telling the guest anything.
        console.error("photo could not be saved to the upload queue; shedding originals and retrying:", err);
        await originalsRef.current?.shed();
        await queueRef.current!.enqueue(item);
      }
    } catch (err) {
      console.error("photo could not be saved to the upload queue:", err);
      setSaveError(true);
      return;
    }
    const thumb = URL.createObjectURL(processed);
    setLastThumbUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return thumb;
    });
    queueRef.current!.drain().catch(logFailure("post-capture drain failed"));
  };

  const loadGalleryPage = async (p: number, append: boolean) => {
    const res = await getMyPhotos(getSessionId(), p);
    setPhotos((prev) => (append ? [...prev, ...res.photos] : res.photos));
    setProfile(res.profile);
    setHasMore(res.hasMore);
    setPage(p);
    setDoneCount(syncDoneCount(res.total));
  };

  const onOpenGallery = () => {
    setScreen("gallery");
    void loadGalleryPage(0, false).catch(logFailure("gallery load failed"));
  };

  const onLoadMore = () =>
    loadGalleryPage(page + 1, true).catch(logFailure("gallery load-more failed"));

  // Local copy first so a failed server save never loses what was typed; the
  // promise is what lets the gallery show "Disimpan" / "Gagal disimpan" honestly.
  const onSaveProfile = (p: MyProfile) => {
    setProfile(p);
    saveProfileLocal(p);
    return saveProfile({ sessionId: getSessionId(), displayName: p.displayName, message: p.message }).catch((err: unknown) => {
      logFailure("profile save failed")(err);
      throw err;
    });
  };

  if (loadFailed) return <LoadError onRetry={() => void refreshStatus({ retry: true })} />;
  if (!status) return <div className="page page--center">Memuatkan…</div>;

  if (screen === "gallery") {
    return (
      <MyGallery
        photos={photos}
        profile={profile}
        hasMore={hasMore}
        onSaveProfile={onSaveProfile}
        onLoadMore={onLoadMore}
        onBack={() => setScreen("landing")}
      />
    );
  }

  return (
    <Landing
      status={status}
      counts={{ done: doneCount, pending: pendingCount, failed: failedCount }}
      lastThumbUrl={lastThumbUrl}
      processError={processError}
      formatError={formatError}
      saveError={saveError}
      quotaReached={quotaReached}
      onFiles={(fs) => void onFiles(fs).catch(logFailure("capture failed"))}
      onRetryFailed={onRetryFailed}
      onOpenGallery={onOpenGallery}
    />
  );
}
