// The tick's wake table: which wakes are due and what each run carries, the daily sweep, calendar
// and goal wakes, the state wakes' fold, and the lessons runs with the owner actions they are shown.
// Ids, kinds, times and labels only.
import {
  type AutonomyRules,
  dayIn,
  hourIn,
  OWNER_ACTION_LEARNING,
  OWNER_ACTIONS_MOST,
  type OwnerActionTeaching,
  type PersonalWakeSource,
  type WorkRef,
} from "@intelligence/contracts/personal";
import { autonomyRules } from "@intelligence/personal-core/planner";
import type { Query } from "../core/db.ts";
import { byText } from "../core/db.ts";
import { within } from "../core/labels.ts";
import { type Planner, plannerOf, runPlanOf, stageRuns } from "../core/run-plan.ts";
import { LEDGER_TARGET_TABLES, LESSON_IN_FORCE, latestEvent } from "../core/statements.ts";
import { ownerZoneOf } from "../core/zone.ts";
import { MAX_CHANGE_ANCHORS } from "../pipeline/triggers.ts";
import { reasonerOf, settingsOf } from "./dispatch-read.ts";

// A wake the tick may act on: its key, its anchors and their label, and whether a veto covers an
// anchor. `owner_request` is `pi work run`'s, never the tick's. `covers` is a folded wake's other
// keys, which its run uses up with its own.
export type WakeCandidate = {
  source: Exclude<PersonalWakeSource, "owner_request">;
  wakeKey: string;
  anchors: WorkRef[];
  compartments: string[];
  vetoed: boolean;
  covers?: string[];
  // A lessons run's lessons in force, by id: what a lesson it proposes may supersede.
  lessons?: string[];
  // A lessons run's owner actions: the decisions it is shown, by id, and the newest decision shown
  // so far, which the next lessons run starts after.
  decisions?: string[];
  cursor?: string | null;
};

// The least time between two daily sweeps.
const SWEEP_SPACING_MS = 12 * 60 * 60 * 1000;

// The owner's decisions that teach `plan` (OWNER_ACTION_LEARNING), as a `from` clause for the
// clearance `$1`, on knowledge.owner_decisions alone. Its kind lists are written into the SQL from
// the registry, so the statement names its kinds. An answer counts by its card's kind, on an
// untainted card within the clearance, so a `lesson` card's answer, and an identity, about-you or
// same-fact one, do not. A decision counts untainted and within the clearance, and, when its target
// is a row with a label, that row within it too, and untainted where it can be (invariant 6). A
// target with no label of its own (a person's entity, the task intent) leaves the decision's label,
// which code computed from it (invariant 4), to stand; so does an answer's target, whose card's
// label is checked. Any other target kind does not count.
function planKinds(teachings: Readonly<Record<string, OwnerActionTeaching>>): string {
  return Object.keys(teachings)
    .filter((kind) => teachings[kind]?.teaches === "plan")
    .sort()
    .map((kind) => `'${kind}'`)
    .join(", ");
}
const { answer: ANSWER_TEACHINGS, ...DECISION_TEACHINGS } = OWNER_ACTION_LEARNING;
// The rows a decision may target that carry their own label: each kind's table, its key, and whether
// a taint on the row hides the decision. A kind not here has no label of its own.
const DECISION_TARGETS: readonly { kind: string; from: string; key: string; tainted: boolean }[] = [
  { kind: "goal", from: "from projections.goal_state t", key: "goal_id", tainted: false },
  { kind: "claim", from: "from knowledge.claims t", key: "id", tainted: false },
  ...(["opportunity", "hypothesis", "intention", "move", "card", "send"] as const).map((kind) => ({
    kind,
    from: `from ${LEDGER_TARGET_TABLES[kind]} t`,
    key: "id",
    tainted: true,
  })),
];
const targetWhens = (then: (target: (typeof DECISION_TARGETS)[number]) => string): string =>
  DECISION_TARGETS.map((target) => `when '${target.kind}' then ${then(target)}`).join("\n      ");
