import type { BeliefRecord, GoalId, GoalState, UntrustedString } from "@intelligence/contracts/personal";
import { type BeliefInputs, beliefAt } from "@intelligence/personal-beliefs";
import { byText, type Query, stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { goalReview, isStale } from "../core/goal-review.ts";
import { ownerZoneOf } from "../core/zone.ts";
import { readBeliefInputs } from "../pipeline/belief-inputs.ts";
import { type Ctx, servedOrNull } from "./read-ctx.ts";

// The owner's goals as beliefs, computed when asked by `beliefAt` from the rows the caller's token
// returns, in the call's one snapshot. A goal is every goal belief about the owner: one they set (an
// owner_command claim, resolved to every goal id on its key through knowledge.goal_ids) and one they only
// stated. Its status is the owner's word alone: their latest goal_status ruling, held in
// projections.goal_state, else active. Staleness is a mark and closes nothing: a goal is stale when
// neither a claim on its key nor a ruling of the owner's on it falls within its review window
// (`ontology/goals.json`: 60 days for a goal the owner set, 30 for one they stated), counted in the
// owner's local days. An applied outcome link on a goal, or a move on it, is support too, read apart from
// `beliefAt`, which stays pure over claims, rulings and relations; an `advances` link is shown on the
// goal, and no outcome closes one. Every statement reads only rows the token returns, so nothing a viewer
// cannot see changes a goal it is shown (invariant 6).
//
// A goal the owner set is closed only by their command or ruling, and a reversal in mail leaves it open and
// disputed. Every goal id on a key is its own goal, sharing the belief. A goal with no mapping row
// yet is read from goal_state, so nothing is hidden before the backfill.

// policy.belief_inputs takes at most this many fact keys a call.
const INPUTS_MAX = 1000;

// The fact keys of the goal claims the token returns, stored by `asOf`.
export const GOAL_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  where policy.label_key(c.compartments) = any ((select policy.clearance_keys())::text[])
    and c.type = 'goal' and c.created_at <= $1::timestamptz
  order by c.fact_key_fp`;

// Each goal id the token returns whose rows name one of the keys, and its latest key: a reworded
// goal's earlier keys are its words no longer.
export const GOAL_MAPPINGS = `
  select distinct on (m.goal_id) m.goal_id, m.fact_key_fp
  from knowledge.goal_ids m
  where policy.label_key(m.compartments) = any ((select policy.clearance_keys())::text[])
    and m.goal_id in (
      select n.goal_id from knowledge.goal_ids n
      where policy.label_key(n.compartments) = any ((select policy.clearance_keys())::text[]) and n.fact_key_fp = any ($1::text[]))
    and m.created_at <= $2::timestamptz
    and not exists (select 1 from knowledge.goal_key_rulings u where u.goal_id = m.goal_id and u.verdict = 'adopt' and u.lifted_at is not null)
  order by m.goal_id, m.created_at desc, m.claim_id collate "C" desc`;

// The keys among them any goal id's rows name. A goal whose adoption the owner undid
// (knowledge.goal_key_rulings, an `adopt` lifted) is no goal; its row on the source goal's key
// names it no longer, so the source goal shows again, and its rows on the owner's own words' keys
// still do, so the owner's words are never shown as a goal from a source.
export const GOAL_NAMED_KEYS = `
  select distinct n.fact_key_fp from knowledge.goal_ids n
  where policy.label_key(n.compartments) = any ((select policy.clearance_keys())::text[]) and n.fact_key_fp = any ($1::text[])
    and not exists (select 1 from knowledge.goal_key_rulings u where u.goal_id = n.goal_id and u.fact_key_fp = n.fact_key_fp and u.verdict = 'adopt' and u.lifted_at is not null)
  order by n.fact_key_fp`;

// The keys among them whose goal stated in a source the owner removed, a hide in force.
const GOAL_HIDDEN = `
  select distinct r.fact_key_fp from knowledge.goal_key_rulings r
  where policy.label_key(r.compartments) = any ((select policy.clearance_keys())::text[])
    and r.verdict = 'hide' and r.lifted_at is null and r.fact_key_fp = any ($1::text[]) and r.created_at <= $2::timestamptz
  order by r.fact_key_fp`;

// The goal ids among them the token's goal_state policy returns, with the owner's word on each. A
// primary-key lookup on goal_state, as pi_reader under its row policy; not label-led.
const GOAL_RULINGS = `
  select g.goal_id, g.status, g.stated_at, g.updated_at from projections.goal_state g
  where g.goal_id = any ($1::text[])
  order by g.goal_id`;

// For each goal id, the latest applied outcome link and the latest move on untainted work
// that names it, and the latest `advances` link, as the token returns them (the reader's policy on
// ledger.outcome_links returns applied, untainted links within its clearance), by `asOf`.
const GOAL_WORK_SUPPORT = `
  select x.goal_id, max(x.at) as last, max(x.at) filter (where x.kind = 'advances') as advanced
  from (
    select l.goal_id, l.judged_at as at, l.kind from ledger.outcome_links l
    where l.goal_id = any ($1::text[]) and policy.label_key(l.compartments) = any ((select policy.clearance_keys())::text[]) and l.judged_at <= $2::timestamptz
    union all
    select o.goal_id, m.created_at, null from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id
    where o.goal_id = any ($1::text[]) and m.tainted_at is null and o.tainted_at is null
      and policy.label_key(m.compartments) = any ((select policy.clearance_keys())::text[])
      and policy.label_key(o.compartments) = any ((select policy.clearance_keys())::text[])
      and m.created_at <= $2::timestamptz
  ) x
  group by x.goal_id
  order by x.goal_id`;

// The goals the token's goal_state policy returns that no mapping row names yet.
const GOAL_UNMAPPED = `
  select g.goal_id, g.status, g.stated_at, g.compartments, g.statement_enc from projections.goal_state g
  where not exists (select 1 from knowledge.goal_ids m where m.goal_id = g.goal_id)
    and not exists (select 1 from knowledge.goal_key_rulings u where u.goal_id = g.goal_id and u.verdict = 'adopt' and u.lifted_at is not null)
  order by g.goal_id`;

export type ComputedGoal = {
  id: GoalId | string;
  goal: GoalId | null;
  // Empty for a goal read from goal_state with no mapping row, which has no belief yet.
  factKeyFp: string;
  statement: string;
  status: GoalState;
  setAt: string;
  stale: boolean;
  disputed: boolean;
  // The stored id of the mail reversal a goal the owner set is open beside.
  reversal: string | null;
  // The latest applied `advances` outcome on work naming it.
  advancedAt?: string;
  unmapped?: true;
};

// The goals a reasoner's request carries: every active goal the owner set, a stale one marked (stale
// is a mark, never an exit), in goal id order.
export const requestGoals = (
  goals: readonly ComputedGoal[],
): { id: GoalId; statement: UntrustedString; stale?: true }[] =>
  goals
    .filter((goal) => goal.goal !== null && goal.status === "active")
    .sort((a, b) => byText(a.goal as string, b.goal as string))
    .map((goal) => ({
      id: goal.goal as GoalId,
      statement: { untrusted: goal.statement },
      ...(goal.stale ? { stale: true as const } : {}),
    }));

// A goal the owner set that a reversal in their mail closed, built again without the reversals of other
// origins: open there means only that reversal closed it, so it is served open and disputed.
function reopened(
  inputs: BeliefInputs,
  clearance: readonly string[],
  record: BeliefRecord,
  read: string,
): { record: BeliefRecord; reversal: string } | undefined {
  const group = inputs.groups.find((one) => one.factKeyFp === record.factKeyFp);
  if (group === undefined || !group.claims.some((one) => one.origin === "owner_command")) return undefined;
  const reversals = group.claims.filter(
    (one) => one.origin !== "owner_command" && one.claim.statementKind === "reversal",
  );
  const latest = [...reversals].sort((a, b) => Date.parse(b.claim.validFrom) - Date.parse(a.claim.validFrom))[0];
  if (latest === undefined) return undefined;
  const without = {
    ...inputs,
    groups: inputs.groups.map((one) =>
      one === group ? { ...one, claims: one.claims.filter((claim) => !reversals.includes(claim)) } : one,
    ),
  };
  const [again] = beliefAt(without, clearance, [record.factKeyFp], read).filter(
    (one) => one.factKeyFp === record.factKeyFp,
  );
  return again === undefined || again.belief.status === "closed"
    ? undefined
    : { record: again, reversal: latest.claim.id };
}

// Every goal of the owner the caller may see, judged stale or not at `asOf`, newest set first. The
// rows are read as of the later of `asOf` and the transaction's own time, so a caller whose clock
// runs behind the database (a test's fixed clock) still reads every committed row of its snapshot.
export async function computedGoals(
  ctx: Pick<Ctx, "run" | "keys">,
  clearance: readonly string[],
  asOf: string,
  // Only the goals the owner set: the beliefs of the keys a goal id names, not every goal claim's,
  // which a first read of the owner pays for on each call.
  options: { setOnly?: boolean } = {},
): Promise<ComputedGoal[]> {
  const query: Query = (text, values = []) => ctx.run(text, values);
  const [clock] = await ctx.run<{ at: Date }>("select now() as at", []);
  const read = new Date(Math.max(Date.parse(asOf), clock?.at.getTime() ?? 0)).toISOString();
  const zone = await ownerZoneOf(query);
  const now = Date.parse(asOf);
  const goals: ComputedGoal[] = [];
  const { claims, beliefs } = await ownerGoalBeliefs(ctx, clearance, read, options.setOnly === true);
  const { goalsOf, named, hidden, rulings, support } = await goalRowsOf(ctx, beliefs, read);
  const { set, stated } = goalReview();
  for (const { record, reversal } of beliefs) {
    const { belief, factKeyFp } = record;
    const ids = goalsOf.get(factKeyFp) ?? [];
    // A key a goal's words were and are no longer: the goal is listed under its latest key.
    if (named.has(factKeyFp) && ids.length === 0) continue;
    const times = belief.support.flatMap((id) => {
      const at = claims.get(id)?.at;
      return at === undefined || Number.isNaN(at) ? [] : [at];
    });
    // Its words: the owner's own command's latest where they set it, else its phrase claim's.
    const command = belief.support
      .filter((id) => claims.get(id)?.origin === "owner_command")
      .sort((a, b) => (claims.get(b)?.at ?? 0) - (claims.get(a)?.at ?? 0))[0];
    const words = claims.get(command ?? record.phraseClaim ?? belief.support[0] ?? "");
    const statement =
      typeof words?.objective === "string" ? words.objective : typeof words?.what === "string" ? words.what : "";
    const disputed = reversal !== null || belief.disputed;
    const shown = {
      factKeyFp,
      statement,
      disputed,
      reversal: reversal === null ? null : fingerprint(ctx.keys, "claim", reversal),
    };
    if (ids.length === 0) {
      // A goal stated in a source that the owner removed.
      if (hidden.has(factKeyFp)) continue;
      goals.push({
        ...shown,
        id: factKeyFp,
        goal: null,
        status: "active",
        setAt: new Date(Math.min(now, ...times)).toISOString(),
        stale: isStale(Math.max(0, ...times), now, stated, zone),
      });
      continue;
    }
    // Each goal id on the key, with its own ruling. A goal the token's goal_state policy does
    // not return is not shown (fails closed).
    for (const goal of ids) {
      const ruled = rulings.get(goal);
      if (ruled === undefined) continue;
      const work = support.get(goal);
      const last = Math.max(0, ...times, ruled.updated_at.getTime(), work?.last?.getTime() ?? 0);
      goals.push({
        ...shown,
        id: goal,
        goal,
        status: ruled.status,
        setAt: stamp(ruled.stated_at),
        stale: isStale(last, now, set, zone),
        ...(work?.advanced == null ? {} : { advancedAt: stamp(work.advanced) }),
      });
    }
  }
  goals.push(...(await unmappedGoals(ctx)));
  return goals.sort((a, b) =>
    a.setAt < b.setAt ? 1 : a.setAt > b.setAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
  );
}

// The owner's goal beliefs as of `read` within the clearance, open or reopened, with what each of
// their claims says, by claim id.
async function ownerGoalBeliefs(
  ctx: Pick<Ctx, "run" | "keys">,
  clearance: readonly string[],
  read: string,
  setOnly: boolean,
) {
  const query: Query = (text, values = []) => ctx.run(text, values);
  const allKeys = (await ctx.run<{ fact_key_fp: string }>(GOAL_KEYS, [read])).map((row) => row.fact_key_fp);
  const keys =
    setOnly && allKeys.length > 0
      ? (await ctx.run<{ fact_key_fp: string }>(GOAL_NAMED_KEYS, [allKeys])).map((row) => row.fact_key_fp)
      : allKeys;
  const claims = new Map<string, { origin: string; owner: boolean; at: number; objective: unknown; what: unknown }>();
  const beliefs: { record: BeliefRecord; reversal: string | null }[] = [];
  for (let start = 0; start < keys.length; start += INPUTS_MAX) {
    const some = keys.slice(start, start + INPUTS_MAX);
    const inputs = await readBeliefInputs(query, ctx.keys, some, read);
    for (const group of inputs.groups)
      for (const one of group.claims)
        claims.set(one.claim.id, {
          origin: one.origin,
          owner: one.subjectKind === "owner",
          at: Date.parse(one.claim.validFrom),
          objective: one.claim.content.fields.objective,
          what: one.claim.content.fields.what,
        });
    for (const record of beliefAt(inputs, clearance, some, read)) {
      // The owner's goals: a belief whose claims are about the owner, by the subject kind the store
      // gave them. Not by the owner's entity's id: the reader's policy on knowledge.entities shows an
      // entity only through an account within the clearance, and a box may hold none of the owner's yet.
      if (record.belief.kind !== "goal" || !record.belief.support.some((id) => claims.get(id)?.owner === true))
        continue;
      if (record.belief.status !== "closed") beliefs.push({ record, reversal: null });
      else {
        const open = reopened(inputs, clearance, record, read);
        if (open !== undefined) beliefs.push(open);
      }
    }
  }
  return { claims, beliefs };
}

// What the goal rows say of those beliefs' keys: the goal ids mapped to each, the keys a goal id
// names, the keys the owner hid, each goal's ruling and its work's support.
async function goalRowsOf(ctx: Pick<Ctx, "run">, beliefs: readonly { record: BeliefRecord }[], read: string) {
  const factKeys = beliefs.map((one) => one.record.factKeyFp);
  const mapped =
    factKeys.length === 0
      ? []
      : await ctx.run<{ goal_id: GoalId; fact_key_fp: string }>(GOAL_MAPPINGS, [factKeys, read]);
  const goalsOf = new Map<string, GoalId[]>();
  for (const row of mapped) goalsOf.set(row.fact_key_fp, [...(goalsOf.get(row.fact_key_fp) ?? []), row.goal_id]);
  const named = new Set(
    factKeys.length === 0
      ? []
      : (await ctx.run<{ fact_key_fp: string }>(GOAL_NAMED_KEYS, [factKeys])).map((row) => row.fact_key_fp),
  );
  const hidden = new Set(
    factKeys.length === 0
      ? []
      : (await ctx.run<{ fact_key_fp: string }>(GOAL_HIDDEN, [factKeys, read])).map((row) => row.fact_key_fp),
  );
  const rulings = new Map(
    mapped.length === 0
      ? []
      : (
          await ctx.run<{ goal_id: GoalId; status: GoalState; stated_at: Date; updated_at: Date }>(GOAL_RULINGS, [
            mapped.map((row) => row.goal_id),
          ])
        ).map((row) => [row.goal_id, row]),
  );
  const goalIds = mapped.map((row) => row.goal_id);
  const support = new Map(
    goalIds.length === 0
      ? []
      : (
          await ctx.run<{ goal_id: GoalId; last: Date | null; advanced: Date | null }>(GOAL_WORK_SUPPORT, [
            goalIds,
            read,
          ])
        ).map((row) => [row.goal_id, row]),
  );
  return { goalsOf, named, hidden, rulings, support };
}

// A goal with no mapping row yet: the owner's words from goal_state, never stale.
async function unmappedGoals(ctx: Pick<Ctx, "run" | "keys">): Promise<ComputedGoal[]> {
  const goals: ComputedGoal[] = [];
  for (const row of await ctx.run<{
    goal_id: GoalId;
    status: GoalState;
    stated_at: Date;
    compartments: string[];
    statement_enc: unknown;
  }>(GOAL_UNMAPPED, [])) {
    const statement = servedOrNull(
      ctx.keys,
      row.compartments,
      { table: "projections.goal_state", id: row.goal_id, column: "statement_enc" },
      row.statement_enc,
    )?.untrusted;
    if (statement === undefined) continue;
    goals.push({
      id: row.goal_id,
      goal: row.goal_id,
      factKeyFp: "",
      statement,
      status: row.status,
      setAt: stamp(row.stated_at),
      stale: false,
      disputed: false,
      reversal: null,
      unmapped: true,
    });
  }
  return goals;
}
