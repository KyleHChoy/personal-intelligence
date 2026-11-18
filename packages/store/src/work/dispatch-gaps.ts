import {
  AGENT_ATTEMPT_HOURS,
  type AutonomyRules,
  CARD_RELAY_HOURS,
  ExploreMissing,
  type GapTrigger,
  isCanaryCompartment,
  OPEN_STATUSES,
  type OpportunityId,
  type OpportunityStatus,
} from "@intelligence/contracts/personal";
import {
  autonomyRules,
  autonomyWindows,
  DEFECT_UNTRIAGED_HOURS,
  type ExploredFlag,
  type FrontierParts,
  type FrontierScore,
  GAP_CAPPED_DATED_TRIGGERS,
  GAP_MEETING_DAYS,
  GAP_QUIET_DAYS,
  GAP_RAISE_WINDOW_DAYS,
  GAP_UNCAPPED_TRIGGERS,
  GAP_VALUE_WINDOW_DAYS,
  GAP_WITHDRAWN_REST_DAYS,
  type GapCandidate,
  type GapHistory,
  type GapStanding,
  type GapSupply,
  gapKey,
  gapQuietKey,
  loopWindows,
  MERGE_AUDIT_DAYS,
  MERGE_AUDIT_SAMPLE,
  type OpenGapFlag,
  storedParts,
} from "@intelligence/personal-core/planner";
import { REMINDER_MAX_MINUTES, secondDegreeRules } from "@intelligence/personal-core/views";
import { attemptsOn } from "../cards/agent-attempts.ts";
import { type Query, stamp, stampOrNull } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import type { Db } from "../core/job-db.ts";
import { GAP_PASS_HOLD } from "../core/locks.ts";
import { gapExpectation } from "../core/outcome-rules.ts";
import { opportunityFacts, type ToDecide } from "./dispatch-read.ts";
import { OWNER_QUEUE_STATE, type OwnerQueueState, ownerQueueGaps } from "./owner-queue.ts";

// Gap flags: the gaps that hold now, the flags open and what earlier ones say, and the two writes.
// The tick reads and writes them as pi_work; the pipeline's pass over the three warmth lanes
// (pipeline/gap-lanes.ts) calls the same reads and writes as pi_pipeline, each through a definer
// that gives the pipeline its lanes' flags alone. Holds no rule: each pass hands core's
// planGapFlags what this reads.

// One gap that holds now, with what raising it needs: what the flag is about, the row its label comes
// from, and when it is due (an attendee's meeting). A close person's gap is about and from the person
// (`entity`). A defect's is about the owner's system (`owner`, no id) and from the defect
// (`improvement`). `score`, set by the pipeline's pass from core's planExplore, the value it is
// raised at. `members`, a close person's group as the ranking summed it, whose warmth days
// ledger.raise_gap_flag holds the flag's label to.
export type GapRow = GapCandidate & {
  aboutKind: "message" | "event" | "entity" | "owner";
  aboutId: string | null;
  sourceKind: "message" | "event" | "goal" | "entity" | "improvement" | "card" | "capture" | "queue";
  dueAt: string | null;
  frontier?: FrontierParts & { goals: string[] };
  score?: FrontierScore;
  members?: string[];
};

// What every source of gaps gives, in one shape.
export const GAP_COLUMNS =
  '"trigger", subject, label, goal_id, about_kind, about_id, source_kind, source_id, at, due_at, facts, ties';
const CANDIDATES = `
  select ${GAP_COLUMNS}
  from ledger.gap_candidates($1::timestamptz, $2::integer)`;
// The three triggers code raises every day, in the same shape, within the windows of
// `ontology/autonomy.json` for this tick.
const AUTONOMY = `
  select ${GAP_COLUMNS}
  from ledger.autonomy_gaps($1::timestamptz, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5::timestamptz)`;
// Same-person batches waiting on agents. The writer batches them.
const SAME_PERSON = `
  select ${GAP_COLUMNS}
  from ledger.same_person_gaps()`;

// The system's own defects: one the system filed, at each opening, and one an agent filed that stood
// open and untouched. Each holds until a task raised for it has ended.
const DEFECTS = `
  select ${GAP_COLUMNS}
  from ledger.defect_gaps($1::timestamptz, $2::integer)`;

