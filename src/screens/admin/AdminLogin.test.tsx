import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminLogin } from "./AdminLogin";

async function submit(onLogin: (u: string, p: string) => Promise<"ok" | "invalid" | "rate-limited" | "error">) {
  render(<AdminLogin onLogin={onLogin} />);
  await userEvent.type(screen.getByLabelText(/nama pengguna/i), "admin");
  await userEvent.type(screen.getByLabelText(/kata laluan/i), "pw");
  await userEvent.click(screen.getByRole("button", { name: /log masuk/i }));
}

describe("AdminLogin", () => {
  it("submits username and password", async () => {
    const onLogin = vi.fn().mockResolvedValue("ok");
    await submit(onLogin);
    expect(onLogin).toHaveBeenCalledWith("admin", "pw");
    expect(screen.queryByText(/gagal|cubaan|rangkaian/i)).not.toBeInTheDocument();
  });

  it("says the credentials are wrong on an invalid login", async () => {
    await submit(vi.fn().mockResolvedValue("invalid"));
    expect(await screen.findByText(/kata laluan salah/i)).toBeInTheDocument();
  });

  it("says to wait a minute when the login is rate-limited, not that the password is wrong", async () => {
    await submit(vi.fn().mockResolvedValue("rate-limited"));
    expect(await screen.findByText(/terlalu banyak cubaan/i)).toBeInTheDocument();
    expect(screen.queryByText(/kata laluan salah/i)).not.toBeInTheDocument();
  });

  it("blames the network on a server or connection error", async () => {
    await submit(vi.fn().mockResolvedValue("error"));
    expect(await screen.findByText(/rangkaian/i)).toBeInTheDocument();
  });

  it("ignores a second tap while a login is in flight (each attempt costs one of 5/min)", async () => {
    let resolve!: (r: "ok") => void;
    const onLogin = vi.fn(() => new Promise<"ok">((r) => { resolve = r; }));
    render(<AdminLogin onLogin={onLogin} />);
    await userEvent.type(screen.getByLabelText(/nama pengguna/i), "admin");
    await userEvent.type(screen.getByLabelText(/kata laluan/i), "pw");
    const button = screen.getByRole("button", { name: /log masuk/i });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(onLogin).toHaveBeenCalledTimes(1);
    resolve("ok");
  });

  it("shows the network message instead of an unhandled rejection when onLogin throws", async () => {
    await submit(vi.fn().mockRejectedValue(new Error("Failed to fetch")));
    expect(await screen.findByText(/rangkaian/i)).toBeInTheDocument();
  });
});
