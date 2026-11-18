import {
  type CardAuthor,
  type CardId,
  type ClientId,
  type HypothesisId,
  type IntentId,
  type IntentionId,
  type IntentMode,
  type MoveId,
  OPEN_STATUSES,
  type OpportunityId,
  type OpportunityKind,
  type OpportunityStatus,
  type PersonalWakeSource,
  type RulingId,
  type RunId,
  type WakeFacts,
  type WorkRef,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { autonomyWindows } from "@intelligence/personal-core/planner";
import { lessonsToAsk } from "../cards/asked-less.ts";
import type { Query } from "../core/db.ts";
import { erasureLevel } from "../core/journal.ts";
import type { Fixed } from "../core/sql.ts";
import {
  CARD_STATE,
  KILL_SWITCH_STATE,
  latestEvent,
  latestRow,
  moveStatus,
  WAKE_CARD_COUNTS,
} from "../core/statements.ts";

// An opportunity not done this long after its `go`, or after it was handed to the owner, expires.
// For work that is `go` or `claimed` the days run from the latest of its `go`, its latest progress
// report and its latest check-back's due time, so work parked or progressed is not expired while
// its holder still means to return to it.
export const OPEN_EXPIRY_DAYS = 14;

// Whether a move, by its id, had a progress report in the 24 hours before a time: its holder is
// still at work on it.
export const recentProgress = (move: string, at: string): string =>
  `exists (select 1 from ledger.record_events p where p.row_kind = 'move' and p.row_id = ${move} and p.event = 'reported'
           and p.code = 'progress' and p.at > ${at}::timestamptz - interval '24 hours')`;

// The furthest ahead a check-back counts: ledger.set_intention takes no time further ahead than
// this, and the open expiry counts a check-back's due time no later than this long after the go,
// so no check-back, and no run of them rolled forward, keeps work open for good.
const CHECK_BACK_MAX_DAYS = 90;

// When the open-expiry days of work that is `go` or `claimed` start, for an opportunity by its
// id: the latest of its go decision, a progress report on one of its moves, and the due time of a
// check-back on it that was not cancelled (a park is one), counted no later than
// CHECK_BACK_MAX_DAYS after the go. Null with no go decision.
export const openSince = (opportunity: string): string =>
  `(select case when g.at is null then null else greatest(
       g.at,
       (select max(p.at) from ledger.moves m join ledger.record_events p on p.row_kind = 'move' and p.row_id = m.id
        where m.opportunity_id = ${opportunity} and p.event = 'reported' and p.code = 'progress'),
       (select case when max(i.due_at) is null then null
                    else least(max(i.due_at), g.at + interval '${CHECK_BACK_MAX_DAYS} days') end
        from ledger.intentions i
        where i.opportunity_id = ${opportunity} and i.kind = 'check_back'
          and (${latestEvent("intention", "i.id")}) is distinct from 'cancelled')) end
    from (select max(d.created_at) as at from ledger.opportunity_decisions d
          where d.opportunity_id = ${opportunity} and d.decision = 'go') g)`;

// The dispatcher's reads, as pi_work: ids, kinds, times, counts, booleans and opaque fingerprints,
// and never a sealed column. The fact shapes are the ladder's (`@intelligence/personal-ladder`,
// src/facts.ts), written out here because the store does not import the ladder; the tick hands them
// over as they are.

// The latest status event of a row, as a scalar subquery on the row aliased `x`.
const status = <K extends string>(rowKind: Fixed<K>, alias: "x" | "o" | "h" | "i" = "x"): string =>
  `(${latestEvent(rowKind, `${alias}.id` as `${typeof alias}.id`)})`;
const OPEN = `array[${OPEN_STATUSES.map((one) => `'${one}'`).join(", ")}]`;
export const UNDECIDED = `${CARD_STATE} in ('pending', 'deferred')`;

// The refs a veto is asked about for an opportunity aliased `o`: what it is about, unless that is
// the owner, and every ref of its basis.
const ABOUT_AND_BASIS = (part: "kind" | "id"): string =>
  `(case when o.about_kind = 'owner' then '{}'::text[] else array[o.about_${part}] end)
     || array(select b.ref_${part} from ledger.basis b where b.row_kind = 'opportunity' and b.row_id = o.id order by b.id)`;
export const OPPORTUNITY_VETO = `policy.vetoed_by(${ABOUT_AND_BASIS("kind")}, ${ABOUT_AND_BASIS("id")}, o.kind)`;

type WorkSettings = {
  maxRunsPerDay: number;
  maxMicroUsdPerDay: number;
  maxPendingCards: number;
  // `sweep_hour_utc`: the owner's local hour once their zone is set, UTC's until then.
  sweepHour: number;
  calendarLeadHours: number;
};

type Reasoner = { id: ClientId; compartments: string[] } | null;

type BasisFactRead = {
  refKind: WorkRef["kind"];
  sourceClass: "source" | "derived" | "owner" | "agent" | "system";
  ownerBacked: boolean;
  flagged: boolean;
  tainted: boolean;
  threadFp: string | null;
  isAbout: boolean;
};

type CaseClosed = { by: "owner" | "expiry"; daysSince: number; newSourceRef: boolean } | null;

type OpportunityFactsRead = {
  kind: OpportunityKind;
  vetoed: boolean;
  cardPending: boolean;
  caseEverCarded: boolean;
  proposedByClass: "run" | "client" | "system";
  bet: boolean;
  aboutOwner: boolean;
  restsOnOwnerHypothesis: boolean;
  caseClosed: CaseClosed;
  intents: { id: IntentId; mode: IntentMode; open: number; maxOpen: number; activeClients: number }[];
  basis: BasisFactRead[];
};

// An opportunity to decide, with what the tick needs to write about it.
export type ToDecide = { id: OpportunityId; status: "proposed" | "later"; facts: OpportunityFactsRead };

export type OwnerHypothesis = { id: HypothesisId; caseClosed: CaseClosed };

export type Expired =
  | { kind: "run_erasure"; run: RunId }
  | { kind: "run_lease"; run: RunId }
  | { kind: "opportunity_lease"; opportunity: OpportunityId }
  | { kind: "card"; card: CardId }
  // A card deferred past `ontology/autonomy.json`'s deferredCardDays, expired by the policy
  // (`system:card_expiry`), never by the owner.
  | { kind: "deferred_card"; card: CardId }
  | { kind: "opportunity"; opportunity: OpportunityId }
  // A move cleared and never reported whose planner no longer holds a live lease on its
  // opportunity, closed failed (`system:work`, code `abandoned`, as abandonMoves writes).
  | { kind: "move_unreported"; move: MoveId };

// A move whose latest event is `cleared` (an agent planned it, it was cleared, and it reported
// nothing), on an internal stage, whose planner holds no lease on its opportunity that is live at
// $1: lapsed, released, or taken by another client. An owner_question's move is finished by
// answer_owner_question and never reported, so it is never one; and `one` narrows the read to a
// single move ($2), as the tick's write checks it again. A move with a progress report in the 24
// hours before $1 is none while the lease row is still its planner's (lapsed, and kept for the
// planner's 24 hours): once the planner released the work or another client took it, it is.
export const unreportedMoves = (one: boolean): string => `
  select m.id, m.compartments from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id
  where m.stage in ('investigate', 'prepare') and m.created_by like 'client:%' and o.kind <> 'owner_question'${one ? " and m.id = $2" : ""}
    and (${moveStatus()}) = 'cleared'
    and not exists (select 1 from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = m.opportunity_id
                    and 'client:' || l.holder = m.created_by and l.lease_until >= $1)
    and not (${recentProgress("m.id", "$1")}
             and exists (select 1 from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = m.opportunity_id
                         and 'client:' || l.holder = m.created_by))
  order by m.id collate "C"`;

export type DueIntention = {
  id: IntentionId;
  kind: "remind" | "check_back";
  opportunity: OpportunityId | null;
  client: ClientId | null;
  opportunityStatus: OpportunityStatus | null;
  // The client whose lease row the opportunity has, live or lapsed; null with none.
  holder: ClientId | null;
};

// Who caused a row, as a card's author (`CardAuthor` in the contracts): `reasoner` for a row a run wrote,
// `client:<id>` for a client's, and `system:work` for anything else.
export const authorOf = (createdBy: string): CardAuthor =>
  createdBy.startsWith("run:") ? "reasoner" : createdBy.startsWith("client:") ? createdBy : "system:work";

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);
export const erasureLevelOf = (query: Query, journal: string): Promise<"level" | "behind"> =>
  erasureLevel(query, journal, { mustExist: true });