// Cards an agent is asked before the owner: each waiting card of those kinds, younger than the
// wait, with no answer and no task that has ended. About the owner's question (`owner`, no id) and
// from the card.
const CARDS = `
  select ${GAP_COLUMNS}
  from ledger.card_gaps($1::timestamptz, $2::integer)`;

// The week's sample of the standing rule's own merges: each is about and from one of the two people
// the ruling joined, under the ruling's label.
const MERGE_AUDITS = `
  select ${GAP_COLUMNS}
  from ledger.merge_audit_gaps($1::timestamptz, $2::integer, $3::integer)`;

// Cards asked through an agent: each waiting card of those kinds while the owner names a question
// role an agent holds, with no relay and no task that has ended.
const RELAYS = `
  select ${GAP_COLUMNS}
  from ledger.card_relay_gaps($1::timestamptz, $2::integer)`;

// Conflicts the dream pass found that code could not settle: each open one,
// about and from its subject, under the finding's own label.
const DREAM_FINDINGS = `
  select ${GAP_COLUMNS}
  from ledger.dream_finding_gaps($1::timestamptz)`;

// Dated things with nobody else on them, by an event's shape: its title is sealed and the tick holds
// no key. Read only while its switch is on.
const DEADLINE_SOON = `
  select ${GAP_COLUMNS}
  from ledger.deadline_gaps($1::timestamptz, $2::timestamptz, $3::integer)`;

// An active goal with no work on it since $2, and a meeting with people that ended after $2.
const GOAL_REVIEW = `
  select ${GAP_COLUMNS}
  from ledger.goal_review_gaps($1::timestamptz, $2::timestamptz)`;
const MEETING_FOLLOWUP = `
  select ${GAP_COLUMNS}
  from ledger.meeting_followup_gaps($1::timestamptz, $2::timestamptz)`;

// Every gap flag with its latest status, when and by whom it was set, its source, its key's label,
// and whether a client holds a live lease on it (ledger.gap_flag_rows; the pipeline's lanes alone as
// pi_pipeline). A label's comma form (`labelJoined`), a flag's identity; never policy.label_key's.
const FLAGS = `
  select id, gap_trigger, gap_subject, gap_source, label_key, event, at, by, code, due_at, owner_no, held, claimed, went
  from ledger.gap_flag_rows($1::timestamptz)`;

// Each label's tasks the cap covers that code decided go today ($1), and the claims and completions
// of its tasks since the window began ($2), every trigger's, by the same key as a flag's.
const SUPPLY = `
  select label_key, raised_today, claimed, done
  from ledger.gap_supply_rows($1::timestamptz, $2::timestamptz, $3::text[], $4::text[])`;

const EXPLORED = `
  select subject, label_key, at, value, goal from ledger.gap_explored_rows($1::timestamptz)`;

// What each trigger the cap covers raised today, under each label, as SUPPLY counts it.
const RAISED_BY_TRIGGER = `
  select label_key, trigger, n from ledger.gap_raised_by_trigger($1::timestamptz)`;

const RAISE =
  "select ledger.raise_gap_flag($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11::text[], $12::double precision, $13::double precision[], $14::text[], $15::text[], $16::text[]) as id";

export type CandidateRow = {
  trigger: GapTrigger;
  subject: string;
  label: string[];
  goal_id: string | null;
  about_kind: GapRow["aboutKind"];
  about_id: string | null;
  source_kind: GapRow["sourceKind"];
  source_id: string;
  at: Date;
  due_at: Date | null;
  facts: number | null;
  ties: number | null;
  // ledger.close_no_tie_gaps and ledger.close_no_role_gaps alone select this.
  members?: string[] | null;
  // ledger.explore_gaps alone selects the rest.
  goal_target?: boolean | null;
  goal_path?: boolean | null;
  goals?: string[] | null;
  meeting_soon?: boolean | null;
  namer_tiers?: string[] | null;
  named_days?: number | null;
  missing?: string[] | null;
};

// An explore row's parts; null on every other trigger's.
function frontierOf(row: CandidateRow): GapRow["frontier"] | undefined {
  if (row.trigger !== "explore") return undefined;
  return {
    goalTarget: row.goal_target === true,
    goalPath: row.goal_path === true,
    meetingSoon: row.meeting_soon === true,
    namerTiers: row.namer_tiers ?? [],
    namedDays: row.named_days ?? null,
    missing: (row.missing ?? []).map((one) => ExploreMissing.parse(one)),
    goals: row.goals ?? [],
  };
}

