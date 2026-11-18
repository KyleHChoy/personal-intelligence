// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Access } from "./access.tsx";
import { read } from "./api.ts";
import { codeFrom } from "./passkey.ts";
import { internalsOn } from "./test-support/internals.ts";

// The way in: the shell with a session, the sign-in screen without one.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "credentials");
});

async function shown(status: number): Promise<HTMLElement> {
  vi.stubGlobal("fetch", async (path: string) =>
    path === "/api/session" ? new Response(status === 200 ? '{"token":"t"}' : "", { status }) : new Promise(() => {}),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(Access)));
  return host;
}

const buttons = (page: HTMLElement): string[] =>
  [...page.querySelectorAll("button")].map((button) => button.textContent ?? "");
const press = async (page: HTMLElement, label: string): Promise<void> => {
  const button = [...page.querySelectorAll("button")].find((one) => one.textContent === label);
  if (button === undefined) throw new Error(`no button ${label}`);
  await act(async () => button.click());
  await act(async () => new Promise((done) => setTimeout(done, 0)));
};
const paste = async (page: HTMLElement, text: string): Promise<void> => {
  const input = page.querySelector("input");
  if (input === null) throw new Error("no field");
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

// The sign-in screen with the box answering each ceremony as `answers` says (a status, or
// "unreachable"), and the browser's passkey prompt cancelled when `cancel` is set.
async function signInScreen(answers: Record<string, number | "unreachable">, cancel = false): Promise<HTMLElement> {
  const refusal = (): Promise<never> => Promise.reject(new DOMException("cancelled", "NotAllowedError"));
  // A passkey the browser gives back, for the box to accept or refuse.
  const used = {
    rawId: new ArrayBuffer(4),
    response: {
      clientDataJSON: new ArrayBuffer(4),
      authenticatorData: new ArrayBuffer(4),
      signature: new ArrayBuffer(4),
    },
  };
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { get: cancel ? refusal : async () => used, create: cancel ? refusal : () => new Promise(() => {}) },
  });
  const options = {
    challenge: "AAAA",
    rpId: "box",
    allowCredentials: [],
    userVerification: "required",
    timeout: 1,
    rp: { id: "box", name: "x" },
    user: { id: "AAAA", name: "x", displayName: "x" },
    pubKeyCredParams: [],
    authenticatorSelection: {},
    attestation: "none",
  };
  vi.stubGlobal("fetch", async (path: string) => {
    if (path === "/api/session") return new Response("", { status: 401 });
    const answer = answers[path] ?? 200;
    if (answer === "unreachable") throw new TypeError("offline");
    return new Response(answer === 200 ? JSON.stringify(options) : "", { status: answer });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(Access)));
  return host;
}
const LINK = `https://box.tail1234.ts.net/register?code=${"A".repeat(43)}`;
const JARGON = /webauthn|credential|challenge|attestation|assertion|\bcode\b|\bhttp_|\b40[134]\b|\b500\b|refused/i;
const noteOf = (page: HTMLElement): string => page.querySelector(".signin-note")?.textContent ?? "";

it("without a session it offers sign-in with the passkey and a way to set one up, and no room", async () => {
  const page = await shown(401);
  expect(page.querySelector("h1")?.textContent).toBe("Personal Intelligence");
  expect(buttons(page)).toEqual(["Sign in with passkey", "Set up a passkey on this device"]);
  expect(page.querySelector('nav[aria-label="Rooms"]')).toBeNull();
});

