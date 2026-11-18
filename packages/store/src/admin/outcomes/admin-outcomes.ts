import type { Timestamp } from "@intelligence/contracts";
import {
  dayAfter,
  dayIn,
  type EntityId,
  GapTrigger,
  OpportunityStatus,
  type OwnerPaths,
  SELF_LOW_USE,
  type TimeWeek,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { GAP_VALUE_WINDOW_DAYS } from "@intelligence/personal-core/planner";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { ownerAudience } from "../../core/audience.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import {
  commitmentEnds,
  commitmentsEndedShares,
  goalPeopleTasksMetric,
  type OutcomeMetric,
  type OutcomeWindow,
  outcomeMetric,
  shareOf,
  topPeopleParts,
  type UsageState,
  usageStateOf,
} from "../../core/outcome-thresholds.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { latestEvent, latestRow, moveStatus } from "../../core/statements.ts";
import { openStatus } from "../../core/status-facts.ts";
import type { Tx } from "../../core/tx.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { thinMerges } from "../../identity/thin-merges.ts";
import { ownerBeliefs } from "../admin-owner.ts";
import { REPEATABLE, unrestrictedOf } from "../admin-time-base.ts";
import { selfReview } from "../history/admin-self.ts";
import { goalTargetIds, paths } from "../people/admin-people-network.ts";
import { ownerWarmthRows } from "../people/admin-warmth.ts";
import { timeWeek } from "../time/admin-work-time.ts";
import { ownerCommitments } from "../work/admin-commitments.ts";
import { openItemTally } from "../work/admin-open-items.ts";
import { type BacktestMeter, backtestMeter, type RecallLine, recallReport } from "./admin-backtest.ts";
import { canaryLatest } from "./admin-canary.ts";
import { type OutcomeTestsShown, outcomeTestsRead } from "./admin-outcome-tests.ts";
import { type ExtractionRetries, extractionRetries } from "./admin-outcomes-extraction.ts";
import { type GoalLine, goalLine, goalMeasures } from "./admin-outcomes-goal.ts";
import { backupAge, type Clock, codeNoGos, healthTold, restoreAge } from "./admin-outcomes-health.ts";
import { mergeAudits } from "./admin-outcomes-merges.ts";
import {
  innerTiesWithChat,
  MAIL_OBLIGATIONS,
  MODEL_FACT,
  momentFactReadBack,
  momentsToClaims,
  NOTICE_OBLIGATIONS,
  PROJECT_CHAT,
} from "./admin-outcomes-moments.ts";
import { ownerQuestions } from "./admin-outcomes-questions.ts";
import { unattendedRoles } from "./admin-outcomes-roles.ts";
import { type RunsReliability, runsReliability } from "./admin-outcomes-runs.ts";
import { type SeamView, seamSignals } from "./admin-outcomes-seam.ts";
import { type TaskFunnel, type TaskValue, taskFunnel, taskUsedShare, taskValue } from "./admin-outcomes-value.ts";
import { type RefusalsView, refusals } from "./admin-refusals.ts";
import { type RefusedField, refusedFields, type ToolUsage, toolUsage } from "./admin-tool-usage.ts";

// `pi outcomes`, run as pi_admin: whether each feature does what it is for, and whether it is used
// at all. Ids, counts, codes and times only. A belief is opened for its status alone, a week of
// work time for its minutes, a commitment for how it ended and a refused claim for its code, and
// none of them leaves the outcomes modules. Every row with a label is counted only within the key
// file's compartments but the restricted ones, as the ledger counts, so no number rests on a row
// the owner's terminal cannot see. It writes nothing.

export const OUTCOME_DAYS = { min: 1, max: 90 } as const;

export type OutcomesView = {
  days: number;
  at: Timestamp;
  // The first thing to read: whether the agents had what they needed (the outcome test's newest score)
  // and whether signals were acted on.
  // `goal`: the owner's acts and questions a week and the defects closed without the owner.
  headline: { hadWhatItNeeded: OutcomeMetric; signals: SeamView; goal: GoalLine };
  // Then whether the system helps, a week after, and what the work behind it cost.
  meter: BacktestMeter & { cost: { raised: number; claimed: number; done: number } };
  // What each closed filter lost, by a stronger model's reading of a sample. None until it is turned on.
  recall: RecallLine[];
  metrics: OutcomeMetric[];
  timeProposals: TimeProposalCounts;
  funnel: TaskFunnel;
  value: TaskValue;
  usage: { tools: ToolUsage[]; tables: TableUsage[]; refusedFields: RefusedField[] };
  refusals: RefusalsView;
  // The items a vendor outage failed: those owed an automatic retry and those whose tries are spent.
  extraction: { vendorRetries: ExtractionRetries };
  runs: RunsReliability;
  // The standing end-to-end check: each source's latest result, none until it first runs.
  canary: Awaited<ReturnType<typeof canaryLatest>>;
  outcomeTests: OutcomeTestsShown;
};
type TimeProposalCounts = { proposed: number; vetoed: number; held: number };
type TableUsage = { table: string; rows: number; lastWrittenAt: Timestamp | null; state: UsageState };

// What the report counts by the column that says when a row was written.
const USAGE_TABLES = [
  ["ledger.surfaced_items", "first_at"],
  ["ledger.recall_checks", "created_at"],
  ["ledger.improvements", "created_at"],
  ["ledger.agent_messages", "created_at"],
  ["ledger.drafts", "created_at"],
  ["ledger.hypothesis_tests", "created_at"],
  ["ledger.move_lessons", "created_at"],
  ["ledger.outcome_links", "judged_at"],
  ["ledger.work_watches", "created_at"],
  ["ledger.goal_proposals", "created_at"],
  ["ledger.expected_outcomes", "created_at"],
  ["ledger.memory_projections", "first_served_at"],
  ["ledger.memory_exposures", "recorded_at"],
  ["ledger.memory_imports", "created_at"],
  ["knowledge.owner_lists", "created_at"],
  ["knowledge.time_rulings", "created_at"],
] as const;

