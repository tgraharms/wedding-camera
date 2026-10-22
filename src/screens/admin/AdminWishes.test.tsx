import { it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../../lib/adminClient";
import { AdminWishes } from "./AdminWishes";
beforeEach(() => vi.restoreAllMocks());
it("collects wishes once per profile, searches names and text, and exports all wishes", async () => {
  vi.spyOn(api, "getAdminWishes").mockResolvedValue([
    { guestId: "1", guestName: "Ahmad", message: "Tahniah!" },
    { guestId: "2", guestName: null, message: "Semoga bahagia ❤️" },
  ]);
  render(<AdminWishes />);
  await screen.findByText("Tahniah!");
  expect(screen.getByText("2 ucapan")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Cari nama atau ucapan"), "bahagia");
  expect(screen.queryByText("Tahniah!")).not.toBeInTheDocument();
  expect(screen.getByText("Semoga bahagia ❤️")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Simpan semua ucapan (.txt)" })).toBeEnabled();
});
it("shows load errors and allows retry", async () => {
  vi.spyOn(api, "getAdminWishes").mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
  render(<AdminWishes />);
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "Cuba semula" }));
  expect(await screen.findByText("Belum ada ucapan.")).toBeInTheDocument();
});
