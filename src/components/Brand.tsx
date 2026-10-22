import { BRAND } from "../config";

// The couple's names as one quiet small-caps line. Text only — no <img>, so
// screens that count images (the gallery tests) are unaffected.
export function Brand() {
  return (
    <header className="brand">
      <p className="brand__names">
        {BRAND.names[0]} <span className="brand__amp">&amp;</span> {BRAND.names[1]}
      </p>
    </header>
  );
}