const PLAN_DECISIONS = `from knowledge.owner_decisions d left join ledger.cards c on d.kind = 'answer' and c.id = d.card_id
  where d.tainted_at is null and d.compartments <@ $1::text[]
    and (d.kind in (${planKinds(DECISION_TEACHINGS)})
      or (d.kind = 'answer' and c.kind in (${planKinds(ANSWER_TEACHINGS)}) and c.tainted_at is null and c.compartments <@ $1::text[]))
    and (d.target_kind is null or case d.target_kind
      ${targetWhens(({ from, key, tainted }) => `exists (select 1 ${from} where t.${key} = d.target_id and t.compartments <@ $1::text[]${tainted ? " and t.tainted_at is null" : ""})`)}
      else d.target_kind in ('entity', 'intent') or d.kind = 'answer' end)`;

// The label of a decision's target row, for the union a lessons run takes, on the decision aliased
// `d`; null for a target with no label of its own, whose decision's label stands (PLAN_DECISIONS).
const TARGET_LABEL = `case d.target_kind
      ${targetWhens(({ from, key }) => `(select t.compartments ${from} where t.${key} = d.target_id)`)} end`;

// The lessons prompt version from which a lessons run is shown the owner's actions. Until
// run_outcome names it, lessons runs are queued with no block and no cursor.
export const OWNER_ACTIONS_FROM = 5;

type ActionsBlock = {
  decisions: string[];
  cursor: string | null;
  compartments: string[];
  more: boolean;
  firstAt: Date | null;
};

// The owner decisions a lessons run is shown, as pi_work or pi_admin: the `plan`-kind decisions
// within the clearance (PLAN_DECISIONS) after the cursor, the oldest first, at most
// OWNER_ACTIONS_MOST, so each is shown to exactly one run and a burst waits for the next (`more`);
// with no cursor (the first run, or a trial), the newest. `cursor`: the newest id shown so far;
// `firstAt`, when the oldest of them was decided. `compartments`: the union of what the run reads,
// each decision's label, its card's and its target's, the labels of the cases within the clearance
// its closed block may show (a run must not lose cases its block happened not to touch), and `own`.
// Ids, labels, kinds and times only.
export async function ownerActionsBlock(
  query: Query,
  clearance: readonly string[],
  after: string | null,
): Promise<ActionsBlock> {
  const cases = await query<{ one: string }>(
    `select distinct unnest(x.compartments) as one from (
       select o.compartments from ledger.opportunities o where o.tainted_at is null and o.compartments <@ $1::text[]
       union select h.compartments from ledger.hypotheses h where h.tainted_at is null and h.kind <> 'lesson' and h.compartments <@ $1::text[]) x`,
    [[...clearance]],
  );
  const rows = await query<{ id: string; labels: string[]; decided_at: Date }>(
    `select d.id, d.decided_at, d.compartments || coalesce(c.compartments, '{}'::text[]) || coalesce(${TARGET_LABEL}, '{}'::text[]) as labels
     ${PLAN_DECISIONS}
       and ($2::text is null or d.id collate "C" > $2::text collate "C")
     order by d.id collate "C" ${after === null ? "desc" : "asc"} limit ${OWNER_ACTIONS_MOST + 1}`,
    [[...clearance], after],
  );
  const kept = rows.slice(0, OWNER_ACTIONS_MOST);
  const decisions = kept.map((row) => row.id).sort(byText);
  const newest = decisions.at(-1);
  return {
    decisions,
    cursor: newest === undefined ? after : after === null || newest > after ? newest : after,
    compartments: [...new Set(["own", ...cases.map((row) => row.one), ...kept.flatMap((row) => row.labels)])].sort(),
    more: after !== null && rows.length > OWNER_ACTIONS_MOST,
    firstAt: kept.length === 0 ? null : new Date(Math.min(...kept.map((row) => row.decided_at.getTime()))),
  };
}

