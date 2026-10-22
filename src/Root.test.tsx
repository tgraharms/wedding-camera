import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Root } from "./Root";
import * as api from "./lib/apiClient";
import * as adminApi from "./lib/adminClient";
import * as session from "./lib/session";

vi.mock("./screens/SharePage", () => ({
  SharePage: ({ token }: { token: string }) => <div>SharePage:{token}</div>,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "getStatus").mockResolvedValue({ state: "open", eventId: "e1", eventName: "Akad" });
  // Explicit 401 rather than relying on an unmocked fetch failing: a network
  // error now routes to the retry screen, so only a real 401 yields the login form.
  vi.spyOn(adminApi, "getAdminEvents").mockRejectedValue(new adminApi.UnauthorizedError());
});

describe("Root", () => {
  it("renders the admin app for /admin", async () => {
    render(<Root pathname="/admin" />);
    expect(await screen.findByRole("button", { name: /log masuk/i })).toBeInTheDocument();
  });

  it("renders the guest app otherwise", async () => {
    render(<Root pathname="/" />);
    expect(await screen.findByRole("button", { name: /muat naik gambar/i })).toBeInTheDocument();
  });

  it("renders SharePage for /share/<token>", async () => {
    render(<Root pathname="/share/abc" />);
    expect(await screen.findByText("SharePage:abc")).toBeInTheDocument();
  });

  it("catches a render crash in the guest app and shows the recovery screen, not a blank page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(session, "loadProfile").mockImplementation(() => {
      throw new Error("storage exploded");
    });
    render(<Root pathname="/" />);
    expect(await screen.findByText(/ada masalah/i)).toBeInTheDocument();
  });
});
