import { createElement, Fragment, type ReactNode } from "react";

// The one place the page makes a link from data. A meeting's call and invite
// addresses come from the server as text; one becomes a link only when it is https, carries no user or
// password, and its host is one of these or a subdomain of one. Any other address stays text. The
// build test (build.test.ts) holds that no other source makes a link.
export const LINK_HOSTS = ["meet.google.com", "zoom.us", "teams.microsoft.com", "calendar.google.com"] as const;

// The address as the page may link it, or null.
export function safeLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  return LINK_HOSTS.some((one) => host === one || host.endsWith(`.${one}`)) ? url.toString() : null;
}

// The address as a link opened in a new tab with no referrer when `safeLink` allows it, else as text.
// As a button, with the mark that says it leaves the page.
const OUT = createElement(
  "svg",
  { className: "ico", viewBox: "0 0 24 24", "aria-hidden": "true" },
  createElement("path", { d: "M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" }),
);
export function SafeLink({
  url,
  children,
  className,
}: {
  url: string;
  children?: ReactNode;
  className?: string | undefined;
}): ReactNode {
  const link = safeLink(url);
  if (link === null) return createElement(Fragment, null, children ?? url);
  return createElement(
    "a",
    { href: link, target: "_blank", rel: "noopener noreferrer", className },
    children ?? url,
    className === undefined ? null : OUT,
  );
}
