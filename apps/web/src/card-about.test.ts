import type { CardLine, CardView, EntityId, GoalId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { cardAbout } from "./card-parts.tsx";

// What a card is about, for the task an agent is asked: its target, its refs and the refs code's lines
// carry. Ids are read from the refs only, never from a line's words. Made-up values only.

const PERSON = "ent_01HZZZZZZZZZZZZZZZZZZZZZZA" as EntityId;
const OTHER = "ent_01HZZZZZZZZZZZZZZZZZZZZZZB";
const MESSAGE = "msg_01HZZZZZZZZZZZZZZZZZZZZZZE";
const GOAL = "gol_01HZZZZZZZZZZZZZZZZZZZZZZG" as GoalId;
const FACT = "a".repeat(64);
const SECOND = "b".repeat(64);

const card = (lines: CardLine[], extra: Partial<CardView> = {}): CardView & { lines: CardLine[] } => ({
  id: "crd_01HZZZZZZZZZZZZZZZZZZZZZZF" as never,
  kind: "same_fact",
  state: "pending",
  author: "system:extract",
  createdAt: "2026-10-30T10:00:00.000Z" as never,
  expiresAt: null,
  options: ["same", "different", "skip"],
  target: null,
  refs: [],
  lines,
  ...extra,
});

describe("cardAbout", () => {
  it("names the target, the card's refs and each code line's refs, once each and in order", () => {
    const about = cardAbout(
      card(
        [
          { text: "fact a: one", from: "code", refs: [{ kind: "fact", id: FACT }] },
          {
            text: "person 1: two",
            from: "code",
            refs: [
              { kind: "entity", id: PERSON },
              { kind: "goal", id: GOAL },
            ],
          },
          { text: "fact b: three", from: "code", refs: [{ kind: "fact", id: SECOND }] },
        ],
        { target: { kind: "claim", id: FACT } as never, refs: [{ kind: "message", id: MESSAGE } as never] },
      ),
    );
    expect(about).toEqual([
      { kind: "fact", id: FACT },
      { kind: "message", id: MESSAGE },
      { kind: "entity", id: PERSON },
      { kind: "goal", id: GOAL },
      { kind: "fact", id: SECOND },
    ]);
  });

  it("reads no id from a line's words, code's or anyone else's", () => {
    const about = cardAbout(
      card([
        { text: `person 1: ${PERSON}`, from: "code" },
        { text: `claim: ${FACT} title`, from: "code" },
        { text: `${OTHER} and ${MESSAGE}`, from: "agent" },
      ]),
    );
    expect(about).toEqual([]);
  });

  it("keeps at most ten", () => {
    const refs = Array.from({ length: 12 }, (_, index) => ({
      kind: "fact" as const,
      id: index.toString(16).padStart(64, "c"),
    }));
    const about = cardAbout(
      card([
        { text: "many", from: "code", refs: refs.slice(0, 10) },
        { text: "more", from: "code", refs: refs.slice(10) },
      ]),
    );
    expect(about).toHaveLength(10);
  });
});
