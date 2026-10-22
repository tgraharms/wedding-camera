export const ADMIN_PAGE_SIZE = 60;

export function AdminPagination({ page, total, pageSize = ADMIN_PAGE_SIZE, loading = false, onChange }: {
  page: number; total: number; pageSize?: number; loading?: boolean; onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const numbers = [...new Set([0, ...Array.from({ length: 5 }, (_, i) => page + i - 2), pages - 1])]
    .filter(p => p >= 0 && p < pages).sort((a, b) => a - b);
  return <nav className="admin-pagination" aria-label="Halaman galeri">
    <button disabled={loading || page === 0} onClick={() => onChange(page - 1)}>← Sebelumnya</button>
    {numbers.map((p, i) => <span key={p}>
      {i > 0 && p > numbers[i - 1] + 1 && <span className="admin-page-gap">…</span>}
      <button aria-label={`Halaman ${p + 1}`} aria-current={page === p ? "page" : undefined}
        disabled={loading} onClick={() => onChange(p)}>{p + 1}</button>
    </span>)}
    <button disabled={loading || page >= pages - 1} onClick={() => onChange(page + 1)}>Seterusnya →</button>
  </nav>;
}
