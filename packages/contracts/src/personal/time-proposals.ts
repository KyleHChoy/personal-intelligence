import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { EntityId, RequestId, TimeProposalId } from "./ids.ts";
import { UntrustedString } from "./tools-args.ts";
import { Who } from "./tools-views.ts";
import { TIME_GROUPS_MAX } from "./work-time.ts";

// Ids and the choice alone: no word of it is ever stored or shown, and it has no place for a label,
// a reader or a destination. Code checks every id against what it asked.
const TimeGroupRef = z.string().regex(/^g[0-9]{1,3}$/);
export const TimeProposalAnswer = z.strictObject({
  assignments: z
    .array(z.strictObject({ project: EntityId, groups: z.array(TimeGroupRef).min(1).max(TIME_GROUPS_MAX) }))
    .max(TIME_GROUPS_MAX),
  newEfforts: z.array(TimeGroupRef).max(TIME_GROUPS_MAX),
});
export type TimeProposalAnswer = z.infer<typeof TimeProposalAnswer>;

export const TimeProposalView = z.strictObject({
  id: TimeProposalId,
  project: Who,
  from: Timestamp,
  to: Timestamp,
  minutes: z.number().min(0),
  stretches: z.number().int().nonnegative(),
  what: UntrustedString,
});
export type TimeProposalView = z.infer<typeof TimeProposalView>;
export const TimeProposals = z.strictObject({ proposals: z.array(TimeProposalView), projects: z.array(Who) });
export type TimeProposals = z.infer<typeof TimeProposals>;
export const TimeVetoBody = z.strictObject({ proposal: TimeProposalId, to: EntityId.optional(), requestId: RequestId });
export type TimeVetoBody = z.infer<typeof TimeVetoBody>;