export async function killSwitchOf(query: Query): Promise<boolean> {
  const [row] = await query<{ state: string }>(KILL_SWITCH_STATE);
  return row?.state === "on";
}

export async function settingsOf(query: Query): Promise<WorkSettings> {
  const [row] = await query<{
    runs: number;
    usd: string;
    cards: number;
    sweep: number;
    lead: number;
  }>(
    `select max_runs_per_day as runs, max_microusd_per_day::text as usd, max_pending_cards as cards,
       sweep_hour_utc as sweep, calendar_lead_hours as lead from policy.work_settings`,
  );
  if (row === undefined) throw new Error("policy.work_settings has no row");
  return {
    maxRunsPerDay: row.runs,
    maxMicroUsdPerDay: Number(row.usd),
    maxPendingCards: row.cards,
    sweepHour: row.sweep,
    calendarLeadHours: row.lead,
  };
}

export async function reasonerOf(query: Query): Promise<Reasoner> {
  const [row] = await query<{ id: ClientId; compartments: string[] }>(
    "select id, compartments from policy.clients where kind = 'reasoner' and status = 'active'",
  );
  return row ?? null;
}

// The ladder's WakeFacts for one wake. Both counts of line 4 are taken over cards of the reasoner's
// own author or within its compartments.
export async function wakeFacts(
  query: Query,
  source: PersonalWakeSource,
  anchorVetoed: boolean,
  now: Date,
): Promise<WakeFacts> {
  const settings = await settingsOf(query);
  const reasoner = await reasonerOf(query);
  const day = utcDay(now);
  const [row] = await query<{ deferred: number; pending: number; runs: number; spent: string }>(
    `select
       ${WAKE_CARD_COUNTS},
       (select count(*)::int from ledger.runs r where r.created_at >= ($2::date)::timestamp at time zone 'UTC' and r.created_at < ($2::date + 1)::timestamp at time zone 'UTC'
          -- A trial is not counted against the day's runs, nor a predict run of the shadow
          -- predictions, now removed.
          and r.wake_source <> 'predict_due' and r.trial_model is null) as runs,
       ledger.spend_on($2::date)::text as spent`,
    [reasoner?.compartments ?? [], day],
  );
  return {
    source,
    killSwitch: await killSwitchOf(query),
    anchorVetoed,
    reasonerRegistered: reasoner !== null,
    reasonerDeferredCards: row?.deferred ?? 0,
    pendingCardsInClearance: reasoner === null ? 0 : (row?.pending ?? 0),
    maxPendingCards: settings.maxPendingCards,
    runsToday: row?.runs ?? 0,
    maxRunsPerDay: settings.maxRunsPerDay,
    spentTodayMicroUsd: Number(row?.spent ?? 0),
    maxMicroUsdPerDay: settings.maxMicroUsdPerDay,
  };
}