// The people the owner is closest to, and what a person's page needs before it reads as known.
const TOP_TIERS = ["inner", "close"];
const FRESH_DAYS = 30;
// A belief that ended no longer says anything current; a stale or dormant one still stands.
const ENDED = new Set(["expired", "closed"]);

// A claim within a day counts: the 1 to 7 days ago window gives every item its whole day.
const CLAIM_WINDOW = { fromDaysAgo: 7, toDaysAgo: 1 };
const READ_BACK_WINDOW = { fromDaysAgo: 14, toDaysAgo: 7 };
const CREDITED_DAYS = 7;

// Its time is `first_known_at`, which a re-derive keeps, so a raised generation does not reset the day.
const CLAIM_IN_A_DAY = `exists (select 1 from knowledge.claims c where c.evidence_id = e.id and c.compartments <@ $3::text[]
    and c.first_known_at <= e.ingested_at + interval '24 hours')`;
// A meeting's commit makes its participants' claims whatever was said, so only a model's fact counts.
const FACT_IN_A_DAY = `exists (select 1 from knowledge.claims c where c.evidence_id = e.id and c.compartments <@ $3::text[]
    and ${MODEL_FACT} and c.first_known_at <= e.ingested_at + interval '24 hours')`;

const MAIL = `
  select count(*)::int as sample, count(*) filter (where ${CLAIM_IN_A_DAY})::int as hits
  from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
  where e.source_kind = 'email' and e.ingested_at >= $1 and e.ingested_at < $2 and m.compartments <@ $3::text[]
    and not e.system_originated and not m.held and not m.bulk`;

const MEETINGS = `
  select count(*)::int as sample, count(*) filter (where ${FACT_IN_A_DAY})::int as hits
  from knowledge.captures k join vault.evidence_items e on e.id = k.evidence_id
  where k.kind = 'meeting' and e.ingested_at >= $1 and e.ingested_at < $2 and k.compartments <@ $3::text[]`;

// Served to another client within a week of its writing: a finding is shown by its record's id, or
// by the id of the evidence that holds it, and a pack lists what it carried. A log row's label is
// the reader's clearance, not what it read, so only the finding's own label decides what is counted.
const READ_BACK = `
  select count(*)::int as sample, count(*) filter (where
      exists (select 1 from ledger.read_log r
              where r.client_id <> w.client_id and r.read_at > w.created_at and r.read_at <= w.created_at + interval '7 days'
                and (r.shown && w.ids or r.bound && w.ids))
      or exists (select 1 from ledger.context_packs p
              where p.client_id <> w.client_id and p.created_at > w.created_at and p.created_at <= w.created_at + interval '7 days'
                and p.item_ids && w.ids))::int as hits
  from (select a.client_id, a.created_at, array_remove(array[a.id, a.evidence_id], null) as ids
        from ledger.agent_writes a
        where a.kind = 'finding' and a.refused_code is null and a.tainted_at is null
          and a.created_at >= $1 and a.created_at < $2 and a.compartments <@ $3::text[]) w`;

// The active projects, and those with a status, decision or next step from a message in the window.
// A finding's are the agent's and not counted: this asks whether the owner's mail reaches the record.
const PROJECT_MAIL = `
  select count(*)::int as sample, count(*) filter (where exists (
      select 1 from knowledge.claim_entities n
      join knowledge.claims c on c.id = n.claim_id
      join knowledge.messages m on m.evidence_id = c.evidence_id
      where n.entity_id = p.id and c.type in ('project.status', 'project.decision', 'project.next_step')
        and c.valid_from >= $1 and c.valid_from < $2 and c.compartments <@ $3::text[]))::int as hits
  from knowledge.projects p where p.status = 'active' and p.compartments <@ $3::text[]`;

// An opportunity's status is its latest event. The report behind it is a `reported` event on a move
// whose own outcome was `done`: every other outcome reports too, and says the work did not finish.
const DONE = `
  with done as (
    select o.id, o.created_at, e.at from ledger.record_events e
    join ledger.opportunities o on o.id = e.row_id
    where e.row_kind = 'opportunity' and e.event = 'done' and e.at >= $1 and e.at <= $2
      and o.tainted_at is null and o.compartments <@ $3::text[]
      and e.id = (select max(l.id) from ledger.record_events l where l.row_kind = 'opportunity' and l.row_id = o.id)
      and exists (select 1 from ledger.moves m
                  join ledger.record_events r on r.row_kind = 'move' and r.row_id = m.id and r.event = 'reported' and r.tainted_at is null
                    and r.code is distinct from 'progress'
                  where m.opportunity_id = o.id and m.tainted_at is null
                    and m.compartments <@ $3::text[] and r.compartments <@ $3::text[]
                    and (${moveStatus("m.id", "x")}) = 'done')
  )
  select (select count(*) from done)::int as done,
    (select percentile_cont(0.5) within group (order by extract(epoch from d.at - d.created_at) / 86400) from done d) as median_days,
    (select count(*) from (select id from done union
       select m.opportunity_id from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id
       where m.created_at >= $1 and m.created_at <= $2 and m.tainted_at is null and o.tainted_at is null
         and m.compartments <@ $3::text[] and o.compartments <@ $3::text[]) t)::int as worked_on`;

