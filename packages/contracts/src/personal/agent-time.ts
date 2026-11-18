import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { AgentAnchorId, AgentRulingId, ClientName, EntityId, RequestId, TimeProposalId } from "./ids.ts";
import type { PersonalWorkTool } from "./tools.ts";
import { UntrustedString } from "./tools-args.ts";
import { WhereKind, Who, WorkBasisCode } from "./tools-views.ts";

// Agents read work time by place and sort it into projects. No shape here has a key for a label, a
// compartment or a reader: code computes every label, and every list is of rows the caller can see.
// A place is a repository, folder, document, host or app, or a chat thread. Window titles, page
// titles and meeting names are served only to a caller holding the title role the owner names, each
// untrusted.

// The most local days one read covers, and the longest stretch one ruling holds.
const WORK_TIME_DAYS = 14;
const AGENT_RULING_HOURS = 24;
// The most of each list one read serves; past it, `more`.
export const WORK_TIME_GROUPS = 50;
export const WORK_TIME_STRETCHES = 20;
export const WORK_TIME_CREDITED = 200;
// The most page titles one uncredited group serves to the title role.
export const WORK_TIME_PAGES = 10;
export const AGENT_TIME_ROWS = 200;
// The most stretches one judged proposal holds: more than a day's pieces ever are.
export const JUDGED_STRETCHES = 1000;

// The kinds of place an agent may anchor: a block's strong keys.
const AgentAnchorKind = z.enum(["repository", "host", "document", "app"]);

const minutes = z.number().nonnegative();
const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / DAY_MS;

// get_work_time: the local days from `from` to `to`, both included, in the owner's zone.
export const GetWorkTimeArgs = z
  .strictObject({ from: DateOnly, to: DateOnly })
  .refine((args) => daysBetween(args.from, args.to) >= 0 && daysBetween(args.from, args.to) < WORK_TIME_DAYS, {
    message: `to on or after from, at most ${WORK_TIME_DAYS} days`,
  });
export type GetWorkTimeArgs = z.infer<typeof GetWorkTimeArgs>;

const Stretch = z.strictObject({ from: Timestamp, to: Timestamp });
// A place as code sees it: one of WhereKind's kinds, or the chat thread on screen.
const WorkTimePlace = z.strictObject({
  kind: z.union([WhereKind, z.literal("thread")]),
  value: UntrustedString,
});

export const GetWorkTimeResult = z.strictObject({
  from: Timestamp,
  to: Timestamp,
  // Credited minutes by project and the step that credited them, most first.
  credited: z
    .array(z.strictObject({ project: Who, basis: WorkBasisCode.exclude(["none"]), minutes }))
    .max(WORK_TIME_CREDITED),
  // Uncredited minutes grouped by place, most first, each with its stretches (oldest first).
  uncredited: z
    .array(
      z.strictObject({
        place: WorkTimePlace,
        app: UntrustedString,
        host: UntrustedString.nullable(),
        minutes,
        stretches: z.array(Stretch).max(WORK_TIME_STRETCHES),
        more: z.boolean(),
        // The title role's alone: the window title the group is cut by, and the titles of the pages its
        // blocks kept.
        title: UntrustedString.optional(),
        pages: z.array(UntrustedString).max(WORK_TIME_PAGES).optional(),
      }),
    )
    .max(WORK_TIME_GROUPS),
  uncreditedMinutes: minutes,
  // The title role's alone: the uncredited meetings in the window, by name, oldest first.
  meetings: z
    .array(z.strictObject({ name: UntrustedString, from: Timestamp, to: Timestamp, minutes }))
    .max(WORK_TIME_GROUPS)
    .optional(),
  // The system's live proposals in the window: judge_time_proposal takes one.
  proposals: z
    .array(
      z.strictObject({
        proposal: TimeProposalId,
        project: Who,
        stretches: z.array(Stretch).max(WORK_TIME_STRETCHES),
        place: WorkTimePlace.nullable(),
      }),
    )
    .max(WORK_TIME_GROUPS),
  // The caller's own live anchors, and its own live rulings that touch the window.
  anchors: z
    .array(z.strictObject({ anchor: AgentAnchorId, project: EntityId, kind: AgentAnchorKind, createdAt: Timestamp }))
    .max(AGENT_TIME_ROWS),
  rulings: z
    .array(
      z.strictObject({
        ruling: AgentRulingId,
        project: EntityId,
        from: Timestamp,
        to: Timestamp,
        proposal: TimeProposalId.nullable(),
        createdAt: Timestamp,
      }),
    )
    .max(AGENT_TIME_ROWS),
  // A list was cut at its most, or a bound left capture rows out.
  more: z.boolean(),
});
export type GetWorkTimeResult = z.infer<typeof GetWorkTimeResult>;

