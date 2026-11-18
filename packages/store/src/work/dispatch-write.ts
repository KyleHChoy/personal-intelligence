import {
  type CardAuthor,
  type CardId,
  CodedError,
  cardOptionsOf,
  currentDefinition,
  type DecisionPointCall,
  type HypothesisId,
  type IntentId,
  isOpenStatus,
  type LedgerRef,
  type OpportunityId,
  type PersonalLogger,
  type RulingId,
  type RunId,
  type SilenceReason,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { type Query, stamp } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { authorWord, caseWord } from "../core/locks.ts";
import { latestOf, lockRows, raiseCard } from "../core/queue.ts";
import { plannerOf, runPlanOf, stageRuns } from "../core/run-plan.ts";
import { CARD_STATE, latestEvent } from "../core/statements.ts";
import { authorOf, OPPORTUNITY_VETO, utcDay } from "./dispatch-read.ts";
import type { WakeCandidate } from "./dispatch-wakes.ts";

// The dispatcher's writes. Each is one transaction, handed in as `query`, that begins with one
// `lockRows` call naming every row whose status it may change, reads those rows' state only after
// it, and does nothing when the state has moved: so each is safe to repeat. Every row takes the
// label of the row it is about. The dispatcher taints nothing: a deletion does that in its own
// transaction.

export const BY = "system:work";
// How long a card about an outcome or a handed-over move stands before it expires.
export const CARD_EXPIRY_DAYS = 14;

// The ledger rows the tick writes events on.
type RowKind = "card" | "run" | "opportunity" | "hypothesis" | "intention" | "move";

// One event on a ledger row, under the label of the row it is about; by the tick unless `by` says.
export const recordEvent = (
  query: Query,
  e: {
    kind: RowKind;
    id: string;
    event: string;
    at: Date;
    compartments: readonly string[];
    code?: string | null;
    by?: string;
  },
): Promise<unknown> =>
  query(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code) values ($1, $2, $3, $4, $5, ledger.label($6), $7)",
    [e.kind, e.id, e.event, stamp(e.at), e.by ?? BY, e.compartments, e.code ?? null],
  );

export const optionsOf = (kind: string): string[] => {
  const options = cardOptionsOf(kind);
  if (options === undefined) throw new CodedError("not_built");
  return [...options];
};

