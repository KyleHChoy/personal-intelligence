import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { RoleName } from "./clients.ts";
import { ClientName } from "./ids.ts";
import { UntrustedString } from "./tools-args.ts";

// The most lines a progress report says are done.
export const PROGRESS_LINES = 20;

// The latest progress report on a piece of work (report_move with the outcome progress): what is
// done so far, what comes next, what it waits on and when its holder means to resume; `at` and
// `by`, when it was reported and by which client. Every text is the agent's own, untrusted.
export const WorkProgress = z.strictObject({
  done: z.array(UntrustedString).max(PROGRESS_LINES),
  next: UntrustedString.nullable(),
  waitingOn: UntrustedString.nullable(),
  resumeAt: Timestamp.nullable(),
  at: Timestamp,
  by: ClientName,
});
export type WorkProgress = z.infer<typeof WorkProgress>;

// How a piece of a project's open work went, as get_project serves it beside the work, so an agent
// that takes the work over reads it in one call. `reports`: its last progress reports, the newest
// first. `checkBack`: its latest check-back: when it is due, the note it was deferred with, the
// client that set it, and whether it still waits. `handOff`: its latest hand-off: when, by which
// client, to which role (`owner` for the owner, null for any agent) and why (null for work handed
// to the owner).
export const PROJECT_REPORTS_LISTED = 5;
export const HandOffReason = z.enum(["other_role", "blocked", "other"]);
export type HandOffReason = z.infer<typeof HandOffReason>;
export const WorkTrail = {
  reports: z.array(WorkProgress).max(PROJECT_REPORTS_LISTED).optional(),
  checkBack: z
    .strictObject({ dueAt: Timestamp, note: UntrustedString.nullable(), by: ClientName, waiting: z.boolean() })
    .optional(),
  handOff: z
    .strictObject({ at: Timestamp, by: ClientName, to: RoleName.nullable(), reason: HandOffReason.nullable() })
    .optional(),
};
export type WorkTrail = { [K in keyof typeof WorkTrail]?: NonNullable<z.infer<(typeof WorkTrail)[K]>> };

// How a client has a piece of work it holds or held.
export const WorkHold = z.enum(["held", "held_until", "lapsed", "returned"]);
export type WorkHold = z.infer<typeof WorkHold>;
// The caller's own check-back on a piece of work: the one that waits, else the latest that came
// due. `holds`: it keeps the work the caller's until `dueAt`. `note`: why the work waited.
export const OwnCheckBack = z.strictObject({
  dueAt: Timestamp,
  note: UntrustedString.nullable(),
  waiting: z.boolean(),
  holds: z.boolean(),
});
export type OwnCheckBack = z.infer<typeof OwnCheckBack>;

// What an OpportunityView carries in scope `mine` alone: `held`, how the caller has the work.
// `held`: under its live lease. `held_until`: a check-back of its own holds it to a date, and no
// other agent is offered it. `lapsed`: its lease ran out under 24 hours ago, and it alone may claim
// it again. `returned`: a check-back of its own came due, and the work is its alone to claim for 24
// hours.
export const HELD_FIELDS = { held: WorkHold.optional() };
// What a WorkBrief carries of the caller's own check-back: on work that came back at its date,
// the note it was deferred with.
export const BRIEF_CHECK_BACK = { checkBack: OwnCheckBack.optional() };