export async function wakeCandidates(
  query: Query,
  now: Date,
  rules: AutonomyRules = autonomyRules(),
): Promise<WakeCandidate[]> {
  const settings = await settingsOf(query);
  const clearance = (await reasonerOf(query))?.compartments ?? ["own"];
  const found: WakeCandidate[] = [
    ...(await sweepCandidates(query, now, settings.sweepHour)),
    ...(await calendarCandidates(query, now, settings.calendarLeadHours)),
    ...(await goalCandidates(query, now)),
    ...(await stateCandidates(query, now, clearance, rules)),
  ];
  const planner = await plannerOf(query);
  found.push(...(await lessonsCandidates(query, clearance, planner)));

  // Under research_only no wake but a lessons one queues a run, and none records a silence; its key
  // stays unused, for the day the owner turns ideas back on.
  const kept = found.filter(
    (candidate) => within(candidate.compartments, clearance) && stageRuns(candidate.source, planner),
  );
  if (kept.length === 0) return [];
  const used = new Set(
    (
      await query<{ key: string }>(
        `select wake_key as key from ledger.runs where wake_key = any($1)
         union select k from ledger.runs r cross join lateral unnest(r.covered_keys) as k where k = any($1)
         union select wake_key from ledger.silences where reason = 'vetoed' and wake_key = any($1)`,
        [kept.map((candidate) => candidate.wakeKey)],
      )
    ).map((row) => row.key),
  );
  return kept.filter((candidate) => !used.has(candidate.wakeKey));
}

// The daily sweep, from its hour of the owner's day, keyed by that day: their zone's once they set
// one, UTC's until then. The day's runs and spend stay UTC days. Not within SWEEP_SPACING_MS of
// the last sweep queued: the day the owner sets their zone, or moves the sweep's hour, the day's
// key moves, and a second sweep the same day waits.
async function sweepCandidates(query: Query, now: Date, sweepHour: number): Promise<WakeCandidate[]> {
  const zone = await ownerZoneOf(query);
  // A run's time is the database's, `now` the tick's: a sweep queued within the spacing of `now`,
  // on either side, counts, so a tick that reads a moment past runs it was given is answered the same.
  const [near] = await query<{ n: number }>(
    "select count(*)::int as n from ledger.runs r where r.wake_source = 'daily_sweep' and r.created_at > $1::timestamptz - make_interval(secs => $2) and r.created_at < $1::timestamptz + make_interval(secs => $2)",
    [now.toISOString(), SWEEP_SPACING_MS / 1000],
  );
  const due = (near?.n ?? 0) === 0 && hourIn(now, zone) >= sweepHour;
  if (!due) return [];
  return [
    { source: "daily_sweep", wakeKey: `sweep:${dayIn(now, zone)}`, anchors: [], compartments: ["own"], vetoed: false },
  ];
}

// The owner-backed events that start within the calendar lead, soonest first.
async function calendarCandidates(query: Query, now: Date, leadHours: number): Promise<WakeCandidate[]> {
  const events = await query<{ id: string; starts_at: Date; compartments: string[]; vetoed: boolean }>(
    `select e.id, d.starts_at, e.compartments, policy.vetoed(array['event'], array[e.id], null) as vetoed
     from knowledge.events e join knowledge.event_details d on d.event_id = e.id
     where d.starts_at >= $1 and d.starts_at < $1 + make_interval(hours => $2) and not d.cancelled and ledger.owner_backed('event', e.id)
     order by d.starts_at, e.id collate "C"`,
    [now, leadHours],
  );
  return events.map(
    (event): WakeCandidate => ({
      source: "calendar",
      wakeKey: `calendar:${event.id}:${event.starts_at.toISOString()}`,
      anchors: [{ kind: "event", id: event.id } as WorkRef],
      compartments: [...event.compartments].sort(),
      vetoed: event.vetoed,
    }),
  );
}

