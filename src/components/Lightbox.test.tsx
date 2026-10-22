import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Lightbox } from "./Lightbox";

const photos = [
  { id: "p1", imageUrl: "https://r2/1.jpg", capturedAt: "2026-09-19T05:00:00Z" },
  { id: "p2", imageUrl: "https://r2/2.jpg", capturedAt: "2026-09-19T05:01:00Z" },
  { id: "p3", imageUrl: "https://r2/3.jpg", capturedAt: "2026-09-19T05:02:00Z" },
];

function setup(index: number | null, extra: Partial<Parameters<typeof Lightbox>[0]> = {}) {
  const props = {
    photos, index, hasMore: false,
    onClose: vi.fn(), onNavigate: vi.fn(), onLoadMore: vi.fn(() => Promise.resolve()),
    ...extra,
  };
  const view = render(<Lightbox {...props} />);
  return { ...view, props };
}

it("renders nothing when no photo is selected", () => {
  setup(null);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("shows the selected photo full-size with a position counter", () => {
  setup(1);
  const dialog = screen.getByRole("dialog");
  expect(dialog).toBeInTheDocument();
  expect(screen.getByRole("img")).toHaveAttribute("src", "https://r2/2.jpg");
  expect(screen.getByText("2 / 3")).toBeInTheDocument();
});

it("next and previous buttons move to the neighbouring photo", async () => {
  const { props } = setup(1);
  await userEvent.click(screen.getByRole("button", { name: /seterusnya/i }));
  expect(props.onNavigate).toHaveBeenCalledWith(2);
  await userEvent.click(screen.getByRole("button", { name: /sebelumnya/i }));
  expect(props.onNavigate).toHaveBeenCalledWith(0);
});

it("disables previous on the first photo", () => {
  setup(0);
  expect(screen.getByRole("button", { name: /sebelumnya/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /seterusnya/i })).toBeEnabled();
});

it("disables next on the last photo when there are no more to load", () => {
  setup(2);
  expect(screen.getByRole("button", { name: /seterusnya/i })).toBeDisabled();
});

it("closes via the X button", async () => {
  const { props } = setup(0);
  await userEvent.click(screen.getByRole("button", { name: /tutup/i }));
  expect(props.onClose).toHaveBeenCalled();
});

it("closes when the backdrop outside the image is tapped", async () => {
  const { props } = setup(0);
  await userEvent.click(screen.getByRole("dialog"));
  expect(props.onClose).toHaveBeenCalled();
});

it("does not close when the image itself is tapped", async () => {
  const { props } = setup(0);
  await userEvent.click(screen.getByRole("img"));
  expect(props.onClose).not.toHaveBeenCalled();
});

it("closes on Escape and navigates with the arrow keys", () => {
  const { props } = setup(1);
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(props.onNavigate).toHaveBeenLastCalledWith(2);
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(props.onNavigate).toHaveBeenLastCalledWith(0);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(props.onClose).toHaveBeenCalled();
});

it("locks page scroll while open and restores it on close", () => {
  const { unmount } = setup(0);
  expect(document.body.style.overflow).toBe("hidden");
  unmount();
  expect(document.body.style.overflow).toBe("");
});

const p4 = { id: "p4", imageUrl: "https://r2/4.jpg", capturedAt: "2026-09-19T05:03:00Z" };

it("next on the last loaded photo fetches the next page and advances when it arrives", async () => {
  let finish!: () => void;
  const onLoadMore = vi.fn(() => new Promise<void>((r) => { finish = r; }));
  const { props, rerender } = setup(2, { hasMore: true, onLoadMore });
  const next = screen.getByRole("button", { name: /seterusnya/i });
  expect(next).toBeEnabled();
  await userEvent.click(next);
  expect(onLoadMore).toHaveBeenCalledTimes(1);
  expect(next).toBeDisabled();
  expect(props.onNavigate).not.toHaveBeenCalled();
  rerender(<Lightbox {...props} photos={[...photos, p4]} />);
  finish();
  expect(props.onNavigate).toHaveBeenCalledWith(3);
});

it("re-enables next when loading more brings no new photos", async () => {
  const onLoadMore = vi.fn(() => Promise.resolve());
  const { props } = setup(2, { hasMore: true, onLoadMore });
  const next = screen.getByRole("button", { name: /seterusnya/i });
  await userEvent.click(next);
  expect(next).toBeEnabled();
  expect(props.onNavigate).not.toHaveBeenCalled();
});

function swipe(el: Element, fromX: number, toX: number) {
  fireEvent.touchStart(el, { touches: [{ clientX: fromX, clientY: 300 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: toX, clientY: 300 }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: toX, clientY: 300 }], touches: [] });
}

it("swiping left goes to the next photo and swiping right goes back", () => {
  const { props } = setup(1);
  const dialog = screen.getByRole("dialog");
  swipe(dialog, 250, 100);
  expect(props.onNavigate).toHaveBeenLastCalledWith(2);
  swipe(dialog, 100, 250);
  expect(props.onNavigate).toHaveBeenLastCalledWith(0);
});

it("a short drag is not a swipe", () => {
  const { props } = setup(1);
  swipe(screen.getByRole("dialog"), 200, 180);
  expect(props.onNavigate).not.toHaveBeenCalled();
});

function pinch(el: Element, startDist: number, endDist: number) {
  fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 300 }, { clientX: 100 + startDist, clientY: 300 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 300 }, { clientX: 100 + endDist, clientY: 300 }] });
  fireEvent.touchEnd(el, { changedTouches: [], touches: [] });
}

