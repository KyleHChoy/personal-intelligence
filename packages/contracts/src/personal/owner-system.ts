import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { ImprovementArea, ImprovementKind, ImprovementSeverity, ImprovementStatus } from "./agent-mail.ts";
import { RoleName } from "./clients.ts";
import { DeployedCommit } from "./deployed-commit.ts";
import { ClientName, EntityId, GoalId, OpportunityId, RequestId } from "./ids.ts";
import { OpportunityKind, OpportunityStatus } from "./opportunity-words.ts";
import {
  AREAS_LISTED,
  AreaKey,
  PROJECT_CHANGES_LISTED,
  PROJECT_WORK_LISTED,
  ProjectChange,
  ProjectStanding,
} from "./projects.ts";
import { UntrustedString } from "./tools-args.ts";
import { WorkProgress } from "./work-progress.ts";

// The owner's reads of the system itself, its projects and its agents' work across days, as the
// dashboard's System and Projects rooms and Work's Agents part read them under pi_admin. Ids,
// counts, codes and times, with the names and lines the owner's other rooms already show for the
// same rows: a project's name, an agent's name, and an agent's own words on its work, each
// { untrusted }.

const count = z.number().int().nonnegative();

// A stored reading is not current once it is older than this: the daily filing pass has not read
// the measure since. The 48 hours get_health marks `stale` by (ledger.health_read).
export const READING_STALE_HOURS = 48;

// One outcome measure's latest stored reading against its healthy line. `healthy` and `minSample`
// are null for a reading that has no line of its own (a count sent from outside). `failingSince`:
// when the run of failing readings it is in began, null unless it is failing. `stale`: the reading was
// taken more than READING_STALE_HOURS before the read, so it says what was, not what is.
export const SystemMeasure = z.strictObject({
  metric: z.string().regex(/^[a-z0-9_:.-]{1,120}$/),
  state: z.enum(["ok", "failing", "no_data"]),
  value: z.number().nullable(),
  sample: count,
  readAt: Timestamp,
  healthy: z.strictObject({ test: z.enum(["at_least", "under", "at_most"]), value: z.number() }).nullable(),
  minSample: count.nullable(),
  failingSince: Timestamp.nullable(),
  stale: z.boolean(),
});
export type SystemMeasure = z.infer<typeof SystemMeasure>;
// Failing first, the longest failing leading, then those with no data, then the healthy, each by name.
export const SystemMeasures = z.strictObject({ at: Timestamp, measures: z.array(SystemMeasure) });
export type SystemMeasures = z.infer<typeof SystemMeasures>;
// The same with the commit `pi web` was deployed at, which the page's server adds.
export const SystemView = SystemMeasures.extend({ commit: DeployedCommit });
export type SystemView = z.infer<typeof SystemView>;

// One open defect: its severity, area and status, the role whose agents work it, the agent holding
// it, its latest fix reference, when it was first filed, and who filed it: the system, with the
// cause it measures (`kind` or `kind:subject`), or an agent.
export const SystemDefect = z.strictObject({
  improvement: z.string().regex(/^imp_[0-9A-HJKMNP-TV-Z]{26}$/),
  kind: ImprovementKind,
  severity: ImprovementSeverity,
  area: ImprovementArea,
  status: ImprovementStatus,
  role: RoleName.nullable(),
  heldBy: ClientName.nullable(),
  fixRef: z.string().max(500).nullable(),
  filedAt: Timestamp,
  days: count,
  reports: count,
  filedBy: z.enum(["system", "agent"]),
  cause: z.string().max(300).nullable(),
  // An agent looked and said the change is the owner's to make (`none:owners_to_change`).
  ownersToChange: z.boolean(),
  // What the agent that filed it wrote: its title, detail and evidence, each the agent's own words
  // (rendered as text, never as markup), null where it wrote none or it does not open. Null for a
  // defect the system filed, which is named by its cause.
  words: z
    .strictObject({
      title: UntrustedString.nullable(),
      detail: UntrustedString.nullable(),
      evidence: UntrustedString.nullable(),
    })
    .nullable(),
});
export type SystemDefect = z.infer<typeof SystemDefect>;
// The open defects, the most severe first and the oldest first within a severity.
export const SystemDefects = z.strictObject({
  at: Timestamp,
  total: count,
  open: count,
  // The role defects go to, null while the owner has set none: then no agent is assigned any.
  defectRole: RoleName.nullable(),
  // Of the open ones, how many an agent marked the owner's to change.
  ownersToChange: count,
  // Each role whose live defect tasks, two or more, are every one held to a date by one agent: no
  // other agent can take one until then.
  heldByOne: z.array(z.strictObject({ role: RoleName, agent: ClientName, tasks: count })).max(50),
  defects: z.array(SystemDefect),
});
export type SystemDefects = z.infer<typeof SystemDefects>;

