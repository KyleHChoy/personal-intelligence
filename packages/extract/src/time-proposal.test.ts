import { PROMPT_PINS, TimeProposalAnswer } from "@intelligence/contracts/personal";
import { promptTextHash } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { TIME_PROPOSAL_PROMPT } from "./time-proposal.ts";

describe("personal_time_proposal@1", () => {
  it("its text hash is the one pinned, with a closed schema and no tools", () => {
    expect(TIME_PROPOSAL_PROMPT.textHash).toBe(promptTextHash(TIME_PROPOSAL_PROMPT));
    expect(PROMPT_PINS[`${TIME_PROPOSAL_PROMPT.id}@${TIME_PROPOSAL_PROMPT.version}`]).toBe(
      TIME_PROPOSAL_PROMPT.textHash,
    );
    expect(TIME_PROPOSAL_PROMPT.tools).toBe("none");
    expect(TIME_PROPOSAL_PROMPT.outputSchema).toBe(TimeProposalAnswer);
  });

  it("the answer has no place for words, a label or a destination", () => {
    const project = "ent_0123456789ABCDEFGHJKMNPQRS";
    expect(
      TimeProposalAnswer.safeParse({ assignments: [{ project, groups: ["g1"] }], newEfforts: ["g2"] }).success,
    ).toBe(true);
    for (const answer of [
      { assignments: [{ project, groups: ["g1"], why: "words" }], newEfforts: [] },
      { assignments: [], newEfforts: [], label: ["own"] },
      { assignments: [{ project: "Harbour", groups: ["g1"] }], newEfforts: [] },
      { assignments: [], newEfforts: ["a name"] },
    ])
      expect(TimeProposalAnswer.safeParse(answer).success, JSON.stringify(answer)).toBe(false);
  });
});
