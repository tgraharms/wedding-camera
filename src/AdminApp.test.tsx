import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminApp from "./AdminApp";
import * as adminApi from "./lib/adminClient";

beforeEach(() => vi.restoreAllMocks());

// Collapses the real 1s/2s/4s retry ladder so these tests don't wait it out.
const fastRetry = { baseDelayMs: 0, sleep: async () => {} };

const events = [{ id: "e1", name: "Akad", windowStart: null, windowEnd: null, count: 0 }];

describe("AdminApp", () => {
  it("shows the login screen when the session check 401s", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockRejectedValue(new adminApi.UnauthorizedError());
    render(<AdminApp />);
    expect(await screen.findByRole("button", { name: /log masuk/i })).toBeInTheDocument();
  });

  it("restores into the events view on mount when the cookie is still valid", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
    render(<AdminApp />);
    expect(await screen.findByRole("heading", { name: /acara/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/nama akad/i)).toBeInTheDocument();
  });

  it("logs out back to the login screen", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
    const logout = vi.spyOn(adminApi, "adminLogout").mockResolvedValue();
    render(<AdminApp />);
    await screen.findByLabelText(/nama akad/i);
    await userEvent.click(screen.getByRole("button", { name: /log keluar/i }));
    expect(logout).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /log masuk/i })).toBeInTheDocument();
  });

  it("shows a retry screen, not the login form, when the load fails for a non-auth reason", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockRejectedValue(new Error("network down"));
    render(<AdminApp retryOpts={fastRetry} />);
    expect(await screen.findByRole("button", { name: /cuba lagi/i })).toBeInTheDocument();
    // Being dumped to the login form implies "your session expired", which is a lie.
    expect(screen.queryByRole("button", { name: /log masuk/i })).not.toBeInTheDocument();
  });

  it("does not retry a 401 — an expired session is not a transient failure", async () => {
    const getAdminEvents = vi.spyOn(adminApi, "getAdminEvents").mockRejectedValue(new adminApi.UnauthorizedError());
    render(<AdminApp retryOpts={fastRetry} />);
    expect(await screen.findByRole("button", { name: /log masuk/i })).toBeInTheDocument();
    expect(getAdminEvents).toHaveBeenCalledTimes(1);
  });

  it("recovers from a failed load when the retry button is pressed", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockRejectedValue(new Error("network down"));
    render(<AdminApp retryOpts={fastRetry} />);
    const retry = await screen.findByRole("button", { name: /cuba lagi/i });

    vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
    await userEvent.click(retry);

    expect(await screen.findByLabelText(/nama akad/i)).toBeInTheDocument();
  });

  it("logs in and shows the events view", async () => {
    vi.spyOn(adminApi, "adminLogin").mockResolvedValue("ok");
    vi.spyOn(adminApi, "getAdminEvents").mockRejectedValueOnce(new adminApi.UnauthorizedError()).mockResolvedValue(events);
    render(<AdminApp />);
    await screen.findByRole("button", { name: /log masuk/i });
    await userEvent.type(screen.getByLabelText(/nama pengguna/i), "admin");
    await userEvent.type(screen.getByLabelText(/kata laluan/i), "pw");
    await userEvent.click(screen.getByRole("button", { name: /log masuk/i }));
    expect(await screen.findByLabelText(/nama akad/i)).toBeInTheDocument();
  });

  it("navigates to the photos view and loads the current filter's page 0", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
    const getAdminPhotos = vi
      .spyOn(adminApi, "getAdminPhotos")
      .mockResolvedValue({ photos: [], hasMore: false, counts: [] });
    render(<AdminApp />);
    await screen.findByLabelText(/nama akad/i);
    await userEvent.click(screen.getByRole("button", { name: /^gambar$/i }));
    expect(await screen.findByRole("heading", { name: /gambar/i })).toBeInTheDocument();
    expect(getAdminPhotos).toHaveBeenCalledWith(0, "all");
  });

  it("navigates to the share view and loads the share link and starred count", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
    vi.spyOn(adminApi, "getAdminPhotos").mockResolvedValue({ photos: [], hasMore: false, counts: [] });
    vi.spyOn(adminApi, "getShareLink").mockResolvedValue({ token: "tok", url: "https://x/share/tok", starredCount: 9 });
    render(<AdminApp />);
    await screen.findByLabelText(/nama akad/i);
    await userEvent.click(screen.getByRole("button", { name: /pautan kongsi/i }));
    expect(await screen.findByDisplayValue("https://x/share/tok")).toBeInTheDocument();
    expect(screen.getByText(/9/)).toBeInTheDocument();
  });

  // GET is a pure read now, so the very first visit finds no token and the
  // client has to mint one over POST.
  it("creates the share link over POST when none exists yet", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
    vi.spyOn(adminApi, "getAdminPhotos").mockResolvedValue({ photos: [], hasMore: false, counts: [] });
    vi.spyOn(adminApi, "getShareLink").mockResolvedValue({ token: null, url: null, starredCount: 4 });
    const regenerate = vi
      .spyOn(adminApi, "regenerateShareLink")
      .mockResolvedValue({ token: "fresh", url: "https://x/share/fresh", starredCount: 4 });
    render(<AdminApp />);
    await screen.findByLabelText(/nama akad/i);
    await userEvent.click(screen.getByRole("button", { name: /pautan kongsi/i }));
    expect(await screen.findByDisplayValue("https://x/share/fresh")).toBeInTheDocument();
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("does not POST when a share link already exists", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
    vi.spyOn(adminApi, "getAdminPhotos").mockResolvedValue({ photos: [], hasMore: false, counts: [] });
    vi.spyOn(adminApi, "getShareLink").mockResolvedValue({ token: "tok", url: "https://x/share/tok", starredCount: 1 });
    const regenerate = vi.spyOn(adminApi, "regenerateShareLink");
    render(<AdminApp />);
    await screen.findByLabelText(/nama akad/i);
    await userEvent.click(screen.getByRole("button", { name: /pautan kongsi/i }));
    await screen.findByDisplayValue("https://x/share/tok");
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("does not crash when a photos page load fails after navigating to the photos view", async () => {
    vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
    vi.spyOn(adminApi, "getAdminPhotos").mockResolvedValue({ photos: [], hasMore: false, counts: [{ eventId: "e1", name: "Akad", count: 0 }] });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AdminApp />);
    await screen.findByLabelText(/nama akad/i);
    await userEvent.click(screen.getByRole("button", { name: /^gambar$/i }));
    await screen.findByRole("heading", { name: /gambar/i });

    vi.spyOn(adminApi, "getAdminPhotos").mockRejectedValue(new Error("network down"));
    await userEvent.selectOptions(screen.getByLabelText(/tapis mengikut acara/i), "e1");

    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("load photos failed:", expect.any(Error)));
    // The view is still intact — a rejected filter refetch didn't blow up the tree.
    expect(screen.getByRole("heading", { name: /gambar/i })).toBeInTheDocument();
  });
});

 it("reuses visited pages and remembers the page across admin tabs", async () => {
   vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
   const get = vi.spyOn(adminApi, "getAdminPhotos").mockImplementation(async (page) => ({
     photos: [{ id: `p${page}`, guestName: `Guest ${page}`, eventId: "e1", eventName: "Akad", message: null,
       imageUrl: "https://r2/test.jpg", starred: false, capturedAt: "2026-10-01T00:00:00Z" }],
     hasMore: page === 0, counts: [{ eventId: "e1", name: "Akad", count: 120 }], total: 120,
   }));
   render(<AdminApp />);
   await screen.findByLabelText(/nama akad/i);
   await userEvent.click(screen.getByRole("button", { name: /^gambar$/i }));
   await screen.findByText("Guest 0");
   await userEvent.click(screen.getAllByRole("button", { name: "Halaman 2" })[0]);
   await screen.findByText("Guest 1");
   expect(screen.queryByText("Guest 0")).not.toBeInTheDocument();
   await userEvent.click(screen.getAllByRole("button", { name: "Halaman 1" })[0]);
   await screen.findByText("Guest 0");
   await userEvent.click(screen.getAllByRole("button", { name: "Halaman 2" })[0]);
   await userEvent.click(screen.getByRole("button", { name: "Acara" }));
   await screen.findByLabelText(/nama akad/i);
   await userEvent.click(screen.getByRole("button", { name: /^gambar$/i }));
   await screen.findByText("Guest 1");
   expect(get).toHaveBeenCalledTimes(2);
 });

