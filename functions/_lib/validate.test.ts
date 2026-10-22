import { describe, it, expect } from "vitest";
import { isUuid, isStorageKeyFor, isJsonObject } from "./validate";

describe("isUuid", () => {
  it("accepts a v4 uuid in either case", () => {
    expect(isUuid("5fc52acd-6552-4632-bd99-7bac695d5b44")).toBe(true);
    expect(isUuid("5FC52ACD-6552-4632-BD99-7BAC695D5B44")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isUuid("evt-1")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid("5fc52acd-6552-4632-bd99-7bac695d5b44 ")).toBe(false);
  });
});

describe("isStorageKeyFor", () => {
  const evt = "5fc52acd-6552-4632-bd99-7bac695d5b44";

  it("accepts exactly what /api/presign mints for that event", () => {
    expect(isStorageKeyFor(evt, `${evt}/11111111-1111-4111-8111-111111111111.jpg`)).toBe(true);
  });

  it("rejects another event's prefix, traversal, and wrong shapes", () => {
    const other = "27c3b464-8e09-4ffd-8788-b56b15edd68b";
    expect(isStorageKeyFor(evt, `${other}/11111111-1111-4111-8111-111111111111.jpg`)).toBe(false);
    expect(isStorageKeyFor(evt, `${evt}/../secret.jpg`)).toBe(false);
    // Valid v4 filename here so this isolates the "extra path segment" rule alone —
    // a non-v4 filename would fail this case for two reasons at once.
    expect(isStorageKeyFor(evt, `${evt}/nested/11111111-1111-4111-8111-111111111111.jpg`)).toBe(false);
    expect(isStorageKeyFor(evt, `${evt}/photo.png`)).toBe(false);
    expect(isStorageKeyFor(evt, evt)).toBe(false);
    expect(isStorageKeyFor(evt, undefined)).toBe(false);
  });

  it("rejects a trailing slash and a double extension", () => {
    expect(isStorageKeyFor(evt, `${evt}/11111111-1111-4111-8111-111111111111.jpg/`)).toBe(false);
    expect(isStorageKeyFor(evt, `${evt}/11111111-1111-4111-8111-111111111111.jpg.png`)).toBe(false);
  });

  it("rejects non-string keys: boolean, array, plain object", () => {
    expect(isStorageKeyFor(evt, true)).toBe(false);
    expect(isStorageKeyFor(evt, ["a"])).toBe(false);
    expect(isStorageKeyFor(evt, { a: 1 })).toBe(false);
  });

  it("rejects an empty eventId even if the key shape would otherwise match", () => {
    // Defence in depth: without this, "" as eventId would accept the key
    // "/<uuid>.jpg", since "" equals the first split segment of that string.
    expect(isStorageKeyFor("", `/11111111-1111-4111-8111-111111111111.jpg`)).toBe(false);
  });
});

describe("isJsonObject", () => {
  it("accepts plain objects", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
  });

  it("rejects null, arrays, and bare primitives", () => {
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([1, 2])).toBe(false);
    expect(isJsonObject("x")).toBe(false);
    expect(isJsonObject(42)).toBe(false);
    expect(isJsonObject(true)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});
