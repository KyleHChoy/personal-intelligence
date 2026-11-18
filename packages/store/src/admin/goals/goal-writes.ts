import {
  ClaimRecord,
  type EntityId,
  GOAL_RANK_MOST,
  type GoalId,
  type GoalKey,
  LifeDomain,
  type PersonalCompartment,
  type RulingId,
} from "@intelligence/contracts/personal";
import { codePoints } from "@intelligence/personal-core";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { newId, requestIdOf } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { openUnder, type Sealed, sealUnder } from "../../core/seal.ts";
import { goalsOf } from "../work/admin-owner-goals.ts";
import { goalKeyOf, writeGoalClaim } from "./goal-claims.ts";

// The owner's goal writes, each in the caller's transaction: `pi goal add`, `pi goal set --status` and
// the owner's accept of an agent's goal proposal run the same code, so an accepted proposal is their goal
// exactly as a command's is. A goal's statement is sealed under its compartment, bound to the row
// it sits in.

export const goalAt = (id: string) => ({ table: "projections.goal_state", id, column: "statement_enc" });
export const decisionAt = (id: string) => ({ table: "knowledge.owner_decisions", id, column: "body_enc" });
const STATEMENT_MOST = 1000;

// A request id of its own for each write a card's answer makes, from the answer's ruling.
export const derivedRequest = (ruling: RulingId, what: string): string => requestIdOf(`${ruling}:${what}`);

// A goal_set decision with the statement sealed, and the goal's state row. A repeated request id
// returns the first goal and adds none.
// With it, its owner_command item, goal claim and mapping row, keyed by content under the
// compartment the owner named (goal-claims.ts), with the life domain they gave. `label`: a goal made the owner's
// from a goal stated in a source, under the whole label its words were read under, in place of the
// one compartment.
export async function writeGoal(
  query: Query,
  keys: Keys,
  goal: {
    statement: string;
    compartment: string;
    label?: readonly string[];
    domain?: LifeDomain;
    requestId: string;
    now: Date;
  },
): Promise<GoalId> {
  if (codePoints(goal.statement.trim()) === 0 || codePoints(goal.statement) > STATEMENT_MOST)
    throw new AdminError("invalid_argument");
  const label = [...new Set(goal.label ?? [goal.compartment])].sort();
  if (label.length === 0 || !label.every((one) => keys.compartments.has(one)))
    throw new AdminError("unknown_compartment");
  const id = newId("gol") as GoalId;
  const decision = newId("rul") as RulingId;
  const ruling = await ownerDecision(
    query,
    {
      id: decision,
      requestId: goal.requestId,
      kind: "goal_set",
      target: { kind: "goal", id },
      compartments: label,
      body: { text: goal.statement, keys },
    },
    goal.now,
  );
  if (ruling !== decision) {
    const [first] = await query<{ kind: string; target_id: GoalId }>(
      "select kind, target_id from knowledge.owner_decisions where id = $1",
      [ruling],
    );
    if (first?.kind !== "goal_set") throw new AdminError("invalid_argument");
    return first.target_id;
  }
  await query(
    `insert into projections.goal_state (goal_id, status, ruling_id, stated_at, updated_at, statement_enc, compartments)
     values ($1, 'active', $2, $3, $3, $4, ledger.label($5))`,
    [id, ruling, stamp(goal.now), sealUnder(keys, label, goalAt(id), goal.statement), label],
  );
  await writeGoalClaim(query, keys, {
    goal: id,
    ruling,
    statement: goal.statement,
    compartments: label,
    ...(goal.domain === undefined ? {} : { domain: goal.domain }),
    at: goal.now,
  });
  return id;
}

// The goal's last goal decision, which a change supersedes; undefined for a goal that does not exist.
const lastOf = async (
  query: Query,
  goal: GoalId,
): Promise<{ id: RulingId; compartments: PersonalCompartment[] } | undefined> =>
  (
    await query<{ id: RulingId; compartments: PersonalCompartment[] }>(
      `select id, compartments from knowledge.owner_decisions where kind in ('goal_set', 'goal_status', 'goal_reword') and target_kind = 'goal' and target_id = $1
       order by decided_at desc, id collate "C" desc limit 1`,
      [goal],
    )
  )[0];

// A goal_status decision that supersedes the goal's last, and the state row. False for a goal that
// does not exist. A repeated request id writes nothing.
export async function writeGoalStatus(
  query: Query,
  change: { goal: GoalId; status: string; requestId: string; now: Date },
): Promise<boolean> {
  const last = await lastOf(query, change.goal);
  if (last === undefined) return false;
  const id = newId("rul") as RulingId;
  const ruling = await ownerDecision(
    query,
    {
      id,
      requestId: change.requestId,
      kind: "goal_status",
      target: { kind: "goal", id: change.goal },
      answer: change.status,
      supersedes: last.id,
      compartments: last.compartments,
    },
    change.now,
  );
  if (ruling === id)
    await query("update projections.goal_state set status = $2, ruling_id = $3, updated_at = $4 where goal_id = $1", [
      change.goal,
      change.status,
      ruling,
      stamp(change.now),
    ]);
  return true;
}