// The tick's gaps: every trigger's but the three warmth lanes', which the pipeline reads
// (pipeline/gap-lanes.ts).
export async function gapCandidates(
  query: Query,
  now: Date,
  rules: AutonomyRules = autonomyRules(),
): Promise<GapRow[]> {
  const windows = autonomyWindows(now, rules);
  const loops = loopWindows(now, rules);
  const rows = [
    ...(await query<CandidateRow>(CANDIDATES, [now.toISOString(), GAP_MEETING_DAYS])),
    ...(await query<CandidateRow>(
      AUTONOMY,
      [now, windows.meetingUntil, windows.dueUntil, windows.replyFrom, windows.replyUntil].map((one) =>
        one.toISOString(),
      ),
    )),
    ...(await query<CandidateRow>(SAME_PERSON)),
    ...(await query<CandidateRow>(DEFECTS, [now.toISOString(), DEFECT_UNTRIAGED_HOURS])),
    // Off by the rule data: no card waits on an agent.
    ...(attemptsOn(rules) ? await query<CandidateRow>(CARDS, [now.toISOString(), AGENT_ATTEMPT_HOURS]) : []),
    // It returns nothing while the owner's switch is off.
    ...(await query<CandidateRow>(MERGE_AUDITS, [now.toISOString(), MERGE_AUDIT_SAMPLE, MERGE_AUDIT_DAYS])),
    // With no question role the function gives none.
    ...(await query<CandidateRow>(RELAYS, [now.toISOString(), CARD_RELAY_HOURS])),
    ...(await query<CandidateRow>(DREAM_FINDINGS, [now.toISOString()])),
    // Absent is off: nothing spends on this unless the rule data says so.
    ...(rules.deadlineSoonOn === true
      ? await query<CandidateRow>(DEADLINE_SOON, [
          now.toISOString(),
          windows.dueUntil.toISOString(),
          REMINDER_MAX_MINUTES,
        ])
      : []),
    ...(loops.goalQuietSince === null
      ? []
      : await query<CandidateRow>(GOAL_REVIEW, [now.toISOString(), loops.goalQuietSince.toISOString()])),
    ...(loops.followUpFrom === null
      ? []
      : await query<CandidateRow>(MEETING_FOLLOWUP, [now.toISOString(), loops.followUpFrom.toISOString()])),
    // At most one a day for each label, and none with no host for the owner's page.
    ...ownerQueueGaps(await query<OwnerQueueState>(OWNER_QUEUE_STATE, [now.toISOString(), attemptsOn(rules)]), now),
  ];
  return gapRowsOf(rows, rules);
}

// Candidate rows as the planner takes them. reply_owed off (its trigger muted): it raises nothing,
// and an open one closes as its gap would. A gap under the standing check's compartments is no
// one's to fill.
export function gapRowsOf(rows: readonly CandidateRow[], rules: AutonomyRules): GapRow[] {
  return rows
    .filter((row) => rules.replyOwedOn !== false || row.trigger !== "reply_owed")
    .filter((row) => !row.label.some(isCanaryCompartment))
    .map((row) => {
      const frontier = frontierOf(row);
      return {
        trigger: row.trigger,
        subject: row.subject,
        labelKey: row.label.join(","),
        goal: row.goal_id,
        source: row.source_id,
        at: stamp(row.at),
        due: row.due_at === null ? null : stamp(row.due_at),
        ...(row.facts === null ? {} : { facts: row.facts }),
        ...(row.ties === null ? {} : { ties: row.ties }),
        aboutKind: row.about_kind,
        aboutId: row.about_id,
        sourceKind: row.source_kind,
        dueAt: row.due_at === null ? null : stamp(row.due_at),
        ...(frontier === undefined ? {} : { frontier }),
        ...(row.members === undefined || row.members === null ? {} : { members: row.members }),
      };
    });
}

// The close_no_role subjects history holds and no open flag does: settled, declined, resting or quiet. An
// open flag's stays, or the flag would read as its gap filled and close.
export async function closeNoRoleHeld(query: Query, now: Date): Promise<string[]> {
  const { open, history } = await gapFlags(query, now);
  const prefix = "close_no_role\n";
  const openKeys = new Set(open.map(gapKey));
  return [...history.quiet, ...history.declined.keys()]
    .filter((key) => key.startsWith(prefix) && !openKeys.has(key))
    .map((key) => key.slice(prefix.length));
}

