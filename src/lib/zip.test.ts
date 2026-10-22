import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadZip } from "client-zip";
import { downloadGalleryZip } from "./zip";
import type { AdminPhoto } from "./types";

vi.mock("client-zip", async () => {
  const actual = await vi.importActual<typeof import("client-zip")>("client-zip");
  return { ...actual, downloadZip: vi.fn(actual.downloadZip) };
});

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());

function photo(id: string, guestName: string | null = "Ahmad"): AdminPhoto {
  return {
    id, eventId: "e1", eventName: "Akad", guestName, message: null,
    imageUrl: `https://r2/${id}.jpg?s`, starred: false,
    capturedAt: "2026-06-12T12:30:00.000Z",
  };
}

describe("downloadGalleryZip", () => {
  it("fetches each photo and triggers a single zip download", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["img"]), { status: 200 })));
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:zip");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.fn();
    vi.spyOn(document, "createElement").mockReturnValue({
      click,
      href: "",
      download: "",
      style: {} as CSSStyleDeclaration,
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement);
    vi.spyOn(document.body, "appendChild").mockImplementation(((n: Node) => n) as never);

    await downloadGalleryZip([photo("a"), photo("b")], "galeri.zip");

    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
  });

  it("names entries with the guest name, falling back to tanpa-nama when null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["img"]), { status: 200 })));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:zip");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(document, "createElement").mockReturnValue({
      click: vi.fn(),
      href: "",
      download: "",
      style: {} as CSSStyleDeclaration,
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement);
    vi.spyOn(document.body, "appendChild").mockImplementation(((n: Node) => n) as never);

    await downloadGalleryZip([photo("a", "Ahmad"), photo("b", null)], "galeri.zip");

    const calls = vi.mocked(downloadZip).mock.calls;
    const entries = calls[calls.length - 1][0] as { name: string }[];
    expect(entries.map((e) => e.name)).toEqual(["Ahmad-a.jpg", "tanpa-nama-b.jpg"]);
  });

  it("does nothing for an empty list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await downloadGalleryZip([], "galeri.zip");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
