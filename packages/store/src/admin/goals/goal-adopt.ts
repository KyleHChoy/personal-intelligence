import {
  type AdoptChange,
  ClaimRecord,
  type GoalId,
  type GoalKey,
  LifeDomain,
  type OwnerGoal,
  type PersonalCompartment,
  type PersonalLabel,
  type RulingId,
} from "@intelligence/contracts/personal";
import { AdminError } from "../../core/admin-error.ts";
import { ownerAudience } from "../../core/audience.ts";
import { type Query, stamp } from "../../core/db.ts";
import { newId, requestIdOf } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { ownerBeliefs } from "../admin-owner.ts";
import { goalsOf } from "../work/admin-owner-goals.ts";
import { goalKeyOf } from "./goal-claims.ts";
import {
  keyLabelOf,
  RANK_LOCK,
  writeGoal,
  writeGoalRank,
  writeGoalStatus,
  writeGoalTarget,
  writeRankOrder,
} from "./goal-writes.ts";

// Each write runs as pi_admin in the caller's transaction.
//
// `adoptGoal`: the owner's first edit, drag or retarget of a goal stated in a source makes it their
// own goal, in one transaction: a goal of the owner's with the source goal's words (or their new
// ones), life domain and label (the union of its key's claims' labels within the owner's audience);
// placed where the source goal sat in its domain, or where the owner dragged it; with their status or
// target applied by the write that makes it for a goal of the owner's. In the source goal's words the
// owner's goal's claim takes the source goal's
// own fact key and the two are one belief (goal-claims.ts), and a goal mapped to a key is what the
// goals reads show for it, so nothing is retired: no belief ruling is written (a `retire` would end
// the release of every fact of a released record). In the owner's new words it takes a key of its
// own, and the source goal is hidden by a `hide`, read by the goals reads alone; the owner's goal is
// served from its own row until the next rebuild makes its belief (admin-owner-goals.ts). Its `adopt`
// row is the lineage from the source key to the owner's goal, which erasing the source follows
// (admin-erase-targets.ts).
// `unadoptGoal`, the owner's Undo: the `adopt` row lifted, the owner's goal dropped, and the source
// goal shown again where it was. Nothing is deleted.
// `hideGoal`, the owner's Remove of a goal stated in a source: a `hide` row on its key, which only
// the goals reads read; `unhideGoal`, its Undo, lifts it.

// A request id of its own for each write one request makes, from the request's.
const derived = (requestId: string, what: string): string => requestIdOf(`${requestId}:${what}`);

type Tx = { query: Query; keys: Keys; now: Date };

// The goal stated in a source by its key, as the goals read shows the owner, the goals of its life
// domain in their order, and the goal before it (null when it is first). Undefined for a key that is
// no such goal.
async function shownSource(
  tx: Tx,
  fact: string,
): Promise<{ goal: OwnerGoal; domain: GoalKey[]; was: GoalKey | null } | undefined> {
  const { goals } = await goalsOf(
    { query: tx.query, keys: tx.keys },
    { stale: true },
    tx.now,
    Number.POSITIVE_INFINITY,
  );
  const goal = goals.find((one) => one.setBy === "stated" && one.goal.id === fact);
  if (goal === undefined) return undefined;
  const domain = goals.filter((one) => one.domain === goal.domain).map((one) => one.goal.id as GoalKey);
  const at = domain.indexOf(fact as GoalKey);
  return { goal, domain, was: at <= 0 ? null : (domain[at - 1] as GoalKey) };
}

