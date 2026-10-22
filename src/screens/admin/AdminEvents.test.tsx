import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminEvents } from "./AdminEvents";
import type { EventInfo } from "../../lib/types";

const events: EventInfo[] = [
  { id: "e1", name: "Akad", windowStart: "2026-07-01T00:00:00.000Z", windowEnd: "2026-07-01T04:00:00.000Z", count: 3 },
];

beforeEach(() => vi.restoreAllMocks());

describe("AdminEvents", () => {
  it("renders a row per event with its photo count", () => {
    render(<AdminEvents events={events} onSave={vi.fn()} onDelete={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByLabelText(/nama akad/i)).toHaveValue("Akad");
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("saves a row's edits with ISO windowStart/windowEnd", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<AdminEvents events={events} onSave={onSave} onDelete={vi.fn()} onCreate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /simpan akad/i }));
    expect(onSave).toHaveBeenCalledWith({
      eventId: "e1",
      name: "Akad",
      windowStart: "2026-07-01T00:00:00.000Z",
      windowEnd: "2026-07-01T04:00:00.000Z",
    });
  });

  it("creates a new event with ISO windowStart/windowEnd from datetime-local inputs", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<AdminEvents events={[]} onSave={vi.fn()} onDelete={vi.fn()} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/nama acara baharu/i), "Sanding");
    const start = screen.getByLabelText(/mula acara baharu/i);
    const end = screen.getByLabelText(/tamat acara baharu/i);
    // fireEvent-style direct value set for datetime-local, then a change event via userEvent.type is
    // unreliable across browsers for this input type — set via userEvent.type on a text-compatible flow.
    await userEvent.type(start, "2026-07-02T10:00");
    await userEvent.type(end, "2026-07-02T14:00");
    await userEvent.click(screen.getByRole("button", { name: /tambah acara/i }));
    expect(onCreate).toHaveBeenCalledWith({
      name: "Sanding",
      windowStart: new Date("2026-07-02T10:00").toISOString(),
      windowEnd: new Date("2026-07-02T14:00").toISOString(),
    });
  });

  it("shows the server's overlap error when create is rejected", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("windows overlap"));
    render(<AdminEvents events={[]} onSave={vi.fn()} onDelete={vi.fn()} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/nama acara baharu/i), "Sanding");
    await userEvent.type(screen.getByLabelText(/mula acara baharu/i), "2026-07-02T10:00");
    await userEvent.type(screen.getByLabelText(/tamat acara baharu/i), "2026-07-02T14:00");
    await userEvent.click(screen.getByRole("button", { name: /tambah acara/i }));
    expect(await screen.findByText(/windows overlap/i)).toBeInTheDocument();
  });

  it("deletes without confirmation when the event has no photos", async () => {
    const empty: EventInfo[] = [{ id: "e2", name: "Resepsi", windowStart: null, windowEnd: null, count: 0 }];
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<AdminEvents events={empty} onSave={vi.fn()} onDelete={onDelete} onCreate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /padam resepsi/i }));
    expect(onDelete).toHaveBeenCalledWith("e2");
  });

  it("confirms before deleting an event that has photos, and skips delete when declined", async () => {
    const onDelete = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<AdminEvents events={events} onSave={vi.fn()} onDelete={onDelete} onCreate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /padam akad/i }));
    expect(window.confirm).toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("surfaces the server's 409 message when delete is rejected", async () => {
    const empty: EventInfo[] = [{ id: "e2", name: "Resepsi", windowStart: null, windowEnd: null, count: 0 }];
    const onDelete = vi.fn().mockRejectedValue(new Error("event has photos"));
    render(<AdminEvents events={empty} onSave={vi.fn()} onDelete={onDelete} onCreate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /padam resepsi/i }));
    expect(await screen.findByText(/event has photos/i)).toBeInTheDocument();
  });
});
