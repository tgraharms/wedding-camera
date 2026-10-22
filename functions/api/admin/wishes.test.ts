import { expect, it, vi } from "vitest";
import { makeAdminWishesHandler } from "./wishes";

function setup(rows: unknown[], error: { message: string } | null = null, authorized = true) {
  const range = vi.fn().mockResolvedValue({ data: rows, error });
  const query = { select: vi.fn(), not: vi.fn(), order: vi.fn(), range };
  query.select.mockReturnValue(query); query.not.mockReturnValue(query); query.order.mockReturnValue(query);
  const from = vi.fn().mockReturnValue(query);
  const handler = makeAdminWishesHandler(async () => authorized ? "admin" : null, () => ({ from }) as never);
  return { handler, from, range };
}
it("requires admin authentication before reading wishes", async () => {
  const { handler, from } = setup([], null, false);
  expect((await handler(new Request("https://x/api/admin/wishes"), {} as never)).status).toBe(401);
  expect(from).not.toHaveBeenCalled();
});
it("reads wishes directly from guest profiles including guests without photos", async () => {
  const { handler, from } = setup([
    { session_id: "g1", display_name: "Ahmad", message: "Tahniah!" },
    { session_id: "g2", display_name: "Ahmad", message: "Tahniah!" },
    { session_id: "g3", display_name: null, message: "  " },
  ]);
  const response = await handler(new Request("https://x/api/admin/wishes"), {} as never);
  expect(await response.json()).toEqual({ wishes: [
    { guestId: "g1", guestName: "Ahmad", message: "Tahniah!" },
    { guestId: "g2", guestName: "Ahmad", message: "Tahniah!" },
  ], hasMore: false });
  expect(from).toHaveBeenCalledWith("guests");
});
it("paginates without the 1000-row ceiling dropping wishes", async () => {
  const { handler, range } = setup(Array.from({ length: 201 }, (_, i) => ({ session_id: String(i), message: "Hi" })));
  const response = await handler(new Request("https://x/api/admin/wishes?page=5"), {} as never);
  const result = await response.json() as { wishes: unknown[]; hasMore: boolean };
  expect(range).toHaveBeenCalledWith(1000, 1200);
  expect(result.wishes).toHaveLength(200);
  expect(result.hasMore).toBe(true);
});
it("reports database errors and rejects invalid pages", async () => {
  const { handler } = setup([], { message: "offline" });
  expect((await handler(new Request("https://x/api/admin/wishes"), {} as never)).status).toBe(500);
  expect((await handler(new Request("https://x/api/admin/wishes?page=-1"), {} as never)).status).toBe(400);
});
