// The owner's cards the tick raises in its step 7, and their withdrawal: a question about a
// hypothesis, the planner's idea and lesson cards, outcome cards with the report label they take,
// reminders and the notices of failed runs. Each write is one transaction, as dispatch-write.ts
// describes.

import {
  type CardAuthor,
  type CardId,
  currentDefinition,
  type HypothesisId,
  type IntentionId,
  type LedgerRef,
  type MoveId,
  type OpportunityId,
  type PersonalLogger,
  type RunId,
} from "@intelligence/contracts/personal";
import { ASKED_LESS_BY, outcomeLabel, outcomeSampled, SETTLED_CODES_SQL, weekStartOf } from "../cards/asked-less.ts";
import { type Query, stamp } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { authorWord, caseWord, outcomeCase } from "../core/locks.ts";
import { latestOf, lockRows, raiseCard } from "../core/queue.ts";
import { lever } from "../core/settings.ts";
import { CARD_STATE, latestEvent, moveStatus } from "../core/statements.ts";
import { authorOf, ENDED_OUTCOMES, OUTCOME_RERAISES } from "./dispatch-read.ts";
import {
  BY,
  CARD_EXPIRY_DAYS,
  hypothesisOf,
  opportunityOf,
  optionsOf,
  recordEvent,
  vetoedOpportunity,
  withdraw,
} from "./dispatch-write.ts";

// The planner's cards: an idea's and a lesson's, each expiring after 30 days.
const PLANNER_CARD_DAYS = 30;

const cardAbout = async (query: Query, kind: string, id: string, cardKind?: string): Promise<boolean> =>
  (
    await query(
      "select 1 from ledger.cards where target_kind = $1 and target_id = $2 and ($3::text is null or kind = $3) limit 1",
      [kind, id, cardKind ?? null],
    )
  ).length > 0;

const basisVetoed = async (query: Query, rowKind: string, id: string): Promise<boolean> =>
  (
    await query<{ vetoed: boolean }>(
      `select policy.vetoed(array(select ref_kind from ledger.basis where row_kind = $1 and row_id = $2 order by id),
         array(select ref_id from ledger.basis where row_kind = $1 and row_id = $2 order by id), null) as vetoed`,
      [rowKind, id],
    )
  )[0]?.vetoed === true;

// A card for the owner about a hypothesis, raised with its row and author locked. Null when
// `open` refuses its state, a card is already about it, or a veto covers its basis.
async function hypothesisCard(
  query: Query,
  id: HypothesisId,
  card: { kind: "owner_question" | "idea" | "lesson"; open: (state: string | null) => boolean; days: number | null },
  now: Date,
  log?: PersonalLogger,
) {
  const hypothesis = await hypothesisOf(query, id);
  if (hypothesis === null) return null;
  const author = authorOf(hypothesis.created_by);
  await lockRows(query, [id, authorWord(author), caseWord(hypothesis.case_id)]);
  if (
    !card.open(await latestOf(query, "hypothesis", id)) ||
    (await cardAbout(query, "hypothesis", id)) ||
    (await basisVetoed(query, "hypothesis", id))
  )
    return null;
  const raised = await raiseCard(
    query,
    {
      id: newId("crd") as CardId,
      requestId: newId("crd"),
      kind: card.kind,
      author,
      options: optionsOf(card.kind),
      target: { kind: "hypothesis", id } as LedgerRef,
      refs: [],
      compartments: [...hypothesis.compartments].sort(),
      expiresAt: null,
      expiresAfterDays: card.days,
      caseKey: hypothesis.case_id,
      run: hypothesis.run_id,
      body: null,
      bodyFrom: null,
    },
    { now, ...(log === undefined ? {} : { log }) },
  );
  return { card: raised, compartments: hypothesis.compartments };
}

// The owner's question about a hypothesis about the owner, which then waits as `asked`.
export async function raiseQuestionCard(
  query: Query,
  id: HypothesisId,
  now: Date,
  log?: PersonalLogger,
): Promise<CardId | null> {
  const open = (state: string | null) => state === "open" || state === "supported";
  const days = currentDefinition("owner_question").expiresAfterDays ?? null;
  const raised = await hypothesisCard(query, id, { kind: "owner_question", open, days }, now, log);
  if (raised === null) return null;
  await recordEvent(query, { kind: "hypothesis", id, event: "asked", at: now, compartments: raised.compartments });
  return raised.card.id;
}