// One piece of open work as the owner follows it across days: who has it and since when, its
// latest progress report, and, held to a date, when its holder means to return (`parkedUntil`, the
// holder's soonest waiting check-back that holds the work; a reminder that holds nothing is not
// one). `holder` is the client under a live lease, or the last holder while the work is still its
// alone: `lapsed` says which, true where the lease ran out and the hold has not.
export const OwnerLongWork = z.strictObject({
  opportunity: OpportunityId,
  kind: OpportunityKind,
  task: z.boolean(),
  status: OpportunityStatus,
  role: RoleName.nullable(),
  holder: ClientName.nullable(),
  lapsed: z.boolean(),
  // For lapsed work: when its holder's lease ran out, and until when the work is still its alone
  // where no check-back holds it (its 24 hours, or a check-back's return). Null otherwise.
  lapsedAt: Timestamp.nullable(),
  theirsUntil: Timestamp.nullable(),
  since: Timestamp.nullable(),
  project: EntityId.nullable(),
  dueAt: Timestamp.nullable(),
  summary: UntrustedString.nullable(),
  progress: WorkProgress.nullable(),
  parkedBy: ClientName.nullable(),
  parkedUntil: Timestamp.nullable(),
});
export type OwnerLongWork = z.infer<typeof OwnerLongWork>;
export const LONG_WORK_LISTED = 200;
// The work an agent has: held under a live lease, held to a date, or its alone to resume; the
// longest held first.
export const AgentLongWork = z.strictObject({
  at: Timestamp,
  work: z.array(OwnerLongWork).max(LONG_WORK_LISTED),
  more: z.boolean(),
});
export type AgentLongWork = z.infer<typeof AgentLongWork>;

// One project as the owner sees it: its name (null where the key file lacks its compartment),
// where it stands and what another tier says, its fields, its open work with each piece's holder
// and latest progress, and what changed in the last seven days.
export const OwnerProject = z.strictObject({
  id: EntityId,
  name: UntrustedString.nullable(),
  status: ProjectStanding,
  ownerRole: RoleName.nullable(),
  goal: GoalId.nullable(),
  dueAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  createdBy: z.union([z.literal("owner"), ClientName]).nullable(),
  // The key of the area it belongs to, one of `areas`; null for none.
  area: AreaKey.nullable(),
  work: z.array(OwnerLongWork).max(PROJECT_WORK_LISTED),
  changes: z.array(ProjectChange).max(PROJECT_CHANGES_LISTED),
  more: z.boolean(),
});
export type OwnerProject = z.infer<typeof OwnerProject>;
export const OWNER_PROJECTS_LISTED = 100;
// An area as the owner sees it: `name` is null where the key file lacks its compartment.
export const OwnerArea = z.strictObject({ key: AreaKey, name: UntrustedString.nullable(), retired: z.boolean() });
export type OwnerArea = z.infer<typeof OwnerArea>;
// Every project but a merged one, the most recently changed first, and every area in the owner's
// order, the retired ones last.
export const OwnerProjects = z.strictObject({
  at: Timestamp,
  projects: z.array(OwnerProject).max(OWNER_PROJECTS_LISTED),
  areas: z.array(OwnerArea).max(AREAS_LISTED),
  more: z.boolean(),
});
export type OwnerProjects = z.infer<typeof OwnerProjects>;

// The owner's stop or start of all agent work: the request alone, the state is the route's.
export const WorkSwitchBody = z.strictObject({ requestId: RequestId });
export type WorkSwitchBody = z.infer<typeof WorkSwitchBody>;

// `pia loops`: what each autonomous loop produced in the window and in the window before it, counts
// only, so a loop that stopped reads `idle` and one that never ran reads `empty`.
export const LOOP_NAMES = Object.freeze([
  "extraction",
  "dreaming",
  "work_tick",
  "agents",
  "questions",
  "planner",
  "outcome_loop",
  "measures",
] as const);
export type LoopName = (typeof LOOP_NAMES)[number];
export type LoopRow = {
  loop: LoopName;
  produced: Record<string, number>;
  before: Record<string, number>;
  state: "producing" | "idle" | "empty";
};
export type LoopsView = { days: number; at: Timestamp; loops: LoopRow[] };