// A card raised under the key of one the owner already answered asks the owner twice. Only a card with a
// key can be raised again, and a box health card recurs by design: each is news of a new event.
const REASKED = `
  with answered as (
    select c.id, c.case_key, c.match_fp, min(r.at) as at from ledger.cards c
    join ledger.record_events r on r.row_kind = 'card' and r.row_id = c.id and r.event = 'decided'
    where r.at >= $1 and r.at <= $2 and c.compartments <@ $3::text[] and c.kind <> 'box_health' and c.tainted_at is null
      and (c.case_key is not null or c.match_fp is not null)
    group by c.id
  )
  select count(*)::int as sample, count(*) filter (where exists (
      select 1 from ledger.cards n where n.id <> a.id and n.created_at > a.at and n.created_at <= $2 and n.compartments <@ $3::text[] and n.tainted_at is null
        and (n.case_key = a.case_key or n.match_fp = a.match_fp)))::int as hits
  from answered a`;

// Which of the top people each claim names. A person folded from several entities is one warmth row
// with every entity in `members`. A re-extraction makes new claims from old mail, so a claim's
// freshness is when it was first known, not when it was written.
const CLAIMS_OF_PEOPLE = `
  select n.claim_id, n.entity_id, c.fact_key_fp, c.first_known_at >= $2 as fresh
  from knowledge.claim_entities n join knowledge.claims c on c.id = n.claim_id
  where n.entity_id = any ($1::text[])`;

type Share = { sample: number; hits: number };

const shareRead = (share: Share | undefined, window: OutcomeWindow) => ({
  value: shareOf(share?.hits ?? 0, share?.sample ?? 0),
  sample: share?.sample ?? 0,
  window,
});

async function claimMetrics(tx: Tx, { now, within, ago }: Clock): Promise<OutcomeMetric[]> {
  const window: [string, string, string[]] = [ago(CLAIM_WINDOW.fromDaysAgo), ago(CLAIM_WINDOW.toDaysAgo), within];
  const [mail] = await tx.query<Share>(MAIL, window);
  const [meetings] = await tx.query<Share>(MEETINGS, window);
  const [obligations] = await tx.query<Share>(MAIL_OBLIGATIONS, window);
  const [notices] = await tx.query<Share>(NOTICE_OBLIGATIONS, window);
  return [
    outcomeMetric("mail_to_claim_24h", shareRead(mail, CLAIM_WINDOW)),
    outcomeMetric("mail_to_obligation_7d", shareRead(obligations, CLAIM_WINDOW)),
    outcomeMetric("notice_to_plan_7d", shareRead(notices, CLAIM_WINDOW)),
    // None received is its own reading: the lane can be on while nothing reaches it.
    outcomeMetric("capture_to_claim_24h_meetings", {
      ...shareRead(meetings, CLAIM_WINDOW),
      ...(meetings?.sample === 0 ? { code: "none_received" } : {}),
    }),
    await innerTiesWithChat(tx, within, CLAIM_WINDOW, now),
    await momentsToClaims(tx, window, CLAIM_WINDOW),
    await momentFactReadBack(
      tx.query,
      [ago(READ_BACK_WINDOW.fromDaysAgo), ago(READ_BACK_WINDOW.toDaysAgo), within],
      READ_BACK_WINDOW,
    ),
  ];
}

// Each with its claims, code's project links and activity facts left out.
const OWN_LINES = `
  select k.evidence_id, p.compartments, p.facts_enc,
    (select count(*)::int from knowledge.claims c
      where c.evidence_id = k.evidence_id and c.compartments <@ $2::text[]
        and c.type not like 'capture.%' and c.type not like 'activity.%') as claims
  from knowledge.captures k join vault.pipeline_items p on p.evidence_id = k.evidence_id
  where k.agent_app and p.updated_at >= $1::timestamptz and k.compartments <@ $2::text[] and p.compartments <@ $2::text[]
    and exists (select 1 from vault.model_call_members m join vault.model_calls mc on mc.id = m.call_id
      where m.evidence_id = k.evidence_id and mc.prompt_id = 'personal_own_lines')`;

async function ownLinesYield(
  query: Query,
  keys: AdminContext["keys"],
  days: number,
  { within, ago }: Clock,
): Promise<OutcomeMetric> {
  const rows = await query<{ evidence_id: string; compartments: string[]; facts_enc: Sealed; claims: number }>(
    OWN_LINES,
    [ago(days), within],
  );
  const done = rows.filter(
    (row) => openStatus({ query, keys }, row.compartments, row.evidence_id, row.facts_enc).status === "done",
  );
  return outcomeMetric(
    "own_lines_claims_per_moment",
    shareRead(
      { sample: done.length, hits: done.reduce((sum, row) => sum + row.claims, 0) },
      { fromDaysAgo: days, toDaysAgo: 0 },
    ),
  );
}

async function readBack(query: Query, { within, ago }: Clock): Promise<OutcomeMetric> {
  const [row] = await query<Share>(READ_BACK, [
    ago(READ_BACK_WINDOW.fromDaysAgo),
    ago(READ_BACK_WINDOW.toDaysAgo),
    within,
  ]);
  return outcomeMetric("finding_read_back_7d", shareRead(row, READ_BACK_WINDOW));
}

async function projectMail(query: Query, days: number, { now, within, ago }: Clock): Promise<OutcomeMetric> {
  const [row] = await query<Share>(PROJECT_MAIL, [ago(days), stamp(now), within]);
  return outcomeMetric("projects_with_mail_facts", shareRead(row, { fromDaysAgo: days, toDaysAgo: 0 }));
}

async function projectChat(query: Query, days: number, { now, within, ago }: Clock): Promise<OutcomeMetric> {
  const [row] = await query<Share>(PROJECT_CHAT, [ago(days), stamp(now), within]);
  return outcomeMetric("projects_with_chat_facts", shareRead(row, { fromDaysAgo: days, toDaysAgo: 0 }));
}