it("says every sign-in and setup outcome in plain words, with no internals and no jargon", async () => {
  const cases: [string, Record<string, number | "unreachable">, boolean, string[], RegExp][] = [
    ["cancelled", {}, true, [], /No passkey was used/],
    ["refused", { "/passkey/login": 401 }, false, [], /not accepted/],
    ["unreachable", { "/passkey/login-options": "unreachable" }, false, [], /not answering/],
    ["server fault", { "/passkey/login-options": 500 }, false, [], /could not answer just now/],
    ["no passkey yet", { "/passkey/login-options": 404 }, false, [], /no passkey yet/],
    [
      "link not whole",
      {},
      false,
      ["Set up a passkey on this device", "paste:https://box.tail1234.ts.net/reg"],
      /not a whole setup link/,
    ],
    [
      "link used or old",
      { "/passkey/register-options": 401 },
      false,
      ["Set up a passkey on this device", `paste:${LINK}`],
      /used, or is more than 5 minutes old/,
    ],
    ["setup cancelled", {}, true, ["Set up a passkey on this device", `paste:${LINK}`], /Setup was cancelled/],
  ];
  for (const [name, answers, cancel, steps, words] of cases) {
    const page = await signInScreen(answers, cancel);
    for (const step of steps) await (step.startsWith("paste:") ? paste(page, step.slice(6)) : press(page, step));
    await press(page, steps.length === 0 ? "Sign in with passkey" : "Set up passkey");
    expect(noteOf(page), name).toMatch(words);
    expect(internalsOn(page), name).toEqual([]);
    const shownWords = [...page.querySelectorAll("h1, p, li, button, label")]
      .map((one) => one.textContent ?? "")
      .join(" ");
    expect(shownWords, name).not.toMatch(JARGON);
    await act(async () => root?.unmount());
    root = null;
    page.remove();
  }
});

it("a refused link lands on the sign-in screen saying so, with the passkey's sign-in", async () => {
  const mark = document.createElement("meta");
  mark.name = "pi-link";
  mark.content = "refused";
  document.head.append(mark);
  try {
    const page = await shown(401);
    expect(page.querySelector('[role="alert"]')?.textContent).toBe(
      "This sign-in link has been used or has expired. Run pia web link for a new one, or sign in with your passkey.",
    );
    expect(buttons(page)[0]).toBe("Sign in with passkey");
    expect(internalsOn(page)).toEqual([]);
  } finally {
    mark.remove();
  }
});

it("the first look's own 401 says nothing of a session ending", async () => {
  const page = await shown(401);
  expect(page.querySelector(".signin-note")).toBeNull();
});

it("with no passkey yet it turns to setting one up, the command to run set apart", async () => {
  const page = await signInScreen({ "/passkey/login-options": 404 });
  await press(page, "Sign in with passkey");
  expect(page.querySelector(".signin-steps code")?.textContent).toBe("pia web link --register");
  expect(buttons(page)).toEqual(["Set up passkey", "Back to sign in"]);
  await press(page, "Back to sign in");
  expect(buttons(page)[0]).toBe("Sign in with passkey");
});

it("with a session it shows the shell", async () => {
  const page = await shown(200);
  expect(page.querySelector('nav[aria-label="Rooms"]')).not.toBeNull();
});

it("a session that ends sends the page back to the sign-in screen; a server fault is said as one", async () => {
  const page = await shown(200);
  vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
  await act(async () => void (await read("digest")));
  expect(page.querySelector('nav[aria-label="Rooms"]')).toBeNull();
  expect(page.querySelector("h1")?.textContent).toBe("Personal Intelligence");
  expect(page.querySelector('[role="status"]')?.textContent).toMatch(/You were signed out/);
  await act(async () => root?.unmount());
  root = null;
  page.remove();
  const failed = await shown(500);
  expect(failed.querySelector('[role="alert"]')?.textContent).toMatch(/could not answer just now/);
  expect(buttons(failed)).toEqual(["Try again"]);
});

it("the registration code is taken from the printed link or given alone, and nothing else", () => {
  const code = `${"A".repeat(42)}_`;
  expect(codeFrom(`https://box.tail1234.ts.net/register?code=${code}\n`)).toBe(code);
  expect(codeFrom(code)).toBe(code);
  for (const bad of ["", `${code}x`, "code=short", `x${code}`]) expect(codeFrom(bad), bad).toBeNull();
});
