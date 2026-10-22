import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Landing } from "./Landing";

const base = {
  counts: { done: 0, pending: 0, failed: 0 }, lastThumbUrl: null,
  onFiles: vi.fn(), onRetryFailed: vi.fn(), onOpenGallery: vi.fn(),
};

// base's mocks are module-scoped (shared across every it() below), so call
// counts must be reset between tests rather than accumulating.
beforeEach(() => vi.clearAllMocks());

it("keeps an empty gallery disabled until the first upload completes", async () => {
  const status = { state: "open", eventId: "e", eventName: "Akad" } as const;
  const { rerender } = render(<Landing {...base} status={status} />);
  const gallery = screen.getByRole("button", { name: /galeri saya/i });
  expect(gallery).toBeDisabled();
  await userEvent.click(gallery);
  expect(base.onOpenGallery).not.toHaveBeenCalled();
  rerender(<Landing {...base} status={status} counts={{ done: 0, pending: 1, failed: 0 }} lastThumbUrl="blob:pending" />);
  expect(gallery).toBeDisabled();
  rerender(<Landing {...base} status={status} counts={{ done: 1, pending: 0, failed: 0 }} />);
  expect(gallery).toBeEnabled();
  await userEvent.click(gallery);
  expect(base.onOpenGallery).toHaveBeenCalledOnce();
});

it("keeps the first-photo cue after cancellation and stops it after the picker returns a photo", () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }} />);
  const upload = screen.getByRole("button", { name: /muat naik gambar/i });
  expect(upload).toHaveClass("btn--first-photo");
  fireEvent.change(screen.getByTestId("upload-input"), { target: { files: [] } });
  expect(upload).toHaveClass("btn--first-photo");
  fireEvent.change(screen.getByTestId("upload-input"), { target: { files: [new File(["x"], "p.jpg", { type: "image/jpeg" })] } });
  expect(upload).not.toHaveClass("btn--first-photo");
});

it.each([
  { done: 1, pending: 0, failed: 0 },
  { done: 0, pending: 1, failed: 0 },
  { done: 0, pending: 0, failed: 1 },
])("does not prompt returning guests with existing photos, and offers 'Muat Naik Lagi': %j", (counts) => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }} counts={counts} />);
  const upload = screen.getByRole("button", { name: /muat naik lagi/i });
  expect(upload).toHaveClass("btn--primary");
  expect(upload).not.toHaveClass("btn--first-photo");
});

it("relabels the upload button to 'Muat Naik Lagi' once the guest has picked photos", () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }} />);
  expect(screen.queryByRole("button", { name: /muat naik lagi/i })).not.toBeInTheDocument();
  fireEvent.change(screen.getByTestId("upload-input"), { target: { files: [new File(["x"], "p.jpg", { type: "image/jpeg" })] } });
  expect(screen.getByRole("button", { name: /muat naik lagi/i })).toBeInTheDocument();
});

// Post-wedding upload week (2026-10-01): guests only send photos they already
// took, so the camera button and its capture input are gone entirely.
it("open: offers no camera, only the library picker", () => {
  const { container } = render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }} />);
  expect(screen.queryByTestId("capture-input")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /ambil gambar/i })).not.toBeInTheDocument();
  expect(container.querySelector("input[capture]")).toBeNull();
  expect(screen.getByRole("button", { name: /muat naik gambar/i })).toHaveClass("btn--primary");
});

it("same file twice in a row still fires onFiles (input value reset)", () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }} />);
  const input = screen.getByTestId("upload-input") as HTMLInputElement;
  const file = new File(["x"], "p.jpg", { type: "image/jpeg" });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.change(input, { target: { files: [file] } });
  expect(base.onFiles).toHaveBeenCalledTimes(2);
});

