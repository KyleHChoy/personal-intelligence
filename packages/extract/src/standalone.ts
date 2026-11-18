import type { ClaimRecord, DecideSaidOutput, DecideStandaloneOutput } from "@intelligence/contracts/personal";
import { type CheckedKind, factLine } from "@intelligence/personal-core/checks";
import type { Prompt } from "@intelligence/personal-models";
import type { RunThresholds } from "./decision-points.ts";
import { DECIDE_SAID, DECIDE_STANDALONE } from "./question-prompts.ts";

// The claim intake's refuse-only model check of a quoted proposal, in the extraction lane, before
// its claim is committed and its about_you card raised. The decide model answers two questions about the line
// the claim renders as (personal-core's factLine, from its typed fields alone): claims_standalone
// over the line alone, with no quote in sight, then claims_said over the line beside the owner's
// quote. Below a point's accept line, or with no answer it can read, the claim is refused with that
// point's code. Nothing here sets, changes or adds a field, a label, a key or a tier: the answer is
// read as one number, and the outcome is the claim as code built it or no claim (invariant 5).

type IntakeRefusal = "not_standalone" | "not_what_was_said";

// One decide-model call over a prompt and its slots, answering the validated output or "rejected"; the
// caller binds askDecideModel (saved calls, the run's budget, the exposure note).
type AskDecideModel = (prompt: Prompt, data: Record<string, string>) => Promise<unknown>;

const below = (answer: unknown, key: "standalone" | "said", line: number): boolean => {
  if (typeof answer !== "object" || answer === null) return true;
  const value = (answer as Partial<DecideStandaloneOutput & DecideSaidOutput>)[key];
  return typeof value !== "number" || value < line;
};

// `checks`: an owner's answer is asked claims_said alone; its phrases are slices. An interpretation
// is asked claims_standalone alone; it is the agent's wording.
export async function intakeRefusal(
  record: ClaimRecord,
  quote: string,
  lines: Pick<RunThresholds, "standalone" | "said">,
  ask: AskDecideModel,
  checks: "both" | "said" | "standalone" = "both",
): Promise<IntakeRefusal | null> {
  const line = factLine(record.claim.content.type as CheckedKind, record.claim.content.fields);
  // Each slot is JSON, as every decide-model prompt's is: the decide-model client parses each slot as the state it
  // sends and refuses one that is not JSON, so plain text would fail every check.
  const slots = { line: JSON.stringify(line), quote: JSON.stringify(quote) };
  if (
    checks !== "said" &&
    lines.standalone !== null &&
    below(await ask(DECIDE_STANDALONE, { line: slots.line }), "standalone", lines.standalone)
  )
    return "not_standalone";
  if (checks !== "standalone" && lines.said !== null && below(await ask(DECIDE_SAID, slots), "said", lines.said))
    return "not_what_was_said";
  return null;
}
