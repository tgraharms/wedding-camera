import { useRef, useState } from "react";
import type { StatusInfo } from "../lib/types";
import { Brand } from "../components/Brand";
import { GalleryIcon, HeartIcon, UploadIcon } from "../components/icons";
import { BRAND } from "../config";
import heroImg from "../assets/hero.webp";

export function Landing(props: {
  status: StatusInfo;
  counts: { done: number; pending: number; failed: number };
  lastThumbUrl: string | null;
  processError?: boolean;
  formatError?: boolean;
  saveError?: boolean;
  quotaReached?: boolean;
  onFiles: (files: File[]) => void;
  onRetryFailed: () => void;
  onOpenGallery: () => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const { status, counts } = props;
  const [hasSelectedPhoto, setHasSelectedPhoto] = useState(false);
  const hasSentAny = hasSelectedPhoto || !!props.lastThumbUrl ||
    counts.done + counts.pending + counts.failed > 0;
  const needsFirstPhoto = !hasSentAny && !props.quotaReached;
  // The gallery reads uploaded photos, so a queued photo is not viewable yet.
  const hasGalleryPhoto = counts.done > 0;

  const selectFiles = (files: File[]) => {
    if (files.length === 0) return;
    setHasSelectedPhoto(true);
    props.onFiles(files);
  };
  return (
    <div className="page page--landing guest-album">
      <Brand />
      <h1 className="headline">
        {BRAND.headline}
        <span className="headline__heart"><HeartIcon filled /></span>
      </h1>
      <p className="sub">{status.state === "ended" ? BRAND.subEnded : BRAND.sub}</p>

      <img className="hero-img" src={heroImg} alt="" width={960} height={1008} decoding="async" fetchPriority="high" />

      <div className="status">
        {props.lastThumbUrl && <img className="status__thumb" src={props.lastThumbUrl} alt="" width={48} />}
        {props.processError && <p>Gambar gagal diproses. Sila cuba pilih semula.</p>}
        {props.formatError && (
          <p data-testid="format-error">Format gambar ini tidak disokong. Sila pilih gambar lain.</p>
        )}
        {props.saveError && (
          <p data-testid="save-error">Gambar tidak dapat disimpan. Sila cuba pilih semula.</p>
        )}
        {counts.done > 0 && <span className="status__chip status__chip--ok">{counts.done} gambar dihantar ✓</span>}
        {counts.pending > 0 && <span className="status__chip status__chip--pending">{counts.pending} menunggu…</span>}
        {/* Retrying cannot clear a spent allowance, so this replaces the retry
            notice rather than sitting alongside it. */}
        {props.quotaReached ? (
          <p data-testid="quota-notice">
            Anda telah menghantar jumlah maksimum gambar. Terima kasih banyak! ❤️
          </p>
        ) : (
          counts.failed > 0 && (
            <span className="status__chip status__chip--failed">
              {counts.failed} gambar gagal dihantar.{" "}
              <button className="btn-link" onClick={props.onRetryFailed}>Cuba Hantar Semula</button>
            </span>
          )
        )}
      </div>

      <div className="actions">
        {status.state === "open" ? (
          <>
            {/* Upload week (2026-10-01): guests send photos they already took,
                so the library picker is the only way in. No `capture` (that is
                what forces the camera on iOS) and a plain image/* accept, which
                is what makes iOS Safari hand over JPEG instead of HEIC for most
                photos. */}
            <input
              ref={uploadRef}
              data-testid="upload-input"
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                selectFiles(files);
                e.target.value = ""; // same photo twice must still fire onChange
              }}
            />
            <button className={`btn btn--primary${needsFirstPhoto ? " btn--first-photo" : ""}`} onClick={() => uploadRef.current?.click()}>
              <UploadIcon />
              <span>{hasSentAny ? BRAND.uploadMore : BRAND.upload}</span>
            </button>
          </>
        ) : status.state === "before" ? (
          <p className="event-notice">{BRAND.before}</p>
        ) : (
          <p className="event-notice">{BRAND.ended}</p>
        )}
        <div className="secondary-actions">
          <button className="btn btn--secondary" disabled={!hasGalleryPhoto} onClick={props.onOpenGallery}>
            <GalleryIcon />
            <span>{BRAND.gallery}</span>
          </button>
        </div>
      </div>

    </div>
  );
}
