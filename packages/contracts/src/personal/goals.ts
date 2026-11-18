import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { GoalId, Handle } from "./ids.ts";
import { Hex64 } from "./primitives.ts";
import { GoalState, UntrustedString } from "./tools-args.ts";

// list_goals: the owner's goals, newest first, at most 50, and whether more
// matched. A statement is the owner's own text, sealed under the compartment they named; it is served
// inside { untrusted } as every stored text is.
// A goal is a belief, computed when asked: one the owner set with `pi goal add` (its id a `gol_`) and
// one they only stated in their mail (its id the fact key's fingerprint, served as a handle where handles
// are on). `stale` marks a goal nothing supported within its review window; a stale goal is
// listed only when asked for. `disputed`: a goal the owner set that their mail later reverses stays
// open, its reversal cited by the claim's fingerprint (`reversal`), so the owner sees it and closes it
// themselves.
export const GOALS_LISTED = 50;

export const ListedGoal = z.strictObject({
  id: GoalId.or(Handle).or(Hex64),
  statement: UntrustedString,
  status: GoalState,
  setAt: Timestamp,
  stale: z.literal(true).optional(),
  // get_self's: the owner's own statement calls this their first priority.
  top: z.literal(true).optional(),
  disputed: z.literal(true).optional(),
  reversal: Hex64.or(Handle).optional(),
  // The latest `advances` outcome on work that names the
  // goal, shown on it; an outcome never closes a goal.
  advancedAt: Timestamp.optional(),
});
export type ListedGoal = z.infer<typeof ListedGoal>;

export const GoalList = z.strictObject({ goals: z.array(ListedGoal).max(GOALS_LISTED), more: z.boolean() });
export type GoalList = z.infer<typeof GoalList>;

// The review windows, `ontology/goals.json` (provisional rule data): a goal is stale when nothing
// supports it for `set` days, for a goal the owner set, or `stated` days, for one they only stated.
// Support is a claim on its key and the owner's rulings on it.
export const GoalReview = z.strictObject({
  set: z.number().int().min(1).max(3650),
  stated: z.number().int().min(1).max(3650),
});
export type GoalReview = z.infer<typeof GoalReview>;