// The numbers core's capGapRaises reads, by label: what code raised today, and what finished lately.
export async function gapSupply(query: Query, now: Date): Promise<Map<string, GapSupply>> {
  const day = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const from = new Date(Math.min(Date.parse(day), now.getTime() - GAP_RAISE_WINDOW_DAYS * 86_400_000)).toISOString();
  const rows = await query<{ label_key: string; raised_today: number; claimed: number; done: number }>(SUPPLY, [
    day,
    from,
    GAP_UNCAPPED_TRIGGERS,
    GAP_CAPPED_DATED_TRIGGERS,
  ]);
  const supply = new Map<string, GapSupply>(
    rows.map((row) => [row.label_key, { raisedToday: row.raised_today, claimed: row.claimed, done: row.done }]),
  );
  // What each trigger's work was worth, as a viewer of the label sees it, and what it raised today.
  const raised = await query<{ label_key: string; trigger: GapTrigger; n: number }>(RAISED_BY_TRIGGER, [day]);
  const since = new Date(now.getTime() - GAP_VALUE_WINDOW_DAYS * 86_400_000).toISOString();
  for (const label of new Set([...supply.keys(), ...raised.map((row) => row.label_key)])) {
    const standing = await query<{ trigger: string } & GapStanding>(
      "select trigger, scored, used, kept, dropped from ledger.task_standing($1, $2)",
      [since, label.split(",")],
    );
    const triggers: Record<string, GapStanding & { raisedToday: number }> = {};
    const of = (trigger: string) => {
      triggers[trigger] ??= { scored: 0, used: 0, kept: 0, dropped: 0, raisedToday: 0 };
      return triggers[trigger];
    };
    for (const row of raised) if (row.label_key === label) of(row.trigger).raisedToday = row.n;
    for (const { trigger, ...counts } of standing) Object.assign(of(trigger), counts);
    const numbers = supply.get(label) ?? { raisedToday: 0, claimed: 0, done: 0 };
    supply.set(label, { ...numbers, used: Object.values(triggers).reduce((sum, one) => sum + one.used, 0), triggers });
  }
  return supply;
}

