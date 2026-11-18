import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { RoleName } from "./clients.ts";
import { AGENT_PROJECT_STATUSES, ProjectStatus } from "./fact-vocabulary.ts";
import { AgentRecordId, ClientName, EntityId, GoalId, Handle, OpportunityId, RequestId } from "./ids.ts";
import type { ClaimTier } from "./knowledge-model.ts";
import type { PersonalWorkTool } from "./tools.ts";
import { UntrustedString } from "./tools-args.ts";
import { Who } from "./tools-views.ts";

// Projects as agents write and read them. No shape here has a key for a label, a compartment, a
// reader or a client: the provider sets each. A project an agent creates takes the caller's
// clearance as its label.

const codePoints = (text: string): number => [...text].length;
const project = EntityId.or(Handle);
const goal = GoalId.or(Handle);

export const PROJECT_NAME_MOST = 200;
const PROJECT_NOTE_MOST = 2000;
const PROJECTS_LISTED = 50;
export const PROJECT_WORK_LISTED = 50;
export const PROJECT_NOTES_LISTED = 20;
export const PROJECT_CHANGES_LISTED = 50;
export const PROJECT_CHANGE_DAYS = 7;

const name = z
  .string()
  .refine((text) => codePoints(text.trim()) >= 1 && codePoints(text) <= PROJECT_NAME_MOST, {
    message: `1 to ${PROJECT_NAME_MOST} code points`,
  })
  .refine((text) => !text.includes("\u0000"), { message: "a NUL" });
const note = z
  .string()
  .refine((text) => codePoints(text.trim()) >= 1 && codePoints(text) <= PROJECT_NOTE_MOST, {
    message: `1 to ${PROJECT_NOTE_MOST} code points`,
  })
  .refine((text) => !text.includes("\u0000"), { message: "a NUL" });

// An area (Part C): a standing part of the owner's life or work that projects belong to. Its key
// is the owner's code for it, which filters and settings name; its name is the owner's words.
export const AreaKey = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export type AreaKey = z.infer<typeof AreaKey>;
export const AREAS_LISTED = 100;
// An area as a project and list_projects serve it. `retired`: the owner retired it; it keeps its
// projects and takes no new one.
export const AreaView = z.strictObject({ key: AreaKey, name: UntrustedString, retired: z.boolean() });
export type AreaView = z.infer<typeof AreaView>;

// The status an agent may set (B2). What mail states keeps its own words (PROJECT_STATUSES).
const AgentProjectStatus = z.enum(AGENT_PROJECT_STATUSES);

// The three tiers a project's status is read by (B3): the owner's word, a source's, an agent's.
export const ProjectStatusTier = z.enum(["owner", "source", "agent"]);
export type ProjectStatusTier = z.infer<typeof ProjectStatusTier>;

// Which of the three a claim's tier is. The owner's own word, a confirmation and words an agent
// relayed are the owner's; an agent's close and an agent's unconfirmed claim are an agent's; every
// other tier is a source's.
export function projectStatusTierOf(tier: ClaimTier): ProjectStatusTier {
  if (tier === "owner" || tier === "owner_confirmed" || tier === "owner_relayed") return "owner";
  return tier === "agent_inferred" || tier === "agent_closed" || tier === "agent_confirmed" ? "agent" : "source";
}

// Who said it: the owner; a source, by its speaker when one resolved; an agent, by its client name
// when the caller can read the record it was written with.
export const ProjectStatusBy = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.literal("source"), who: Who.nullable() }),
  z.strictObject({ kind: z.literal("agent"), client: ClientName.nullable() }),
]);
export type ProjectStatusBy = z.infer<typeof ProjectStatusBy>;

// `closed` is the owner's close of the project, which no claim states.
export const ProjectStandingValue = z.enum([...ProjectStatus.options, "closed"]);
export type ProjectStandingValue = z.infer<typeof ProjectStandingValue>;

const said = { value: ProjectStandingValue, asOf: Timestamp, by: ProjectStatusBy };
// Where the project stands, who said so and when; `disputedBy`, the latest word of each other
// tier that says otherwise, the higher tier first.
export const ProjectStanding = z.strictObject({
  ...said,
  disputedBy: z.array(z.strictObject(said)).min(1).max(2).optional(),
});
export type ProjectStanding = z.infer<typeof ProjectStanding>;

// A project as list_projects and get_project serve it. `createdBy`, the owner or the agent that
// created it (null: an agent whose name the caller is not shown).
export const ProjectView = z.strictObject({
  id: project,
  name: UntrustedString,
  status: ProjectStanding,
  ownerRole: RoleName.nullable(),
  goal: goal.nullable(),
  dueAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  createdBy: z.union([z.literal("owner"), ClientName]).nullable(),
  // AR4: the project's one area, where the caller can see areas; else null, as for none.
  area: AreaView.nullable(),
});
export type ProjectView = z.infer<typeof ProjectView>;

// A next step or a decision of the project, from a finding or from mail: its words, when, who said
// it, and for a next step who is to do it and by when.
export const ProjectNote = z.strictObject({
  what: UntrustedString,
  at: Timestamp,
  by: ProjectStatusBy,
  record: AgentRecordId.or(Handle).optional(),
  who: Who.optional(),
  due: z.union([DateOnly, Timestamp]).optional(),
});
export type ProjectNote = z.infer<typeof ProjectNote>;

