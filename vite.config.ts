import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";

// Short commit sha baked into the bundle and logged once at boot, so a live
// deploy can be matched to a commit without grepping minified output. It
// also guarantees every deploy gets a fresh /assets hash — on 2026-09-13 a
// verification request for a new bundle URL landed in the propagation gap,
// the old deployment answered with the SPA fallback HTML, and Cloudflare
// cached that HTML as an immutable .js for the custom domain.
function buildId(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Kamera Majlis",
        short_name: "Kamera",
        start_url: "/",
        display: "standalone",
        background_color: "#F8F1E4",
        theme_color: "#F8F1E4",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // Pages are fetched from the network first so a deploy shows on the very
        // next open, with no second reload; the cache is only the offline
        // fallback. Hashed assets stay precached. index.html is deliberately
        // NOT precached — a precached shell is what served the old bundle once
        // after every deploy.
        navigateFallback: null,
        globPatterns: ["**/*.{js,css,webp,svg,png}"],
        // The HEIC decoder is a 3 MB WASM chunk that only Android/desktop
        // guests with a "Keep Originals" iPhone photo ever need. Precaching it
        // would push it to every phone on install; instead it is fetched on
        // first use and then kept (below) so a later offline pick still works.
        globIgnores: ["**/heic-to-*.js"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/assets\/heic-to-[^/]+\.js$/.test(url.pathname),
            handler: "CacheFirst",
            options: { cacheName: "heic-decoder", cacheableResponse: { statuses: [0, 200] } },
          },
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "pages",
              networkTimeoutSeconds: 3,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