// The latest closing of a hypothesis's case: the latest of the owner's answers on it and its cards'
// expiries, which closes it when it is a no (`reject`) or an expiry. `newSourceRef` asks whether
// the row's basis holds a `source` ref none of the case's other rows cites. An opportunity's is
// ledger.opportunity_facts'.
async function caseClosedOf(query: Query, row: { id: string; caseId: string }, now: Date): Promise<CaseClosed> {
  const [latest] = await query<{ at: Date; closes: boolean; by: "owner" | "expiry" }>(
    `select closings.at, closings.closes, closings.by from (
       select d.decided_at as at, d.answer = 'reject' as closes, 'owner' as by
       from knowledge.owner_decisions d join ledger.cards c on c.id = d.card_id
       where d.kind = 'answer' and c.case_key = $1
       union all
       select r.at, true, 'expiry' from ledger.cards c
       join lateral (${latestRow("e.event, e.at", "card", "c.id", { alias: "e" })}) r on true
       where c.case_key = $1 and r.event = 'expired'
     ) closings order by at desc limit 1`,
    [row.caseId],
  );
  if (latest === undefined || !latest.closes) return null;
  const [news] = await query<{ news: boolean }>(
    `select exists (
       select 1 from ledger.basis b
       where b.row_kind = 'hypothesis' and b.row_id = $1 and b.source_class = 'source'
         and not exists (
           select 1 from ledger.basis b2 join ledger.hypotheses other on other.id = b2.row_id
           where b2.row_kind = 'hypothesis' and other.case_id = $2 and other.id <> $1 and b2.ref_kind = b.ref_kind and b2.ref_id = b.ref_id)) as news`,
    [row.id, row.caseId],
  );
  return {
    by: latest.by,
    daysSince: (now.getTime() - latest.at.getTime()) / DAY_MS,
    newSourceRef: news?.news === true,
  };
}