async function doneWork(query: Query, days: number, { now, within, ago }: Clock): Promise<OutcomeMetric[]> {
  const [row] = await query<{ done: number; median_days: number | null; worked_on: number }>(DONE, [
    ago(days),
    stamp(now),
    within,
  ]);
  const window = { fromDaysAgo: days, toDaysAgo: 0 };
  return [
    outcomeMetric("done_work_per_week", {
      value: ((row?.done ?? 0) / days) * 7,
      sample: row?.worked_on ?? 0,
      window,
    }),
    outcomeMetric("median_days_to_done", {
      value: row?.median_days ?? null,
      sample: row?.done ?? 0,
      window,
    }),
  ];
}

async function reasked(query: Query, days: number, { now, within, ago }: Clock): Promise<OutcomeMetric> {
  const [row] = await query<Share>(REASKED, [ago(days), stamp(now), within]);
  return outcomeMetric("reasked_after_answer", shareRead(row, { fromDaysAgo: days, toDaysAgo: 0 }));
}

async function topPeople(
  query: Query,
  keys: AdminContext["keys"],
  { now, within, ago }: Clock,
): Promise<OutcomeMetric> {
  const audience = await ownerAudience(query);
  if (audience.length === 0)
    return outcomeMetric("top_people_filled", { value: null, sample: 0, window: null, code: "no_owner_audience" });
  const people = (await ownerWarmthRows({ query, keys }, now)).filter(
    (w) => TOP_TIERS.includes(w.tier) && w.compartments.every((one) => within.includes(one)),
  );
  const personOf = new Map(people.flatMap((one) => one.members.map((member) => [member, one.entity_id] as const)));
  const claims = await query<{ claim_id: string; entity_id: string; fact_key_fp: string; fresh: boolean }>(
    CLAIMS_OF_PEOPLE,
    [[...personOf.keys()], ago(FRESH_DAYS)],
  );
  const claimsById = new Map<string, typeof claims>();
  for (const claim of claims) claimsById.set(claim.claim_id, [...(claimsById.get(claim.claim_id) ?? []), claim]);
  const current = new Map<string, { beliefs: number; fresh: boolean }>();
  // Only the beliefs of the facts the claims naming them hold: no other belief names them.
  const facts = [...new Set(claims.map((one) => one.fact_key_fp))];
  for (const { belief, support, compartments } of await ownerBeliefs({ query, keys }, facts)) {
    if (ENDED.has(belief.status) || !compartments.every((one) => within.includes(one))) continue;
    const named = support.flatMap((id) => claimsById.get(id) ?? []);
    const about = new Set(named.flatMap((claim) => personOf.get(claim.entity_id) ?? []));
    for (const person of about) {
      const seen = current.get(person) ?? { beliefs: 0, fresh: false };
      const fresh = named.some((claim) => claim.fresh && personOf.get(claim.entity_id) === person);
      current.set(person, { beliefs: seen.beliefs + 1, fresh: seen.fresh || fresh });
    }
  }
  // A person no current belief names is in none of `current`, and lacks everything.
  const parts = topPeopleParts([
    ...current.values(),
    ...Array.from({ length: Math.max(0, people.length - current.size) }, () => ({ beliefs: 0, fresh: false })),
  ]);
  return outcomeMetric("top_people_filled", {
    value: shareOf(parts.filled, people.length),
    sample: people.length,
    window: null,
    parts,
  });
}

// How many goal targets the share below looks at: each builds the owner's graph once.
const GOAL_TARGET_SAMPLE = 5;

// How many people warmth scores, and how many it reads as dormant, in the owner's audience.
async function warmthReach(query: Query, keys: AdminContext["keys"], { now, within }: Clock): Promise<OutcomeMetric[]> {
  const audience = await ownerAudience(query);
  if (audience.length === 0)
    return (["people_with_warmth", "dormant_people"] as const).map((metric) =>
      outcomeMetric(metric, { value: null, sample: 0, window: null, code: "no_owner_audience" }),
    );
  const rows = (await ownerWarmthRows({ query, keys }, now)).filter((w) =>
    w.compartments.every((one) => within.includes(one)),
  );
  const row = {
    people: rows.length,
    warm: rows.filter((w) => Number(w.warmth) > 0).length,
    dormant: rows.filter((w) => w.dormant).length,
  };
  const sample = row?.people ?? 0;
  return [
    outcomeMetric("people_with_warmth", { value: row?.warm ?? 0, sample, window: null }),
    outcomeMetric("dormant_people", { value: row?.dormant ?? 0, sample, window: null }),
  ];
}

// How many live joins rest on a first name alone (thin-merges.ts).
async function firstNameMerges(query: Query, keys: AdminContext["keys"]): Promise<OutcomeMetric> {
  const [row] = await query<{ n: number }>(
    "select count(*)::int as n from knowledge.identity_rulings where verdict = 'same' and lifted_at is null and b_fp is not null",
  );
  const thin = await thinMerges(query, keys);
  return outcomeMetric("merges_first_name_only", {
    value: thin.filter((one) => one.reason === "first_name_only").length,
    sample: row?.n ?? 0,
    window: null,
  });
}

// Whether what the system holds can answer "who can introduce me to this person", on a few targets of
// active goals, the lowest ids so the sample holds still between runs. A target the owner has a tie
// with needs no route and is not counted; a route counts when a hop joins two people.
async function goalTargetPaths(admin: AdminContext): Promise<OutcomeMetric> {
  const none = (code: string): OutcomeMetric =>
    outcomeMetric("goal_targets_with_person_path", { value: null, sample: 0, window: null, code });
  const targets = (await admin.transaction(goalTargetIds)).sort(byText).slice(0, GOAL_TARGET_SAMPLE);
  let sample = 0;
  let hits = 0;
  for (const target of targets) {
    let found: OwnerPaths | null;
    try {
      found = await paths(admin, target as EntityId);
    } catch (error) {
      if (error instanceof AdminError && error.code === "rebuilding") return none("rebuilding");
      throw error;
    }
    if (found === null) continue;
    if (found.paths.some((path) => path.edges.length === 1 && path.nodes[1]?.kind === "person")) continue;
    sample += 1;
    if (
      found.paths.some((path) =>
        path.edges.some(
          (edge, n) => edge.kind !== "tie" && path.nodes[n]?.kind === "person" && path.nodes[n + 1]?.kind === "person",
        ),
      )
    )
      hits += 1;
  }
  return outcomeMetric("goal_targets_with_person_path", {
    value: shareOf(hits, sample),
    sample,
    window: null,
  });
}