// The source goal's words and life domain, as its claim states them (not a domain ruling of the
// owner's, which keeps holding on the key), so the owner's goal's claim takes the same key.
async function sourceWords(
  tx: Tx,
  fact: string,
): Promise<{ statement: string; domain: LifeDomain | undefined } | undefined> {
  const [belief] = await ownerBeliefs({ query: tx.query, keys: tx.keys }, [fact]);
  const claim = belief?.phraseClaim ?? belief?.support[0];
  if (claim === undefined) return undefined;
  const [row] = await tx.query<{ id: string; compartments: string[]; content_enc: Sealed }>(
    "select id, compartments, content_enc from knowledge.claims where id = $1",
    [claim],
  );
  if (row === undefined) return undefined;
  const fields = ClaimRecord.parse(JSON.parse(open(tx.keys, row, "knowledge.claims.content_enc", "throw"))).claim
    .content.fields;
  const statement =
    typeof fields.objective === "string" ? fields.objective : typeof fields.what === "string" ? fields.what : null;
  if (statement === null) return undefined;
  const domain = LifeDomain.safeParse(fields.domain);
  return { statement, domain: domain.success ? domain.data : undefined };
}

const changeOf = (change: AdoptChange): "words" | "status" | "target" | "rank" =>
  "statement" in change ? "words" : "status" in change ? "status" : "entity" in change ? "target" : "rank";

// The owner's goal made from the source goal `fact`, with `change`; null for a key that is no goal
// stated in a source shown the owner. A repeated request id returns the first goal and writes nothing.
export async function adoptGoal(
  tx: Tx,
  fact: string,
  change: AdoptChange,
  { requestId }: { requestId: string },
): Promise<GoalId | null> {
  const { query, keys, now } = tx;
  // One adoption of a key at a time, and one rank at a time (writeGoalRank's lock).
  await lockRows(query, [`goal_adopt:${fact}`, RANK_LOCK]);
  const [repeat] = await query<{ kind: string; target_id: GoalId }>(
    "select kind, target_id from knowledge.owner_decisions where request_id = $1",
    [requestId],
  );
  if (repeat !== undefined) {
    if (repeat.kind !== "goal_adopt") throw new AdminError("invalid_argument");
    return repeat.target_id;
  }
  const source = await shownSource(tx, fact);
  if (source === undefined) return null;
  if ("after" in change && change.after === fact) throw new AdminError("invalid_argument");
  const words = await sourceWords(tx, fact);
  const label = await keyLabelOf(query, fact, await ownerAudience(query));
  if (words === undefined || label.length === 0) return null;

  // The owner's new words are their goal's first, in the life domain they saw it in (a domain ruling
  // of the owner's on the source key holds on that key alone); else the source goal's words and its
  // claim's domain, so the owner's goal's claim takes the source goal's key, where their ruling holds too.
  const reworded = "statement" in change;
  const statement = reworded ? change.statement : words.statement;
  const domain = reworded ? (source.goal.domain ?? undefined) : (words.domain ?? source.goal.domain ?? undefined);
  const goal = await writeGoal(query, keys, {
    statement,
    compartment: label[0] as string,
    label,
    ...(domain === undefined ? {} : { domain }),
    requestId: derived(requestId, "set"),
    now,
  });
  const ruling = newId("rul") as RulingId;
  await ownerDecision(
    query,
    {
      id: ruling,
      requestId,
      kind: "goal_adopt",
      target: { kind: "goal", id: goal },
      details: { fact, change: changeOf(change), was: source.was },
      compartments: label,
    },
    now,
  );
  await query(
    "insert into knowledge.goal_key_rulings (ruling_id, verdict, fact_key_fp, goal_id, compartments, created_at) values ($1, 'adopt', $2, $3, ledger.label($4), $5)",
    [ruling, fact, goal, label, stamp(now)],
  );
  // With the source goal's words the owner's goal's claim takes the source goal's key, and the source
  // goal is shown as the owner's. In their new words it takes a key of its own, as does a source goal
  // keyed before goals carried their domain: the source goal is then hidden, as the owner's Remove hides it.
  if ((await goalKeyOf(query, goal)) !== fact) await hide(tx, fact, label, derived(requestId, "hide"));
  // Where the source goal sat, or where the owner dragged it, among the goals of its domain as they saw them.
  let order: GoalKey[];
  if ("after" in change) {
    const others = source.domain.filter((id) => id !== fact);
    const at = change.after === null ? 0 : others.indexOf(change.after) + 1;
    if (at === 0 && change.after !== null) throw new AdminError("invalid_argument");
    order = [...others.slice(0, at), goal, ...others.slice(at)];
  } else order = source.domain.map((id) => (id === fact ? goal : id));
  await writeRankOrder(query, {
    goal,
    after: order[order.indexOf(goal) - 1] ?? null,
    order,
    requestId: derived(requestId, "rank"),
    now,
  });
  if ("status" in change)
    await writeGoalStatus(query, { goal, status: change.status, requestId: derived(requestId, "status"), now });
  if (
    "entity" in change &&
    change.entity !== null &&
    !(await writeGoalTarget(query, { goal, entity: change.entity, requestId: derived(requestId, "target"), now }))
  )
    throw new AdminError("not_found");
  return goal;
}