// The opportunities that may be the tick's to decide, `proposed` or `later`, by id; $1 narrows to one.
const PROPOSED_OR_LATER = `
  select o.id from ledger.opportunities o
  where o.tainted_at is null and ${status("opportunity", "o")} in ('proposed', 'later') and ($1::text is null or o.id = $1)
  order by o.id collate "C"`;

// The ladder's OpportunityFacts for each opportunity the tick is to decide: `proposed` with no
// undecided card on its case, or `later` with its check-back time come.
export async function proposedOpportunities(query: Query, now: Date, only: string | null = null): Promise<ToDecide[]> {
  const found: ToDecide[] = [];
  for (const { id } of await query<{ id: OpportunityId }>(PROPOSED_OR_LATER, [only])) {
    const one = await opportunityFacts(query, id, now);
    if (one !== null) found.push(one);
  }
  return found;
}

type OpportunityFactsRow = {
  id: OpportunityId;
  status: "proposed" | "later";
  kind: OpportunityKind;
  proposed_by_class: "run" | "client" | "system";
  bet: boolean;
  about_owner: boolean;
  owner_hypothesis: boolean;
  vetoed: boolean;
  card_pending: boolean;
  ever_carded: boolean;
  closed_by: "owner" | "expiry" | null;
  closed_at: Date | null;
  new_source_ref: boolean | null;
  intents: OpportunityFactsRead["intents"];
  basis: BasisFactRead[];
};

// One opportunity's facts, read by ledger.opportunity_facts (the tick's role and the pipeline's
// alike), or null when it is not to be decided now. Carded once, always carded, for every case
// of the same kind about the same thing, whatever hypothesis it rests on, so a new idea's work on
// what the owner was asked about reaches them as a card: never auto-declined, never auto-go.
export async function opportunityFacts(query: Query, id: string, now: Date): Promise<ToDecide | null> {
  const [row] = await query<OpportunityFactsRow>(
    `select id, status, kind, proposed_by_class, bet, about_owner, owner_hypothesis, vetoed, card_pending, ever_carded,
       closed_by, closed_at, new_source_ref, intents, basis
     from ledger.opportunity_facts($1, $2::timestamptz)`,
    [id, now.toISOString()],
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    status: row.status,
    facts: {
      kind: row.kind,
      vetoed: row.vetoed,
      cardPending: row.card_pending,
      caseEverCarded: row.ever_carded,
      proposedByClass: row.proposed_by_class,
      bet: row.bet,
      aboutOwner: row.about_owner,
      restsOnOwnerHypothesis: row.owner_hypothesis,
      caseClosed:
        row.closed_by === null || row.closed_at === null
          ? null
          : {
              by: row.closed_by,
              daysSince: (now.getTime() - row.closed_at.getTime()) / DAY_MS,
              newSourceRef: row.new_source_ref === true,
            },
      intents: row.intents,
      basis: row.basis,
    },
  };
}

// Every open opportunity a veto covers, with the ruling id of the oldest covering veto.
export async function vetoedOpen(query: Query): Promise<{ id: OpportunityId; ruling: RulingId }[]> {
  return query<{ id: OpportunityId; ruling: RulingId }>(
    `select x.id, x.ruling from (
       select o.id, ${status("opportunity", "o")} as status, ${OPPORTUNITY_VETO} as ruling from ledger.opportunities o where o.tainted_at is null
     ) x where x.status = any (${OPEN}) and x.ruling is not null order by x.id collate "C"`,
  );
}

