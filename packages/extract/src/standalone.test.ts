import type { ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { DECIDE_SAID, DECIDE_STANDALONE } from "./question-prompts.ts";
import { intakeRefusal } from "./standalone.ts";

// An interpretation is the agent's wording, so the claim intake's decide-model check asks claims_standalone
// of its line alone, never claims_said beside a quote.
const record = {
  claim: { content: { type: "goal", fields: { domain: "career", objective: "found a company within two years" } } },
} as unknown as ClaimRecord;
const lines = { standalone: 0.5, said: 0.5 };

describe("intakeRefusal's checks", () => {
  it("standalone asks claims_standalone alone; both asks claims_said too; said asks it alone", async () => {
    for (const [checks, asked] of [
      ["standalone", [DECIDE_STANDALONE]],
      ["both", [DECIDE_STANDALONE, DECIDE_SAID]],
      ["said", [DECIDE_SAID]],
    ] as const) {
      const seen: unknown[] = [];
      const answer = await intakeRefusal(
        record,
        "a quote",
        lines,
        async (prompt) => {
          seen.push(prompt);
          return { standalone: 0.9, said: 0.9 };
        },
        checks,
      );
      expect(answer, checks).toBeNull();
      expect(seen, checks).toEqual(asked);
    }
  });

  it("an interpretation's line that does not stand alone is refused not_standalone", async () => {
    expect(await intakeRefusal(record, "", lines, async () => ({ standalone: 0.1, said: 0.9 }), "standalone")).toBe(
      "not_standalone",
    );
    expect(
      await intakeRefusal(record, "", lines, async () => ({ standalone: 0.9, said: 0.1 }), "standalone"),
    ).toBeNull();
  });
});
