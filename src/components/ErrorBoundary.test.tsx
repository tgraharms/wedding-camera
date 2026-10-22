import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("boom");
}

afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>selamat</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("selamat")).toBeInTheDocument();
  });

  it("shows a recovery screen instead of a blank page when a child throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText(/ada masalah/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /muat semula/i })).toBeInTheDocument();
  });
});