// A hypothesis about the owner that is open and has no card about it, with its case's closing. A
// planning lesson is about the owner too, and has its own card.
export async function ownerHypothesesWithoutCard(query: Query, now: Date): Promise<OwnerHypothesis[]> {
  const rows = await query<{ id: HypothesisId; case_id: string }>(
    `select h.id, h.case_id from ledger.hypotheses h
     where h.about_owner and h.kind <> 'lesson' and h.tainted_at is null and ${status("hypothesis", "h")} in ('open', 'supported')
       and not exists (select 1 from ledger.cards c where c.target_kind = 'hypothesis' and c.target_id = h.id)
     order by h.id collate "C"`,
  );
  const found: OwnerHypothesis[] = [];
  for (const row of rows)
    found.push({
      id: row.id,
      caseClosed: await caseClosedOf(query, { id: row.id, caseId: row.case_id }, now),
    });
  return found;
}

// The planner's ideas and lessons that are open and have no card, and are due one: every idea a run
// wrote, oldest first, then every lesson, the most supported by the owner's decisions first, with no
// weekly limit. A lesson whose basis a veto covers is read as `vetoed` and left out: raisePlannerCard
// raises nothing on it.
export async function plannerHypothesesWithoutCard(
  query: Query,
): Promise<{ id: HypothesisId; kind: "idea" | "lesson" }[]> {
  const rows = await query<{
    id: HypothesisId;
    kind: "idea" | "lesson";
    created_at: Date;
    support: number;
    vetoed: boolean;
  }>(
    `select h.id, h.kind, h.created_at,
       (select count(distinct b.ref_id)::int from ledger.basis b
        where b.row_kind = 'hypothesis' and b.row_id = h.id and b.ref_kind = 'decision' and b.tainted_at is null) as support,
       h.kind = 'lesson' and policy.vetoed(
         array(select b.ref_kind from ledger.basis b where b.row_kind = 'hypothesis' and b.row_id = h.id order by b.id),
         array(select b.ref_id from ledger.basis b where b.row_kind = 'hypothesis' and b.row_id = h.id order by b.id), null) as vetoed
     from ledger.hypotheses h
     where h.kind in ('idea', 'lesson') and h.tainted_at is null and ${status("hypothesis", "h")} = 'open'
       -- An idea an agent filed is for the owner's ledger alone, never a card.
       and starts_with(h.created_by, 'run:')
       and not exists (select 1 from ledger.cards c where c.target_kind = 'hypothesis' and c.target_id = h.id)
     order by h.created_at, h.id collate "C"`,
  );
  const asked = lessonsToAsk(
    rows
      .filter((row) => row.kind === "lesson")
      .map((row) => ({ id: row.id, support: row.support, createdAt: new Date(row.created_at), vetoed: row.vetoed })),
  );
  return [
    ...rows.filter((row) => row.kind === "idea").map((row) => ({ id: row.id, kind: row.kind })),
    ...asked.map((one) => ({ id: one.id, kind: "lesson" as const })),
  ];
}

// How many times an outcome card on handed work is raised again after one ended unanswered
// (expired or withdrawn).
export const OUTCOME_RERAISES = 2;
// An outcome card on handed work that is live: pending or deferred. One that ended unanswered no
// longer counts, so the work is offered its Done and Drop again.
const LIVE_OUTCOME = `exists (select 1 from ledger.cards c where c.kind = 'outcome' and c.target_kind = 'opportunity' and c.target_id = o.id and ${UNDECIDED})`;
// The outcome cards on handed work that ended unanswered, on an opportunity aliased `o`.
export const ENDED_OUTCOMES = `(select count(*)::int from ledger.cards c where c.kind = 'outcome' and c.target_kind = 'opportunity' and c.target_id = o.id
       and ${CARD_STATE} in ('expired', 'withdrawn'))`;

// The opportunities handed to the owner with no live outcome card: none raised yet, or the last one
// expired or was withdrawn unanswered, at most OUTCOME_RERAISES times.
export async function handedWithoutCard(query: Query): Promise<OpportunityId[]> {
  const rows = await query<{ id: OpportunityId }>(
    `select o.id from ledger.opportunities o
     where o.tainted_at is null and o.tier = 'opportunity' and ${status("opportunity", "o")} = 'handed_to_owner'
       and not ${LIVE_OUTCOME} and ${ENDED_OUTCOMES} <= ${OUTCOME_RERAISES}
     order by o.id collate "C"`,
  );
  return rows.map((row) => row.id);
}

