import { z } from "zod";
import { EntityId, Handle } from "./ids.ts";

// What an agent proposes about a goal: a change to it, or who it is after. Each is a card; only the
// owner's accept makes it theirs.

const codePoints = (text: string): number => [...text].length;

// A goal change an agent proposes; the owner's accept makes it theirs.
export const GOAL_CHANGES = Object.freeze(["add", "reword", "pause", "done", "drop"] as const);
export const GoalChange = z.enum(GOAL_CHANGES);
export type GoalChange = z.infer<typeof GoalChange>;
// The status each status change sets, as `pi goal status` does.
export const GOAL_CHANGE_STATUS = Object.freeze({ pause: "paused", done: "done", drop: "dropped" } as const);
// The bound `pi goal add` takes.
export const GOAL_STATEMENT_MOST = 1000;
export const goalStatement = z
  .string()
  .refine(
    (text) => codePoints(text.trim()) >= 1 && codePoints(text) <= GOAL_STATEMENT_MOST && !text.includes("\u0000"),
    { message: `1 to ${GOAL_STATEMENT_MOST} code points` },
  );
export type goalStatement = z.infer<typeof goalStatement>;
// What propose_goal answers: carded, a card on the same change already waiting, the owner's earlier no on
// it with no new basis, or a status change already in force. Nothing else is said.
export const GoalProposalStatus = z.enum(["proposed", "pending", "rejected", "in_force"]);
export type GoalProposalStatus = z.infer<typeof GoalProposalStatus>;
// What propose_goal_target answers: carded (or nothing it may be told of stands), a card on the same
// target waiting, the owner's no on it, already the goal's target, or the goal's cards at their cap.
export const GoalTargetProposalStatus = z.enum(["proposed", "pending", "rejected", "in_force", "capped"]);
export type GoalTargetProposalStatus = z.infer<typeof GoalTargetProposalStatus>;

// The longest name `pia goal target --name` takes, and the name as an agent gives it.
const GOAL_TARGET_NAME_MOST = 200;
const goalTargetName = z
  .string()
  .refine(
    (text) => codePoints(text.trim()) >= 1 && codePoints(text) <= GOAL_TARGET_NAME_MOST && !text.includes("\u0000"),
    { message: `1 to ${GOAL_TARGET_NAME_MOST} code points` },
  );

// The person or organization a goal is after, a card for the owner: by an id from a read, or by a
// name nobody may be known by yet. A person's name is a full name, as `pia goal target --name` takes
// one; `organization` says a name is an organization's. Shapes shared with the other proposal tools
// come from work.ts, which imports this file.
export const proposeGoalTargetArgs = <
  G extends z.ZodType,
  S extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
>(shared: {
  goal: G;
  summary: S;
  basis: B;
  requestId: R;
}) =>
  z
    .strictObject({
      goal: shared.goal.describe("The goal, from list_goals.") as G,
      entity: EntityId.or(Handle).optional().describe("A person or organization you can see, from search."),
      name: goalTargetName.optional().describe("Instead of entity: a full name, or an organization's name."),
      organization: z.literal(true).optional().describe("The name is an organization's."),
      summary: shared.summary,
      basis: shared.basis,
      requestId: shared.requestId,
    })
    .refine((args) => (args.entity === undefined) !== (args.name === undefined), {
      message: "entity or name, one of them",
      path: ["entity"],
    })
    .refine((args) => args.organization === undefined || args.name !== undefined, {
      message: "organization goes with name",
      path: ["organization"],
    })
    .refine((args) => args.name === undefined || args.organization === true || /\s/u.test(args.name.trim()), {
      message: "a person's full name",
      path: ["name"],
    });
