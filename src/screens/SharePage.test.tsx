import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SharePage } from "./SharePage";
import * as api from "../lib/apiClient";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SharePage", () => {
  it("fetches on mount and renders the heading plus a photo grid on success", async () => {
    vi.spyOn(api, "getShare").mockResolvedValue({
      photos: [
        { id: "p1", imageUrl: "https://r2/1.jpg", capturedAt: "2026-09-19T05:00:00Z" },
        { id: "p2", imageUrl: "https://r2/2.jpg", capturedAt: "2026-09-19T06:00:00Z" },
      ],
    });
    render(<SharePage token="goodtoken" />);
    expect(await screen.findByText("Detik-detik pilihan kami ❤️")).toBeInTheDocument();
    expect(api.getShare).toHaveBeenCalledWith("goodtoken");
    expect(await screen.findAllByRole("img")).toHaveLength(2);
  });

  // The share page can hold up to 1,000 full-size photos; without lazy loading
  // one visit downloads every one of them (2026-10-01, ahead of larger files).
  it("loads grid photos lazily, as the guest scrolls", async () => {
    vi.spyOn(api, "getShare").mockResolvedValue({
      photos: [{ id: "p1", imageUrl: "https://r2/1.jpg", capturedAt: "2026-09-19T05:00:00Z" }],
    });
    render(<SharePage token="goodtoken" />);
    const img = await screen.findByRole("img");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
  });

  it("renders 'Pautan tidak sah.' on any failure", async () => {
    vi.spyOn(api, "getShare").mockRejectedValue(new Error("getShare failed: 404"));
    render(<SharePage token="badtoken" />);
    expect(await screen.findByText("Pautan tidak sah.")).toBeInTheDocument();
  });
});