// The owner's Undo of an adoption: its `adopt` row lifted by a goal_adopt_undo decision, their goal dropped,
// and the source goal placed back where it was. False for a goal no adoption in force made. A
// repeated request id writes nothing.
export async function unadoptGoal(tx: Tx, goal: GoalId, { requestId }: { requestId: string }): Promise<boolean> {
  const { query, keys, now } = tx;
  const [repeat] = await query<{ kind: string; target_id: string }>(
    "select kind, target_id from knowledge.owner_decisions where request_id = $1",
    [requestId],
  );
  if (repeat !== undefined) {
    if (repeat.kind !== "goal_adopt_undo" || repeat.target_id !== goal) throw new AdminError("invalid_argument");
    return true;
  }
  const [adopted] = await query<{
    ruling_id: RulingId;
    fact_key_fp: string;
    compartments: PersonalCompartment[];
    was: GoalKey | null;
  }>(
    `select r.ruling_id, r.fact_key_fp, r.compartments, d.details ->> 'was' as was from knowledge.goal_key_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id
     where r.verdict = 'adopt' and r.goal_id = $1 and r.lifted_at is null for update of r`,
    [goal],
  );
  if (adopted === undefined) return false;
  // As an adoption: one change to the key and one rank at a time.
  await lockRows(query, [`goal_adopt:${adopted.fact_key_fp}`, RANK_LOCK]);
  const lift = await ownerDecision(
    query,
    {
      requestId,
      kind: "goal_adopt_undo",
      target: { kind: "goal", id: goal },
      supersedes: adopted.ruling_id,
      compartments: adopted.compartments,
    },
    now,
  );
  await query("update knowledge.goal_key_rulings set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1", [
    adopted.ruling_id,
    stamp(now),
    lift,
  ]);
  // Every other reader of goal_state sees it ended.
  await writeGoalStatus(query, { goal, status: "dropped", requestId: derived(requestId, "status"), now });
  // A hide the adoption wrote goes with it.
  const [hidden] = await query<{ ruling_id: RulingId }>(
    "select r.ruling_id from knowledge.goal_key_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id where r.verdict = 'hide' and r.lifted_at is null and r.fact_key_fp = $1 and d.request_id = $2",
    [adopted.fact_key_fp, derived((await requestOf(query, adopted.ruling_id)) ?? "", "hide")],
  );
  if (hidden !== undefined) await lifted(tx, hidden.ruling_id, adopted.compartments, derived(requestId, "unhide"));
  // The source goal back where it was, when that goal is still there; else first.
  const { goals } = await goalsOf({ query, keys }, { stale: true }, now, Number.POSITIVE_INFINITY);
  const domain = goals.find((one) => one.goal.id === adopted.fact_key_fp)?.domain;
  const was =
    adopted.was !== null && goals.some((one) => one.goal.id === adopted.was && one.domain === domain)
      ? adopted.was
      : null;
  await writeGoalRank(query, keys, {
    goal: adopted.fact_key_fp as GoalKey,
    after: was,
    requestId: derived(requestId, "rank"),
    now,
  });
  return true;
}

