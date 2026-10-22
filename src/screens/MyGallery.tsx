import { useLayoutEffect, useRef, useState } from "react";
import type { MyPhoto, MyProfile } from "../lib/types";
import { Brand } from "../components/Brand";
import { ChevronLeftIcon, DownloadIcon } from "../components/icons";
import { Lightbox } from "../components/Lightbox";
import { savePhotoToDevice } from "../lib/savePhoto";
import { useDownloadState } from "../lib/useDownloadState";
import { BRAND, fileSafe } from "../config";

export function MyGallery(props: {
  photos: MyPhoto[]; profile: MyProfile; hasMore: boolean;
  onSaveProfile: (p: MyProfile) => Promise<void> | void; onLoadMore: () => Promise<void> | void; onBack: () => void;
}) {
  const [displayName, setDisplayName] = useState(props.profile.displayName ?? "");
  const [message, setMessage] = useState(props.profile.message ?? "");
  const [preview, setPreview] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  // Last profile the server confirmed; a Simpan press with nothing new just
  // re-shows "Disimpan" instead of sending again (blur then click is one save).
  const lastSaved = useRef<MyProfile>({ displayName: props.profile.displayName ?? null, message: props.profile.message ?? null });
  const messageRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = messageRef.current;
    if (!field) return;
    const fit = () => {
      field.style.height = "auto";
      // Include the border in the border-box height.
      field.style.height = `${field.scrollHeight + 2}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [message]);
  // `explicit` = the Simpan button. A press always answers, even with nothing
  // new to send; a blur with nothing new stays silent so tabbing through the
  // fields does not flash "Disimpan".
  const save = async (explicit = false) => {
    const p: MyProfile = { displayName: displayName.trim() || null, message: message.trim() || null };
    const unchanged = p.displayName === lastSaved.current.displayName && p.message === lastSaved.current.message;
    if (saveState === "saving") return; // one in flight is enough; blur + click land here together
    if (unchanged && saveState !== "failed") { if (explicit || saveState !== "idle") setSaveState("saved"); return; }
    setSaveState("saving");
    try {
      await props.onSaveProfile(p);
      lastSaved.current = p;
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  };
  const saveStatus =
    saveState === "saving" ? "Menyimpan…" : saveState === "saved" ? "Disimpan ✓" : saveState === "failed" ? "Gagal disimpan, cuba lagi" : "";
  return (
    <div className="page page--gallery guest-album">
      <div className="topbar">
        <button className="btn btn--secondary btn--compact" onClick={props.onBack}>
          <ChevronLeftIcon />
          <span>Kembali</span>
        </button>
        <Brand />
      </div>
      <h1 className="headline headline--sm">{BRAND.gallery}</h1>
      <div className="guest-note">
        <label className="field">
          <span className="field__label">Nama anda</span>
          <input className="field__input" value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} onBlur={() => void save()} />
        </label>
        <label className="field">
          <span className="field__label">Pesanan untuk pengantin</span>
          <textarea ref={messageRef} aria-describedby="wish-count" className="field__input" value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} onBlur={() => void save()} />
        </label>
        <span id="wish-count" className="wish-count">{message.length} / 500</span>
        <div className="save-row">
          <button type="button" className="btn btn--secondary btn--compact" onClick={() => void save(true)}>Simpan</button>
          <span role="status" aria-live="polite" className={`save-status${saveState === "failed" ? " save-status--bad" : ""}`}>{saveStatus}</span>
        </div>
      </div>
      {props.photos.length === 0 ? (
        <p className="grid-empty">Belum ada gambar lagi. Muat naik gambar pertama anda!</p>
      ) : (
        <div className="grid">
          {props.photos.map((p, i) => (
            <div key={p.id} className="grid__cell">
              <button type="button" className="grid__thumb" aria-label={`Buka gambar ${i + 1}`} onClick={() => setPreview(i)}>
                <img src={p.imageUrl} alt="Gambar" loading="lazy" decoding="async" />
              </button>
              <CellDownload index={i} onDownload={() => savePhotoToDevice(p.imageUrl, photoFilename(i))} />
            </div>
          ))}
        </div>
      )}
      <Lightbox
        photos={props.photos} index={preview} hasMore={props.hasMore}
        onClose={() => setPreview(null)} onNavigate={setPreview} onLoadMore={props.onLoadMore}
        download={(p, i) => savePhotoToDevice(p.imageUrl, photoFilename(i))}
      />
      {props.hasMore && (
        <div className="stack">
          <button className="btn btn--secondary" onClick={props.onLoadMore}>Lagi</button>
        </div>
      )}
    </div>
  );
}

const photoFilename = (index: number) => `${BRAND.names.map((n) => fileSafe(n).toLowerCase()).join("-")}-${index + 1}.jpg`;

// Icon-only "save this one" on the Polaroid's white strip; same states as the
// overlay's Muat turun. Lives outside the thumb button (a button cannot nest).
function CellDownload({ index, onDownload }: { index: number; onDownload: () => Promise<void> }) {
  const { state, start } = useDownloadState(onDownload);
  const label = state === "failed" ? `Gagal muat turun gambar ${index + 1}` : `Muat turun gambar ${index + 1}`;
  return (
    <button
      type="button" className={`grid__save${state === "failed" ? " grid__save--bad" : ""}`}
      aria-label={label} title={label} disabled={state === "busy"} aria-busy={state === "busy" || undefined}
      onClick={() => void start()}
    >
      <DownloadIcon />
    </button>
  );
}