it("pinching out zooms the photo in", () => {
  setup(1);
  pinch(screen.getByRole("dialog"), 100, 200);
  expect(screen.getByRole("img").style.transform).toContain("scale(2)");
});

it("swiping while zoomed pans instead of changing photo", () => {
  const { props } = setup(1);
  const dialog = screen.getByRole("dialog");
  pinch(dialog, 100, 200);
  swipe(dialog, 250, 100);
  expect(props.onNavigate).not.toHaveBeenCalled();
  expect(screen.getByRole("img").style.transform).toContain("scale(2)");
});

it("double-tapping toggles zoom and moving to another photo resets it", () => {
  const { props, rerender } = setup(1);
  const dialog = screen.getByRole("dialog");
  const tap = () => {
    fireEvent.touchStart(dialog, { touches: [{ clientX: 150, clientY: 300 }] });
    fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: 150, clientY: 300 }], touches: [] });
  };
  tap(); tap();
  expect(screen.getByRole("img").style.transform).toContain("scale(2.5)");
  rerender(<Lightbox {...props} index={2} />);
  expect(screen.getByRole("img").style.transform).toContain("scale(1)");
});

it("forgets a pending advance if the overlay is closed before the page arrives", async () => {
  const onLoadMore = vi.fn(() => new Promise<void>(() => {}));
  const { props, rerender } = setup(2, { hasMore: true, onLoadMore });
  await userEvent.click(screen.getByRole("button", { name: /seterusnya/i }));
  rerender(<Lightbox {...props} index={null} />);
  rerender(<Lightbox {...props} index={0} photos={[...photos, p4]} />);
  expect(props.onNavigate).not.toHaveBeenCalled();
});

it("keeps the zoom when the fingers lift before React has re-rendered the pinch", () => {
  setup(1);
  const dialog = screen.getByRole("dialog");
  const touch = (x: number, id: number) => ({ identifier: id, target: dialog, clientX: x, clientY: 300 });
  const raw = (type: string, touches: object[], changed: object[] = touches) =>
    dialog.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { touches, changedTouches: changed }));
  // One act() around the whole burst: no re-render between the events, the
  // same way a real browser delivers a fast pinch-and-release.
  act(() => {
    raw("touchstart", [touch(100, 0), touch(200, 1)]);
    raw("touchmove", [touch(100, 0), touch(300, 1)]);
    raw("touchend", [], []);
  });
  expect(screen.getByRole("img").style.transform).toContain("scale(2)");
});

it("draws the close and paging controls as SVG icons, not font glyphs", () => {
  setup(1);
  for (const name of [/tutup/i, /sebelumnya/i, /seterusnya/i]) {
    const btn = screen.getByRole("button", { name });
    expect(btn.querySelector("svg")).not.toBeNull();
    expect(btn.textContent?.trim()).toBe("");
  }
});

describe("Muat turun", () => {
  it("downloads the photo on screen and shows progress while it runs", async () => {
    let finish!: () => void;
    const download = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    setup(1, { download });
    const btn = screen.getByRole("button", { name: /muat turun/i });
    await userEvent.click(btn);
    expect(download).toHaveBeenCalledWith(photos[1], 1);
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/memuat turun/i);
    finish();
    await vi.waitFor(() => expect(btn).toBeEnabled());
    expect(btn).toHaveTextContent(/^muat turun$/i);
  });

  it("shows the failure copy when the download fails, then recovers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const download = vi.fn(() => Promise.reject(new Error("403")));
      setup(1, { download });
      const btn = screen.getByRole("button", { name: /muat turun/i });
      await userEvent.click(btn);
      await vi.waitFor(() => expect(btn).toHaveTextContent(/gagal muat turun/i));
      await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
      expect(btn).toHaveTextContent(/^muat turun$/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("downloading does not close the overlay", async () => {
    const { props } = setup(1, { download: vi.fn(() => Promise.resolve()) });
    await userEvent.click(screen.getByRole("button", { name: /muat turun/i }));
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