export const SetAnchorArgs = z.strictObject({
  project: EntityId,
  kind: AgentAnchorKind,
  value: z.string().min(1).max(1000),
  requestId: RequestId,
});
export type SetAnchorArgs = z.infer<typeof SetAnchorArgs>;
export const SetAnchorResult = z.strictObject({ anchor: AgentAnchorId });
export type SetAnchorResult = z.infer<typeof SetAnchorResult>;

export const LiftAnchorArgs = z.strictObject({ anchor: AgentAnchorId, requestId: RequestId });
export type LiftAnchorArgs = z.infer<typeof LiftAnchorArgs>;
export const LiftedResult = z.strictObject({ lifted: z.literal(true) });
export type LiftedResult = z.infer<typeof LiftedResult>;

export const RuleTimeArgs = z
  .strictObject({ from: Timestamp, to: Timestamp, project: EntityId, requestId: RequestId })
  .refine(
    (args) =>
      Date.parse(args.to) > Date.parse(args.from) &&
      Date.parse(args.to) - Date.parse(args.from) <= AGENT_RULING_HOURS * 3_600_000,
    { message: `to after from, at most ${AGENT_RULING_HOURS} hours` },
  );
export type RuleTimeArgs = z.infer<typeof RuleTimeArgs>;
export const RuleTimeResult = z.strictObject({ ruling: AgentRulingId });
export type RuleTimeResult = z.infer<typeof RuleTimeResult>;

export const LiftTimeRulingArgs = z.strictObject({ ruling: AgentRulingId, requestId: RequestId });
export type LiftTimeRulingArgs = z.infer<typeof LiftTimeRulingArgs>;

// Accept a proposal (no project) or redirect it to another project; there is no reject.
export const JudgeTimeProposalArgs = z.strictObject({
  proposal: TimeProposalId,
  project: EntityId.optional(),
  requestId: RequestId,
});
export type JudgeTimeProposalArgs = z.infer<typeof JudgeTimeProposalArgs>;
export const JudgeTimeProposalResult = z.strictObject({ rulings: z.array(AgentRulingId).min(1).max(JUDGED_STRETCHES) });
export type JudgeTimeProposalResult = z.infer<typeof JudgeTimeProposalResult>;

export const AGENT_TIME_ARGS = Object.freeze({
  get_work_time: GetWorkTimeArgs,
  set_anchor: SetAnchorArgs,
  lift_anchor: LiftAnchorArgs,
  rule_time: RuleTimeArgs,
  lift_time_ruling: LiftTimeRulingArgs,
  judge_time_proposal: JudgeTimeProposalArgs,
} satisfies Partial<Record<PersonalWorkTool, z.ZodType>>);
export const AGENT_TIME_RESULTS = Object.freeze({
  get_work_time: GetWorkTimeResult,
  set_anchor: SetAnchorResult,
  lift_anchor: LiftedResult,
  rule_time: RuleTimeResult,
  lift_time_ruling: LiftedResult,
  judge_time_proposal: JudgeTimeProposalResult,
} satisfies Record<keyof typeof AGENT_TIME_ARGS, z.ZodType>);

// The owner's view (`pia time agents`, the Projects room): every live agent anchor and ruling, newest
// first, with the agent and when; and the week's sample of five for the owner to mark right or wrong.
export const AGENT_TIME_SAMPLE = 5;
export const AgentTimeRow = z.strictObject({
  id: z.union([AgentAnchorId, AgentRulingId]),
  kind: z.union([AgentAnchorKind, z.literal("ruling")]),
  project: EntityId,
  projectName: z.string().nullable(),
  // An anchor's place at its normal form, as the agent gave it; null for a ruling.
  place: z.string().nullable(),
  client: ClientName,
  from: Timestamp.nullable(),
  to: Timestamp.nullable(),
  createdAt: Timestamp,
  // The owner's mark on a sampled row: right, wrong, or not yet.
  mark: z.enum(["right", "wrong"]).nullable(),
});
export type AgentTimeRow = z.infer<typeof AgentTimeRow>;
export const AgentTimeView = z.strictObject({
  rows: z.array(AgentTimeRow).max(AGENT_TIME_ROWS),
  more: z.boolean(),
  // This week's fixed sample (ISO week starting Monday, UTC), at most AGENT_TIME_SAMPLE ids.
  week: DateOnly,
  sample: z.array(z.union([AgentAnchorId, AgentRulingId])).max(AGENT_TIME_SAMPLE),
  // Of every sample marked so far: right, wrong (the measure's precision).
  marked: z.strictObject({ right: z.number().int().nonnegative(), wrong: z.number().int().nonnegative() }),
});
export type AgentTimeView = z.infer<typeof AgentTimeView>;
// The owner's right or wrong on one agent anchor or ruling, from the Projects room.
export const AgentTimeMarkBody = z.strictObject({
  id: z.union([AgentAnchorId, AgentRulingId]),
  mark: z.enum(["right", "wrong"]),
  requestId: RequestId,
});
export type AgentTimeMarkBody = z.infer<typeof AgentTimeMarkBody>;
