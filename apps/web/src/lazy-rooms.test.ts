// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetKept } from "./kept-store.ts";
import { Shell } from "./shell.tsx";

// A fast first load: Today is in the first load, and each other room is its own file. While a
// room's file arrives the room shows a quiet glass panel with its name for the reader; then the
// room itself.

// Settings' file arrives only when the test lets it.
const gate = vi.hoisted(() => {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open: () => open() };
});
vi.mock("./rooms/settings.tsx", async (original) => {
  await gate.opened;
  return original();
});
// Ledger's file fails to arrive the first time it is asked for.
const tries = vi.hoisted(() => ({ ledger: 0 }));
vi.mock("./rooms/ledger.tsx", async (original) => {
  tries.ledger += 1;
  if (tries.ledger === 1) throw new Error("the file did not arrive");
  return original();
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(forgetKept);
beforeEach(async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  vi.stubGlobal("scrollTo", () => {});
  window.history.replaceState(null, "", "#");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Shell)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const room = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('nav[aria-label="Rooms"] button')].find(
    (button) => button.textContent === name,
  );
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
};
// A view of the open room, by its segmented control.
const view = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll<HTMLButtonElement>(".seg button")].find(
    (button) => button.textContent === name,
  );
  if (found === undefined) throw new Error(`no ${name} view`);
  return found;
};

it("Today opens with no wait; Settings shows its placeholder until its file arrives, then itself", async () => {
  expect(host.querySelector(".arriving")).toBeNull();
  expect(host.querySelector("main h1#room-title.big")).not.toBeNull();

  await act(async () => room("System").click());
  await act(async () => view("Settings").click());
  const waiting = host.querySelector('.panel.arriving[role="status"]');
  expect(waiting?.getAttribute("aria-label")).toBe("Opening System");
  // The page is still headed by the room's name while it waits, once.
  expect([...host.querySelectorAll("main h1#room-title")].map((one) => one.textContent)).toEqual(["System"]);

  await act(async () => gate.open());
  await vi.waitFor(() => expect(host.querySelector(".arriving")).toBeNull());
  expect([...host.querySelectorAll("main h1#room-title")].map((one) => one.textContent)).toEqual(["System"]);
  expect(host.querySelector(".seg [aria-pressed=true]")?.textContent).toBe("Settings");
  expect(host.querySelector("main .panel h2")?.textContent).toBe("Settings");
});

// A room's file that fails (a dropped connection, or a newer build that renamed it) says so
// in the room's place, the rest of the page stays, and Try again fetches it anew.
it("a room whose file did not arrive says so in its place, and Try again opens it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => room("System").click());
  await act(async () => view("Ledger").click());
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("System did not open."));
  expect(host.querySelector('nav[aria-label="Rooms"]')).not.toBeNull();
  expect(host.querySelector("main h1#room-title")?.textContent).toBe("System");
  const again = [...host.querySelectorAll<HTMLButtonElement>("main button")].find(
    (button) => button.textContent === "Try again",
  );
  await act(async () => again?.click());
  await vi.waitFor(() => expect(host.querySelector("main .panel h2")?.textContent).toBe("Today so far"));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  // Today is untouched by it.
  await act(async () => room("Today").click());
  expect(host.querySelector("main h1#room-title.big")).not.toBeNull();
  vi.restoreAllMocks();
});