// An idea's or a lesson's card for the owner, by the run that wrote it, which then waits as
// `asked`. Null when the state has moved, a card is already about it, or a veto covers its basis.
export async function raisePlannerCard(
  query: Query,
  id: HypothesisId,
  kind: "idea" | "lesson",
  now: Date,
  log?: PersonalLogger,
): Promise<CardId | null> {
  const open = (state: string | null) => state === "open";
  const raised = await hypothesisCard(query, id, { kind, open, days: PLANNER_CARD_DAYS }, now, log);
  if (raised === null) return null;
  // A rule the owner confirmed held it back: closed on record, and `pi cards reopen` gives both back.
  if (raised.card.state === "withdrawn")
    await recordEvent(query, {
      kind: "hypothesis",
      id,
      event: "withdrawn",
      at: now,
      compartments: raised.compartments,
      code: "rule_stopped",
    });
  else await recordEvent(query, { kind: "hypothesis", id, event: "asked", at: now, compartments: raised.compartments });
  return raised.card.id;
}

// A hypothesis about the owner whose case the owner closed, or whose card expired, with no news:
// closed as `expired`, with no card.
export async function closeHypothesis(query: Query, id: HypothesisId, now: Date): Promise<boolean> {
  await lockRows(query, [id]);
  const hypothesis = await hypothesisOf(query, id);
  const state = await latestOf(query, "hypothesis", id);
  if (hypothesis === null || (state !== "open" && state !== "supported")) return false;
  await recordEvent(query, {
    kind: "hypothesis",
    id,
    event: "expired",
    at: now,
    compartments: hypothesis.compartments,
  });
  return true;
}

// A move's latest untainted report of how it ended (never a progress report): who reported, its opportunity, and the union of the labels of
// what it shows: the opportunity's (the brief), the report's, the move's and its basis rows', each within the move's label, its ceiling. An
// outcome card on the move and the owner's judgment of a task's result (admin-results.ts) take this label.
export async function reportOf(
  query: Query,
  move: string,
): Promise<{ by: string; opportunity: string; compartments: string[] } | null> {
  const [report] = await query<{
    by: string;
    compartments: string[];
    opportunity: string;
    brief: string[];
    move: string[];
  }>(
    `select r.by, r.compartments, m.opportunity_id as opportunity, o.compartments as brief, m.compartments as move
     from ledger.record_events r join ledger.moves m on m.id = r.row_id join ledger.opportunities o on o.id = m.opportunity_id
     where r.row_kind = 'move' and r.row_id = $1 and r.event = 'reported' and r.code is distinct from 'progress'
       and r.tainted_at is null order by r.id desc limit 1`,
    [move],
  );
  if (report === undefined) return null;
  const basis = await query<{ compartments: string[] }>(
    "select compartments from ledger.basis where row_kind = 'move' and row_id = $1 and tainted_at is null",
    [move],
  );
  const compartments = [
    ...new Set([...report.compartments, ...report.brief, ...report.move, ...basis.flatMap((row) => row.compartments)]),
  ].sort();
  return { by: report.by, opportunity: report.opportunity, compartments };
}

// The outcome cards still waiting on a task's move, withdrawn quietly by the system (`system:work`, never
// the owner: nothing was an answer from the owner), each author's oldest deferred card then admitted. No
// notice. Returns how many were withdrawn.
export async function withdrawTaskResultCards(
  query: Query,
  cards: { id: CardId; author: CardAuthor }[],
  now: Date,
): Promise<number> {
  if (cards.length === 0) return 0;
  await lockRows(query, [...cards.map((card) => card.id), ...new Set(cards.map((card) => authorWord(card.author)))]);
  return withdraw(query, cards, now);
}

