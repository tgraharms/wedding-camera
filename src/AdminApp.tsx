import "./admin.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminLogin } from "./screens/admin/AdminLogin";
import { AdminEvents } from "./screens/admin/AdminEvents";
import { ADMIN_PAGE_SIZE } from "./screens/admin/AdminPagination";
import { AdminPhotos } from "./screens/admin/AdminPhotos";
import { AdminWishes } from "./screens/admin/AdminWishes";
import { AdminShare } from "./screens/admin/AdminShare";
import { LoadError } from "./screens/LoadError";
import { withRetry, type RetryOpts } from "./lib/retry";
import { BRAND } from "./config";
import {
  adminLogin,
  adminLogout,
  getAdminEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getAdminPhotos,
  getShareLink,
  regenerateShareLink,
  UnauthorizedError,
} from "./lib/adminClient";
import type { EventInfo, AdminPhoto } from "./lib/types";

type View = "login" | "events" | "photos" | "share" | "wishes";

export default function AdminApp({ retryOpts }: { retryOpts?: RetryOpts } = {}) {
  const [view, setView] = useState<View>("login");
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [checking, setChecking] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const [photos, setPhotos] = useState<AdminPhoto[]>([]);
  const [counts, setCounts] = useState<{ eventId: string; name: string; count: number }[]>([]);
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [groupByGuest, setGroupByGuest] = useState(false);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosError, setPhotosError] = useState("");
  const [photosOpened, setPhotosOpened] = useState(false);
  const [wishesOpened, setWishesOpened] = useState(false);
  type CachedPage = Awaited<ReturnType<typeof getAdminPhotos>> & { savedAt: number };
  const photosCache = useRef(new Map<string, CachedPage>());
  const starRevision = useRef(0);
  const confirmedStars = useRef(new Map<string, { starred: boolean; revision: number }>());
  const requestedPage = useRef({ page: 0, filter: "all", grouped: false });

  const [shareUrl, setShareUrl] = useState("");
  const [starredCount, setStarredCount] = useState(0);

  // Held in a ref so restoreSession keeps a stable identity across renders.
  const retryRef = useRef(retryOpts);
  retryRef.current = retryOpts;

  // Bumped on every loadPhotosPage call; a response only commits if it's
  // still the most recent request when it lands. Guards against a fast
  // filter change racing an earlier, slower page load.
  const photosSeqRef = useRef(0);

  async function loadEvents() {
    setEvents(await getAdminEvents());
    setView("events");
    setLoadFailed(false);
  }

  // Retries transient failures but never a 401 — an expired session won't fix
  // itself, and silently showing the login form for a network blip would tell
  // the couple their session died when it didn't.
  const restoreSession = useCallback(async () => {
    setLoadFailed(false);
    try {
      await withRetry(loadEvents, {
        ...retryRef.current,
        shouldRetry: (e) => !(e instanceof UnauthorizedError),
      });
    } catch (e) {
      if (e instanceof UnauthorizedError) setView("login");
      else setLoadFailed(true);
    } finally {
      setChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Cookie session lasts 7 days; try restoring it instead of forcing re-login.
    void restoreSession();
  }, [restoreSession]);

  async function loadPhotosPage(targetPage: number, filter: string, grouped = groupByGuest, refresh = false) {
    const seq = ++photosSeqRef.current;
    const starsAtRequestStart = starRevision.current;
    requestedPage.current = { page: targetPage, filter, grouped };
    const key = JSON.stringify([filter, grouped, targetPage]);
    if (refresh) photosCache.current.clear();
    setPhotosLoading(true);
    setPhotosError("");
    try {
      const cached = photosCache.current.get(key);
      // Signed image URLs last 24 hours; refresh well before they expire.
      const res = cached && Date.now() - cached.savedAt < 20 * 60 * 60 * 1000
        ? cached
        : { ...await (grouped ? getAdminPhotos(targetPage, filter, true) : getAdminPhotos(targetPage, filter)), savedAt: Date.now() };
      if (seq !== photosSeqRef.current) return;
      const total = res.counts.filter(c => filter === "all" || c.eventId === filter).reduce((n, c) => n + c.count, 0);
      const lastPage = Math.max(0, Math.ceil(total / ADMIN_PAGE_SIZE) - 1);
      if (targetPage > lastPage) { await loadPhotosPage(lastPage, filter, grouped); return; }
      // A read started before a successful star write can return its old value.
      // Preserve only writes completed during this request; later fresh reads
      // can still reflect changes made by another admin.
      const reconciled = res.photos.map(photo => {
        const confirmed = confirmedStars.current.get(photo.id);
        return confirmed && confirmed.revision > starsAtRequestStart
          ? { ...photo, starred: confirmed.starred }
          : photo;
      });
      photosCache.current.set(key, { ...res, photos: reconciled });
      setPhotos(reconciled);
      setCounts(res.counts);
      setPage(targetPage);
      setEventFilter(filter);
      setGroupByGuest(grouped);
    } catch (e) {
      if (seq !== photosSeqRef.current) return;
      console.error("load photos failed:", e);
      setPhotosError("Gambar gagal dimuatkan. Halaman sebelumnya dikekalkan.");
    } finally {
      if (seq === photosSeqRef.current) setPhotosLoading(false);
    }
  }

  function updateCachedStar(id: string, starred: boolean) {
    confirmedStars.current.set(id, { starred, revision: ++starRevision.current });
    for (const cached of photosCache.current.values()) {
      cached.photos = cached.photos.map(photo => photo.id === id ? { ...photo, starred } : photo);
    }
    setPhotos(previous => previous.map(photo => photo.id === id ? { ...photo, starred } : photo));
  }

  async function loadShare() {
    const read = await getShareLink();
    // First ever visit: GET only reads, so mint the token here via POST. This
    // is click-triggered (not an effect), so there's no double-fire to race.
    const link = read.url
      ? { url: read.url, starredCount: read.starredCount }
      : await regenerateShareLink();
    setShareUrl(link.url);
    setStarredCount(link.starredCount);
  }

  if (checking) return <div className="admin-shell admin-loading">Memuatkan…</div>;
  if (loadFailed) return <LoadError onRetry={() => void restoreSession()} />;

  if (view === "login") {
    return (
      <div className="admin-shell admin-login"><AdminLogin
        onLogin={async (u, p) => {
          const result = await adminLogin(u, p);
          if (result !== "ok") return result;
          try {
            await loadEvents();
            return "ok";
          } catch (err) {
            // The cookie is set, but the first load failed — say so rather
            // than leaving the form up with no message.
            console.error("post-login load failed:", err);
            return "error";
          }
        }}
      /></div>
    );
  }

  async function logout() {
    try {
      await adminLogout();
      ++photosSeqRef.current;
      photosCache.current.clear();
      confirmedStars.current.clear();
      setPhotos([]);
      setCounts([]);
      setPage(0);
      setEventFilter("all");
      setGroupByGuest(false);
      setPhotosOpened(false);
      setWishesOpened(false);
      setView("login");
    } catch (e) {
      console.error("logout failed:", e);
    }
  }

  return (
    <div className="admin-shell">
      <header className="admin-header"><div><span className="admin-eyebrow">{BRAND.couple.toUpperCase()}</span><strong>Ruang Admin<span className="admin-dot">.</span></strong></div><button className="admin-quiet" onClick={() => void logout()}>Log Keluar ↗</button></header>
      <nav className="admin-nav" aria-label="Navigasi admin">
        <button aria-current={view === "events" ? "page" : undefined} onClick={() => void loadEvents().catch((e) => console.error("load events failed:", e))}>Acara</button>
        <button aria-current={view === "photos" ? "page" : undefined}
          onClick={() => {
            setView("photos");
            setPhotosOpened(true);
            void loadPhotosPage(page, eventFilter);
          }}
        >
          Gambar
        </button>
        <button aria-current={view === "wishes" ? "page" : undefined} onClick={() => { setWishesOpened(true); setView("wishes"); }}>Ucapan</button>
        <button aria-current={view === "share" ? "page" : undefined}
          onClick={() =>
            void loadShare()
              .then(() => setView("share"))
              .catch((e) => console.error("load share link failed:", e))
          }
        >
          Pautan Kongsi
        </button>

      </nav>

      {view === "events" && (
        <AdminEvents
          events={events}
          onSave={async (patch) => {
            await updateEvent(patch);
            setEvents((prev) =>
              prev.map((e) =>
                e.id === patch.eventId
                  ? {
                      ...e,
                      name: patch.name ?? e.name,
                      windowStart: patch.windowStart ?? e.windowStart,
                      windowEnd: patch.windowEnd ?? e.windowEnd,
                    }
                  : e
              )
            );
          }}
          onDelete={async (eventId) => {
            await deleteEvent(eventId);
            setEvents((prev) => prev.filter((e) => e.id !== eventId));
          }}
          onCreate={async (input) => {
            await createEvent(input);
            setEvents(await getAdminEvents());
          }}
        />
      )}

      {photosOpened && <div hidden={view !== "photos"}>
        {photosError && <div role="alert">{photosError} <button onClick={() => {
          const request = requestedPage.current;
          void loadPhotosPage(request.page, request.filter, request.grouped);
        }}>Cuba semula</button></div>}
        <button className="admin-quiet" disabled={photosLoading} onClick={() => void loadPhotosPage(page, eventFilter, groupByGuest, true)}>Muat semula gambar</button>
        <AdminPhotos
          photos={photos} counts={counts} eventFilter={eventFilter} page={page}
          total={counts.filter(c => eventFilter === "all" || c.eventId === eventFilter).reduce((n, c) => n + c.count, 0)}
          loading={photosLoading} groupByGuest={groupByGuest}
          onFilterChange={id => { void loadPhotosPage(0, id); }}
          onGroupChange={grouped => { void loadPhotosPage(0, eventFilter, grouped); }}
          onPageChange={next => {
            void loadPhotosPage(next, eventFilter).then(() => document.querySelector(".admin-viewbar")?.scrollIntoView?.({ block: "start" }));
          }}
          onStarChange={updateCachedStar}
        />
      </div>}
      {wishesOpened && <div hidden={view !== "wishes"}><AdminWishes /></div>}

      {view === "share" && (
        <AdminShare
          url={shareUrl}
          starredCount={starredCount}
          onRegenerate={async () => {
            const { url, starredCount: count } = await regenerateShareLink();
            setShareUrl(url);
            setStarredCount(count);
          }}
        />
      )}
    </div>
  );
}
