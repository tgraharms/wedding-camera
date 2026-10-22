import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminPhotos } from "./AdminPhotos";
import * as adminApi from "../../lib/adminClient";
import * as zip from "../../lib/zip";
import type { AdminPhoto } from "../../lib/types";

const photos: AdminPhoto[] = [
  {
    id: "p1", eventId: "e1", eventName: "Akad", guestName: "Ahmad", message: "Tahniah!",
    imageUrl: "https://r2/p1.jpg", starred: false, capturedAt: "2026-06-12T12:30:00.000Z",
  },
  {
    id: "p2", eventId: "e1", eventName: "Akad", guestName: null, message: null,
    imageUrl: "https://r2/p2.jpg", starred: true, capturedAt: "2026-06-12T13:00:00.000Z",
  },
];

const counts = [{ eventId: "e1", name: "Akad", count: 2 }];

beforeEach(() => vi.restoreAllMocks());

function renderPhotos(overrides: Partial<Parameters<typeof AdminPhotos>[0]> = {}) {
  const props = {
    photos,
    counts,
    eventFilter: "all",
    hasMore: false,
    onFilterChange: vi.fn(),
    onPageChange: vi.fn(),
    page: 0,
    total: 2,
    groupByGuest: false,
    onGroupChange: vi.fn(),
    ...overrides,
  };
  render(<AdminPhotos {...props} />);
  return props;
}

describe("AdminPhotos", () => {
  it("renders the filter options and photo grid", () => {
    renderPhotos();
    expect(screen.getByRole("option", { name: /semua/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /akad \(2\)/i })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("calls setStarred and flips the button optimistically", async () => {
    const setStarredSpy = vi.spyOn(adminApi, "setStarred").mockResolvedValue(undefined);
    renderPhotos();
    const button = screen.getByRole("button", { name: /bintang ahmad/i });
    expect(button).toHaveTextContent("☆");
    await userEvent.click(button);
    expect(setStarredSpy).toHaveBeenCalledWith("p1", true);
    expect(await screen.findByRole("button", { name: /nyahbintang ahmad/i })).toHaveTextContent("★");
  });

  it("reverts the optimistic flip when setStarred fails", async () => {
    vi.spyOn(adminApi, "setStarred").mockRejectedValue(new Error("network down"));
    renderPhotos();
    const button = screen.getByRole("button", { name: /bintang ahmad/i });
    await userEvent.click(button);
    expect(await screen.findByRole("button", { name: /bintang ahmad/i })).toHaveTextContent("☆");
  });

  it("calls onFilterChange when the select changes", async () => {
    const props = renderPhotos();
    await userEvent.selectOptions(screen.getByLabelText(/tapis mengikut acara/i), "e1");
    expect(props.onFilterChange).toHaveBeenCalledWith("e1");
  });

  it("shows the full total and numbered navigation independently of loaded photos", async () => {
    const props = renderPhotos({ counts: [{ eventId: "e1", name: "Akad", count: 180 }], total: 180 });
    expect(screen.getByText("1–2 daripada 180 gambar")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Halaman 2" })[0]);
    expect(props.onPageChange).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("button", { name: "Lagi" })).not.toBeInTheDocument();
  });

  it("closes on the backdrop but keeps image clicks open", async () => {
    renderPhotos();
    await userEvent.click(screen.getByRole("button", { name: "Buka gambar Ahmad" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog.querySelector("img")!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(dialog, { clientX: -10, clientY: -10 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("groups by guest identity instead of combining identical names", () => {
    renderPhotos({ groupByGuest: true, photos: [
      { ...photos[0], guestId: "guest1" },
      { ...photos[0], id: "p3", guestId: "guest2" },
    ] });
    expect(screen.getAllByRole("heading", { name: "Ahmad" })).toHaveLength(2);
  });

  it("fetches every page of the current filter before zipping, not just the loaded ones", async () => {
    const page0 = [photos[0]];
    const page1 = [photos[1]];
    const getAdminPhotos = vi
      .spyOn(adminApi, "getAdminPhotos")
      .mockResolvedValueOnce({ photos: page0, hasMore: true, counts })
      .mockResolvedValueOnce({ photos: page1, hasMore: false, counts });
    const downloadSpy = vi.spyOn(zip, "downloadGalleryZip").mockResolvedValue(undefined);

    renderPhotos({ eventFilter: "e1" });
    await userEvent.click(screen.getByRole("button", { name: /muat turun semua/i }));

    await waitFor(() => expect(downloadSpy).toHaveBeenCalled());
    expect(getAdminPhotos).toHaveBeenNthCalledWith(1, 0, "e1");
    expect(getAdminPhotos).toHaveBeenNthCalledWith(2, 1, "e1");
    expect(downloadSpy).toHaveBeenCalledWith([...page0, ...page1], "Akad.zip");
  });

  it("shows progress and disables the button while assembling the zip", async () => {
    let resolvePage1: (v: { photos: AdminPhoto[]; hasMore: boolean; counts: typeof counts }) => void;
    const page1Promise = new Promise<{ photos: AdminPhoto[]; hasMore: boolean; counts: typeof counts }>((resolve) => {
      resolvePage1 = resolve;
    });
    vi.spyOn(adminApi, "getAdminPhotos")
      .mockResolvedValueOnce({ photos: [photos[0]], hasMore: true, counts })
      .mockReturnValueOnce(page1Promise);
    vi.spyOn(zip, "downloadGalleryZip").mockResolvedValue(undefined);

    renderPhotos({ eventFilter: "e1" });
    const button = screen.getByRole("button", { name: /muat turun semua/i });
    await userEvent.click(button);

    const busyButton = await screen.findByRole("button", { name: /menyediakan zip.*1\/…/i });
    expect(busyButton).toBeDisabled();

    resolvePage1!({ photos: [photos[1]], hasMore: false, counts });
    expect(await screen.findByRole("button", { name: /^muat turun semua/i })).not.toBeDisabled();
  });

  it("opens a detail overlay showing Tanpa nama for a guestless photo, message and time", async () => {
    renderPhotos();
    const images = screen.getAllByRole("img");
    await userEvent.click(images[1]); // p2, guestName null
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Tanpa nama");
    expect(await screen.findByRole("button", { name: /tutup/i })).toBeInTheDocument();
  });

  it("closes the detail overlay with Tutup", async () => {
    renderPhotos();
    const images = screen.getAllByRole("img");
    await userEvent.click(images[0]);
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: /tutup/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

 it("keeps photo selection and stars usable when switching views", async () => {
    renderPhotos();
    await userEvent.click(screen.getByRole("button", { name: "Senarai" }));
    expect(screen.getByRole("button", { name: "Senarai" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Padat" }));
    expect(screen.getByRole("button", { name: "Padat" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /nyahbintang tanpa nama/i })).toHaveTextContent("★");
    await userEvent.click(screen.getByRole("button", { name: "Buka gambar Ahmad" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Tahniah!");
 });