// What ended as done in the window and stayed so: the owner's Done on any item, and an agent's close
// that says done, each with no reopen since.
const ITEMS_DONE = `
  select (
    select count(*) from knowledge.owner_decisions d
    where d.kind in ('commitment_close', 'open_item_close') and d.answer = 'done' and d.tainted_at is null
      and d.decided_at >= $1 and d.decided_at <= $2 and d.compartments <@ $3::text[]
      and not exists (select 1 from knowledge.owner_decisions r
        where r.kind in ('commitment_reopen', 'open_item_reopen') and r.tainted_at is null and (r.decided_at, r.id) > (d.decided_at, d.id)
          and coalesce(r.details ->> 'key', r.details ->> 'factKey') = coalesce(d.details ->> 'key', d.details ->> 'factKey'))
      -- Done twice with a reopen between counts once: the later close stands alone.
  )::int + (
    select count(*) from ledger.agent_writes w
    where w.kind = 'close' and w.close_ending = 'done' and w.body_enc is not null
      and w.created_at >= $1 and w.created_at <= $2 and w.compartments <@ $3::text[]
      and not exists (select 1 from ledger.commitment_reopens r where r.close_id = w.id)
  )::int as done`;

async function openItemMetrics(admin: AdminContext, days: number, clock: Clock): Promise<OutcomeMetric[]> {
  const none = (metric: "open_items_count" | "open_items_done_share", code: string): OutcomeMetric =>
    outcomeMetric(metric, { value: null, sample: 0, window: null, code });
  let tally: Awaited<ReturnType<typeof openItemTally>>;
  try {
    tally = await openItemTally(admin, new Date(clock.ago(days)), clock.within);
  } catch (error) {
    if (error instanceof AdminError && error.code === "rebuilding")
      return [none("open_items_count", "rebuilding"), none("open_items_done_share", "rebuilding")];
    throw error;
  }
  const [row] = await admin.transaction((query) =>
    query<{ done: number }>(ITEMS_DONE, [clock.ago(days), stamp(clock.now), clock.within]),
  );
  const done = row?.done ?? 0;
  const ended = done + tally.lapsed;
  return [
    outcomeMetric("open_items_count", { ...tally.count, sample: Math.max(tally.count.value, ended), window: null }),
    outcomeMetric("open_items_done_share", {
      value: shareOf(done, ended),
      sample: ended,
      window: { fromDaysAgo: days, toDaysAgo: 0 },
    }),
  ];
}

// A target is a bound one or a name still waiting in the goal's latest decision, as rebuildGoalState
// reads it, so one cleared is none.
const HAS_TARGET = `(g.target_entity_id is not null or (
    select d.details -> 'named' from knowledge.owner_decisions d
    where d.kind = 'goal_target' and d.target_kind = 'goal' and d.target_id = g.goal_id
    order by d.decided_at desc, d.id collate "C" desc limit 1) is not null)`;
const GOAL_PEOPLE_TASKS = `
  select
    (select count(*)::int from ledger.opportunities o
     join projections.goal_state g on g.goal_id = o.goal_id and g.status = 'active' and ${HAS_TARGET}
     where o.gap_trigger in ('intro_path', 'explore') and o.created_at >= $1 and o.created_at <= $2 and o.compartments <@ $3::text[]) as raised,
    (select count(*)::int from projections.goal_state g
     where g.status = 'active' and g.compartments <@ $3::text[] and ${HAS_TARGET}) as targeted`;

async function goalPeopleTasks(query: Query, days: number, { now, within, ago }: Clock): Promise<OutcomeMetric> {
  const [row] = await query<{ raised: number; targeted: number }>(GOAL_PEOPLE_TASKS, [ago(days), stamp(now), within]);
  return goalPeopleTasksMetric({ raised: row?.raised ?? 0, targeted: row?.targeted ?? 0 }, days);
}

// Gap flags code let through in the window, by trigger: the board's supply. A row rung 0 closed as it
// was raised is left out, since nobody could have worked it, so a loop never reads as supply. Its
// parts say how many each trigger raised, where they stand now, and both together: an empty board
// with agents on it is most often work finished, which `<trigger>_now_<status>` tells from work
// never raised. Zero with a trigger that can fire is what `pi-work work gaps` explains.
const GAP_SUPPLY = `
  select o.gap_trigger as trigger, e.event, count(*)::int as n
  from ledger.opportunities o
  cross join lateral (${latestRow("r.event", "opportunity", "o.id", { and: "r.at <= $2" })}) e
  where o.gap_trigger is not null and o.tainted_at is null and o.created_at >= $1 and o.created_at <= $2 and o.compartments <@ $3::text[]
    and exists (select 1 from ledger.record_events g where g.row_kind = 'opportunity' and g.row_id = o.id and g.event = 'go' and g.by = 'system:gaps')
  group by 1, 2`;

