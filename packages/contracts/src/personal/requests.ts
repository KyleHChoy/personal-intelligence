import { z } from "zod";
import { Timestamp } from "../ids.ts";
import {
  AgentRecordId,
  GoalProposalId,
  Handle,
  HypothesisId,
  OpportunityId,
  ProposalId,
  WorkRequestId,
} from "./ids.ts";
import { DeclineReason } from "./primitives.ts";
import { WorkRef } from "./work.ts";

// A clear word of code: a kind or a status, never text a source or an agent wrote.
const word = z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);

// What came of a client's own requests, proposals, opportunities and hypotheses. `what` is the
// row's kind, `results` the refs of rows that came of it which the caller can see. An
// `agent_record` item is one of the caller's own proposals or findings that code settled by an
// earlier ruling of the owner's, `what` its record kind, `status` `settled_confirmed` or
// `settled_rejected`, `at` when it was settled, with no results. An `opportunity` item is one of
// the caller's own opportunities the owner declined (`status` `declined`) or tasks the owner
// cancelled (`cancelled`); a `hypothesis` item one of its own hypotheses the owner rejected on its
// question's card (`rejected`); `what` its kind, `at` when, and `reason` the code the owner gave,
// when they gave one. A `goal_proposal` item is one of its own goal proposals the owner rejected
// (`rejected`), `what` its
// change.
export const SuggestionList = z.strictObject({
  items: z
    .array(
      z.strictObject({
        ref: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("work_request"), id: WorkRequestId.or(Handle) }),
          z.strictObject({ kind: z.literal("proposal"), id: ProposalId.or(Handle) }),
          z.strictObject({ kind: z.literal("opportunity"), id: OpportunityId.or(Handle) }),
          z.strictObject({ kind: z.literal("hypothesis"), id: HypothesisId.or(Handle) }),
          z.strictObject({ kind: z.literal("agent_record"), id: AgentRecordId.or(Handle) }),
          z.strictObject({ kind: z.literal("goal_proposal"), id: GoalProposalId }),
        ]),
        what: word,
        status: word,
        at: Timestamp,
        results: z.array(WorkRef).max(20),
        reason: DeclineReason.optional(),
      }),
    )
    .max(50),
  more: z.boolean(),
});
export type SuggestionList = z.infer<typeof SuggestionList>;