// A call row for a decision the tick made, about one subject, under the subject's label.
async function writeCall(
  query: Query,
  call: DecisionPointCall,
  subject: { kind: string; id: string },
  compartments: string[],
  now: Date,
  card: CardId | null = null,
): Promise<string> {
  const id = newId("dpc");
  await query(
    `insert into ledger.decision_point_calls (id, request_id, created_at, created_by, compartments, point, version, definition_hash, rung, input_hash,
       output, effect, effect_class, escalated, card_id, subject_kind, subject_id)
     values ($1, $1, $2, $3, ledger.label($4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      id,
      stamp(now),
      BY,
      compartments,
      call.point,
      call.version,
      call.definitionHash,
      call.rung,
      call.inputHash,
      call.output,
      call.effect,
      call.effectClass,
      call.escalated,
      card,
      subject.kind,
      subject.id,
    ],
  );
  return id;
}

// Every set intention of an opportunity, cancelled: what every write that closes one does.
export const cancelIntentionsOf = (query: Query, opportunity: string, now: Date, by: string = BY): Promise<unknown> =>
  query(
    `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments)
     select 'intention', i.id, 'cancelled', $2, $3, i.compartments from ledger.intentions i
     where i.opportunity_id = $1
       and (${latestEvent("intention", "i.id")}) = 'set'`,
    [opportunity, stamp(now), by],
  );

const dropLease = (query: Query, id: string): Promise<unknown> =>
  query("delete from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [id]);

// What every close of open work does: its lease dropped and its set intentions cancelled.
export async function closeWork(query: Query, opportunity: string, now: Date, by: string = BY): Promise<void> {
  await dropLease(query, opportunity);
  await cancelIntentionsOf(query, opportunity, now, by);
}

// The undecided cards about an opportunity, with their authors: ids that never change, read
// before the locks.
export const undecidedAbout = (
  query: Query,
  kind: string,
  id: string,
  cardKind?: string,
): Promise<{ id: CardId; author: CardAuthor }[]> =>
  query<{ id: CardId; author: CardAuthor }>(
    `select c.id, c.created_by as author from ledger.cards c
     where c.target_kind = $1 and c.target_id = $2 and ($3::text is null or c.kind = $3) and ${CARD_STATE} in ('pending', 'deferred') order by c.id`,
    [kind, id, cardKind ?? null],
  );

// Each card withdrawn, then each author's oldest deferred card admitted.
export async function withdraw(query: Query, cards: { id: CardId; author: CardAuthor }[], now: Date): Promise<number> {
  const authors = new Set<CardAuthor>();
  let withdrawn = 0;
  for (const card of cards) {
    const state = await latestOf(query, "card", card.id);
    if (state !== "pending" && state !== "deferred") continue;
    const [row] = await query<{ compartments: string[] }>("select compartments from ledger.cards where id = $1", [
      card.id,
    ]);
    await recordEvent(query, {
      kind: "card",
      id: card.id,
      event: "withdrawn",
      at: now,
      compartments: row?.compartments ?? ["own"],
    });
    authors.add(card.author);
    withdrawn += 1;
  }
  for (const author of authors) await query("select ledger.admit_deferred($1)", [author]);
  return withdrawn;
}

type Opportunity = {
  id: OpportunityId;
  kind: string;
  compartments: string[];
  case_id: string;
  created_by: string;
  run_id: string | null;
};

export const opportunityOf = async (query: Query, id: string): Promise<Opportunity | null> =>
  (
    await query<Opportunity>(
      "select id, kind, compartments, case_id, created_by, run_id from ledger.opportunities where id = $1",
      [id],
    )
  )[0] ?? null;

export const vetoedOpportunity = async (query: Query, id: string): Promise<boolean> =>
  (
    await query<{ ruling: string | null }>(
      `select ${OPPORTUNITY_VETO} as ruling from ledger.opportunities o where o.id = $1`,
      [id],
    )
  )[0]?.ruling != null;

const undecidedOnCase = async (query: Query, caseKey: string): Promise<boolean> =>
  (
    await query(
      `select 1 from ledger.cards c where c.case_key = $1 and ${CARD_STATE} in ('pending', 'deferred') limit 1`,
      [caseKey],
    )
  ).length > 0;

// Whether an opportunity is still to be decided: `proposed`, or `later` with its check-back come.
async function toDecide(query: Query, opportunity: Opportunity, now: Date): Promise<boolean> {
  const state = await latestOf(query, "opportunity", opportunity.id);
  if (state === "later") {
    const [decision] = await query<{ at: Date | null }>(
      "select check_back_at as at from ledger.opportunity_decisions where opportunity_id = $1 order by id desc limit 1",
      [opportunity.id],
    );
    if (decision?.at == null || decision.at.getTime() > now.getTime()) return false;
  } else if (state !== "proposed") return false;
  return !(await undecidedOnCase(query, opportunity.case_id));
}

type Hypothesis = {
  id: HypothesisId;
  compartments: string[];
  case_id: string;
  created_by: string;
  run_id: string | null;
};
export const hypothesisOf = async (query: Query, id: string): Promise<Hypothesis | null> =>
  (
    await query<Hypothesis>(
      "select id, compartments, case_id, created_by, run_id from ledger.hypotheses where id = $1",
      [id],
    )
  )[0] ?? null;

// ---------------------------------------------------------------------------------------------
// Wakes
// ---------------------------------------------------------------------------------------------

// A queued run for a wake whose key is not used up, with its anchors in the basis and its
// `wake_worth_run` call. Null when a run already holds the key, or an anchor no longer resolves.
export async function queueRun(
  query: Query,
  candidate: WakeCandidate,
  call: DecisionPointCall,
  now: Date,
): Promise<RunId | null> {
  await lockRows(query, [`wake:${candidate.wakeKey}`]);
  // A folded wake's keys too: none may be one a run already holds.
  const keys = [candidate.wakeKey, ...(candidate.covers ?? [])];
  if (
    (await query("select 1 from ledger.runs where wake_key = any ($1) or covered_keys && $1::text[]", [keys])).length >
    0
  )
    return null;
  const planner = await plannerOf(query);
  // A mode changed since the candidates were read queues nothing it does not run.
  if (!stageRuns(candidate.source, planner)) return null;
  const plan = runPlanOf(candidate.source, planner);
  const id = newId("run") as RunId;
  // A lessons run's lessons in force go into its row, so finish_run can check what a lesson
  // supersedes, and its owner decisions and the cursor after them.
  await query(
    `insert into ledger.runs (id, request_id, created_at, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version, covered_keys,
       lessons, decisions, decisions_cursor)
     values ($1, $1, $2, $3, ledger.label($4), $5, $6, $7, $8, $9, $10, $11, $12::text[], $13::text[], $14)`,
    [
      id,
      stamp(now),
      BY,
      candidate.compartments,
      candidate.source,
      candidate.wakeKey,
      "run_outcome",
      plan.version,
      plan.promptId,
      plan.promptVersion,
      candidate.covers ?? [],
      candidate.lessons ?? null,
      candidate.decisions ?? null,
      candidate.decisions === undefined ? null : (candidate.cursor ?? null),
    ],
  );
  await recordEvent(query, { kind: "run", id, event: "queued", at: now, compartments: candidate.compartments });
  if (candidate.anchors.length > 0) {
    const [basis] = await query<{ ok: boolean }>("select ledger.add_basis('run', $1, $2, $3, $4, null) as ok", [
      id,
      candidate.compartments,
      candidate.anchors.map((ref) => ref.kind),
      candidate.anchors.map((ref) => ref.id),
    ]);
    if (basis?.ok !== true) throw new CodedError("not_found");
  }
  await writeCall(query, call, { kind: "run", id }, candidate.compartments, now);
  return id;
}

// A silence, written at most once for one key, reason and UTC day, with its call. Nothing when a
// run holds the key. Answers whether a row was written.
export async function recordSilence(
  query: Query,
  candidate: WakeCandidate,
  reason: SilenceReason,
  call: DecisionPointCall,
  now: Date,
): Promise<boolean> {
  await lockRows(query, [`wake:${candidate.wakeKey}`]);
  // Nor a silence for a wake whose run the planner would not queue.
  if (!stageRuns(candidate.source, await plannerOf(query))) return false;
  if ((await query("select 1 from ledger.runs where wake_key = $1", [candidate.wakeKey])).length > 0) return false;
  const requestId = newId("dpc");
  const inserted = await query<{ id: string }>(
    `insert into ledger.silences (request_id, created_at, created_by, compartments, reason, wake_source, wake_key, day)
     values ($1, $2, $3, ledger.label($4), $5, $6, $7, $8::date)
     on conflict on constraint silences_once do nothing returning id::text`,
    [requestId, stamp(now), BY, candidate.compartments, reason, candidate.source, candidate.wakeKey, utcDay(now)],
  );
  const [silence] = inserted;
  if (silence === undefined) return false;
  await writeCall(query, call, { kind: "silence", id: silence.id }, candidate.compartments, now);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

export type RungZeroDecision = { output: "go" | "no_go" | "later"; reason: string; intent: IntentId | null };

// Rung 0's decision on an opportunity still to be decided: the call, the decision and its status
// event; a `later` looks again the next day, and a `no_go` cancels the intentions. False when
// the state has moved. A go on its proposer's bet (`agent_bet`) is stored as the agent's, never
// code's own or the owner's: the bettor is the opportunity's author, who placed the bet on it.
export async function decideOpportunity(
  query: Query,
  id: OpportunityId,
  call: DecisionPointCall,
  decision: RungZeroDecision,
  now: Date,
): Promise<boolean> {
  await lockRows(query, [id]);
  const opportunity = await opportunityOf(query, id);
  if (opportunity === null || !(await toDecide(query, opportunity, now))) return false;
  const callId = await writeCall(query, call, { kind: "opportunity", id }, opportunity.compartments, now);
  await query(
    `insert into ledger.opportunity_decisions (request_id, created_at, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id, call_id, check_back_at)
     values ($1, $2, $3, ledger.label($4), $5, $6, $10, 0, $7, $8, $1, $9)`,
    [
      callId,
      stamp(now),
      BY,
      opportunity.compartments,
      id,
      decision.output,
      decision.reason,
      decision.intent,
      decision.output === "later" ? stamp(new Date(now.getTime() + DAY_MS)) : null,
      decision.reason === "agent_bet" ? "agent" : "policy",
    ],
  );
  await recordEvent(query, {
    kind: "opportunity",
    id,
    event: decision.output,
    at: now,
    compartments: opportunity.compartments,
  });
  if (decision.output === "no_go") await cancelIntentionsOf(query, id, now);
  return true;
}

// The owner's card for an opportunity rung 0 could not decide, with the escalated call. Null when
// the state has moved, a card already waits on its case, or a veto covers it.
export async function raiseDecisionCard(
  query: Query,
  id: OpportunityId,
  call: DecisionPointCall,
  now: Date,
  log?: PersonalLogger,
): Promise<CardId | null> {
  const opportunity = await opportunityOf(query, id);
  if (opportunity === null) return null;
  const author = authorOf(opportunity.created_by);
  await lockRows(query, [id, authorWord(author), caseWord(opportunity.case_id)]);
  if (!(await toDecide(query, opportunity, now)) || (await vetoedOpportunity(query, id))) return null;
  const definition = currentDefinition("opportunity_go");
  const card = await raiseCard(
    query,
    {
      id: newId("crd") as CardId,
      requestId: newId("crd"),
      kind: "opportunity_decision",
      author,
      options: optionsOf("opportunity_decision"),
      target: { kind: "opportunity", id } as LedgerRef,
      refs: [],
      compartments: [...opportunity.compartments].sort(),
      expiresAt: null,
      expiresAfterDays: definition.expiresAfterDays ?? null,
      caseKey: opportunity.case_id,
      run: opportunity.run_id,
      body: null,
      bodyFrom: null,
    },
    { now, ...(log === undefined ? {} : { log }) },
  );
  await writeCall(query, call, { kind: "opportunity", id }, opportunity.compartments, now, card.id);
  // A rule the owner confirmed held the question back: the work closes on record, not stuck and not asked
  // again, and `pi cards reopen` gives both back.
  if (card.state === "withdrawn")
    await recordEvent(query, {
      kind: "opportunity",
      id,
      event: "no_go",
      at: now,
      compartments: opportunity.compartments,
      code: "rule_stopped",
    });
  return card.id;
}

// Handed work included.
export async function closeVetoed(query: Query, id: OpportunityId, ruling: RulingId, now: Date): Promise<boolean> {
  const cards = await undecidedAbout(query, "opportunity", id);
  await lockRows(query, [id, ...cards.map((card) => card.id), ...cards.map((card) => authorWord(card.author))]);
  const opportunity = await opportunityOf(query, id);
  const state = await latestOf(query, "opportunity", id);
  if (opportunity === null || state === null || !isOpenStatus(state)) return false;
  await query(
    `insert into ledger.opportunity_decisions (request_id, created_at, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, ruling_id)
     values ($1, $2, $3, ledger.label($4), $5, 'no_go', 'owner', 4, 'vetoed', $6)`,
    [newId("dpc"), stamp(now), BY, opportunity.compartments, id, ruling],
  );
  await recordEvent(query, {
    kind: "opportunity",
    id,
    event: "no_go",
    at: now,
    compartments: opportunity.compartments,
  });
  await withdraw(query, await undecidedAbout(query, "opportunity", id), now);
  await closeWork(query, id, now);
  return true;
}

// The unclaimed pings whose wait is over go to the next place in the owner's order: how many went.
export async function fallBackPings(query: Query, now: Date): Promise<number> {
  const [row] = await query<{ n: number }>("select ledger.fall_back_pings($1) as n", [now.toISOString()]);
  return row?.n ?? 0;
}