// What changed on the project in the last PROJECT_CHANGE_DAYS days, newest first: a status said,
// a field an agent or the owner changed (`field`), or a step of its work (`work` with the work's
// event: proposed, go, claimed, done and the rest).
export const ProjectChange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("status"), at: Timestamp, value: ProjectStandingValue, by: ProjectStatusBy }),
  z.strictObject({
    kind: z.literal("field"),
    at: Timestamp,
    field: z.enum(["created", "name", "owner_role", "goal", "due_at", "note"]),
    by: z.enum(["owner", "agent"]),
  }),
  z.strictObject({
    kind: z.literal("work"),
    at: Timestamp,
    opportunity: OpportunityId.or(Handle),
    event: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  }),
]);
export type ProjectChange = z.infer<typeof ProjectChange>;

// The parts of get_project's result that name no work: work.ts adds the open work.
export const ProjectDetailParts = {
  nextSteps: z.array(ProjectNote).max(PROJECT_NOTES_LISTED),
  decisions: z.array(ProjectNote).max(PROJECT_NOTES_LISTED),
  changes: z.array(ProjectChange).max(PROJECT_CHANGES_LISTED),
  // More open work, next steps, decisions or changes than are listed.
  more: z.boolean(),
};

export const ProposeProjectArgs = z.strictObject({
  name,
  goal: goal.describe("A goal the project serves, from list_goals.").optional(),
  ownerRole: RoleName.describe("The role that leads the project.").optional(),
  dueAt: Timestamp.optional(),
  area: AreaKey.describe(
    "The area the project belongs to: a key from list_projects' areas. Left out, your role's default.",
  ).optional(),
  requestId: RequestId,
});
export type ProposeProjectArgs = z.infer<typeof ProposeProjectArgs>;
export const ProposeProjectResult = z.strictObject({ project });
export type ProposeProjectResult = z.infer<typeof ProposeProjectResult>;

// A field given is set; null clears a goal, an owner role or a due time. `status` is the agent's
// word on where the project stands, below the owner's and a source's; `note` says why.
export const UpdateProjectArgs = z
  .strictObject({
    project,
    status: AgentProjectStatus.optional(),
    name: name.optional(),
    ownerRole: RoleName.nullable().optional(),
    goal: goal.nullable().optional(),
    dueAt: Timestamp.nullable().optional(),
    area: AreaKey.nullable().describe("An area's key from list_projects' areas; null for none.").optional(),
    note: note.optional(),
    requestId: RequestId,
  })
  .refine(
    (args) =>
      ["status", "name", "ownerRole", "goal", "dueAt", "area", "note"].some(
        (key) => args[key as keyof typeof args] !== undefined,
      ),
    {
      message: "something to change",
    },
  );
export type UpdateProjectArgs = z.infer<typeof UpdateProjectArgs>;
// `refused`, the fields the owner set or the project's state keeps an agent from changing; the
// rest were written.
const ProjectFieldRefusal = z.enum(["owner_set", "not_active"]);
export const UpdateProjectResult = z.strictObject({
  project,
  status: ProjectStanding,
  record: AgentRecordId.or(Handle).optional(),
  refused: z
    .array(
      z.strictObject({
        field: z.enum(["status", "name", "ownerRole", "goal", "dueAt", "area", "note"]),
        code: ProjectFieldRefusal,
      }),
    )
    .min(1)
    .optional(),
});
export type UpdateProjectResult = z.infer<typeof UpdateProjectResult>;

// The most recently changed first; `after` is the `next` a page answered. AR7: `area`, only that
// area's projects; `order: "area"`, by the owner's order of the areas, then the most recently
// changed first. `areas`, every area the caller can see, in the owner's order.
export const ListProjectsArgs = z.strictObject({
  status: z.array(ProjectStandingValue).min(1).max(ProjectStandingValue.options.length).optional(),
  area: AreaKey.describe("Only the projects of this area: a key from areas.").optional(),
  order: z
    .enum(["changed", "area"])
    .describe("area: by the owner's order of the areas, then the most recently changed first.")
    .optional(),
  after: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .describe("The `next` a page answered, for projects changed earlier.")
    .optional(),
  limit: z.number().int().min(1).max(PROJECTS_LISTED).optional(),
});
export type ListProjectsArgs = z.infer<typeof ListProjectsArgs>;
export const ListProjectsResult = z.strictObject({
  projects: z.array(ProjectView).max(PROJECTS_LISTED),
  areas: z.array(AreaView).max(AREAS_LISTED),
  next: z.string().min(1).max(200).optional(),
});
export type ListProjectsResult = z.infer<typeof ListProjectsResult>;

const GetProjectArgs = z.strictObject({ project });

export const PROJECT_ARGS = Object.freeze({
  propose_project: ProposeProjectArgs,
  update_project: UpdateProjectArgs,
  list_projects: ListProjectsArgs,
  get_project: GetProjectArgs,
} satisfies Partial<Record<PersonalWorkTool, z.ZodType>>);
