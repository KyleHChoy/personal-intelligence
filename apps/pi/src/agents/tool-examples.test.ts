import type { PersonProposalBody } from "@intelligence/contracts/personal";
import { interpretationRefusal, personProposalRefusal, summaryStandsAlone } from "@intelligence/personal-core/checks";
import { TOOL_EXAMPLES } from "@intelligence/personal-mcp";
import { describe, expect, it } from "vitest";

// The worked examples a tool's description shows pass the checks past its schema, the ones a real
// call meets at intake, so an agent that follows one is not refused for its words. The agent API
// cannot import these checks, so this is here.

describe("the worked examples at intake", () => {
  it("each proposal's summary stands alone", () => {
    for (const name of ["propose_goal", "propose_task", "propose_opportunity", "propose_hypothesis"] as const)
      for (const { args } of TOOL_EXAMPLES[name] ?? [])
        expect(summaryStandsAlone(args.summary as string), `${name} ${String(args.summary)}`).toBe(true);
  });

  it("propose_person's pass its claim intake", () => {
    for (const { args } of TOOL_EXAMPLES.propose_person ?? [])
      expect(personProposalRefusal(args as unknown as PersonProposalBody), String(args.kind)).toBeNull();
  });

  it("propose_about_you's statement stands alone and its quote is the owner's words", () => {
    for (const { args } of TOOL_EXAMPLES.propose_about_you ?? [])
      expect(interpretationRefusal(args.statement as string, [args.quote as string], {})).toBeNull();
  });
});
