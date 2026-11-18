import { z } from "zod";
import type { OpportunityKind } from "./opportunity-words.ts";
import { OUTCOME_EVENTS, OUTCOME_HORIZON_MOST } from "./work.ts";
import { GapTrigger } from "./work-gaps.ts";

// `ontology/outcomes.json`: each kind's default expectation (none for a kind with no outcome the
// world gives back), the horizon of a stated expectation that gives none, and the grace period a
// closed work's watches and expectations stay compared for. Data, not code.
const outcomeDefault = z
  .strictObject({ type: z.enum(OUTCOME_EVENTS), horizonDays: z.number().int().min(1).max(OUTCOME_HORIZON_MOST) })
  .nullable();
export const OutcomeRules = z.strictObject({
  version: z.number().int().positive(),
  graceDays: z.number().int().min(1).max(OUTCOME_HORIZON_MOST),
  horizonDays: z.number().int().min(1).max(OUTCOME_HORIZON_MOST),
  defaults: z.strictObject({
    follow_up: outcomeDefault,
    reply: outcomeDefault,
    meeting_prep: outcomeDefault,
    investigate: outcomeDefault,
    goal_step: outcomeDefault,
    life_admin: outcomeDefault,
    owner_question: outcomeDefault,
    research: outcomeDefault,
    // An introduction has no outcome of its own (whether it was made is its connection's), so it
    // has no default here and none in the file.
  } satisfies Record<Exclude<OpportunityKind, "introduction">, typeof outcomeDefault>),
  // What work code raised expects, by what raised it: every flag is a `research` task, so its kind
  // says nothing. None, for a trigger whose work comes back as knowledge.
  gapTriggers: z.strictObject(
    Object.fromEntries(GapTrigger.options.map((trigger) => [trigger, outcomeDefault])) as Record<
      GapTrigger,
      typeof outcomeDefault
    >,
  ),
});
export type OutcomeRules = z.infer<typeof OutcomeRules>;
