import { describe, it, expect } from "vitest";
import { formatStamp } from "./config";

describe("config", () => {
  it("formats a timestamp in a readable Malay-friendly form", () => {
    const stamp = formatStamp(new Date("2026-06-12T12:30:00.000Z"), "Asia/Kuala_Lumpur");
    expect(stamp).toBe("12 Jun 2026, 8:30 PM");
  });
});
