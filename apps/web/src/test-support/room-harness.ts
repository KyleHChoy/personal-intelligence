import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import { forgetKept } from "../kept-store.ts";
import { ToastProvider } from "../toast.tsx";

// A room's test bench: the clock held at `now`, a fetch that answers from `answers` and notes each
// call, and the room rendered inside the toast provider into a host the test reads. `first` gives
// the answers every test starts from; a test sets its own on `answers` before it shows the room.

export type Answer = { status: number; body: unknown };

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

export function roomHarness(now: Date, room: () => ReactNode, first: () => Record<string, Answer>) {
  const calls: string[] = [];
  const answers: Record<string, Answer> = {};
  let root: Root;
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const bench = {
    calls,
    answers,
    // The element the room is rendered into, new for each `show`.
    host: undefined as unknown as HTMLElement,
    settle,
    async show(element: ReactNode = room()): Promise<void> {
      bench.host = document.createElement("div");
      document.body.append(bench.host);
      root = createRoot(bench.host);
      await act(async () => root.render(createElement(ToastProvider, null, element)));
      await settle();
    },
    // The room taken down, for a test that shows a second one.
    async hide(): Promise<void> {
      await act(async () => root.unmount());
      bench.host.remove();
    },
  };
  beforeEach(forgetKept);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now });
    calls.length = 0;
    for (const url of Object.keys(answers)) delete answers[url];
    Object.assign(answers, first());
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      const answer = answers[url];
      return answer === undefined ? reply(404, { refused: "not_here" }) : reply(answer.status, answer.body);
    });
  });
  afterEach(async () => {
    await bench.hide();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  return bench;
}