// The outcome card for a handed opportunity (by its author), or for a move whose report carries a summary (by
// the reporting client). A move's card is under the union of the labels of what it shows: the opportunity's
// (the brief), the report's, the move's and its basis rows', each of which is under the move's label, its
// ceiling, so a cited record or source is within it. Its target is the move, so a taint of what the move cites
// taints the card (`ledger.taint_citing`, a card whose target is a tainted move). `owner`: the owner's Done or
// Drop from handed work's row (admin-queue.ts decideHanded): the card is raised under the owner's request's
// id, and past OUTCOME_RERAISES, since the owner asked for it.
export async function raiseOutcomeCard(
  query: Query,
  target: { kind: "opportunity"; id: OpportunityId } | { kind: "move"; id: MoveId },
  now: Date,
  log?: PersonalLogger,
  owner?: { requestId: string },
): Promise<CardId | null> {
  let author: CardAuthor;
  let compartments: string[];
  let run: string | null = null;
  let opportunityId: string;
  if (target.kind === "opportunity") {
    const opportunity = await opportunityOf(query, target.id);
    if (opportunity === null) return null;
    author = authorOf(opportunity.created_by);
    compartments = opportunity.compartments;
    run = opportunity.run_id;
    opportunityId = opportunity.id;
  } else {
    const report = await reportOf(query, target.id);
    if (report === null) return null;
    author = authorOf(report.by);
    compartments = report.compartments;
    opportunityId = report.opportunity;
  }
  const caseKey = outcomeCase(target.id);
  await lockRows(query, [target.id, authorWord(author), caseWord(caseKey)]);
  const [opportunity] = await query<{ state: string | null; tier: string; live: boolean; ended: number }>(
    `select (${latestEvent("opportunity", "o.id")}) as state, o.tier,
       exists (select 1 from ledger.cards c where c.kind = 'outcome' and c.target_kind = 'opportunity' and c.target_id = o.id and ${CARD_STATE} in ('pending', 'deferred')) as live,
       ${ENDED_OUTCOMES} as ended
     from ledger.opportunities o where o.id = $1`,
    [opportunityId],
  );
  if (opportunity === undefined) return null;
  // Handed work: due while handed with no live card, raised again at most OUTCOME_RERAISES times
  // after one ended unanswered. A move: one card ever, on an opportunity not handed to the owner; a
  // task's report raises none, it is in the owner's Results feed.
  const due =
    target.kind === "opportunity"
      ? opportunity.state === "handed_to_owner" &&
        !opportunity.live &&
        (owner !== undefined || opportunity.ended <= OUTCOME_RERAISES)
      : opportunity.tier === "opportunity" &&
        opportunity.state !== "handed_to_owner" &&
        !(await cardAbout(query, "move", target.id, "outcome"));
  if (!due || (await vetoedOpportunity(query, opportunityId))) return null;
  // A report's outcome reaches the owner only as one of the week's sample. Handed work's card is
  // the owner's own Done or Drop, and is always theirs.
  const asked =
    target.kind === "opportunity" ||
    outcomeSampled(target.id, now, await sampledThisWeek(query, now), {
      weekly: await lever(query, "outcomes.sample_weekly"),
      share: await lever(query, "outcomes.sample_share"),
    });
  const label = [...new Set(compartments)].sort();
  const card = await raiseCard(
    query,
    {
      id: newId("crd") as CardId,
      requestId: owner?.requestId ?? newId("crd"),
      kind: "outcome",
      author,
      options: optionsOf("outcome"),
      target: target as LedgerRef,
      refs: [],
      compartments: label,
      expiresAt: null,
      expiresAfterDays: CARD_EXPIRY_DAYS,
      caseKey,
      run,
      body: null,
      bodyFrom: null,
    },
    { now, ...(log === undefined ? {} : { log }) },
  );
  if (asked || card.replayed || (card.state !== "pending" && card.state !== "deferred")) return card.id;
  await settleOutcome(query, { id: card.id, move: target.id, compartments: label }, now, log);
  return null;
}

// The outcome cards on a report raised to the owner since the ISO week began: every one code did
// not settle.
const sampledThisWeek = async (query: Query, now: Date): Promise<number> =>
  (
    await query<{ n: number }>(
      `select count(*)::int as n from ledger.cards c
       where c.kind = 'outcome' and c.target_kind = 'move' and c.created_at >= $1
         and not exists (select 1 from ledger.record_events e where e.row_kind = 'card' and e.row_id = c.id and e.code in (${SETTLED_CODES_SQL}))`,
      [stamp(weekStartOf(now))],
    )
  )[0]?.n ?? 0;

