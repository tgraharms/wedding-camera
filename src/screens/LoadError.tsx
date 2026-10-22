import { Brand } from "../components/Brand";

// Shown when the event list can't be loaded after the automatic retries.
// Without this the app renders "Memuatkan…" forever and looks dead — which is
// exactly how the 2026-07-11 outage presented to anyone who scanned the QR.
export function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="page page--landing">
      <Brand />
      <h2 className="headline headline--sm">Sambungan bermasalah</h2>
      <p className="sub">Tidak dapat memuatkan maklumat majlis. Sila periksa sambungan internet anda dan cuba lagi.</p>
      <div className="actions">
        <button className="btn btn--primary" onClick={onRetry}>Cuba Lagi</button>
      </div>
    </div>
  );
}
