import { describe, expect, it } from "vitest";
import { byText } from "./compare.ts";
import { sha256 } from "./hash.ts";

describe("byText", () => {
  it("orders by code unit, as the C collation does: upper case before lower, a prefix first", () => {
    expect(["b", "a", "B", "aa", ""].sort(byText)).toEqual(["", "B", "a", "aa", "b"]);
    expect(byText("x", "x")).toBe(0);
  });
});

describe("sha256", () => {
  it("is the hex digest of text as UTF-8, and the same of the same bytes", () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(sha256("")).toBe(empty);
    expect(sha256(new Uint8Array())).toBe(empty);
    expect(sha256("é")).toBe(sha256(new TextEncoder().encode("é")));
  });
});