// The person or organization a goal is after, or none, as a goal_target decision and the state
// row. False for a goal that does not exist, or an entity that is neither a person
// nor an organization. A repeated request id writes nothing.
export async function writeGoalTarget(
  query: Query,
  change: { goal: GoalId; entity: EntityId | null; requestId: string; now: Date },
): Promise<boolean> {
  const [state] = await query<{ compartments: PersonalCompartment[] }>(
    "select compartments from projections.goal_state where goal_id = $1",
    [change.goal],
  );
  if (state === undefined) return false;
  // The entity's key locked until commit, so an erasure that deletes it
  // waits for this target, whose goal_targets hook then reaches it, or this finds it gone.
  if (
    change.entity !== null &&
    (
      await query(
        "select 1 from knowledge.entities where id = $1 and kind in ('person', 'organization') for key share",
        [change.entity],
      )
    ).length === 0
  )
    return false;
  const fact = await goalKeyOf(query, change.goal);
  const id = newId("rul") as RulingId;
  const ruling = await ownerDecision(
    query,
    {
      id,
      requestId: change.requestId,
      kind: "goal_target",
      target: { kind: "goal", id: change.goal }, // A ruling on the goal's fact key, which it names.
      details: { entity: change.entity, ...(fact === undefined ? {} : { fact }) },
      compartments: state.compartments,
    },
    change.now,
  );
  if (ruling === id)
    await query("update projections.goal_state set target_entity_id = $2 where goal_id = $1", [
      change.goal,
      change.entity,
    ]);
  return true;
}

// A goal_reword decision, the new words sealed under the goal's own compartments,
// and the state row's statement. False for a goal that does not exist.
export async function writeGoalReword(
  query: Query,
  keys: Keys,
  change: { goal: GoalId; statement: string; requestId: string; now: Date },
): Promise<boolean> {
  if (codePoints(change.statement.trim()) === 0 || codePoints(change.statement) > STATEMENT_MOST)
    throw new AdminError("invalid_argument");
  const last = await lastOf(query, change.goal);
  if (last === undefined) return false;
  const [state] = await query<{ compartments: PersonalCompartment[] }>(
    "select compartments from projections.goal_state where goal_id = $1",
    [change.goal],
  );
  if (state === undefined) return false;
  const id = newId("rul") as RulingId;
  const ruling = await ownerDecision(
    query,
    {
      id,
      requestId: change.requestId,
      kind: "goal_reword",
      target: { kind: "goal", id: change.goal },
      supersedes: last.id,
      compartments: state.compartments,
      body: { text: change.statement, keys },
    },
    change.now,
  );
  if (ruling === id) {
    // The new words are a claim of their own, on their own key, which the goal's latest mapping
    // row now names; the domain stays the goal's. Under the goal's whole label, never a narrower
    // one.
    if (state.compartments.length > 0) {
      const domain = await goalDomainOf(query, keys, change.goal);
      await writeGoalClaim(query, keys, {
        goal: change.goal,
        ruling,
        statement: change.statement,
        compartments: state.compartments,
        ...(domain === undefined ? {} : { domain }),
        at: change.now,
      });
    }
    await query(
      "update projections.goal_state set statement_enc = $2, ruling_id = $3, updated_at = $4 where goal_id = $1",
      [
        change.goal,
        sealUnder(keys, state.compartments, goalAt(change.goal), change.statement),
        ruling,
        stamp(change.now),
      ],
    );
  }
  return true;
}

// `pi goal rank`: the goal placed right after `after` (first when null) among the goals of its
// life domain, as the goals read orders them (ranked first, by rank, then the rest newest first),
// and every one of them given its place from 1, in one goal_rank decision whose details hold the
// whole new order, so rebuildGoalState writes it again. Every goal of the domain by its key, the
// owner's by its id and one stated in a source by its fact key, so a goal from a source keeps its
// place among the owner's without being made theirs; `pi goal rank` places a goal of the owner's,
// and the undo of an adoption places the source goal back. False for a goal not shown the owner;
// `invalid_argument` for an `after`
// that is not shown in the same domain. A repeated request id writes nothing.
export async function writeGoalRank(
  query: Query,
  keys: Keys,
  change: { goal: GoalKey; after: GoalKey | null; requestId: string; now: Date },
): Promise<boolean> {
  if (change.after === change.goal) throw new AdminError("invalid_argument");
  // One rank at a time, so each reads the order the last one wrote, and a replay in decision order
  // writes what the owner saw.
  await lockRows(query, [RANK_LOCK]);
  const { goals } = await goalsOf({ query, keys }, { stale: true }, change.now, Number.POSITIVE_INFINITY);
  const placed = goals.find((one) => one.goal.id === change.goal);
  if (placed === undefined) return false;
  const others = goals
    .filter((one) => one.domain === placed.domain && one.goal.id !== change.goal)
    .map((one) => one.goal.id as GoalKey);
  const at = change.after === null ? 0 : others.indexOf(change.after) + 1;
  if (at === 0 && change.after !== null) throw new AdminError("invalid_argument");
  return writeRankOrder(query, { ...change, order: [...others.slice(0, at), change.goal, ...others.slice(at)] });
}

