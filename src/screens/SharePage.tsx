import { useEffect, useState } from "react";
import { getShare } from "../lib/apiClient";
import type { MyPhoto } from "../lib/types";
import { Brand } from "../components/Brand";

// Public, unlisted curated-share view — no auth, no retry loop. Any failure
// (404 for a wrong/absent token, or a genuine network error) collapses to the
// same message so a bad link doesn't look different from a network blip.
export function SharePage({ token }: { token: string }) {
  const [photos, setPhotos] = useState<MyPhoto[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPhotos(null);
    setFailed(false);
    getShare(token)
      .then((res) => {
        if (!cancelled) setPhotos(res.photos);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (failed) {
    return (
      <div className="page">
        <Brand />
        <p className="sub grid-empty">Pautan tidak sah.</p>
      </div>
    );
  }
  if (!photos) return <div className="page page--center">Memuatkan…</div>;

  return (
    <div className="page">
      <Brand />
      <h1 className="headline headline--sm">Detik-detik pilihan kami ❤️</h1>
      <div className="grid">
        {photos.map((p) => (
          <img key={p.id} src={p.imageUrl} alt="Gambar" loading="lazy" decoding="async" />
        ))}
      </div>
    </div>
  );
}
