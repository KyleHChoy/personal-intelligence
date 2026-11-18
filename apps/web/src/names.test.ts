// @vitest-environment jsdom
import { CardDetail } from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardBody } from "./card-parts.tsx";
import { cardHead, cardShape } from "./cards.ts";
import { OpenPerson } from "./opens.tsx";
import { NAMED_ID_CARDS, RAW_ID_CARDS } from "./test-support/id-cards.ts";
import { internalsIn, internalsOn } from "./test-support/internals.ts";
import { ToastProvider } from "./toast.tsx";

// No id reaches the owner: `pi web` says the owner's words in place of every id an agent wrote. The guard
// fails on a card whose agent words hold ids as the store renders them, and passes on the same card as
// `pi web` serves it, its ids in the owner's words and what they name opening.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shown = (card: CardDetail): string[] => {
  const shape = cardShape(card);
  return [
    shape.title,
    shape.sub,
    ...cardHead(card, shape).flatMap((row) => [row.k, row.v]),
    ...shape.rows.flatMap((row) => [row.k, row.v]),
    ...(shape.sections ?? []).flatMap((row) => [row.k, row.v]),
    ...shape.notes,
  ];
};

describe("ids in agent words", () => {
  it("each served card parses as the read answers it", () => {
    for (const card of NAMED_ID_CARDS) expect(CardDetail.safeParse(card).success, card.id).toBe(true);
  });

  for (const [index, raw] of RAW_ID_CARDS.entries()) {
    it(`the guard catches the ids of ${raw.kind} ${index + 1} as the store renders it, and passes it as served`, () => {
      expect(
        internalsIn(shown(raw)).filter((one) => one.startsWith("an id") || one.startsWith("a fact's id")),
      ).not.toEqual([]);
      expect(internalsIn(shown(NAMED_ID_CARDS[index] as CardDetail))).toEqual([]);
    });
  }
});

let root: Root | undefined;
let host: HTMLElement | undefined;
const opened: string[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: false, status: 404, json: async () => ({ refused: "not_here" }) }) as Response,
  );
});
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

it("an opened research result shows names, never ids, and each name it can open opens", async () => {
  const card = NAMED_ID_CARDS[0] as CardDetail;
  const page = createElement(CardBody, { card, onAnswered: () => {} });
  const into = document.createElement("div");
  document.body.append(into);
  host = into;
  const made = createRoot(into);
  root = made;
  await act(async () =>
    made.render(
      createElement(
        ToastProvider,
        null,
        createElement(OpenPerson.Provider, { value: (one) => opened.push(one.id) }, page),
      ),
    ),
  );
  expect(internalsOn(into)).toEqual([]);
  // What it names is evidence, shown when the owner asks for it.
  await act(async () => into.querySelector<HTMLButtonElement>("button.evidence")?.click());
  expect(internalsOn(into)).toEqual([]);
  // The fact is said once, its words not repeated in brackets, and the
  // question asks about the finding, not the finding's citation.
  expect(into.textContent).toContain("Dana Example is chair; the board meets monthly");
  expect(into.textContent).not.toContain("(Chair at Example Garden Club)");
  expect(cardShape(card).question).toBe("Was this useful: Dana Example chairs it?");
  expect(into.textContent).toContain("Named in it");
  // Dana is opened from its sources already, so the mentions list only what they do not.
  expect(into.querySelectorAll(`button[aria-label="Open Dana Example's page"]`)).toHaveLength(1);
  const dana = [...into.querySelectorAll("button")].find(
    (one) => one.getAttribute("aria-label") === "Open Dana Example's page",
  );
  await act(async () => dana?.click());
  expect(opened).toEqual([card.mentions?.[0]?.open.id]);
  for (const words of ["Chair at Example Garden Club", "Garden open day"])
    expect([...into.querySelectorAll("button")].some((one) => one.textContent === words)).toBe(true);
});
