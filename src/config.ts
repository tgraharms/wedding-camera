const MONTHS_MS = [
  "Jan", "Feb", "Mac", "Apr", "Mei", "Jun",
  "Jul", "Ogo", "Sep", "Okt", "Nov", "Dis",
];

// Deterministic stamp string: "12 Jun 2026, 8:30 PM" in the given IANA tz.
export function formatStamp(date: Date, timeZone = "Asia/Kuala_Lumpur"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const month = MONTHS_MS[Number(get("month")) - 1];
  const dayPeriod = get("dayPeriod").toUpperCase();
  return `${get("day")} ${month} ${get("year")}, ${get("hour")}:${get("minute")} ${dayPeriod}`;
}

// The couple's names: the small-caps line on guest screens, the admin header,
// the wishes export and saved photo filenames. Placeholders here; a real
// wedding sets its own.
const COUPLE: { names: readonly [string, string]; short: string } = {
  names: ["[Husband Name]", "[Wife Name]"],
  short: "[Husband Name] & [Wife Name]",
};

// Letters and digits only, runs of anything else become one "-":
// "Adam & Hawa" → "Adam-Hawa", "[Husband Name]" → "Husband-Name".
export const fileSafe = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

// Guest-facing brand copy (Malay). Every screen reads from here so a wording
// change is a one-place edit.
// Wording approved by the couple on 2026-09-12; the privacy line and the
// footer tagline were cut at the same review. Upload-week copy (no camera, no
// closing date on screen) approved on 2026-10-01.
export const BRAND = {
  names: COUPLE.names,
  // Admin header, wishes export and its filename.
  couple: COUPLE.short,
  headline: "Kongsi Detik Anda",
  sub: "Muat naik gambar-gambar yang anda tangkap semasa majlis kami.",
  subEnded: "Terima kasih kerana berkongsi detik bersama kami.",
  upload: "Muat Naik Gambar",
  uploadMore: "Muat Naik Lagi",
  gallery: "Galeri Saya",
  before: "Muat naik belum dibuka",
  ended: "Muat naik telah ditutup. Terima kasih! ❤️",
} as const;