// One goal_rank decision with the domain's whole new order, and each goal given its place: the
// tail of `writeGoalRank`, and an adoption's, which places a goal the read does not show yet (one
// in the owner's new words, whose belief the next rebuild makes) where the source goal sat. The caller
// holds RANK_LOCK.
export async function writeRankOrder(
  query: Query,
  change: { goal: GoalKey; after: GoalKey | null; order: readonly GoalKey[]; requestId: string; now: Date },
): Promise<boolean> {
  const { order } = change;
  if (order.length > GOAL_RANK_MOST || new Set(order).size !== order.length) throw new AdminError("invalid_argument");
  // The decision names every goal of the order: its label is the union of theirs (invariant 4), a
  // source goal's the label of its key's claims.
  const compartments = [...new Set((await labelsOf(query, order)).flat())].sort();
  const id = newId("rul") as RulingId;
  const ruling = await ownerDecision(
    query,
    {
      id,
      requestId: change.requestId,
      kind: "goal_rank",
      target: { kind: "goal", id: change.goal },
      details: { after: change.after, order: [...order] },
      compartments,
    },
    change.now,
  );
  if (ruling === id) await rankAll(query, order);
  return true;
}

export const RANK_LOCK = "goal_rank";

const isFactKey = (key: string): boolean => /^[0-9a-f]{64}$/.test(key);

// Each goal's label, by its key: the owner's goal's state row's; a source goal's, the union of its key's
// claims' labels, the labels its words were read under.
async function labelsOf(query: Query, order: readonly string[]): Promise<string[][]> {
  const own = await query<{ compartments: string[] }>(
    "select compartments from projections.goal_state where goal_id = any ($1::text[]) order by goal_id",
    [order],
  );
  const facts = order.filter(isFactKey);
  const stated =
    facts.length === 0
      ? []
      : await query<{ compartments: string[] }>(
          "select distinct compartments from knowledge.claims where fact_key_fp = any ($1::text[]) and type = 'goal'",
          [facts],
        );
  return [...own, ...stated].map((one) => one.compartments);
}

// The label of one source goal's key: the union of its claims' labels within `audience`.
export async function keyLabelOf(query: Query, fact: string, audience: readonly string[]): Promise<string[]> {
  const rows = await query<{ compartments: string[] }>(
    "select distinct compartments from knowledge.claims where fact_key_fp = $1 and compartments <@ $2::text[]",
    [fact, audience],
  );
  return [...new Set(rows.flatMap((one) => one.compartments))].sort();
}

// Each goal of the order given its place from 1: the owner's goal's on its state row, a source goal's
// on its key's rank row. A goal whose domain the owner changes later keeps its place until they rank its new
// domain: the read refills that domain's places by it meanwhile.
export async function rankAll(query: Query, order: readonly string[]): Promise<void> {
  await query(
    "update projections.goal_state g set rank = o.place from unnest($1::text[]) with ordinality as o (goal_id, place) where g.goal_id = o.goal_id",
    [order],
  );
  const facts = order.flatMap((key, at) => (isFactKey(key) ? [{ key, place: at + 1 }] : []));
  if (facts.length === 0) return;
  // Each key's row is replaced, so its label is read from its goal claims as they stand: no runtime
  // role updates a label. A key with no goal claim left (an erased source) takes no row.
  const keys = facts.map((one) => one.key);
  await query("delete from projections.goal_key_ranks where fact_key_fp = any ($1::text[])", [keys]);
  await query(
    `insert into projections.goal_key_ranks (fact_key_fp, rank, compartments)
     select o.key, o.place, array(select distinct x from knowledge.claims c cross join unnest(c.compartments) as x where c.fact_key_fp = o.key and c.type = 'goal' order by 1)
     from unnest($1::text[], $2::int[]) as o (key, place)
     where exists (select 1 from knowledge.claims c where c.fact_key_fp = o.key and c.type = 'goal')
     on conflict (fact_key_fp) do update set rank = excluded.rank`,
    [keys, facts.map((one) => one.place)],
  );
}

// The life domain of a goal's latest claim, opened under the admin's keys; none for a goal with no
// claim or none given.
export async function goalDomainOf(query: Query, keys: Keys, goal: GoalId): Promise<LifeDomain | undefined> {
  const [row] = await query<{ id: string; compartments: string[]; content_enc: Sealed }>(
    `select c.id, c.compartments, c.content_enc from knowledge.goal_ids m join knowledge.claims c on c.id = m.claim_id
     where m.goal_id = $1 order by m.created_at desc, m.claim_id collate "C" desc limit 1`,
    [goal],
  );
  if (row === undefined) return undefined;
  const record = ClaimRecord.parse(
    JSON.parse(
      openUnder(
        keys,
        row.compartments,
        { table: "knowledge.claims", id: row.id, column: "content_enc" },
        row.content_enc,
      ),
    ),
  );
  const parsed = LifeDomain.safeParse(record.claim.content.fields.domain);
  return parsed.success ? parsed.data : undefined;
}
