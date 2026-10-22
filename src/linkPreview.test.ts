import indexHtml from "../index.html?raw";
import pagesHeaders from "../public/_headers?raw";
import ogImageDataUrl from "../public/og-image-demo.jpg?inline";

// Link preview (WhatsApp, Telegram, iMessage, Facebook) for the shared URL,
// added 2026-10-01 with the couple's sunflower card. Crawlers do not run JS,
// so these tags must sit in the static index.html, and og:image must be an
// absolute URL to a JPEG — WhatsApp does not reliably render WebP thumbnails
// and skips images that are too heavy.
const head = new DOMParser().parseFromString(indexHtml, "text/html").head;
const meta = (key: string) =>
  head.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content");

// ?inline yields a base64 data URL; decode it back to the file's bytes.
const ogImage = Uint8Array.from(atob(ogImageDataUrl.split(",")[1]), (c) => c.charCodeAt(0));

// Width and height from the first baseline/progressive SOF marker.
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer);
  let i = 2;
  while (i < bytes.length) {
    const marker = bytes[i + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    i += 2 + view.getUint16(i + 2);
  }
  throw new Error("no SOF marker");
}

describe("link preview", () => {
  it("declares Open Graph and Twitter card tags pointing at the absolute JPEG", () => {
    expect(meta("og:type")).toBe("website");
    expect(meta("og:url")).toBe("https://wedding-camera-demo.pages.dev/");
    expect(meta("og:title")).toBe("[Husband Name] & [Wife Name] · Kongsi Detik Anda");
    expect(meta("og:description")).toBe("Muat naik gambar-gambar yang anda tangkap semasa majlis kami.");
    expect(meta("og:image")).toBe("https://wedding-camera-demo.pages.dev/og-image-demo.jpg");
    expect(meta("og:image:type")).toBe("image/jpeg");
    expect(meta("og:image:width")).toBe("1200");
    expect(meta("og:image:height")).toBe("630");
    expect(meta("og:image:alt")).toBeTruthy();
    expect(meta("twitter:card")).toBe("summary_large_image");
  });

  it("keeps the site out of search results without blocking link previews", () => {
    expect(head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
    expect(pagesHeaders).toMatch(/^\/\*\n {2}X-Robots-Tag: noindex, nofollow$/m);
  });

  it("keeps the browser tab title", () => {
    expect(head.querySelector("title")?.textContent).toBe("Kamera Majlis");
  });

  it("ships a 1200x630 JPEG small enough for WhatsApp", () => {
    expect(ogImageDataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect([...ogImage.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(jpegSize(ogImage)).toEqual({ width: 1200, height: 630 });
    expect(ogImage.length).toBeLessThan(300 * 1024);
  });
});
