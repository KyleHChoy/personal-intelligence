import { describe, expect, it } from "vitest";
import { PersonalWorkArgs } from "./work.ts";

// An agent files an idea, or adds to one it names: `idea` goes with kind idea alone.

const args = {
  kind: "idea",
  about: { kind: "message", id: "msg_01J8ZQ0000000000000000000A" },
  summary: "A shared calendar for the reading club",
  basis: [{ kind: "message", id: "msg_01J8ZQ0000000000000000000A" }],
  requestId: "req-0001",
};

describe("propose_hypothesis for the idea ledger", () => {
  it("takes kind idea, with or without an idea to add to", () => {
    expect(PersonalWorkArgs.propose_hypothesis.safeParse(args).success).toBe(true);
    const adding = { ...args, idea: "hyp_01J8ZQ0000000000000000000A" };
    expect(PersonalWorkArgs.propose_hypothesis.safeParse(adding).success).toBe(true);
  });

  it("refuses an idea to add to with any other kind, and a lesson", () => {
    const other = { ...args, kind: "open_loop", idea: "hyp_01J8ZQ0000000000000000000A" };
    expect(PersonalWorkArgs.propose_hypothesis.safeParse(other).success).toBe(false);
    expect(PersonalWorkArgs.propose_hypothesis.safeParse({ ...args, kind: "lesson" }).success).toBe(false);
  });
});
