import { describe, expect, it } from "vitest";
import { cardLineText } from "./card-line.ts";
import { QuestionTried } from "./paid-questions.ts";
import { WriteBackArgs } from "./signals.ts";
import { PersonalWorkArgs } from "./work.ts";

const ULID = "01HZX3V4N8Q2W5E7R9T1Y3A5B7";
const tried = {
  searches: [{ tool: "find_messages", query: "venue for the offsite" }],
  sources: [`msg_${ULID}`, `rec_${ULID}`],
  why: "No message names a venue.",
};

describe("a question's tried", () => {
  it("takes searches by a search tool, sources by id and one bounded sentence", () => {
    expect(QuestionTried.safeParse(tried).success).toBe(true);
    for (const wrong of [
      { ...tried, searches: [] },
      { ...tried, searches: [{ tool: "read_message", query: "x" }] },
      { ...tried, searches: Array.from({ length: 6 }, () => tried.searches[0]) },
      { ...tried, sources: [] },
      { ...tried, sources: [`msg_${ULID}`, `msg_${ULID}`] },
      { ...tried, sources: ["not an id"] },
      { ...tried, why: " " },
      { ...tried, why: "x".repeat(301) },
      { ...tried, extra: true },
    ])
      expect(QuestionTried.safeParse(wrong).success, JSON.stringify(wrong).slice(0, 80)).toBe(false);
  });

  it("is taken by propose_opportunity and hand_off", () => {
    const base = { requestId: "a-request-1", tried };
    expect(
      PersonalWorkArgs.hand_off.safeParse({
        ...base,
        id: `opp_${ULID}`,
        role: "owner",
        reason: "other",
        record: `rec_${ULID}`,
      }).success,
    ).toBe(true);
    expect(
      PersonalWorkArgs.propose_opportunity.safeParse({
        ...base,
        kind: "owner_question",
        about: { kind: "owner" },
        summary: "ask about the offsite venue",
        basis: [{ kind: "message", id: `msg_${ULID}` }],
      }).success,
    ).toBe(true);
  });

  it("is taken by write_back, whose needs_owner is a question to the owner", () => {
    const back = { source: { kind: "message", id: `msg_${ULID}` }, state: "needs_owner", requestId: "a-request-1" };
    expect(WriteBackArgs.safeParse({ ...back, tried }).success).toBe(true);
    // Its absence is the tool's question_unpaid, with the hint, not a schema refusal.
    expect(WriteBackArgs.safeParse(back).success).toBe(true);
    expect(WriteBackArgs.safeParse({ ...back, tried: { ...tried, searches: [] } }).success).toBe(false);
  });

  it("is shown as counts, tools and ids", () => {
    expect(
      cardLineText("checked", [
        { kind: "count", n: 1 },
        { kind: "count", n: 2 },
        { kind: "code", code: "find_messages" },
        { kind: "id", of: "item", id: "a".repeat(64) },
        { kind: "id", of: "record", id: `rec_${ULID}` },
      ]),
    ).toBe(`checked first: 1 searches, 2 sources (find_messages, ${"a".repeat(64)}, rec_${ULID})`);
  });
});
