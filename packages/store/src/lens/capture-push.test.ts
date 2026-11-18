import { describe, expect, it } from "vitest";
import { boxHostOf, defaultAdmits, neverDefault } from "./capture-push.ts";

// Synthetic hosts on reserved names alone.

const BOX = "box.example.test";

describe("neverDefault", () => {
  it("is true for a sign-in host, an identity provider's host and an agent's web page or a host under one", () => {
    for (const host of [
      "login.example.com",
      "LOGIN.example.com.",
      "accounts.example.com",
      "id.example.org",
      "auth.example.net",
      "claude.ai",
      "chat.chatgpt.com",
      "chatgpt.com",
      "gemini.google.com",
    ]) {
      expect(neverDefault(host, BOX), host).toBe(true);
    }
  });

  it("is true for the box's own host and every host under it, and false for a sibling or the host above", () => {
    expect(neverDefault(BOX, BOX)).toBe(true);
    expect(neverDefault("Box.Example.Test.", BOX)).toBe(true);
    expect(neverDefault("api.box.example.test", BOX)).toBe(true);
    // The controls: a sibling that ends with the same letters, and the host above.
    expect(neverDefault("notbox.example.test", BOX)).toBe(false);
    expect(neverDefault("example.test", BOX)).toBe(false);
  });

  it("is true for every host when the box's own host is not known, and for no host at all", () => {
    for (const host of ["www.example.com", "docs.example.org"]) expect(neverDefault(host, undefined), host).toBe(true);
    expect(neverDefault(undefined, BOX)).toBe(true);
    expect(neverDefault("", BOX)).toBe(true);
  });

  it("is true for a host of one label and an address of digits, which no exclusion can name", () => {
    for (const host of ["localhost", "wiki", "127.0.0.1", "192.168.1.20", "[::1]", "::1"])
      expect(neverDefault(host, BOX), host).toBe(true);
  });

  it("is false for an ordinary host when the box's own host is known", () => {
    for (const host of ["www.example.com", "news.example.org", "loginpage.example.com", "docs.example.net"])
      expect(neverDefault(host, BOX), host).toBe(false);
  });
});

describe("defaultAdmits", () => {
  const SAFARI = "com.apple.Safari";
  it("admits a browser's block with a host on a deny device, and nothing on an allow device", () => {
    expect(defaultAdmits({ deny: true, boxHost: BOX }, SAFARI, "www.example.com")).toBe(true);
    expect(defaultAdmits({ deny: false, boxHost: BOX }, SAFARI, "www.example.com")).toBe(false);
  });

  it("admits no app's block that is no browser's, no browser's block with no host, and no host R171 keeps out", () => {
    const deny = { deny: true, boxHost: BOX };
    expect(defaultAdmits(deny, "test.example.notes", "www.example.com")).toBe(false);
    expect(defaultAdmits(deny, SAFARI, undefined)).toBe(false);
    expect(defaultAdmits(deny, SAFARI, "login.example.com")).toBe(false);
    expect(defaultAdmits(deny, SAFARI, "claude.ai")).toBe(false);
    expect(defaultAdmits(deny, SAFARI, BOX)).toBe(false);
    expect(defaultAdmits({ deny: true, boxHost: undefined }, SAFARI, "www.example.com")).toBe(false);
  });
});

describe("boxHostOf", () => {
  it("is the host of a bare https origin, and undefined for an unset, empty or malformed value", () => {
    expect(boxHostOf("https://Box.Example.Test")).toBe(BOX);
    expect(boxHostOf("https://box.example.test/")).toBe(BOX);
    for (const value of [
      undefined,
      "",
      "http://box.example.test",
      "box.example.test",
      "https://box.example.test/path",
      "https://user:pw@box.example.test",
      "https://box.example.test?x",
      "https://box.example.test#x",
      "not a url",
    ]) {
      expect(boxHostOf(value), String(value)).toBeUndefined();
    }
  });
});
