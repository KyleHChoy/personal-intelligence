import {
  GOALS_LISTED,
  type GoalId,
  type GoalList,
  type ListedGoal,
  ListGoalsArgs,
} from "@intelligence/contracts/personal";
import { byText } from "../core/db.ts";
import type { Ctx, Found } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { computedGoals } from "./read-goal-beliefs.ts";

// list_goals: the goals the owner set, read under the caller's token, newest set first, at most 50, one
// more to say whether more matched. Each goal is a belief computed when asked (goal-beliefs.ts),
// active and not stale by default; `stale: true` lists the stale ones too, each marked, and
// `stated: true` the goals they only stated in a source, by their fact key. Goals are
// shown, as the row policy on projections.goal_state shows them, to the reasoner and to a client
// that holds the tool and the work view: any other caller is shown none. A goal is no evidence:
// the read log row names the goals by id and the fact keys of the beliefs shown. The packs' second
// degree shows a goal by the same gate.
export const SHOWN = `
  select (('list_goals' = any (c.tools) and 'work' = any (c.views)) or (select policy.current_client_kind()) = 'reasoner') as shown,
    policy.client_clearance() as clearance
  from policy.current_client() c`;

// The owner's own order of the goals shown (`pi goal rank`), for get_self's head.
const RANKS =
  "select g.goal_id, g.rank from projections.goal_state g where g.goal_id = any($1) and g.rank is not null order by g.goal_id";
export async function goalRanks(ctx: Ctx, goals: readonly { id: string }[]): Promise<ReadonlyMap<string, number>> {
  if (goals.length === 0) return new Map();
  const rows = await ctx.run<{ goal_id: string; rank: number }>(RANKS, [goals.map((goal) => goal.id)]);
  return new Map(rows.map((row) => [row.goal_id, row.rank]));
}

// `only: "set"`, the goals the owner set alone whatever `args` asks: get_self's head and the context's
// goals, whose stated goals are already its section lines.
export async function listGoals(
  ctx: Ctx,
  args: ListGoalsArgs,
  now: Date,
  only: "set" | "args" = "args",
): Promise<Found<GoalList> & { withheld: boolean }> {
  const status = args.status ?? "active";
  const [gate] = await ctx.run<{ shown: boolean | null; clearance: string[] }>(SHOWN, []);
  const empty = {
    value: { goals: [], more: false },
    rows: 0,
    read: { bound: [], shown: [], factKeyFps: [], goals: [] },
    withheld: true,
  };
  if (gate === undefined || gate.shown !== true) return empty;
  const setOnly = only === "set" || args.stated !== true;
  const all = await computedGoals(ctx, gate.clearance, now.toISOString(), { setOnly });
  const matched = all.filter(
    (goal) =>
      (!setOnly || goal.goal !== null) &&
      (status === "any" || goal.status === status) &&
      (args.stale === true || !goal.stale),
  );
  const listed = matched.slice(0, GOALS_LISTED);
  const goals: ListedGoal[] = listed.map((goal) => ({
    id: goal.id as ListedGoal["id"],
    statement: { untrusted: goal.statement },
    status: goal.status,
    setAt: goal.setAt,
    ...(goal.stale ? { stale: true as const } : {}),
    ...(goal.disputed ? { disputed: true as const } : {}),
    ...(goal.reversal === null ? {} : { reversal: goal.reversal }),
    ...(goal.advancedAt === undefined ? {} : { advancedAt: goal.advancedAt }),
  }));
  return {
    withheld: false,
    value: { goals, more: matched.length > GOALS_LISTED },
    rows: goals.length,
    read: {
      bound: [],
      shown: [],
      factKeyFps: [...new Set(listed.flatMap((goal) => (goal.factKeyFp === "" ? [] : [goal.factKeyFp])))].sort(byText),
      goals: [...new Set(listed.flatMap((goal) => (goal.goal === null ? [] : [goal.goal as GoalId])))].sort(byText),
    },
  };
}

// The owner's goals the caller is cleared for, view `work`: a list tool.
export const LIST_GOALS_TOOL: ReadTool<ListGoalsArgs, GoalList> = {
  tool: "list_goals",
  parse: (args) => parsed(ListGoalsArgs.safeParse(args)),
  work: (ctx, valid, _client, env) => listGoals(ctx, valid, env.now()),
};