it("keeps a confirmed star when an older photo refresh finishes afterwards", async () => {
  vi.spyOn(adminApi, "getAdminEvents").mockResolvedValue(events);
  const response = {
    photos: [{ id: "p1", guestName: "Ahmad", eventId: "e1", eventName: "Akad", message: null,
      imageUrl: "https://r2/test.jpg", starred: false, capturedAt: "2026-10-01T00:00:00Z" }],
    hasMore: false, counts: [{ eventId: "e1", name: "Akad", count: 1 }],
  };
  let finishRefresh!: (result: typeof response) => void;
  vi.spyOn(adminApi, "getAdminPhotos").mockResolvedValueOnce(response)
    .mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
  const star = vi.spyOn(adminApi, "setStarred").mockResolvedValue(undefined);
  render(<AdminApp />);
  await screen.findByLabelText(/nama akad/i);
  await userEvent.click(screen.getByRole("button", { name: /^gambar$/i }));
  await screen.findByText("Ahmad");
  await userEvent.click(screen.getByRole("button", { name: "Muat semula gambar" }));
  await userEvent.click(screen.getByRole("button", { name: "Bintang Ahmad" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Nyahbintang Ahmad" })).toBeEnabled());
  finishRefresh(response);
  await waitFor(() => expect(screen.queryByText("Memuatkan halaman…")).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Nyahbintang Ahmad" }));
  expect(star).toHaveBeenLastCalledWith("p1", false);
});
