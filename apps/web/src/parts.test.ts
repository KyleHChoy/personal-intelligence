// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OpenBody, OpenRow, OpenRows, Panel, TypedRow as Row } from "./parts.tsx";

// The shared parts: one open row at a time across the page, opened in place with
// focus on its first action; one body shape with the action bar last; a row a button only when it
// opens something.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const row = (id: string, verb: string) =>
  h(OpenRow, {
    id,
    row: { lead: { verb }, what: `Thing ${id}`, meta: "Iris" },
    // biome-ignore lint/correctness/noChildrenProp: createElement in a .ts test takes them as a prop
    children: h(OpenBody, {
      lead: ["Asked on Tuesday"],
      blocks: [
        ["Evidence", "It said so."],
        ["Empty", null],
      ],
      actions: [
        { label: "Not now", onClick: () => {}, kind: "quiet" },
        { label: "Edit", onClick: () => {} },
        { label: "Approve", onClick: () => {}, kind: "go" },
      ],
    }),
  });

const lines = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>("button.row")];

it("opens one row at a time across panels, in place, with focus on its main action", async () => {
  await act(async () =>
    root.render(
      h(
        OpenRows,
        null,
        // biome-ignore lint/correctness/noChildrenProp: createElement in a .ts test takes them as a prop
        h(Panel, { title: "For you", count: 2, children: row("a", "Approve") }),
        // biome-ignore lint/correctness/noChildrenProp: createElement in a .ts test takes them as a prop
        h(Panel, { title: "Due", children: row("b", "Send") }),
      ),
    ),
  );
  expect(lines().map((one) => one.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  await act(async () => lines()[0]?.click());
  expect(lines().map((one) => one.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
  const body = host.querySelector(".exp") as HTMLElement;
  expect(lines()[0]?.getAttribute("aria-controls")).toBe(body.id);
  // Lead, the labelled block that has something, then one bar: the main action first, the quiet one last.
  expect(body.querySelector(".blk")?.textContent).toBe("Asked on Tuesday");
  expect([...body.querySelectorAll(".k")].map((one) => one.textContent)).toEqual(["Evidence"]);
  expect(body.lastElementChild?.className).toBe("actbar compact");
  expect([...body.querySelectorAll(".actbar button")].map((one) => [one.textContent, one.className])).toEqual([
    ["Approve", "btn sm go"],
    ["Edit", "btn sm"],
    ["Not now", "lnk"],
  ]);
  expect(document.activeElement?.textContent).toBe("Approve");
  // Opening the second closes the first.
  await act(async () => lines()[1]?.click());
  expect(lines().map((one) => one.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
  expect(host.querySelectorAll(".exp")).toHaveLength(1);
  await act(async () => lines()[1]?.click());
  expect(host.querySelectorAll(".exp")).toHaveLength(0);
});

it("a row is a button, with a chevron, only when it opens something; its verb is a chip, its status the meta", async () => {
  await act(async () =>
    root.render(
      h(
        "div",
        null,
        h(Row, { lead: { when: "9:30" }, what: "Stand-up", meta: "late", metaWarn: true }),
        h(Row, { lead: { av: "AO" }, what: "Ada One", onOpen: () => {} }),
      ),
    ),
  );
  const [still, opens] = [...host.querySelectorAll(".row")];
  expect(still?.tagName).toBe("DIV");
  expect(still?.querySelector(".chev")).toBeNull();
  expect(still?.querySelector(".meta.warn")?.textContent).toBe("late");
  expect(opens?.tagName).toBe("BUTTON");
  expect(opens?.querySelector(".chev")).not.toBeNull();
  expect(opens?.querySelector(".av")?.textContent).toBe("AO");
});
