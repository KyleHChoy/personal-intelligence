import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeLink, safeLink } from "./safe-link.ts";

// A call or invite address is a link only on the fixed hosts, over https.

describe("safeLink", () => {
  it("allows https on each listed host and its subdomains", () => {
    expect(safeLink("https://meet.google.com/abc-defg-hij")).toBe("https://meet.google.com/abc-defg-hij");
    expect(safeLink(" https://us02web.zoom.us/j/123?pwd=x ")).toBe("https://us02web.zoom.us/j/123?pwd=x");
    expect(safeLink("https://teams.microsoft.com/l/meetup-join/1")).toBe("https://teams.microsoft.com/l/meetup-join/1");
    expect(safeLink("https://calendar.google.com/calendar/event?eid=1")).toBe(
      "https://calendar.google.com/calendar/event?eid=1",
    );
    expect(safeLink("https://ZOOM.US/j/1")).toBe("https://zoom.us/j/1");
  });

  it("refuses any other scheme, host, look-alike or credentials", () => {
    for (const raw of [
      "http://meet.google.com/abc",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://example.test/meet.google.com",
      "https://meet.google.com.example.test/abc",
      "https://evilzoom.us/j/1",
      "https://zoom.us@example.test/j/1",
      "https://user:pass@zoom.us/j/1",
      "//meet.google.com/abc",
      "meet.google.com/abc",
      "not a url",
      "",
    ])
      expect(safeLink(raw), raw).toBeNull();
  });
});

describe("SafeLink", () => {
  it("makes a new-tab link with no referrer of an allowed address", () => {
    const html = renderToStaticMarkup(createElement(SafeLink, { url: "https://meet.google.com/abc" }, "Join"));
    expect(html).toBe('<a href="https://meet.google.com/abc" target="_blank" rel="noopener noreferrer">Join</a>');
  });

  it("shows any other address as text", () => {
    expect(renderToStaticMarkup(createElement(SafeLink, { url: "https://example.test/x" }))).toBe(
      "https://example.test/x",
    );
    expect(renderToStaticMarkup(createElement(SafeLink, { url: "javascript:alert(1)" }, "Join"))).toBe("Join");
  });
});