// The owner's rulings of the past seven days on an active goal.
async function goalCandidates(query: Query, now: Date): Promise<WakeCandidate[]> {
  const goals = await query<{ ruling: string; goal: string; compartments: string[] }>(
    `select d.id as ruling, g.goal_id as goal, g.compartments
     from knowledge.owner_decisions d join projections.goal_state g on g.goal_id = d.target_id
     where d.kind in ('goal_set', 'goal_status', 'goal_reword') and d.target_kind = 'goal' and g.status = 'active'
       and d.decided_at > $1::timestamptz - interval '7 days' and d.decided_at <= $1
     order by d.decided_at, d.id collate "C"`,
    [now],
  );
  return goals.map(
    (goal): WakeCandidate => ({
      source: "goal_changed",
      wakeKey: `goal:${goal.ruling}`,
      anchors: [{ kind: "goal", id: goal.goal } as WorkRef],
      compartments: [...goal.compartments].sort(),
      vetoed: false,
    }),
  );
}

// Wakes from state (S5, S6): the pipeline's offers still live, read through a definer
// function; the tick reads no belief, oldest offer first. A commitment has no anchor: a ref to
// a belief waits for the fact ref.
async function stateCandidates(
  query: Query,
  now: Date,
  clearance: readonly string[],
  rules: AutonomyRules,
): Promise<WakeCandidate[]> {
  const found: WakeCandidate[] = [];
  const offers = await query<{
    wake_source: "commitment_due" | "belief_changed";
    wake_key: string;
    compartments: string[];
    vetoed: boolean;
    anchors: string[];
  }>("select wake_source, wake_key, compartments, vetoed, anchors from ledger.state_wakes($1)", [now]);
  // A belief change outside the clearance is dropped before the fold, so it widens no run's label.
  const changes: typeof offers = [];
  for (const offer of offers) {
    const compartments = [...offer.compartments].sort();
    if (offer.wake_source === "belief_changed" && !offer.vetoed) {
      if (within(compartments, clearance)) changes.push(offer);
      continue;
    }
    // A vetoed change is a candidate of its own, so its silence uses its key up (S5).
    found.push({ source: offer.wake_source, wakeKey: offer.wake_key, anchors: [], compartments, vetoed: offer.vetoed });
  }
  // Every live change waiting is one run: its key the oldest offer's, so a wake that waits on the
  // budget keeps one key and writes one silence a day; its anchors the entities of the newest
  // changes first, at most MAX_CHANGE_ANCHORS; its label the union of theirs. With
  // `beliefChangedRunsOn` false (ontology/autonomy.json), no run is queued; the offers stay live,
  // so turning it on again folds them into one run.
  const [oldest] = changes;
  if (oldest !== undefined && rules.beliefChangedRunsOn !== false) {
    const anchors = [...new Set([...changes].reverse().flatMap((offer) => offer.anchors))].slice(0, MAX_CHANGE_ANCHORS);
    found.push({
      source: "belief_changed",
      wakeKey: oldest.wake_key,
      anchors: anchors.map((id) => ({ kind: "entity", id }) as WorkRef),
      compartments: [...new Set(changes.flatMap((offer) => offer.compartments))].sort(),
      vetoed: false,
      covers: changes.slice(1).map((offer) => offer.wake_key),
    });
  }
  return found;
}

