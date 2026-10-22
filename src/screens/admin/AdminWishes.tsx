import { useEffect, useRef, useState } from "react";
import { getAdminWishes } from "../../lib/adminClient";
import type { AdminWish } from "../../lib/types";
import { AdminPagination } from "./AdminPagination";
import { BRAND, fileSafe } from "../../config";

export function AdminWishes() {
  const [wishes, setWishes] = useState<AdminWish[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const sequence = useRef(0);
  async function load() {
    const seq = ++sequence.current;
    setLoading(true); setError("");
    try {
      const result = await getAdminWishes();
      if (sequence.current === seq) { setWishes(result); setPage(0); }
    } catch {
      if (sequence.current === seq) setError("Ucapan gagal dimuatkan. Sila cuba lagi.");
    } finally { if (sequence.current === seq) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { sequence.current++; }; }, []);
  const filtered = wishes.filter(wish => `${wish.guestName ?? "Tanpa nama"} ${wish.message}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  function download() {
    const text = `UCAPAN UNTUK ${BRAND.couple.toUpperCase()}\n${wishes.length} ucapan\n\n` + wishes.map(wish => `${wish.guestName ?? "Tanpa nama"}\n${wish.message}`).join("\n\n────────────────────\n\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `Ucapan-${fileSafe(BRAND.couple)}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="admin-section" aria-busy={loading}>
    <div className="admin-title"><div><span className="admin-eyebrow">KATA-KATA UNTUK DIKENANG</span><h2>Ucapan</h2><p>Semua pesanan tetamu, dikumpulkan satu kali bagi setiap profil.</p></div><span className="admin-count">{wishes.length} ucapan</span></div>
    <div className="admin-photo-toolbar admin-panel">
      <div className="admin-filter"><label htmlFor="wish-search">Cari nama atau ucapan</label><input id="wish-search" type="search" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} /></div>
      <button disabled={loading || wishes.length === 0} onClick={download}>Simpan semua ucapan (.txt)</button>
      <button className="admin-quiet" disabled={loading} onClick={() => void load()}>Muat semula ucapan</button>
    </div>
    {loading && <p role="status">Mengumpulkan ucapan…</p>}
    {error && <p role="alert">{error} <button onClick={() => void load()}>Cuba semula</button></p>}
    {!loading && !error && filtered.length === 0 && <p className="admin-empty">{wishes.length ? "Tiada ucapan yang sepadan." : "Belum ada ucapan."}</p>}
    <p>{search && `${filtered.length} ucapan sepadan`}</p>
    <div className="admin-wishes">{filtered.slice(page * 30, (page + 1) * 30).map(wish => <article key={wish.guestId} className="admin-panel admin-wish"><h3>{wish.guestName ?? "Tanpa nama"}</h3><p>{wish.message}</p></article>)}</div>
    <AdminPagination page={page} total={filtered.length} pageSize={30} onChange={setPage} />
  </section>;
}