// The moves whose report carries a summary, with no outcome card, on an opportunity that is not
// handed to the owner. A task's report raises none, nor does work an agent approved with a bet: each is
// in the owner's Results feed (admin-results.ts). A
// `reported` event is written only with a summary (`ledger.report_move`) and a taint sets its
// `tainted_at`, so no sealed column is asked about.
export async function reportsWithoutCard(query: Query): Promise<MoveId[]> {
  const rows = await query<{ id: MoveId }>(
    `select distinct m.id from ledger.moves m
     join ledger.opportunities o on o.id = m.opportunity_id
     join ledger.record_events r on r.row_kind = 'move' and r.row_id = m.id and r.event = 'reported' and r.tainted_at is null
       and r.code is distinct from 'progress'
     where m.tainted_at is null and o.tier = 'opportunity' and o.bet_at is null
       and ${status("opportunity", "o")} is distinct from 'handed_to_owner'
       and not exists (select 1 from ledger.cards c where c.kind = 'outcome' and c.target_kind = 'move' and c.target_id = m.id)
     order by m.id`,
  );
  return rows.map((row) => row.id);
}

// The outcome cards still waiting on a task's move, raised before results became a feed: pending
// or held back by the card cap. The tick withdraws them, quietly; the feed shows each task's
// result.
export async function taskResultCards(query: Query): Promise<{ id: CardId; author: CardAuthor }[]> {
  return query<{ id: CardId; author: CardAuthor }>(
    `select c.id, c.created_by as author from ledger.cards c
     join ledger.moves m on c.target_kind = 'move' and m.id = c.target_id
     join ledger.opportunities o on o.id = m.opportunity_id
     where c.kind = 'outcome' and o.tier = 'task' and ${CARD_STATE} in ('pending', 'deferred')
     order by c.id`,
  );
}

// A finished task's last report, on a move aliased `m` of an opportunity aliased `o`: the task
// closed `done` or (a failed report) `withdrawn` with the code `failed`, the move's own outcome
// was `done` or `failed`, and no later move of the task reported. A blocked task went back to
// the board, unfinished, and an owner's withdrawal reported nothing.
export const FINISHED_TASK_REPORT = `${status("opportunity", "o")} in ('done', 'withdrawn')
         and (${moveStatus("m.id", "e")}) in ('done', 'failed')
         and not exists (select 1 from ledger.moves n join ledger.record_events f on f.row_kind = 'move' and f.row_id = n.id and f.event = 'reported'
                           and f.code is distinct from 'progress'
                         where n.opportunity_id = o.id and n.id <> m.id
                           and f.id > (select max(g.id) from ledger.record_events g where g.row_kind = 'move' and g.row_id = m.id and g.event = 'reported'))`;

