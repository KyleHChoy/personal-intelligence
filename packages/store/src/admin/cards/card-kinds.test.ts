import type { CardId, LedgerRef } from "@intelligence/contracts/personal";
import { CARD_OPTIONS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { StoredCard } from "../../cards/card-kind-row.ts";
import { CARD_KINDS } from "./card-kinds.ts";

// The draft_waiting row of CARD_KINDS, which needs no database: its options, the rows it
// locks, and lines that are code's and open nothing. Ids that are valid but mean nothing.

const DRAFT = `drf_${"0".repeat(25)}1`;
const card: StoredCard = {
  id: `crd_${"0".repeat(25)}1` as CardId,
  kind: "draft_waiting",
  author: `client:cli_${"0".repeat(25)}1` as never,
  createdAt: "2026-10-04T10:00:00Z" as never,
  options: ["reject", "acknowledge"],
  target: { kind: "draft", id: DRAFT } as LedgerRef,
  refs: [],
  compartments: ["own"],
  caseKey: `draft:${DRAFT}`,
  requestId: "r".repeat(64),
  run: null,
  bodyFrom: null,
};

describe("the card kinds' options", () => {
  it("every kind has a row in CARD_OPTIONS and its row answers from it, so the queue checks what the row takes", () => {
    expect(Object.keys(CARD_OPTIONS).sort()).toEqual(Object.keys(CARD_KINDS).sort());
    for (const [kind, row] of Object.entries(CARD_KINDS)) {
      expect(row.options, kind).toEqual(CARD_OPTIONS[kind as keyof typeof CARD_OPTIONS]);
    }
  });
});

describe("CARD_KINDS.draft_waiting", () => {
  const row = CARD_KINDS.draft_waiting;

  it("offers reject and acknowledge, and locks the draft", async () => {
    expect(row?.options).toEqual(["reject", "acknowledge"]);
    expect(await row?.lockIds?.(async () => [], card)).toEqual([DRAFT]);
  });

  it("names the draft and the command that shows it, in lines of code's, and opens nothing", async () => {
    let opened = false;
    const lines = await row?.render(
      card,
      () => {
        opened = true;
        return "a body";
      },
      { query: async () => [], keys: {} as never },
    );
    expect(opened).toBe(false);
    expect(lines?.every((line) => line.from === "code")).toBe(true);
    expect(lines?.map((line) => line.text)).toContain(`draft: ${DRAFT}`);
    expect(lines?.map((line) => line.text)).toContain(`to read it: pi send show ${DRAFT}`);
  });

  it("acknowledge writes nothing", async () => {
    const statements: string[] = [];
    await row?.effect({
      query: async (text: string) => {
        statements.push(text);
        return [];
      },
      card,
      answer: "acknowledge",
      ruling: "rul_0" as never,
      now: new Date(),
      keys: {} as never,
    });
    expect(statements).toEqual([]);
  });
});
