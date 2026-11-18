import { describe, expect, it } from "vitest";
import { robotsAllows, robotsDisallow } from "./robots.ts";

describe("robots", () => {
  it("a disallowed prefix is refused and a sibling path allowed", () => {
    const disallow = robotsDisallow("User-agent: *\nDisallow: /private/\n");
    expect(disallow).toEqual(["/private/"]);
    expect(robotsAllows(disallow, "/private/minutes")).toBe(false);
    expect(robotsAllows(disallow, "/private/")).toBe(false);
    expect(robotsAllows(disallow, "/privately")).toBe(true);
    expect(robotsAllows(disallow, "/public/board")).toBe(true);
  });

  it("another agent's group is ignored", () => {
    const text = [
      "User-agent: BadBot",
      "Disallow: /",
      "",
      "User-agent: *",
      "Disallow: /drafts",
      "",
      "User-agent: OtherBot",
      "Disallow: /people",
    ].join("\n");
    const disallow = robotsDisallow(text);
    expect(disallow).toEqual(["/drafts"]);
    expect(robotsAllows(disallow, "/people/mara-ellison")).toBe(true);
    expect(robotsAllows(disallow, "/drafts/one")).toBe(false);
  });

  it("an empty file allows everything, and so does an empty Disallow", () => {
    expect(robotsDisallow("")).toEqual([]);
    expect(robotsAllows(robotsDisallow(""), "/anything")).toBe(true);
    const disallow = robotsDisallow("User-agent: *\nDisallow:\n");
    expect(disallow).toEqual([]);
    expect(robotsAllows(disallow, "/anything")).toBe(true);
  });

  it("a 600-line file is cut at 500 lines and still answers", () => {
    const lines = ["User-agent: *", ...Array.from({ length: 599 }, (_, n) => `Disallow: /p${n}/`)];
    const disallow = robotsDisallow(lines.join("\n"));
    expect(disallow).toHaveLength(499);
    expect(robotsAllows(disallow, "/p0/x")).toBe(false);
    expect(robotsAllows(disallow, "/p498/x")).toBe(false);
    // Line 501 and after are not read.
    expect(robotsAllows(disallow, "/p499/x")).toBe(true);
  });

  it("reads keys in any case, with comments, CRLF line ends and groups of several agents", () => {
    const text = [
      "# a comment",
      "user-agent: OtherBot",
      "USER-AGENT: *   # us too",
      "disallow: /a   # the first",
      "Allow: /a/open",
      "Crawl-delay: 5",
      "",
      "User-agent: *",
      "Disallow: /b",
    ].join("\r\n");
    const disallow = robotsDisallow(text);
    expect(disallow).toEqual(["/a", "/b"]);
    // Allow is not read: a site's wish not to be fetched is kept whole.
    expect(robotsAllows(disallow, "/a/open")).toBe(false);
  });

  it("a byte order mark before the first line is not part of its key", () => {
    expect(robotsDisallow("\uFEFFUser-agent: *\nDisallow: /\n")).toEqual(["/"]);
  });

  it("a rule's * matches any run and a final $ anchors it", () => {
    const disallow = robotsDisallow("User-agent: *\nDisallow: /*.pdf$\nDisallow: /files/*/secret\n");
    expect(robotsAllows(disallow, "/reports/2025.pdf")).toBe(false);
    expect(robotsAllows(disallow, "/reports/2025.pdf?x=1")).toBe(true);
    expect(robotsAllows(disallow, "/files/a/b/secret/one")).toBe(false);
    expect(robotsAllows(disallow, "/files/secret")).toBe(true);
  });

  it("a rule over 512 characters is cut to its first 512, so it refuses more, never less", () => {
    const long = `/${"a".repeat(600)}`;
    const disallow = robotsDisallow(`User-agent: *\nDisallow: ${long}\n`);
    expect(disallow).toEqual([long.slice(0, 512)]);
    expect(robotsAllows(disallow, `/${"a".repeat(511)}b`)).toBe(false);
  });
});

describe("robots against a hostile file", () => {
  it("a rule of many stars over a long path answers at once", () => {
    const disallow = robotsDisallow(`User-agent: *\nDisallow: /${"*a".repeat(200)}b\n`);
    const started = performance.now();
    expect(robotsAllows(disallow, `/${"a".repeat(2000)}`)).toBe(true);
    // A backtracking match of this rule takes years: the bound only needs to tell that from a slow machine.
    expect(performance.now() - started).toBeLessThan(4_000);
  });
});