// A lessons run after every `lessons_every` of the owner's `plan`-kind decisions within the
// reasoner's clearance (PLAN_DECISIONS), keyed by how many such batches there have been, so each
// batch wakes one run. Under `own`, as the sweep. And the latest lessons run, when it failed, once
// more.
async function lessonsCandidates(query: Query, clearance: string[], planner: Planner): Promise<WakeCandidate[]> {
  const found: WakeCandidate[] = [];
  const [answers] = await query<{ n: number; every: number }>(
    `select (select count(*)::int ${PLAN_DECISIONS}) as n, (select s.lessons_every from policy.work_settings s) as every`,
    [clearance],
  );
  // Lessons are learned under every planner: agents' work briefs read them, and the one-pass
  // planner's personal_run reads them from its prompt version 4.
  const batches = answers === undefined ? 0 : Math.floor(answers.n / answers.every);
  const lessonsDue =
    Number(runPlanOf("lessons_due", planner).promptVersion) >= OWNER_ACTIONS_FROM
      ? await actionsDue(query, clearance, batches)
      : batches >= 1
        ? { key: `lessons:${batches}` }
        : null;
  if (lessonsDue !== null) {
    const lessons = await query<{ id: string; compartments: string[] }>(
      `select h.id, h.compartments from ledger.hypotheses h where ${LESSON_IN_FORCE} and h.compartments <@ $1::text[] order by h.created_at desc, h.id desc limit 50`,
      [clearance],
    );
    const block = "block" in lessonsDue ? lessonsDue.block : null;
    found.push({
      source: "lessons_due",
      wakeKey: lessonsDue.key,
      anchors: [],
      // A run shown the owner's actions takes the union of what it reads (invariant 4), its block
      // and its lessons; one queued without them `own`.
      compartments:
        block === null
          ? ["own"]
          : [...new Set([...block.compartments, ...lessons.flatMap((row) => row.compartments)])].sort(),
      vetoed: false,
      lessons: lessons.map((row) => row.id),
      ...(block === null ? {} : { decisions: block.decisions, cursor: block.cursor }),
    });
  }
  // The latest lessons run, when it failed, is tried once more as it was queued, its lessons,
  // decisions and cursor, under its key and `:retry`; a retry that fails is not tried again. Only
  // while no new lessons run is due: a key already used is none.
  const lessonsFresh =
    lessonsDue !== null &&
    (await query("select 1 from ledger.runs where wake_key = $1 or $1 = any (covered_keys)", [lessonsDue.key]))
      .length === 0;
  if (lessonsFresh) return found;
  const [last] = await query<{
    wake_key: string;
    compartments: string[];
    lessons: string[] | null;
    decisions: string[] | null;
    decisions_cursor: string | null;
    event: string;
  }>(
    `select x.wake_key, x.compartments, x.lessons, x.decisions, x.decisions_cursor, e.event from ledger.runs x
       join lateral (${latestEvent("run", "x.id")}) e on true
       where x.wake_source = 'lessons_due' and x.trial_model is null
       order by x.created_at desc, x.id desc limit 1`,
  );
  if (last !== undefined && last.event === "failed" && !last.wake_key.endsWith(LESSONS_RETRY)) {
    found.push({
      source: "lessons_due",
      wakeKey: `${last.wake_key}${LESSONS_RETRY}`,
      anchors: [],
      compartments: [...last.compartments].sort(),
      vetoed: false,
      ...(last.lessons === null ? {} : { lessons: last.lessons }),
      ...(last.decisions === null ? {} : { decisions: last.decisions, cursor: last.decisions_cursor }),
    });
  }
  return found;
}

// The lessons run due once the owner's actions are shown, and its block. A new batch of
// `lessons_every` decisions wakes one; so does a run that was shown a full block while decisions
// made before it was queued still wait after its cursor, keyed by that cursor, so a burst is shown
// whole, each decision once, and a decision made after a full run waits for its batch. Null when
// neither is due, or a batch's key is already used.
export async function actionsDue(
  query: Query,
  clearance: string[],
  batches: number,
): Promise<{ key: string; block: ActionsBlock } | null> {
  const [last] = await query<{ cursor: string; shown: number; created_at: Date }>(
    `select r.decisions_cursor as cursor, cardinality(r.decisions)::int as shown, r.created_at from ledger.runs r
     where r.decisions_cursor is not null order by r.decisions_cursor collate "C" desc, r.created_at desc limit 1`,
  );
  const batch = `lessons:${batches}`;
  const fresh =
    batches >= 1 &&
    (await query("select 1 from ledger.runs where wake_key = $1 or $1 = any (covered_keys)", [batch])).length === 0;
  const full = last !== undefined && last.shown >= OWNER_ACTIONS_MOST;
  if (!fresh && !full) return null;
  const block = await ownerActionsBlock(query, clearance, last?.cursor ?? null);
  if (!fresh && (block.firstAt === null || last === undefined || block.firstAt.getTime() > last.created_at.getTime()))
    return null;
  return { key: fresh ? batch : `lessons:after:${last?.cursor}`, block };
}

// The suffix of a failed lessons run's one retry.
export const LESSONS_RETRY = ":retry";