// The flags open now, and what the closed ones say (core's GapHistory): one declined (a `no_go` decided by the owner, or rung 0's on a veto of the owner's) names
// its source for good; one done, or closed by anyone but `system:gaps` is quiet for GAP_QUIET_DAYS; one code withdrew because its gap filled, rung 0 closed
// `no_go`, or a task that expired with no agent ever claiming it rests for GAP_WITHDRAWN_REST_DAYS unless it is dated, so a candidate that flickers is not raised
// again without bound, code's no is never read as the owner's, and work nobody read says nothing about its gap. So does undated work that ended with no result: a
// failed report, or an expiry after a claim, since a claim alone left nothing to read. A dated one stays quiet instead: with no rest it would be paid for again on
// the next tick, and its date moves it on. The owner's no counts whatever the flag's last status: one on a card whose flag code had withdrawn holds too.
// `resting`: the keys of `history.quiet` that only the shorter rest holds, for the report. `states`: flags by trigger and latest status. Three such ends of one
// undated gap within GAP_FAILURES_DAYS and it stops resting and goes quiet: a refused tool or an outage says nothing new each week, and the event's code cannot
// tell those from a model finding nothing.
export type GapFlags = {
  open: OpenGapFlag[];
  history: GapHistory;
  explored: ExploredFlag[];
  resting: ReadonlySet<string>;
  states: Partial<Record<GapTrigger, Record<string, number>>>;
};
const GAP_FAILURES_DAYS = 90;
const GAP_FAILURES_MOST = 3;
const CLOSE_NO_ROLE_FAILURES_MOST = 2;
export async function gapFlags(query: Query, now: Date): Promise<GapFlags> {
  const rows = await query<{
    id: string;
    gap_trigger: GapTrigger;
    gap_subject: string;
    gap_source: string;
    label_key: string;
    event: OpportunityStatus;
    at: Date;
    by: string;
    code: string | null;
    due_at: Date | null;
    owner_no: boolean;
    held: boolean;
    claimed: boolean;
    went: boolean;
  }>(FLAGS, [now.toISOString()]);
  const since = now.getTime() - GAP_QUIET_DAYS * 86_400_000;
  const rested = now.getTime() - GAP_WITHDRAWN_REST_DAYS * 86_400_000;
  const open: OpenGapFlag[] = [];
  const quiet = new Set<string>();
  const rest = new Set<string>();
  const declined = new Map<string, Set<string>>();
  const states: GapFlags["states"] = {};
  const failures = new Map<string, number>();
  const failedSince = now.getTime() - GAP_FAILURES_DAYS * 86_400_000;
  for (const row of rows) {
    const counted = (states[row.gap_trigger] ??= {});
    counted[row.event] = (counted[row.event] ?? 0) + 1;
    const flag = {
      id: row.id,
      trigger: row.gap_trigger,
      subject: row.gap_subject,
      labelKey: row.label_key,
      held: row.held,
      ...(row.event === "go" ? { goDue: stampOrNull(row.due_at) } : {}),
    };
    const key = gapKey(flag);
    if (OPEN_STATUSES.includes(row.event)) open.push(flag);
    else if (row.owner_no || (row.event === "no_go" && row.by === "owner"))
      declined.set(key, (declined.get(key) ?? new Set()).add(row.gap_source));
    // A role an agent found is under its own compartment, so it closes no gap under `own`: a task done
    // settles it, or the same person is paid for every 30 days with nothing new to find. Work that ended
    // with no result settles nothing.
    else if (row.gap_trigger === "close_no_role" && row.event === "done") quiet.add(key);
    // Its subject is its day, and ledger.owner_queue_state says whether the day is spent: only an
    // agent's done report, the owner told, spends it. One the tick withdrew, or that expired or
    // failed, told nobody.
    else if (row.gap_trigger === "owner_queue") continue;
    else if (row.gap_trigger === "goal_review") {
      if (row.at.getTime() >= since) quiet.add(key);
    } else if (
      row.event === "no_go" ||
      row.by === "system:gaps" ||
      (row.event === "expired" && row.went && !row.claimed)
    ) {
      if (row.due_at === null && row.at.getTime() >= rested) rest.add(key);
    } else if (
      row.due_at === null &&
      ((row.event === "withdrawn" && row.code === "failed") || (row.event === "expired" && row.went))
    ) {
      if (row.at.getTime() >= failedSince) failures.set(key, (failures.get(key) ?? 0) + 1);
      if (row.at.getTime() >= rested) rest.add(key);
      const most = row.gap_trigger === "close_no_role" ? CLOSE_NO_ROLE_FAILURES_MOST : GAP_FAILURES_MOST;
      if ((failures.get(key) ?? 0) >= most && row.at.getTime() >= since) quiet.add(key);
    } else if (row.at.getTime() >= since) quiet.add(gapQuietKey({ ...flag, due: stampOrNull(row.due_at) }));
  }
  const dayStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const from = Math.min(dayStart, now.getTime() - secondDegreeRules().exploreRestDays * 86_400_000);
  const explored = (
    await query<{ subject: string; label_key: string; at: Date; value: number; goal: boolean }>(EXPLORED, [
      new Date(from).toISOString(),
    ])
  ).map((row) => ({
    subject: row.subject,
    labelKey: row.label_key,
    at: stamp(row.at),
    value: row.value,
    goal: row.goal,
  }));
  return {
    open,
    history: { quiet: new Set([...quiet, ...rest]), declined },
    explored,
    resting: new Set([...rest].filter((key) => !quiet.has(key))),
    states,
  };
}

