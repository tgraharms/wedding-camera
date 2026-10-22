import { useEffect, useRef, useState } from "react";
import type { MyPhoto } from "../lib/types";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon } from "./icons";
import { useDownloadState } from "../lib/useDownloadState";

const SWIPE_PX = 60;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 12;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;

type Zoom = { scale: number; tx: number; ty: number };
const NO_ZOOM: Zoom = { scale: 1, tx: 0, ty: 0 };

type Gesture = {
  startX: number; startY: number; startDist: number; startZoom: Zoom; moved: boolean; fingers: number;
};

const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

export function Lightbox(props: {
  photos: MyPhoto[]; index: number | null; hasMore: boolean;
  onClose: () => void; onNavigate: (index: number) => void; onLoadMore: () => Promise<void> | void;
  download?: (photo: MyPhoto, index: number) => Promise<void>;
}) {
  const { photos, index, hasMore, onClose, onNavigate, onLoadMore, download } = props;
  const { state: downloadState, start: startDownload } = useDownloadState(async () => {
    if (index === null || !download) return;
    await download(photos[index], index);
  });
  const open = index !== null && index >= 0 && index < photos.length;
  const [loading, setLoading] = useState(false);
  const [zoom, setZoomState] = useState<Zoom>(NO_ZOOM);
  // Touch handlers read the ref, never the state: a fast pinch-and-release
  // delivers touchend before React has re-rendered the touchmove's update.
  const zoomRef = useRef<Zoom>(NO_ZOOM);
  const setZoom = (z: Zoom) => { zoomRef.current = z; setZoomState(z); };
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef(0);
  // Set when the guest asked for the photo after the last loaded one; consumed
  // as soon as the next page lands so the overlay slides straight onto it.
  const advanceWhenLoaded = useRef(false);

  const canPrev = open && index > 0;
  const atEnd = open && index === photos.length - 1;
  const canNext = open && !loading && (!atEnd || hasMore);

  useEffect(() => { setZoom(NO_ZOOM); }, [index]);



  useEffect(() => {
    if (!open || !advanceWhenLoaded.current || atEnd) return;
    advanceWhenLoaded.current = false;
    onNavigate(index + 1);
  }, [open, atEnd, index, photos.length, onNavigate]);

  useEffect(() => {
    if (!open) { advanceWhenLoaded.current = false; return; }
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const goPrev = () => { if (canPrev) onNavigate(index - 1); };
  const goNext = async () => {
    if (!canNext) return;
    if (!atEnd) { onNavigate(index + 1); return; }
    advanceWhenLoaded.current = true;
    setLoading(true);
    try { await onLoadMore(); } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") void goNext();
      else if (e.key === "ArrowLeft") goPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches;
    gesture.current = {
      startX: t[0].clientX, startY: t[0].clientY, startDist: t.length > 1 ? dist(t) : 0,
      startZoom: zoomRef.current, moved: false, fingers: t.length,
    };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (!g) return;
    const t = e.touches;
    if (t.length > 1) {
      if (g.fingers < 2) { g.fingers = 2; g.startDist = dist(t); g.startZoom = zoomRef.current; }
      g.moved = true;
      const scale = Math.min(MAX_SCALE, Math.max(1, (g.startZoom.scale * dist(t)) / g.startDist));
      setZoom({ ...g.startZoom, scale });
      return;
    }
    const dx = t[0].clientX - g.startX;
    const dy = t[0].clientY - g.startY;
    if (Math.hypot(dx, dy) > TAP_SLOP_PX) g.moved = true;
    const z = zoomRef.current;
    if (z.scale > 1 && g.fingers === 1) setZoom({ ...z, tx: g.startZoom.tx + dx, ty: g.startZoom.ty + dy });
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (e.touches.length > 0) return; // A finger is still down; keep the gesture alive.
    gesture.current = null;
    const z = zoomRef.current;
    if (g.fingers > 1) { if (z.scale <= 1.02) setZoom(NO_ZOOM); return; }
    const end = e.changedTouches[0];
    const dx = end ? end.clientX - g.startX : 0;
    if (!g.moved) {
      const now = Date.now();
      if (now - lastTap.current < DOUBLE_TAP_MS) {
        lastTap.current = 0;
        setZoom(z.scale > 1 ? NO_ZOOM : { scale: DOUBLE_TAP_SCALE, tx: 0, ty: 0 });
      } else {
        lastTap.current = now;
      }
      return;
    }
    if (z.scale > 1) return; // Panning, not paging.
    if (dx <= -SWIPE_PX) void goNext();
    else if (dx >= SWIPE_PX) goPrev();
  };

  if (!open) return null;
  const photo = photos[index];
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      className="lightbox" role="dialog" aria-modal="true" aria-label="Pratonton gambar"
      onClick={onClose} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}
    >
      <button type="button" className="lightbox__close" aria-label="Tutup" onClick={onClose}><CloseIcon /></button>
      <span className="lightbox__counter">{index + 1} / {photos.length}</span>
      <img
        className="lightbox__img" src={photo.imageUrl} alt="Gambar" draggable={false} onClick={stop}
        style={{ transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})` }}
      />
      <button type="button" className="lightbox__nav lightbox__nav--prev" aria-label="Sebelumnya" disabled={!canPrev}
        onClick={(e) => { stop(e); goPrev(); }}><ChevronLeftIcon /></button>
      {download && (
        <button
          type="button" className="lightbox__download" disabled={downloadState === "busy"}
          aria-busy={downloadState === "busy" || undefined} onClick={(e) => { stop(e); void startDownload(); }}
        >
          <DownloadIcon />
          <span>{downloadState === "busy" ? "Memuat turun…" : downloadState === "failed" ? "Gagal muat turun" : "Muat turun"}</span>
        </button>
      )}
      <button type="button" className="lightbox__nav lightbox__nav--next" aria-label="Seterusnya" disabled={!canNext}
        aria-busy={loading || undefined} onClick={(e) => { stop(e); void goNext(); }}><ChevronRightIcon /></button>
    </div>
  );
}
