import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MyGallery } from "./MyGallery";
import * as savePhoto from "../lib/savePhoto";

const base = {
  photos: [{ id: "p1", imageUrl: "https://r2/1.jpg", capturedAt: "2026-09-19T05:00:00Z" }],
  profile: { displayName: null, message: null }, hasMore: false,
  onSaveProfile: vi.fn(), onLoadMore: vi.fn(), onBack: vi.fn(),
};

it("renders the grid and saves profile on blur", async () => {
  render(<MyGallery {...base} />);
  expect(screen.getByRole("img")).toHaveAttribute("src", "https://r2/1.jpg");
  const name = screen.getByLabelText(/nama anda/i);
  await userEvent.type(name, "Aminah");
  await userEvent.tab();
  expect(base.onSaveProfile).toHaveBeenCalledWith({ displayName: "Aminah", message: null });
});
it("Lagi appears only when hasMore", async () => {
  const { rerender } = render(<MyGallery {...base} hasMore />);
  await userEvent.click(screen.getByRole("button", { name: /lagi/i }));
  expect(base.onLoadMore).toHaveBeenCalled();
  rerender(<MyGallery {...base} hasMore={false} />);
  expect(screen.queryByRole("button", { name: /lagi/i })).not.toBeInTheDocument();
});

it("labels the profile fields without the '(tak wajib)' suffix", () => {
  render(<MyGallery {...base} />);
  expect(screen.getByLabelText("Nama anda")).toBeInTheDocument();
  expect(screen.getByLabelText("Pesanan untuk pengantin")).toBeInTheDocument();
  expect(screen.queryByText(/tak wajib/i)).not.toBeInTheDocument();
});

it("keeps and saves a full-length wish while reporting remaining space", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const onSaveProfile = vi.fn();
  render(<MyGallery {...base} onSaveProfile={onSaveProfile} />);
  const field = screen.getByLabelText("Pesanan untuk pengantin");
  const message = "A".repeat(500);
  fireEvent.change(field, { target: { value: message } });
  fireEvent.blur(field);
  expect(onSaveProfile).toHaveBeenCalledWith({ displayName: null, message });
  expect(screen.getByText("500 / 500")).toBeInTheDocument();
});

it("tapping a thumbnail opens the preview overlay on that photo", async () => {
  const photos = [
    base.photos[0],
    { id: "p2", imageUrl: "https://r2/2.jpg", capturedAt: "2026-09-19T05:01:00Z" },
  ];
  render(<MyGallery {...base} photos={photos} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /buka gambar 2/i }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toBeInTheDocument();
  expect(screen.getByText("2 / 2")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /sebelumnya/i }));
  expect(screen.getByText("1 / 2")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /tutup/i }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("next on the last thumbnail in the overlay asks the gallery to load more", async () => {
  const onLoadMore = vi.fn(() => Promise.resolve());
  render(<MyGallery {...base} hasMore onLoadMore={onLoadMore} />);
  await userEvent.click(screen.getByRole("button", { name: /buka gambar 1/i }));
  await userEvent.click(screen.getByRole("button", { name: /seterusnya/i }));
  expect(onLoadMore).toHaveBeenCalled();
});

describe("Simpan button and save status", () => {
  it("saves on demand and reports Disimpan once the server confirms", async () => {
    let finish!: () => void;
    const onSaveProfile = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    render(<MyGallery {...base} onSaveProfile={onSaveProfile} />);
    await userEvent.type(screen.getByLabelText("Nama anda"), "Aminah");
    await userEvent.click(screen.getByRole("button", { name: /^simpan$/i }));
    expect(onSaveProfile).toHaveBeenCalledWith({ displayName: "Aminah", message: null });
    expect(screen.getByRole("status")).toHaveTextContent(/menyimpan/i);
    finish();
    expect(await screen.findByText(/disimpan/i)).toBeInTheDocument();
  });

  it("reports a failed save and lets the guest try again", async () => {
    const onSaveProfile = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    render(<MyGallery {...base} onSaveProfile={onSaveProfile} />);
    await userEvent.type(screen.getByLabelText("Nama anda"), "Aminah");
    await userEvent.tab(); // auto-save on blur fails
    expect(await screen.findByText(/gagal disimpan/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^simpan$/i })); // explicit retry
    expect(await screen.findByText(/^disimpan/i)).toBeInTheDocument();
    expect(onSaveProfile).toHaveBeenCalledTimes(2);
  });

  it("answers an explicit Simpan press with Disimpan even when nothing changed, without a request", async () => {
    const onSaveProfile = vi.fn(() => Promise.resolve());
    render(<MyGallery {...base} profile={{ displayName: "Aminah", message: null }} onSaveProfile={onSaveProfile} />);
    await userEvent.click(screen.getByRole("button", { name: /^simpan$/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/disimpan/i);
    expect(onSaveProfile).not.toHaveBeenCalled();
  });

  it("does not re-send an unchanged profile (blur then click is one save)", async () => {
    const onSaveProfile = vi.fn(() => Promise.resolve());
    render(<MyGallery {...base} onSaveProfile={onSaveProfile} />);
    await userEvent.type(screen.getByLabelText("Nama anda"), "Aminah");
    await userEvent.click(screen.getByRole("button", { name: /^simpan$/i })); // blur fires first, then click
    await screen.findByText(/disimpan/i);
    await userEvent.click(screen.getByRole("button", { name: /^simpan$/i }));
    expect(onSaveProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(/disimpan/i);
  });
});

describe("download icon on each Polaroid", () => {
  it("saves that photo to the device without opening the preview", async () => {
    const spy = vi.spyOn(savePhoto, "savePhotoToDevice").mockResolvedValue(undefined);
    const photos = [
      base.photos[0],
      { id: "p2", imageUrl: "https://r2/2.jpg", capturedAt: "2026-09-19T05:01:00Z" },
    ];
    render(<MyGallery {...base} photos={photos} />);
    await userEvent.click(screen.getByRole("button", { name: /muat turun gambar 2/i }));
    expect(spy).toHaveBeenCalledWith("https://r2/2.jpg", "husband-name-wife-name-2.jpg");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it("is disabled while saving and marks a failure briefly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reject!: (e: Error) => void;
      const spy = vi.spyOn(savePhoto, "savePhotoToDevice").mockImplementation(() => new Promise<void>((_, rj) => { reject = rj; }));
      render(<MyGallery {...base} />);
      const btn = screen.getByRole("button", { name: /muat turun gambar 1/i });
      await userEvent.click(btn);
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute("aria-busy", "true");
      reject(new Error("403"));
      await vi.waitFor(() => expect(btn).toHaveAccessibleName(/gagal muat turun/i));
      await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
      expect(btn).toHaveAccessibleName(/^muat turun gambar 1$/i);
      expect(btn).toBeEnabled();
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps exactly one photo image per cell for the existing grid assertions", () => {
    render(<MyGallery {...base} />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });
});

// Upload week (2026-10-01): there is no camera to "take" a first photo with.
it("empty gallery invites an upload, not a capture", () => {
  render(<MyGallery {...base} photos={[]} />);
  expect(screen.getByText("Belum ada gambar lagi. Muat naik gambar pertama anda!")).toBeInTheDocument();
  expect(screen.queryByText(/ambil gambar/i)).not.toBeInTheDocument();
});

// A guest's grid holds full-size photos; only fetch the ones scrolled into view.
it("loads grid photos lazily, as the guest scrolls", () => {
  render(<MyGallery {...base} />);
  const img = screen.getByRole("img");
  expect(img).toHaveAttribute("loading", "lazy");
  expect(img).toHaveAttribute("decoding", "async");
});