// One flag raised: its id, an open one's that already holds the gap, or null (ledger.raise_gap_flag:
// gone, vetoed, or no intent of the owner's authorizes it yet). `decide` false proposes it for the owner's card.
export async function raiseGapFlag(query: Query, gap: GapRow, decide: boolean): Promise<OpportunityId | null> {
  const explore = gap.trigger === "explore" && gap.frontier !== undefined && gap.score !== undefined;
  const [row] = await query<{ id: string | null }>(RAISE, [
    newId("opp"),
    gap.trigger,
    gap.subject,
    gap.aboutKind,
    gap.aboutId,
    gap.sourceKind,
    gap.source,
    gap.goal,
    gap.dueAt,
    decide,
    explore ? gap.frontier?.missing : null,
    explore ? gap.score?.value : null,
    explore && gap.score !== undefined ? storedParts(gap.score) : null,
    explore ? gap.frontier?.goals : null,
    // A close person's flag is labelled as the pipeline's ranking labelled the person, and carries
    // the person's group, whose warmth days the label must hold.
    ...(gap.trigger === "close_no_tie" || gap.trigger === "close_no_role"
      ? [gap.labelKey.split(","), gap.members ?? null]
      : [null, null]),
  ]);
  const id = (row?.id ?? null) as OpportunityId | null;
  // What the outcome machinery judges this work by, in the raise's transaction. No
  // value to seal: a default holds a type and a horizon, so the tick needs no key.
  const expected = id === null ? null : gapExpectation(gap.trigger);
  if (expected !== null)
    await query("select ledger.expect_gap_flag($1, $2, $3)", [id, expected.type, expected.horizonDays]);
  return id;
}

// `fn`, a whole gap pass, under the gap pass lock on a connection of its own, given back when `fn`
// ends or lost with the connection: the tick's pass and the pipeline's lanes' never read a label's
// supply and raise against it at once.
export const underGapPass = <T>(db: Db, fn: () => Promise<T>): Promise<T> =>
  db.session(async (query) => {
    await query(GAP_PASS_HOLD.take);
    try {
      return await fn();
    } finally {
      await query(GAP_PASS_HOLD.give);
    }
  });

// Thrown only to roll a raise back, and caught where it is thrown.
const ROLLED_BACK = new Error("rolled_back");
export type GapRaiseCheck = { now: Date; closesAtOnce: (facts: ToDecide["facts"]) => boolean };
async function raiseChecked(
  query: Query,
  gap: GapRow,
  decide: boolean,
  check: GapRaiseCheck | undefined,
): Promise<OpportunityId | null | "withheld"> {
  const id = await raiseGapFlag(query, gap, decide);
  if (id === null || check === undefined) return id;
  const item = await opportunityFacts(query, id, check.now);
  return item !== null && check.closesAtOnce(item.facts) ? "withheld" : id;
}

export type InTransaction = <T>(fn: (query: Query) => Promise<T>) => Promise<T>;

// Given `check`, a raised row still to be decided is asked of first: one it says closes at once is
// rolled back and answered `withheld`, so a gap rung 0 will not let through spends no row, whichever
// way the raise made it the owner's. The rule stays the ladder's, in the caller's hands.
export async function raiseGapChecked(
  inWrite: InTransaction,
  gap: GapRow,
  decide: boolean,
  check: GapRaiseCheck | undefined,
): Promise<OpportunityId | null | "withheld"> {
  let answer: OpportunityId | null | "withheld" = null;
  try {
    return await inWrite(async (query) => {
      answer = await raiseChecked(query, gap, decide, check);
      if (answer === "withheld") throw ROLLED_BACK;
      return answer;
    });
  } catch (error) {
    if (error === ROLLED_BACK) return answer;
    throw error;
  }
}

// What raiseGapChecked would answer, by the same writes and the same check, with the transaction
// always rolled back: a report's question that spends no row.
export async function probeGap(
  inWrite: InTransaction,
  gap: GapRow,
  decide: boolean,
  check: GapRaiseCheck,
): Promise<OpportunityId | null | "withheld"> {
  let answer: OpportunityId | null | "withheld" = null;
  try {
    await inWrite(async (query) => {
      answer = await raiseChecked(query, gap, decide, check);
      throw ROLLED_BACK;
    });
  } catch (error) {
    if (error !== ROLLED_BACK) throw error;
  }
  return answer;
}

// One flag closed because its gap filled (ledger.close_gap_flag): withdrawn by `system:gaps`, while
// it is open and no client holds a live lease on it, its lease and its holder's waiting check-backs
// removed with it. False when it was not open. Each pass closes its own triggers' flags alone.
export async function closeGapFlag(query: Query, id: string, now: Date): Promise<boolean> {
  const [row] = await query<{ closed: boolean }>("select ledger.close_gap_flag($1, $2::timestamptz) as closed", [
    id,
    now.toISOString(),
  ]);
  return row?.closed === true;
}
