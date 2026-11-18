import { describe, expect, it } from "vitest";
import { normalizeAddress, strictAddress } from "./addresses.ts";

describe("normalizeAddress", () => {
  it("upper and lower case addresses are one address", () => {
    expect(normalizeAddress("Alex@Example.COM")).toBe("alex@example.com");
    expect(normalizeAddress("  alex@example.com ")).toBe("alex@example.com");
    expect(normalizeAddress("Alex@Example.COM")).toBe(normalizeAddress("alex@example.com"));
  });

  it("an address without a dot in its domain is refused", () => {
    expect(normalizeAddress("alex@example.com")).toBe("alex@example.com");
    expect(normalizeAddress("alex@localhost")).toBeNull();
    // The other forms the rule names: no local part, two "@", an empty label.
    for (const text of [
      "@example.com",
      "alex@lab@example.com",
      "alex@example..com",
      "alex@.example.com",
      "alex@example.com.",
      "alex",
      "",
    ]) {
      expect(normalizeAddress(text), text).toBeNull();
    }
  });
});

describe("strictAddress", () => {
  it("strictAddress refuses a display name, a comma, a line break and a non-ASCII character, which normalizeAddress accepts", () => {
    for (const text of [
      "Lee Example <lee@example.com>",
      "lee,kim@example.com",
      "lee\nx@example.com",
      "l\u00e9e@example.com",
    ]) {
      expect(normalizeAddress(text), text).not.toBeNull();
      expect(strictAddress(text), text).toBe(false);
    }
    // The controls: plain addresses, one with a plus and dots, and mixed case.
    for (const text of ["lee@example.com", "lee.kim+alpha@mail.example.org", "Lee@Example.COM"])
      expect(strictAddress(text), text).toBe(true);
    // And what neither shape is: no "@", two, an empty part, a one-label domain, white space.
    for (const text of [
      "lee",
      "lee@@example.com",
      "@example.com",
      "lee@",
      "lee@example",
      " lee@example.com",
      "lee@example..com",
      '"lee"@example.com',
    ])
      expect(strictAddress(text), text).toBe(false);
  });
});