// The leases, cards, opportunities and runs past their time (the tick's third step).
export async function expired(query: Query, now: Date): Promise<Expired[]> {
  const found: Expired[] = [];
  const runs = await query<{ id: RunId }>(
    `select x.id from ledger.runs x
     where ${status("run")} = 'running'
       and (select a.erasure_mark from ledger.run_attempts a where a.run_id = x.id order by a.attempt desc limit 1) <> policy.erasure_mark()
     order by x.id collate "C"`,
  );
  for (const run of runs) found.push({ kind: "run_erasure", run: run.id });
  const erased = new Set(runs.map((run) => run.id));

  const leases = await query<{ kind: "run" | "opportunity"; id: string; status: string | null }>(
    `select l.resource_kind as kind, l.resource_id as id,
       case l.resource_kind
         when 'run' then (${latestEvent("run", "l.resource_id")})
         else (${latestEvent("opportunity", "l.resource_id")}) end as status
     from queue.leases l where l.lease_until < $1 order by l.resource_kind, l.resource_id collate "C"`,
    [now],
  );
  for (const lease of leases) {
    if (lease.kind === "run" && lease.status === "running" && !erased.has(lease.id as RunId))
      found.push({ kind: "run_lease", run: lease.id as RunId });
    if (lease.kind === "opportunity" && lease.status === "claimed")
      found.push({ kind: "opportunity_lease", opportunity: lease.id as OpportunityId });
  }

  // The candidates: cardExpiry decides for each after its lock.
  const cards = await query<{ id: CardId }>(
    `select x.id from (
       select c.id, c.expires_at, c.expires_after_days, r.event, r.at
       from ledger.cards c
       join lateral (${latestRow("e.event, e.at", "card", "c.id", { alias: "e" })}) r on true
     ) x
     where (x.event in ('pending', 'deferred') and x.expires_at <= $1)
        or (x.event = 'pending' and x.expires_after_days is not null and x.at + make_interval(days => x.expires_after_days) <= $1)
     order by x.id collate "C"`,
    [now],
  );
  for (const card of cards) found.push({ kind: "card", card: card.id });

  // A card deferred since the window's start or before, and not tainted. Its age is its latest
  // event's, its `deferred`, so a card the owner reopened waits its days again. A pending card is
  // never one.
  const deferred = await query<{ id: CardId }>(
    `select c.id from ledger.cards c
     join lateral (${latestRow("e.event, e.at", "card", "c.id", { alias: "e" })}) r on true
     where r.event = 'deferred' and r.at <= $1 and c.tainted_at is null
     order by c.id collate "C"`,
    [autonomyWindows(now).deferredBefore],
  );
  for (const card of deferred) found.push({ kind: "deferred_card", card: card.id });

  const opportunities = await query<{ id: OpportunityId }>(
    `select x.id from (
       select o.id, ${status("opportunity", "o")} as status,
         (${latestRow("r.at", "opportunity", "o.id", { and: "r.event = 'handed_to_owner'" })}) as handed_at,
         ${openSince("o.id")} as open_since
       from ledger.opportunities o
     ) x
     where (x.status in ('go', 'claimed') and x.open_since + interval '${OPEN_EXPIRY_DAYS} days' <= $1)
        or (x.status = 'handed_to_owner' and x.handed_at + interval '${OPEN_EXPIRY_DAYS} days' <= $1)
     order by x.id collate "C"`,
    [now],
  );
  for (const opportunity of opportunities) found.push({ kind: "opportunity", opportunity: opportunity.id });
  for (const move of await query<{ id: MoveId }>(unreportedMoves(false), [now]))
    found.push({ kind: "move_unreported", move: move.id });
  return found;
}

// The intentions that are set and due, each with its opportunity's latest status.
export async function dueIntentions(query: Query, now: Date): Promise<DueIntention[]> {
  const rows = await query<{
    id: IntentionId;
    kind: "remind" | "check_back";
    opportunity: OpportunityId | null;
    client: ClientId | null;
    status: OpportunityStatus | null;
    holder: ClientId | null;
  }>(
    `select i.id, i.kind, i.opportunity_id as opportunity, i.client_id as client,
       (${latestEvent("opportunity", "i.opportunity_id")}) as status,
       (select l.holder from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = i.opportunity_id) as holder
     from ledger.intentions i
     where i.tainted_at is null and i.due_at <= $1 and ${status("intention", "i")} = 'set'
     order by i.due_at, i.id collate "C"`,
    [now],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    opportunity: row.opportunity,
    client: row.client,
    opportunityStatus: row.status,
    holder: row.holder,
  }));
}

// The opportunities a check-back's 24-hour hold was on, which it ended with the item still `go` and
// unclaimed. Each is written once: its lapse clears the hold. None while a waiting check-back of
// the lease's holder holds the work: it has not come back to the board, and nothing says it has.
export async function lapsedHolds(query: Query, now: Date): Promise<OpportunityId[]> {
  const rows = await query<{ id: OpportunityId }>(
    `select l.resource_id as id from queue.leases l
     where l.resource_kind = 'opportunity' and l.preferred_until is not null and l.preferred_until <= $1 and l.lease_until < $1
       and (${latestEvent("opportunity", "l.resource_id")}) = 'go'
       and not ledger.check_back_holds(l.resource_id, l.holder)
     order by l.resource_id collate "C"`,
    [now],
  );
  return rows.map((row) => row.id);
}
