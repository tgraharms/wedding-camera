import { useEffect, useRef, useState } from "react";

export type DownloadState = "idle" | "busy" | "failed";
const FAILED_MS = 3000;

// idle → busy → idle, or busy → failed → (3 s) → idle. A start() while busy
// is ignored. Shared by the overlay's "Muat turun" and the grid icons so the
// two never drift.
export function useDownloadState(run: () => Promise<void>) {
  const [state, setState] = useState<DownloadState>("idle");
  const busy = useRef(false);

  useEffect(() => {
    if (state !== "failed") return;
    const id = setTimeout(() => setState("idle"), FAILED_MS);
    return () => clearTimeout(id);
  }, [state]);

  const start = async () => {
    if (busy.current) return;
    busy.current = true;
    setState("busy");
    try {
      await run();
      setState("idle");
    } catch {
      setState("failed");
    } finally {
      busy.current = false;
    }
  };

  return { state, start };
}
