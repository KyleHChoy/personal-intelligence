// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetKept } from "./kept-store.ts";
import { Shell } from "./shell.tsx";

// The frame: five rooms in the bar and the tab bar, each room and view an address,
// Back and Forward between them, and search as the page's one overlay.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADA = `ent_01J${"0".repeat(22)}1`;
const WORKS = `ent_01J${"0".repeat(22)}2`;
const MESSAGE = `msg_01J${"0".repeat(22)}7`;
const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const hit = (id: string, name: string, kind = "person") => ({
  who: { id, kind, name: { untrusted: name }, address: null },
  tier: kind === "person" ? "close" : null,
  match: "name",
});

let root: Root;
let host: HTMLElement;
let posts: { url: string; body: unknown }[] = [];
const scrolled = vi.fn();
const modal = vi.fn();

const mount = async (): Promise<void> => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Shell)));
};
beforeEach(forgetKept);
beforeEach(async () => {
  posts = [];
  scrolled.mockClear();
  modal.mockClear();
  window.history.replaceState(null, "", "#");
  vi.stubGlobal("scrollTo", scrolled);
  // Nothing on the page may open a modal dialog: the one overlay is the search palette.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: modal });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (url === "/api/session") return reply({ token: "form-token-1" });
    if (url === "/api/search") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return reply({ hits: [hit(ADA, "Ada One"), hit(WORKS, "Ada Works", "organization")] });
    }
    if (url === "/api/searchItems")
      return reply({
        facts: [],
        mail: [{ message: MESSAGE, at: "2026-10-21T09:00:00.000Z", subject: { untrusted: "The draft" }, from: null }],
      });
    if (url.startsWith("/api/message?"))
      return reply({
        id: MESSAGE,
        at: "2026-10-21T09:00:00.000Z",
        direction: "inbound",
        subject: { untrusted: "The draft" },
        sender: null,
        text: { untrusted: "Here it is." },
        more: false,
        unreadable: false,
        attachmentList: [],
      });
    return new Promise(() => {});
  });
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const buttons = (selector: string): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>(selector)];
const named = (selector: string, name: string): HTMLButtonElement => {
  const found = buttons(selector).find((one) => one.textContent?.startsWith(name));
  if (found === undefined) throw new Error(`no ${name} in ${selector}`);
  return found;
};
const click = (button: HTMLElement) => act(async () => button.click());
const hash = (): string => new URL(document.URL).hash;
const _title = (): string | null | undefined => host.querySelector("main h1#room-title")?.textContent;
const type = async (input: HTMLInputElement, words: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, words);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
};
const key = (target: Element, name: string) =>
  act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));

it("shows the five rooms in the bar and the tab bar, opens on Today, and gives each its address", async () => {
  const rooms = ["Today", "People", "Work", "You", "System"];
  expect(buttons('nav[aria-label="Rooms"] button').map((one) => one.textContent)).toEqual(rooms);
  expect(buttons('nav[aria-label="Tabs"] button').map((one) => one.textContent)).toEqual(rooms);
  // Today is headed by its greeting, the date over it.
  expect(host.querySelector("main h1#room-title.big")).not.toBeNull();
  for (const room of rooms) {
    await click(named('nav[aria-label="Rooms"] button', room));
    expect(hash()).toBe(`#${room.toLowerCase()}`);
    expect(named('nav[aria-label="Rooms"] button', room).getAttribute("aria-current")).toBe("page");
    expect(named('nav[aria-label="Tabs"] button', room).getAttribute("aria-current")).toBe("page");
  }
  // A room change starts at the top.
  expect(scrolled).toHaveBeenCalledWith(0, 0);
});

it("a view is an address of its own; Back returns to the last, and a reload keeps the place", async () => {
  await click(named('nav[aria-label="Rooms"] button', "Work"));
  expect(buttons(".seg button").map((one) => one.textContent)).toEqual([
    "Agents",
    "Owed",
    "Goals",
    "Projects",
    "Ideas",
    "Time",
  ]);
  await click(named(".seg button", "Goals"));
  expect(hash()).toBe("#work-goals");
  expect(named(".seg button", "Goals").getAttribute("aria-pressed")).toBe("true");
  // Back: the address goes back, the page follows it.
  await act(async () => {
    window.history.replaceState(null, "", "#work");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(named(".seg button", "Agents").getAttribute("aria-pressed")).toBe("true");
  // A reload on a person's address opens them in People.
  await act(async () => root.unmount());
  window.history.replaceState(null, "", `#person-${ADA}`);
  await mount();
  expect(named('nav[aria-label="Rooms"] button', "People").getAttribute("aria-current")).toBe("page");
  // An address that names nothing is Today.
  await act(async () => {
    window.history.replaceState(null, "", "#nowhere-at-all");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  // Today is headed by its greeting, the date over it.
  expect(host.querySelector("main h1#room-title.big")).not.toBeNull();
});

it("sets the sky for the hour on the app root, and names its colour set", () => {
  const app = host.querySelector<HTMLElement>(".app");
  expect(app?.style.getPropertyValue("--sky")).toMatch(/^linear-gradient\(180deg, rgb\(/);
  expect(["light", "dark"]).toContain(app?.dataset.theme);
});

it("search is the one overlay: a palette that posts the term in its body and goes where a match lives", async () => {
  expect(host.querySelector('[aria-modal="true"]')).toBeNull();
  await click(host.querySelector(".bar .find") as HTMLElement);
  const palette = host.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement;
  expect(palette.getAttribute("aria-label")).toBe("Search");
  const input = palette.querySelector("input") as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  await type(input, "Ada");
  expect(posts).toEqual([{ url: "/api/search", body: { term: "Ada" } }]);
  expect([...palette.querySelectorAll(".label")].map((one) => one.textContent)).toEqual(["People", "Mail"]);
  // An organization goes to the Map; the palette closes.
  await key(input, "ArrowDown");
  await key(input, "Enter");
  expect(hash()).toBe("#people-map");
  expect(host.querySelector('[aria-modal="true"]')).toBeNull();
  // ⌘K opens it again; a person goes to their page.
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
  const again = host.querySelector('[aria-modal="true"] input') as HTMLInputElement;
  await type(again, "Ada");
  await key(again, "Enter");
  expect(hash()).toBe(`#person-${ADA}`);
  // Escape closes it.
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })));
  await key(host.querySelector('[aria-modal="true"] input') as HTMLElement, "Escape");
  expect(host.querySelector('[aria-modal="true"]')).toBeNull();
  expect(modal).not.toHaveBeenCalled();
});

it("a message found opens in place in the palette's list, not over it", async () => {
  await click(host.querySelector(".bar .find") as HTMLElement);
  const input = host.querySelector('[aria-modal="true"] input') as HTMLInputElement;
  await type(input, "draft");
  await click(named('[aria-modal="true"] .row', "The draft"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  const opened = host.querySelector('[aria-modal="true"] .reader[aria-label="A message"]');
  expect(opened?.textContent).toContain("Here it is.");
  expect(opened?.querySelectorAll(".actbar")).toHaveLength(1);
  expect(modal).not.toHaveBeenCalled();
  expect(host.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
});

it("turns the bar solid once the page scrolls under it", async () => {
  const bar = host.querySelector(".bar") as HTMLElement;
  expect(bar.classList.contains("scrolled")).toBe(false);
  await act(async () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 300 });
    window.dispatchEvent(new Event("scroll"));
  });
  expect(bar.classList.contains("scrolled")).toBe(true);
  await act(async () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    window.dispatchEvent(new Event("scroll"));
  });
});
