import { useState } from "react";

export function AdminShare({
  url,
  starredCount,
  onRegenerate,
}: {
  url: string;
  starredCount: number;
  onRegenerate: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
  }

  async function regenerate() {
    if (!confirm("Jana semula pautan kongsi? Pautan lama akan berhenti berfungsi.")) return;
    setError(null);
    setCopied(false);
    try {
      await onRegenerate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "gagal menjana semula");
    }
  }

  return (
    <div className="admin-section admin-share">
      <div className="admin-title"><div><span className="admin-eyebrow">KENANGAN PILIHAN</span><h2>Pautan Kongsi</h2><p>Satu pautan untuk gambar yang anda bintangkan.</p></div></div><div className="admin-panel admin-share-card">
      <label htmlFor="share-url">Pautan kongsi</label>
      <input id="share-url" readOnly value={url} />
      <button onClick={() => void copy()}>Salin</button>
      {copied && <p>Disalin!</p>}
      <button className="admin-quiet" onClick={() => void regenerate()}>Jana Semula</button>
      {error && <p role="alert">{error}</p>}
      <p>Gambar berbintang: {starredCount}</p>
    </div></div>
  );
}