export async function gapSupplyLine(query: Query, days: number, { now, within, ago }: Clock): Promise<OutcomeMetric> {
  const rows = await query<{ trigger: string; event: string; n: number }>(GAP_SUPPLY, [ago(days), stamp(now), within]);
  const raised = rows.reduce((sum, row) => sum + row.n, 0);
  const parts: Record<string, number> = {};
  // Three families, each summing to the sample: by trigger, by where the task stands now, and by
  // both. A trigger or a status the contracts do not name is counted as `other`, never dropped.
  for (const row of rows) {
    const trigger = GapTrigger.safeParse(row.trigger).success ? row.trigger : "other";
    const event = OpportunityStatus.safeParse(row.event).success ? row.event : "other";
    for (const part of [trigger, `now_${event}`, `${trigger}_now_${event}`]) parts[part] = (parts[part] ?? 0) + row.n;
  }
  return outcomeMetric("gap_tasks_raised_per_day", {
    value: raised / days,
    sample: raised,
    window: { fromDaysAgo: days, toDaysAgo: 0 },
    parts,
  });
}

// Tasks first claimed in the window, by whether a move's `done` or `failed` report left a result. One a
// client holds is left out; one given back counts as no result until someone finishes it. One whose
// report a deletion took is left out too: it was reported, and what it said is gone.
const CLAIMED_RESULTS = `
  select count(*) filter (where exists (
      select 1 from ledger.moves m join ledger.record_events r on r.row_kind = 'move' and r.row_id = m.id and r.event = 'reported' and r.tainted_at is null
        and r.code is distinct from 'progress'
      where m.opportunity_id = o.id and exists (select 1 from ledger.record_events f where f.row_kind = 'move' and f.row_id = m.id and f.event in ('done', 'failed') and f.code is null)
    ))::int as with_result, count(*)::int as claimed
  from ledger.opportunities o
  where o.tier = 'task' and o.tainted_at is null and o.compartments <@ $3::text[]
    and (select min(c.at) from ledger.record_events c where c.row_kind = 'opportunity' and c.row_id = o.id and c.event = 'claimed') between $1 and $2
    and not exists (select 1 from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until >= $2)
    and not exists (
      select 1 from ledger.moves m join ledger.record_events r on r.row_kind = 'move' and r.row_id = m.id and r.event = 'reported'
      where m.opportunity_id = o.id and r.tainted_at is not null and r.code is distinct from 'progress')`;

export async function claimedResults(query: Query, days: number, { now, within, ago }: Clock): Promise<OutcomeMetric> {
  const [row] = await query<{ with_result: number; claimed: number }>(CLAIMED_RESULTS, [ago(days), stamp(now), within]);
  const claimed = row?.claimed ?? 0;
  const withResult = row?.with_result ?? 0;
  return outcomeMetric("tasks_claimed_no_result_per_day", {
    value: (claimed - withResult) / days,
    sample: claimed,
    window: { fromDaysAgo: days, toDaysAgo: 0 },
    parts: { with_result: withResult, no_result: claimed - withResult },
  });
}

// Of what the model proposed as a commitment, the share the bar refused, by code. A refused claim is
// sealed and holds no time of its own, so this is over all that stands since the item of the first
// refusal, and of the mail and chat lanes alone: a commitment from before the bar, or of a lane it does
// not judge, never faced it, and would only dilute the share.
const BAR_CODES: ReadonlySet<string> = new Set(["not_a_promise", "wrong_direction"]);
async function commitmentsRefused(
  query: Query,
  keys: AdminContext["keys"],
  { within }: Pick<Clock, "within">,
): Promise<OutcomeMetric> {
  const unmapped = await query<{ id: string; evidence_id: string; compartments: string[]; facts_enc: Sealed }>(
    "select id, evidence_id, compartments, facts_enc from vault.unmapped_claims where compartments <@ $1::text[]",
    [within],
  );
  const parts: Record<string, number> = { not_a_promise: 0, wrong_direction: 0 };
  const items: string[] = [];
  for (const row of unmapped) {
    const { reason, proposedType } = JSON.parse(open(keys, row, "vault.unmapped_claims.facts_enc", "throw")) as {
      reason: string;
      proposedType: string;
    };
    if (proposedType === "commitment" && BAR_CODES.has(reason)) {
      parts[reason] = (parts[reason] ?? 0) + 1;
      items.push(row.evidence_id);
    }
  }
  const [kept] = await query<{ n: number }>(
    `select count(*)::int as n from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
     where c.type = 'commitment' and not c.closes and c.compartments <@ $1::text[]
       and (e.source_kind = 'email'
            or exists (select 1 from knowledge.captures k where k.evidence_id = e.id and k.kind = 'moment'))
       and e.ingested_at >= (select min(f.ingested_at) from vault.evidence_items f where f.id = any ($2::text[]))`,
    [within, items],
  );
  const refused = (parts.not_a_promise ?? 0) + (parts.wrong_direction ?? 0);
  const sample = refused + (kept?.n ?? 0);
  return outcomeMetric("commitments_refused_share", { value: shareOf(refused, sample), sample, window: null, parts });
}

// How the commitments that ended in the window ended, by the owner's own read, which every close
// and every lapse reaches, within what this report counts.
async function commitmentsDone(
  admin: AdminContext,
  days: number,
  zone: string | null,
  { now, within }: Pick<Clock, "now" | "within">,
): Promise<OutcomeMetric[]> {
  const window = { fromDaysAgo: days, toDaysAgo: 0 };
  let items: Awaited<ReturnType<typeof ownerCommitments>>["commitments"];
  try {
    items = (await ownerCommitments(admin, { state: "closed" }, { whole: true, within })).commitments;
  } catch (error) {
    if (error instanceof AdminError && error.code === "rebuilding")
      return (["commitments_done_share", "commitments_released_share"] as const).map((metric) =>
        outcomeMetric(metric, { value: null, sample: 0, window, code: "rebuilding" }),
      );
    throw error;
  }
  const ends = commitmentEnds(
    items.map((one) => one.item),
    { from: dayIn(new Date(now.getTime() - days * DAY_MS), zone), to: dayIn(now, zone) },
    zone,
  );
  const shares = commitmentsEndedShares(ends, window);
  return [shares.done, shares.released];
}