// A report's outcome outside the week's sample, settled by code: its card is on record and
// withdrawn at once by ASKED_LESS_BY, never the owner, its code the label the code judge's latest
// applied link gives the work, else the report's own. A link outside the card's label labels
// nothing (invariant 6). `pi cards reopen` gives the card to the owner.
async function settleOutcome(
  query: Query,
  card: { id: CardId; move: string; compartments: string[] },
  now: Date,
  log?: PersonalLogger,
): Promise<void> {
  const [row] = await query<{ move: string | null; judged: string | null }>(
    `select (${moveStatus("m.id")}) as move,
       (select l.kind from ledger.outcome_links l
        where l.opportunity_id = m.opportunity_id and l.judge = 'rule' and l.applied and l.move_result_link_id is null
          and l.tainted_at is null and l.compartments <@ $2::text[]
        order by l.id desc limit 1) as judged
     from ledger.moves m where m.id = $1`,
    [card.move, card.compartments],
  );
  const code = outcomeLabel({ judged: row?.judged ?? null, move: row?.move ?? null });
  await recordEvent(query, {
    kind: "card",
    id: card.id,
    event: "withdrawn",
    at: now,
    compartments: card.compartments,
    code,
    by: ASKED_LESS_BY,
  });
  log?.info({ event: "outcome_settled", code, ids: { card: card.id } });
}

// A due `remind`: its card, and the intention `fired`. One a veto covers is cancelled, with no
// card.
export async function raiseReminderCard(
  query: Query,
  id: IntentionId,
  now: Date,
  log?: PersonalLogger,
): Promise<CardId | null> {
  const [intention] = await query<{ compartments: string[]; created_by: string; run_id: string | null }>(
    "select compartments, created_by, run_id from ledger.intentions where id = $1 and kind = 'remind'",
    [id],
  );
  if (intention === undefined) return null;
  const author = authorOf(intention.created_by);
  const caseKey = `reminder:${id}`;
  await lockRows(query, [id, authorWord(author), caseWord(caseKey)]);
  if ((await latestOf(query, "intention", id)) !== "set") return null;
  if (await basisVetoed(query, "intention", id)) {
    await recordEvent(query, {
      kind: "intention",
      id,
      event: "cancelled",
      at: now,
      compartments: intention.compartments,
    });
    return null;
  }
  const card = await raiseCard(
    query,
    {
      id: newId("crd") as CardId,
      requestId: newId("crd"),
      kind: "reminder",
      author,
      options: optionsOf("reminder"),
      target: { kind: "intention", id } as LedgerRef,
      refs: [],
      compartments: [...intention.compartments].sort(),
      expiresAt: null,
      expiresAfterDays: CARD_EXPIRY_DAYS,
      caseKey,
      run: intention.run_id,
      body: null,
      bodyFrom: null,
    },
    { now, ...(log === undefined ? {} : { log }) },
  );
  await recordEvent(query, { kind: "intention", id, event: "fired", at: now, compartments: intention.compartments });
  return card.id;
}

// The notice that three runs in a row failed: from `system:work`, about the latest of them.
export async function raiseFailureNotice(
  query: Query,
  run: RunId,
  now: Date,
  log?: PersonalLogger,
): Promise<CardId | null> {
  await lockRows(query, [run, authorWord(BY), caseWord("run_failures")]);
  if (await cardAbout(query, "run", run)) return null;
  return noticeCard(query, run, "run_failures", now, log);
}

// A notice card from `system:work` about a run, under a case key, in the run's label.
async function noticeCard(
  query: Query,
  run: RunId,
  caseKey: string,
  now: Date,
  log?: PersonalLogger,
): Promise<CardId | null> {
  const [row] = await query<{ compartments: string[] }>("select compartments from ledger.runs where id = $1", [run]);
  if (row === undefined) return null;
  const card = await raiseCard(
    query,
    {
      id: newId("crd") as CardId,
      requestId: newId("crd"),
      kind: "notice",
      author: BY,
      options: optionsOf("notice"),
      target: { kind: "run", id: run } as LedgerRef,
      refs: [],
      compartments: [...row.compartments].sort(),
      expiresAt: null,
      expiresAfterDays: null,
      caseKey,
      run,
      body: null,
      bodyFrom: null,
    },
    { now, ...(log === undefined ? {} : { log }) },
  );
  return card.id;
}
