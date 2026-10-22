import { AdminPagination, ADMIN_PAGE_SIZE } from "./AdminPagination";
import { useEffect, useRef, useState } from "react";
import { setStarred, getAdminPhotos } from "../../lib/adminClient";
import { downloadGalleryZip } from "../../lib/zip";
import type { AdminPhoto } from "../../lib/types";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function PhotoDetail({ photo, onClose }: { photo: AdminPhoto; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal?.();
    return () => element?.close?.();
  }, []);
  return (
    <dialog ref={dialog} open={typeof HTMLDialogElement.prototype.showModal !== "function" || undefined} className="admin-photo-dialog" aria-label="Butiran gambar" onCancel={onClose} onClick={e => {
      if (e.target !== e.currentTarget) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
    }}>
      <div className="admin-dialog-bar"><span>{photo.eventName}</span><button onClick={onClose}>Tutup ×</button></div>
      <img src={photo.imageUrl} alt={photo.guestName ?? "Tanpa nama"} />
      <div className="admin-dialog-caption"><h3>{photo.guestName ?? "Tanpa nama"}</h3>
      {photo.message && <p>{photo.message}</p>}
      <p>{formatTime(photo.capturedAt)}</p></div>
    </dialog>
  );
}

export function AdminPhotos({
  photos,
  counts,
  eventFilter,
  page, total, loading = false, groupByGuest, onGroupChange, onStarChange,
  onFilterChange,
  onPageChange,
}: {
  photos: AdminPhoto[];
  counts: { eventId: string; name: string; count: number }[];
  eventFilter: string;
  page: number; total: number; loading?: boolean;
  groupByGuest: boolean; onGroupChange: (group: boolean) => void;
  onStarChange?: (id: string, starred: boolean) => void;
  onFilterChange: (eventId: string) => void;
  onPageChange: (page: number) => void;
}) {
  const [layout, setLayout] = useState<"grid" | "dense" | "list">("grid");
  const [fit, setFit] = useState(false);
  const [starError, setStarError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [selected, setSelected] = useState<AdminPhoto | null>(null);
  // Keep optimistic feedback local; confirmed values update every cached page.
  const [pendingStars, setPendingStars] = useState<Set<string>>(new Set());
  const starLocks = useRef(new Set<string>());
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // The ZIP must contain every photo in the current filter, not just the
  // current page — otherwise a 1,600-photo
  // gallery silently downloads as 60. So this walks every page itself.
  const [downloading, setDownloading] = useState(false);
  const [fetchedCount, setFetchedCount] = useState(0);

  async function toggleStar(photo: AdminPhoto) {
    if (starLocks.current.has(photo.id)) return;
    starLocks.current.add(photo.id);
    setPendingStars(new Set(starLocks.current));
    setStarError("");
    const current = overrides[photo.id] ?? photo.starred;
    const next = !current;
    setOverrides((prev) => ({ ...prev, [photo.id]: next }));
    try {
      await setStarred(photo.id, next);
      onStarChange?.(photo.id, next);
      if (onStarChange) setOverrides(previous => {
        const nextOverrides = { ...previous }; delete nextOverrides[photo.id]; return nextOverrides;
      });
    } catch {
      setStarError("Bintang gagal disimpan. Sila cuba lagi.");
      setOverrides((prev) => ({ ...prev, [photo.id]: current }));
    } finally {
      starLocks.current.delete(photo.id);
      setPendingStars(new Set(starLocks.current));
    }
  }

  async function downloadAll() {
    if (downloading) return;
    setDownloadError("");
    setDownloading(true);
    setFetchedCount(0);
    try {
      const all: AdminPhoto[] = [];
      let p = 0;
      for (;;) {
        const res = await getAdminPhotos(p, eventFilter);
        all.push(...res.photos);
        setFetchedCount(all.length);
        if (!res.hasMore) break;
        p += 1;
      }
      const eventName = eventFilter === "all" ? "Semua" : counts.find((c) => c.eventId === eventFilter)?.name ?? eventFilter;
      await downloadGalleryZip(all, `${eventName}.zip`);
    } catch {
      setDownloadError("Muat turun gagal. Sila cuba lagi.");
    } finally {
      setDownloading(false);
    }
  }

  const groups = new Map<string, AdminPhoto[]>();
  for (const photo of photos) {
    const key = groupByGuest ? photo.guestId ?? photo.id : "all";
    groups.set(key, [...(groups.get(key) ?? []), photo]);
  }
  const pagination = <AdminPagination page={page} total={total} loading={loading} onChange={onPageChange} />;
  return (
    <div className="admin-section" aria-busy={loading}>
      <div className="admin-title"><div><span className="admin-eyebrow">DI SEBALIK LENSA</span><h2>Gambar</h2><p>Semua momen, dalam satu tempat. Bintangkan kegemaran anda.</p></div><span className="admin-count">{total} gambar</span></div>
      <div className="admin-photo-toolbar admin-panel"><div className="admin-filter">
      <label htmlFor="event-filter">Tapis mengikut acara</label>
      <select disabled={loading} id="event-filter" value={eventFilter} onChange={(e) => onFilterChange(e.target.value)}>
        <option value="all">Semua</option>
        {counts.map((c) => (
          <option key={c.eventId} value={c.eventId}>
            {c.name} ({c.count})
          </option>
        ))}
      </select>
      </div><label className="admin-fit"><input type="checkbox" checked={groupByGuest} disabled={loading} onChange={e => onGroupChange(e.target.checked)} />Kumpul mengikut tetamu</label><button onClick={() => void downloadAll()} disabled={downloading}>
        {downloading ? `Menyediakan ZIP… (${fetchedCount}/…)` : "Muat Turun Semua (ZIP)"}
      </button>
      </div>
      {downloadError && <p role="alert">{downloadError}</p>}
      <div className="admin-viewbar"><span>{photos.length ? page * ADMIN_PAGE_SIZE + 1 : 0}–{photos.length ? page * ADMIN_PAGE_SIZE + photos.length : 0} daripada {total} gambar</span><div className="admin-view-options"><label className="admin-fit"><input type="checkbox" checked={fit} onChange={e => setFit(e.target.checked)} />Gambar penuh</label><div className="admin-segment" role="group" aria-label="Paparan gambar">{([['grid', 'Grid'], ['dense', 'Padat'], ['list', 'Senarai']] as const).map(([value, label]) => <button key={value} aria-pressed={layout === value} onClick={() => setLayout(value)}>{label}</button>)}</div></div></div>
      {starError && <p role="alert">{starError}</p>}
      {loading && <p role="status">Memuatkan halaman…</p>}
      {groupByGuest && <p>Gambar dikumpulkan mengikut profil tetamu. Kumpulan yang besar bersambung ke halaman seterusnya.</p>}
      {pagination}
      {!loading && photos.length === 0 && <div className="admin-empty">Belum ada gambar untuk acara ini.</div>}
      {[...groups].map(([key, group]) => <section key={key} className="admin-guest-group">
      {groupByGuest && <div className="admin-group-title"><h3>{group[0].guestName ?? "Tanpa nama"}</h3><span>{group.length} gambar pada halaman ini</span></div>}
      <ul className={`admin-photos admin-photos--${layout}${fit ? " admin-photos--fit" : ""}`}>
        {group.map((p) => {
          const starred = overrides[p.id] ?? p.starred;
          const label = p.guestName ?? "Tanpa nama";
          return (
            <li key={p.id} className="admin-photo-card">
              <button className="admin-photo-open" aria-label={`Buka gambar ${label}`} onClick={() => setSelected(p)}><img src={p.imageUrl} alt={label} loading="lazy" decoding="async" /></button>
              <div className="admin-photo-meta"><strong>{label}</strong><span>{p.eventName} · {formatTime(p.capturedAt)}</span>{layout === "list" && p.message && <p>{p.message}</p>}</div>
              <button className={`admin-star${starred ? " is-starred" : ""}`} aria-pressed={starred} disabled={pendingStars.has(p.id)}
                aria-label={starred ? `Nyahbintang ${label}` : `Bintang ${label}`}
                onClick={() => void toggleStar(p)}
              >
                {starred ? "★" : "☆"}
              </button>
            </li>
          );
        })}
      </ul></section>)}
      {pagination}
      {selected && <PhotoDetail photo={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