// The share of observed minutes a project was credited. The box stores no minutes: they are cut at
// each read, so this is the week's own read, which already leaves a restricted compartment out.
export function creditedShare(week: Pick<TimeWeek, "byProject" | "unattributed">): OutcomeMetric {
  const credited = week.byProject.reduce((sum, one) => sum + one.minutes, 0);
  const observed = credited + week.unattributed;
  return outcomeMetric("credited_share", {
    value: shareOf(credited, observed),
    sample: Math.round(observed),
    window: { fromDaysAgo: CREDITED_DAYS, toDaysAgo: 0 },
  });
}

// A stretch the owner said no to on a card is lifted by the card's answer, and was never credited, so it is
// no proposal; one with a veto is.
const TIME_PROPOSALS = `
  select count(distinct r.proposal_id) filter (where r.pending_card is null and (r.lift_ruling_id is null or d.kind = 'time_veto'))::int as proposed,
    count(distinct r.proposal_id) filter (where d.kind = 'time_veto')::int as vetoed,
    count(distinct r.proposal_id) filter (where r.pending_card is not null
      and (${latestEvent("card", "r.pending_card", "e")}) in ('pending', 'deferred'))::int as held
  from knowledge.time_rulings r left join knowledge.owner_decisions d on d.id = r.lift_ruling_id
  where r.source = 'system' and r.created_at >= $1 and r.created_at <= $2 and r.compartments <@ $3::text[]`;

async function timeProposals(query: Query, days: number, { now, within, ago }: Clock): Promise<TimeProposalCounts> {
  const [row] = await query<TimeProposalCounts>(TIME_PROPOSALS, [ago(days), stamp(now), within]);
  return { proposed: row?.proposed ?? 0, vetoed: row?.vetoed ?? 0, held: row?.held ?? 0 };
}

async function tableUsage(query: Query, days: number, { now, within, ago }: Clock): Promise<TableUsage[]> {
  const usage: TableUsage[] = [];
  for (const [table, column] of USAGE_TABLES) {
    const [row] = await query<{ rows: number; last: Date | null }>(
      `select count(*) filter (where ${column} >= $1)::int as rows, max(${column}) as last
       from ${table} where ${column} <= $2 and compartments <@ $3::text[]`,
      [ago(days), stamp(now), within],
    );
    usage.push({
      table,
      rows: row?.rows ?? 0,
      lastWrittenAt: row?.last === null || row?.last === undefined ? null : stamp(row.last),
      state: usageStateOf(row?.rows ?? 0),
    });
  }
  return usage;
}

// Of what models proposed from items that came in within `--days`, the share the checks refused.
function refusedShare({ weeks }: RefusalsView, days: number): OutcomeMetric {
  const refused = weeks.reduce((sum, week) => sum + week.refused, 0);
  const sample = refused + weeks.reduce((sum, week) => sum + week.claims, 0);
  return outcomeMetric("candidates_refused", {
    value: shareOf(refused, sample),
    sample,
    window: { fromDaysAgo: days, toDaysAgo: 0 },
  });
}

// How much of what the Self room shows can lead it: a count over its rows, their words read by none.
// A review that cannot be read costs this metric alone, and says so.
async function selfRowsLeading(admin: AdminContext): Promise<OutcomeMetric> {
  try {
    const rows = (await selfReview(admin)).filter((row) => row.notice === null);
    return outcomeMetric("self_rows_leading", {
      value: shareOf(rows.filter((row) => row.use < SELF_LOW_USE).length, rows.length),
      sample: rows.length,
      window: null,
    });
  } catch {
    return outcomeMetric("self_rows_leading", { value: null, sample: 0, window: null, code: "review_unreadable" });
  }
}

// What a metric reads from: the report's snapshot (its statements and keys), the window and its
// clock, the owner's zone, and the reads other parts of the report share.
type At = { query: Query; keys: AdminContext["keys"]; days: number; clock: Clock; zone: string | null; shared: Shared };
type Shared = Awaited<ReturnType<typeof sharedReads>>;
type Read = OutcomeMetric | OutcomeMetric[];

// The reads the headline and the report's other parts take as well as a metric.
const sharedReads = async (query: Query, keys: AdminContext["keys"], days: number, clock: Clock) => ({
  seam: await seamSignals(query, days, { since: clock.ago(days), until: stamp(clock.now), within: clock.within }),
  refusals: await refusals(query, keys, { within: clock.within, since: clock.ago(days) }),
  questions: await ownerQuestions(query, clock.ago(days), stamp(clock.now), clock.within),
  goal: await goalMeasures(query, clock.ago(days), stamp(clock.now), clock.within),
  time: await timeProposals(query, days, clock),
  value: await taskValue(query, clock.ago(GAP_VALUE_WINDOW_DAYS), stamp(clock.now), clock.within),
  tests: await outcomeTestsRead(query, clock.now),
});