// The library picker must NOT carry `capture` (that is what forces the camera
// on iOS) and must keep accept="image/*": iOS Safari transcodes HEIC to JPEG on
// selection only when the page does not ask for HEIC explicitly.
it("open: 'Muat Naik Gambar' opens a multi-select library picker wired to onFiles", () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }} />);
  const input = screen.getByTestId("upload-input") as HTMLInputElement;
  expect(input.accept).toBe("image/*");
  expect(input.capture).toBe("");
  expect(input.multiple).toBe(true);
  const click = vi.spyOn(input, "click");
  fireEvent.click(screen.getByRole("button", { name: /muat naik gambar/i }));
  expect(click).toHaveBeenCalled();
  const a = new File(["a"], "a.jpg", { type: "image/jpeg" });
  const b = new File(["b"], "b.heic", { type: "image/heic" });
  fireEvent.change(input, { target: { files: [a, b] } });
  expect(base.onFiles).toHaveBeenCalledWith([a, b]);
  expect(input.value).toBe("");
  expect(screen.queryByText(/belum tersedia/i)).not.toBeInTheDocument();
});

it("upload button is hidden outside the window, gallery button stays", () => {
  render(<Landing {...base} status={{ state: "ended" }} />);
  expect(screen.queryByTestId("upload-input")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /muat naik gambar/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /galeri saya/i })).toBeInTheDocument();
});

it("shows the unsupported-format notice", () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }} formatError />);
  expect(screen.getByTestId("format-error")).toHaveTextContent(/tidak disokong/i);
});
it("closed states replace the button", () => {
  const { rerender } = render(<Landing {...base} status={{ state: "before" }} />);
  expect(screen.getByText("Muat naik belum dibuka")).toBeInTheDocument();
  expect(screen.queryByTestId("upload-input")).not.toBeInTheDocument();
  rerender(<Landing {...base} status={{ state: "ended" }} />);
  expect(screen.getByText("Muat naik telah ditutup. Terima kasih! ❤️")).toBeInTheDocument();
  expect(screen.getByText("Terima kasih kerana berkongsi detik bersama kami.")).toBeInTheDocument();
  expect(screen.queryByText(/muat naik gambar-gambar/i)).not.toBeInTheDocument();
});
// Upload-week copy approved 2026-10-01: the invitation asks for the
// photos guests took at the wedding, with no closing date on screen (the couple
// tells guests in person). The 2026-09-12 cuts stay cut.
it("shows the approved landing copy and nothing that was cut", () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }} />);
  expect(screen.getByText("Muat naik gambar-gambar yang anda tangkap semasa majlis kami.")).toBeInTheDocument();
  expect(screen.queryByText(/tangkap gambar dan kongsikan/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/dibuka sehingga/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/hanya untuk pengantin/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/sudut pandang berbeza/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/kongsikan bersama kami/i)).not.toBeInTheDocument();
});
it("shows counts strip and failure retry", async () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }}
    counts={{ done: 12, pending: 2, failed: 1 }} lastThumbUrl="blob:t" />);
  expect(screen.getByText(/12 gambar dihantar/)).toBeInTheDocument();
  expect(screen.getByText(/2 menunggu/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /cuba hantar semula/i }));
  expect(base.onRetryFailed).toHaveBeenCalled();
});

// Retrying cannot clear a spent allowance, so offering the retry button here
// would be telling the guest to do something that can only fail again.
it("quota reached: thanks the guest instead of offering a retry", () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }}
    counts={{ done: 200, pending: 0, failed: 1 }} quotaReached />);
  expect(screen.getByTestId("quota-notice")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /cuba hantar semula/i })).not.toBeInTheDocument();
});

it("shows the ordinary retry notice while no quota has been hit", () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }}
    counts={{ done: 3, pending: 0, failed: 1 }} />);
  expect(screen.queryByTestId("quota-notice")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /cuba hantar semula/i })).toBeInTheDocument();
});

// With the camera gone, "cuba ambil semula" (try taking it again) points at a
// button that no longer exists; the guest has to pick the photo again.
it("error notices ask the guest to pick the photo again, not to retake it", () => {
  render(<Landing {...base} status={{ state: "open", eventId: "e", eventName: "Akad" }} processError saveError />);
  expect(screen.getByText("Gambar gagal diproses. Sila cuba pilih semula.")).toBeInTheDocument();
  expect(screen.getByTestId("save-error")).toHaveTextContent("Gambar tidak dapat disimpan. Sila cuba pilih semula.");
  expect(screen.queryByText(/ambil semula/i)).not.toBeInTheDocument();
});
