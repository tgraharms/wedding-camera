import { act, renderHook } from "@testing-library/react";
import { useDownloadState } from "./useDownloadState";

describe("useDownloadState", () => {
  it("is busy while the download runs, then idle", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const { result } = renderHook(() => useDownloadState(run));
    expect(result.current.state).toBe("idle");
    let p!: Promise<void>;
    act(() => { p = result.current.start(); });
    expect(result.current.state).toBe("busy");
    await act(async () => { finish(); await p; });
    expect(result.current.state).toBe("idle");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores a second start while busy", async () => {
    const run = vi.fn(() => new Promise<void>(() => {}));
    const { result } = renderHook(() => useDownloadState(run));
    act(() => { void result.current.start(); });
    act(() => { void result.current.start(); });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("shows failed for a moment, then resets to idle", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(() => Promise.reject(new Error("403")));
      const { result } = renderHook(() => useDownloadState(run));
      await act(async () => { await result.current.start(); });
      expect(result.current.state).toBe("failed");
      await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
      expect(result.current.state).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});