// Every metric of the report, in the order it is served: one entry each. `in: "snapshot"` reads in
// the report's one snapshot; `in: "own"` reads through the admin, in transactions of its own.
const METRICS: readonly (
  | { in: "snapshot"; read: (at: At) => Read | Promise<Read> }
  | { in: "own"; read: (admin: AdminContext, at: At) => Promise<Read> }
)[] = [
  { in: "snapshot", read: ({ shared }) => shared.seam.metrics },
  { in: "snapshot", read: ({ shared, days }) => refusedShare(shared.refusals, days) },
  { in: "snapshot", read: ({ query, keys, clock }) => claimMetrics({ query, keys }, clock) },
  { in: "snapshot", read: ({ query, keys, days, clock }) => ownLinesYield(query, keys, days, clock) },
  {
    in: "own",
    read: async (admin, { clock, zone }) =>
      creditedShare(await timeWeek(admin, dayAfter(dayIn(clock.now, zone), 1 - CREDITED_DAYS))),
  },
  {
    in: "snapshot",
    read: ({ shared, days }) =>
      outcomeMetric(
        "time_proposal_veto_rate",
        shareRead({ sample: shared.time.proposed, hits: shared.time.vetoed }, { fromDaysAgo: days, toDaysAgo: 0 }),
      ),
  },
  { in: "snapshot", read: ({ query, clock }) => readBack(query, clock) },
  { in: "snapshot", read: ({ query, days, clock }) => projectMail(query, days, clock) },
  { in: "snapshot", read: ({ query, days, clock }) => projectChat(query, days, clock) },
  { in: "snapshot", read: ({ query, days, clock }) => doneWork(query, days, clock) },
  { in: "snapshot", read: ({ query, days, clock }) => reasked(query, days, clock) },
  { in: "snapshot", read: ({ shared }) => shared.questions },
  { in: "snapshot", read: ({ shared }) => shared.goal.ownerActions },
  { in: "snapshot", read: ({ shared }) => shared.goal.defectsWithoutOwner },
  { in: "own", read: (admin, { days, zone, clock }) => commitmentsDone(admin, days, zone, clock) },
  { in: "snapshot", read: ({ query, keys, clock }) => commitmentsRefused(query, keys, clock) },
  { in: "snapshot", read: ({ query, keys, clock }) => topPeople(query, keys, clock) },
  { in: "snapshot", read: ({ query, keys, clock }) => warmthReach(query, keys, clock) },
  { in: "own", read: (admin) => selfRowsLeading(admin) },
  { in: "own", read: (admin) => goalTargetPaths(admin) },
  { in: "own", read: (admin, { days, clock }) => openItemMetrics(admin, days, clock) },
  { in: "snapshot", read: ({ query, days, clock }) => goalPeopleTasks(query, days, clock) },
  { in: "snapshot", read: ({ query, days, clock }) => codeNoGos(query, days, clock) },
  { in: "snapshot", read: ({ query, days, clock }) => gapSupplyLine(query, days, clock) },
  { in: "snapshot", read: ({ query, days, clock }) => claimedResults(query, days, clock) },
  { in: "snapshot", read: async ({ query, clock }) => (await unattendedRoles(query, clock)).metric },
  { in: "snapshot", read: ({ query, keys }) => firstNameMerges(query, keys) },
  { in: "snapshot", read: ({ query, days, clock }) => mergeAudits(query, days, clock) },
  { in: "snapshot", read: ({ shared }) => shared.tests.metric },
  { in: "snapshot", read: ({ query, clock }) => backupAge(query, clock) },
  { in: "snapshot", read: ({ query, clock }) => restoreAge(query, clock) },
  { in: "snapshot", read: ({ query, days, clock }) => healthTold(query, days, clock) },
  { in: "snapshot", read: ({ shared }) => taskUsedShare(shared.value) },
];

export async function outcomes(admin: AdminContext, days: number): Promise<OutcomesView> {
  if (!Number.isInteger(days) || days < OUTCOME_DAYS.min || days > OUTCOME_DAYS.max)
    throw new AdminError("invalid_argument");
  const now = admin.now();
  const clock: Clock = {
    now,
    within: unrestrictedOf(admin.keys),
    ago: (back) => stamp(new Date(now.getTime() - back * DAY_MS)),
  };
  // One snapshot, so each number is of the same moment. A metric read through the admin takes its own.
  const read = await admin.transaction(async (query) => {
    await query(REPEATABLE);
    const at: At = {
      query,
      keys: admin.keys,
      days,
      clock,
      zone: await ownerZoneOf(query),
      shared: await sharedReads(query, admin.keys, days, clock),
    };
    const metrics: (Read | undefined)[] = [];
    for (const metric of METRICS) metrics.push(metric.in === "snapshot" ? await metric.read(at) : undefined);
    return {
      at,
      metrics,
      funnel: await taskFunnel(query, clock.ago(days), stamp(now), clock.within),
      tools: await toolUsage(query, days, clock),
      refusedFields: await refusedFields(query, days, clock),
      tables: await tableUsage(query, days, clock),
      vendorRetries: await extractionRetries(query, clock.within),
      canary: await canaryLatest(query),
      recall: await recallReport(query, clock.within),
      runs: await runsReliability(query, { since: clock.ago(days), until: stamp(now), within: clock.within }),
    };
  });
  const metrics: OutcomeMetric[] = [];
  for (const [index, metric] of METRICS.entries()) {
    const value = metric.in === "own" ? await metric.read(admin, read.at) : read.metrics[index];
    if (value !== undefined) metrics.push(...[value].flat());
  }
  const { shared } = read.at;
  const meter = await backtestMeter(admin, days, clock.within);
  return {
    days,
    at: stamp(now),
    headline: {
      hadWhatItNeeded: shared.tests.metric,
      signals: shared.seam,
      goal: goalLine(shared.goal, shared.questions),
    },
    meter: { ...meter, cost: { raised: read.funnel.raised, claimed: read.funnel.claimed, done: read.funnel.done } },
    recall: read.recall,
    metrics,
    timeProposals: shared.time,
    funnel: read.funnel,
    value: shared.value,
    usage: { tools: read.tools, tables: read.tables, refusedFields: read.refusedFields },
    refusals: shared.refusals,
    extraction: { vendorRetries: read.vendorRetries },
    runs: read.runs,
    canary: read.canary,
    outcomeTests: shared.tests.shown,
  };
}
