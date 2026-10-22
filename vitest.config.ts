import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify("test") },
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Pins the test worker's local time zone so datetime-local round-trip
    // tests (e.g. AdminEvents' toLocalInput/toIso) are load-bearing on CI
    // machines that default to UTC, not just on developer machines already
    // set to MYT.
    env: { TZ: "Asia/Kuala_Lumpur" },
    // Node's experimental Web Storage global (added in Node 26) shadows
    // vitest-environment-jsdom's own `localStorage` global: jsdom only
    // copies `localStorage` onto globalThis when the key isn't already
    // present, so Node's (disabled, value === undefined) global wins and
    // `localStorage` ends up undefined in tests. Disabling the flag in the
    // worker process lets jsdom's localStorage come through as intended.
    execArgv: ["--no-experimental-webstorage"],
  },
});
