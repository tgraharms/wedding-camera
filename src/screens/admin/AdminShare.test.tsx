import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminShare } from "./AdminShare";

beforeEach(() => vi.restoreAllMocks());

describe("AdminShare", () => {
  it("shows the url read-only and the starred count", () => {
    render(<AdminShare url="https://x/share/tok" starredCount={4} onRegenerate={vi.fn()} />);
    const input = screen.getByLabelText(/pautan kongsi/i) as HTMLInputElement;
    expect(input).toHaveValue("https://x/share/tok");
    expect(input).toHaveAttribute("readonly");
    expect(screen.getByText(/4/)).toBeInTheDocument();
  });

  it("copies the url to the clipboard on Salin", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AdminShare url="https://x/share/tok" starredCount={0} onRegenerate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /salin/i }));
    expect(writeText).toHaveBeenCalledWith("https://x/share/tok");
  });

  it("asks for confirmation before regenerating, and skips the call when declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onRegenerate = vi.fn();
    render(<AdminShare url="https://x/share/tok" starredCount={0} onRegenerate={onRegenerate} />);
    await userEvent.click(screen.getByRole("button", { name: /jana semula/i }));
    expect(window.confirm).toHaveBeenCalled();
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it("regenerates when confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    render(<AdminShare url="https://x/share/tok" starredCount={0} onRegenerate={onRegenerate} />);
    await userEvent.click(screen.getByRole("button", { name: /jana semula/i }));
    expect(onRegenerate).toHaveBeenCalled();
  });
});