const requestOf = async (query: Query, ruling: RulingId): Promise<string | undefined> =>
  (await query<{ request_id: string }>("select request_id from knowledge.owner_decisions where id = $1", [ruling]))[0]
    ?.request_id;

// A goal_hide decision and its `hide` row, unless one is in force on the key.
async function hide(tx: Tx, fact: string, label: PersonalLabel, requestId: string): Promise<void> {
  if (
    (
      await tx.query(
        "select 1 from knowledge.goal_key_rulings where verdict = 'hide' and fact_key_fp = $1 and lifted_at is null",
        [fact],
      )
    ).length > 0
  )
    return;
  const ruling = newId("rul") as RulingId;
  const written = await ownerDecision(
    tx.query,
    { id: ruling, requestId, kind: "goal_hide", compartments: [...label], subjectFps: [fact] },
    tx.now,
  );
  if (written !== ruling) return;
  await tx.query(
    "insert into knowledge.goal_key_rulings (ruling_id, verdict, fact_key_fp, compartments, created_at) values ($1, 'hide', $2, ledger.label($3), $4)",
    [ruling, fact, label, stamp(tx.now)],
  );
}

// A hide lifted by a goal_hide_lift decision that supersedes it.
async function lifted(tx: Tx, ruling: RulingId, label: readonly string[], requestId: string): Promise<void> {
  const lift = await ownerDecision(
    tx.query,
    { requestId, kind: "goal_hide_lift", supersedes: ruling, compartments: [...label] },
    tx.now,
  );
  await tx.query(
    "update knowledge.goal_key_rulings set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1 and lifted_at is null",
    [ruling, stamp(tx.now), lift],
  );
}

// Whether the request id already wrote a decision: true for one of this kind, an invalid
// argument for one of another.
async function repeated(tx: Tx, requestId: string, kind: string): Promise<boolean> {
  const [repeat] = await tx.query<{ kind: string }>(
    "select kind from knowledge.owner_decisions where request_id = $1",
    [requestId],
  );
  if (repeat === undefined) return false;
  if (repeat.kind !== kind) throw new AdminError("invalid_argument");
  return true;
}

// The owner's Remove of a goal stated in a source. False for a key that is no such goal shown them. A
// repeated request id writes nothing.
export async function hideGoal(tx: Tx, fact: string, { requestId }: { requestId: string }): Promise<boolean> {
  if (await repeated(tx, requestId, "goal_hide")) return true;
  await lockRows(tx.query, [`goal_adopt:${fact}`]);
  if ((await shownSource(tx, fact)) === undefined) return false;
  const label = await keyLabelOf(tx.query, fact, await ownerAudience(tx.query));
  if (label.length === 0) return false;
  await hide(tx, fact, label, requestId);
  return true;
}

// The owner's Undo of a Remove: the hide in force on the key lifted. False when none is in force. A repeated
// request id writes nothing.
export async function unhideGoal(tx: Tx, fact: string, { requestId }: { requestId: string }): Promise<boolean> {
  if (await repeated(tx, requestId, "goal_hide_lift")) return true;
  await lockRows(tx.query, [`goal_adopt:${fact}`]);
  // A key an adoption in force hid is shown again only by that adoption's undo.
  if (
    (
      await tx.query(
        "select 1 from knowledge.goal_key_rulings where verdict = 'adopt' and fact_key_fp = $1 and lifted_at is null",
        [fact],
      )
    ).length > 0
  )
    return false;
  const [hidden] = await tx.query<{ ruling_id: RulingId; compartments: string[] }>(
    "select ruling_id, compartments from knowledge.goal_key_rulings where verdict = 'hide' and fact_key_fp = $1 and lifted_at is null for update",
    [fact],
  );
  if (hidden === undefined) return false;
  await lifted(tx, hidden.ruling_id, hidden.compartments, requestId);
  return true;
}
