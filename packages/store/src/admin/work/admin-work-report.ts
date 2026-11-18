import type { Keys } from "../../core/keys.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
// `pi work report`: what the window's runs cost and proposed, with the owner's answers and notes
// opened for a terminal, and the counts of the other reports it gathers.

import type { Timestamp } from "@intelligence/contracts";
import type { HypothesisId, OpportunityId, ReportMark, RunId, SettledReport } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { FRONTIER_PARTS } from "@intelligence/personal-core/planner";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { CARD_EXPIRY } from "../../core/queue.ts";
import { LESSON_IN_FORCE, latestEvent, latestRow } from "../../core/statements.ts";
import { openedReport } from "../../core/work-refs.ts";
import { settledReport } from "../../pipeline/fact-settlements.ts";
import { type TriggerCounts, triggerCounts } from "../../pipeline/triggers.ts";
import { type NoticeCounts, noticeCounts } from "../../work/notices.ts";
import { type Coordination, coordination } from "../admin-tasks.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { type ClosesReport, closesReport } from "./admin-commitments.ts";
import { APPROVING, type PlannerWeek, type ProposalYield, plannerWeeks, usedProposals } from "./admin-planner-yield.ts";
import { type DecisionRate, decisionRateReport } from "./decision-rate.ts";
import { type DreamReport, dreamReport } from "./dream-report.ts";
import { type OutcomeTruth, outcomeTruth } from "./outcome-truth.ts";

// One run of `pi work report`: what it cost, how it used its turns and tools, how it ended, and
// what it proposed with the owner's answers and notes, so its caps can be set from what runs do. Summaries
// and notes are opened: for a terminal only.
type WorkReportProposal = {
  rowKind: "opportunity" | "hypothesis";
  id: string;
  kind: string;
  status: string;
  summary: string | null;
  decision: { answer: string; by: "owner" | "policy"; at: Timestamp; note: string | null } | null;
  // The owner's latest answer let it go ahead, and what came of it was used.
  accepted: boolean;
  used: boolean;
};
type WorkReportRun = {
  id: RunId;
  source: string;
  prompt: { id: string; version: string };
  at: Timestamp;
  outcome: string;
  code: string | null;
  attempts: number;
  turns: number;
  toolCalls: Record<string, number>;
  refused: number;
  failed: number;
  tooLarge: number;
  truncated: number;
  outputChecks: number;
  // The web searches and fetches the vendor ran for the run's model calls, counts only.
  webSearches: number;
  webFetches: number;
  costMicroUsd: number;
  // Its proposals counted: proposed, answered by the owner, accepted, used.
  yield: ProposalYield;
  proposals: WorkReportProposal[];
};
// The window's proposals summed by the prompt their run was queued under and by their kind: every
// word is the stored one, so a new prompt, stage, kind or answer shows with no change here.
type WorkReportSummary = {
  prompt: { id: string; version: string };
  rowKind: "opportunity" | "hypothesis";
  kind: string;
  proposed: number;
  answers: Record<string, number>;
  statuses: Record<string, number>;
  approved: number;
  approvalRate: number | null;
};
// Ids and counts only.
type WorkReportLesson = { lesson: HypothesisId; briefs: number; cited: number; answers: Record<string, number> };
// `coordination`: the agents' work on tasks and the owner's card load. `marks`: the marks of the
// moves reported in the window, counted by the client that reported them and by mark.
type WorkReportMarks = { client: string; mark: ReportMark; n: number };

export type WorkReport = {
  days: number;
  since: Timestamp;
  runs: WorkReportRun[];
  summary: WorkReportSummary[];
  // The runs' yield by UTC week and prompt, with the cost of each accepted and each used item.
  plannerYield: PlannerWeek[];
  coordination: Coordination;
  // Each expired card that keeps a person's gap off the board until the owner acts.
  heldByExpiredCard: HeldByExpiredCard[];
  // Work notices by event and state, the notice function's failures, and declines.
  notices: NoticeCounts;
  lessons: WorkReportLesson[];
  marks: WorkReportMarks[];
  // Per fact kind, the cards not raised by the answer that settled them, the duplicates withdrawn and
  // the reopened; and the identity merges the policy made by basis, and the same_person cards
  // raised. Counts only.
  settled: SettledReport;
  // Closes of commitments by agents, by agent and ending, and how many were
  // reopened, by the owner or by their agents, or left orphaned; and the owner's own closes. Counts only.
  closes: ClosesReport;
  // The owner's noes of the window, on opportunities and on ideas, by the reason they
  // gave (null for none). Codes and counts only.
  declines: WorkReportDecline[];
  // The query-time trigger rows written in the window, by cause and
  // raise, and the rechecks still owed. Counts only.
  triggers: TriggerCounts;
  // Outcomes labelled by work already done, the share the system had linked, its misses by path and
  // kind, and the links written. Counts only.
  outcomes: OutcomeTruth;
  // The dream pass's sweep, the relation switches set in the window, every kind's source checks
  // with their Wilson lower bound, and its audits raised, answered and found wrong. Counts only.
  dream: DreamReport;
  // The owner's decisions per day by how they teach, and the mean per day of the owner's `plan` ones.
  decisions: DecisionRate;
  // Ids, codes and numbers only.
  explore: WorkReportExplore[];
};
type WorkReportExplore = {
  id: OpportunityId;
  node: string;
  at: Timestamp;
  value: number;
  parts: Record<string, number>;
  missing: string[];
  goal: string | null;
  status: string | null;
};

async function exploreReport(query: Query, since: Date): Promise<WorkReportExplore[]> {
  const rows = await query<{
    id: OpportunityId;
    node: string;
    at: Date;
    value: number;
    parts: number[];
    missing: string[];
    goal: string | null;
    status: string | null;
  }>(
    `select o.id, o.gap_subject as node, o.created_at as at, o.gap_value as value, o.gap_parts as parts, o.gap_missing as missing, o.goal_id as goal,
       (${latestEvent("opportunity", "o.id")}) as status
     from ledger.opportunities o where o.gap_trigger = 'explore' and o.created_at >= $1 order by o.created_at desc, o.id collate "C" desc`,
    [stamp(since)],
  );
  return rows.map((row) => ({
    ...row,
    at: stamp(row.at),
    parts: Object.fromEntries(FRONTIER_PARTS.map((part, at) => [part, row.parts[at] ?? 0])),
  }));
}
type WorkReportDecline = {
  rowKind: "opportunity" | "idea" | "question" | "goal_proposal";
  reason: string | null;
  n: number;
};

// The owner's no_go on opportunities (a task's cancel among them), their no on ideas, their reject
// of a question and their reject of an agent's goal proposal in the window, by the code of that
// event: the owner's decline reason, `cancelled` for a cancel with none, null for none. A lesson's
// reject is not counted.
async function declinesReport(query: Query, since: Date): Promise<WorkReportDecline[]> {
  return query<WorkReportDecline>(
    `select case when r.row_kind in ('opportunity', 'goal_proposal') then r.row_kind when h.kind = 'idea' then 'idea' else 'question' end as "rowKind", r.code as reason, count(*)::int as n
     from ledger.record_events r left join ledger.hypotheses h on r.row_kind = 'hypothesis' and h.id = r.row_id
     where r.by = 'owner' and r.at >= $1
       and ((r.row_kind = 'opportunity' and r.event = 'no_go') or (r.row_kind = 'goal_proposal' and r.event = 'rejected')
         or (r.row_kind = 'hypothesis' and r.event = 'rejected' and h.kind <> 'lesson'))
     group by 1, 2 order by 1, 2 nulls last`,
    [stamp(since)],
  );
}
export const REPORT_DAYS = { least: 1, most: 90, default: 7 } as const;

// Each such card still closing its case, newest first. `reopenable`: `pi cards reopen` takes it, as it
// takes only what the policy expired. Ids only.
type HeldByExpiredCard = { card: string; opportunity: string; trigger: string; reopenable: boolean };
// `within`: only cards and work inside those compartments, for a count stored under that label.
export async function heldByExpiredCard(query: Query, within: string[] | null = null): Promise<HeldByExpiredCard[]> {
  return query<HeldByExpiredCard>(
    `select c.id as card, o.id as opportunity, o.gap_trigger as trigger, e.by = $1 as reopenable
     from ledger.cards c
     join ledger.opportunities o on c.target_kind = 'opportunity' and o.id = c.target_id and o.gap_trigger in ('close_no_tie', 'close_no_role', 'explore')
     cross join lateral (${latestRow("r.event, r.at, r.by", "card", "c.id")}) e
     where c.tainted_at is null and e.event = 'expired'
       and ($2::text[] is null or (c.compartments <@ $2::text[] and o.compartments <@ $2::text[]))
       and not exists (select 1 from ledger.opportunity_decisions d join ledger.opportunities x on x.id = d.opportunity_id
                       where x.case_id = o.case_id and d.decided_by = 'owner' and d.created_at > e.at)
       and not exists (select 1 from ledger.cards n
                       cross join lateral (${latestRow("r.event, r.at", "card", "n.id")}) s
                       where n.case_key = o.case_id and n.id <> c.id and n.tainted_at is null
                         and (s.event in ('pending', 'deferred') or (s.event = 'expired' and s.at > e.at)))
     order by e.at desc, c.id desc`,
    [CARD_EXPIRY, within],
  );
}

// Read-log retention bounds `briefs`. A move_lessons row keeps no taint of its own: a tainted
// move's is read, and a tainted lesson is not in force.
async function lessonsReport(query: Query, since: Date): Promise<WorkReportLesson[]> {
  const lessons = await query<{ id: HypothesisId }>(
    `select h.id from ledger.hypotheses h where ${LESSON_IN_FORCE} order by h.created_at desc, h.id desc`,
  );
  const ids = lessons.map((row) => row.id);
  const briefs = await query<{ lesson: string; n: number }>(
    `select l.lesson, count(*)::int as n from ledger.read_log r cross join lateral unnest(r.lessons) as l (lesson)
     where r.read_at >= $1 and l.lesson = any($2) group by l.lesson`,
    [stamp(since), ids],
  );
  const cited = await query<{ lesson: string; n: number }>(
    `select m.lesson_id as lesson, count(*)::int as n from ledger.move_lessons m join ledger.moves v on v.id = m.move_id and v.tainted_at is null
     where m.created_at >= $1 and m.lesson_id = any($2) group by m.lesson_id`,
    [stamp(since), ids],
  );
  const answers = await query<{ lesson: string; answer: string; n: number }>(
    `select m.lesson_id as lesson, d.answer, count(*)::int as n from ledger.move_lessons m
     join ledger.moves v on v.id = m.move_id and v.tainted_at is null
     join ledger.cards c on c.kind = 'outcome' and c.target_kind = 'move' and c.target_id = m.move_id and c.tainted_at is null
     join lateral (select o.answer from knowledge.owner_decisions o where o.kind = 'answer' and o.card_id = c.id and o.tainted_at is null
                   order by o.decided_at desc, o.id desc limit 1) d on true
     where m.created_at >= $1 and m.lesson_id = any($2) group by m.lesson_id, d.answer`,
    [stamp(since), ids],
  );
  const count = (rows: readonly { lesson: string; n: number }[], id: string): number =>
    rows.find((row) => row.lesson === id)?.n ?? 0;
  return ids.map((id) => ({
    lesson: id,
    briefs: count(briefs, id),
    cited: count(cited, id),
    answers: Object.fromEntries(
      answers
        .filter((row) => row.lesson === id)
        .sort((a, b) => byText(a.answer, b.answer))
        .map((row) => [row.answer, row.n]),
    ),
  }));
}

export function reportSummary(
  proposals: readonly {
    prompt: { id: string; version: string };
    rowKind: "opportunity" | "hypothesis";
    kind: string;
    status: string;
    answer: string | null;
  }[],
): WorkReportSummary[] {
  type Group = {
    first: (typeof proposals)[number];
    proposed: number;
    answers: Map<string, number>;
    statuses: Map<string, number>;
  };
  const add = (counts: Map<string, number>, word: string): void => void counts.set(word, (counts.get(word) ?? 0) + 1);
  const groups = new Map<string, Group>();
  for (const one of proposals) {
    const key = JSON.stringify([one.prompt.id, one.prompt.version, one.rowKind, one.kind]);
    const group = groups.get(key) ?? { first: one, proposed: 0, answers: new Map(), statuses: new Map() };
    group.proposed += 1;
    add(group.statuses, one.status);
    if (one.answer !== null) add(group.answers, one.answer);
    groups.set(key, group);
  }
  // Object.fromEntries defines each word as an own key, whatever the word.
  return [...groups.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([, { first, proposed, answers, statuses }]) => {
      const answered = [...answers.values()].reduce((sum, n) => sum + n, 0);
      const approved = [...answers].reduce((sum, [word, n]) => sum + (APPROVING.has(word) ? n : 0), 0);
      return {
        prompt: first.prompt,
        rowKind: first.rowKind,
        kind: first.kind,
        proposed,
        answers: Object.fromEntries([...answers].sort(([a], [b]) => byText(a, b))),
        statuses: Object.fromEntries([...statuses].sort(([a], [b]) => byText(a, b))),
        approved,
        approvalRate: answered === 0 ? null : approved / answered,
      };
    });
}

// The runs of the last `days` days, newest first, with their steps counted and their proposals
// and hypotheses with the owner's answers and notes opened (`pi work report`).
export async function workReport(context: AdminContext, days: number = REPORT_DAYS.default): Promise<WorkReport> {
  if (!Number.isSafeInteger(days) || days < REPORT_DAYS.least || days > REPORT_DAYS.most)
    throw new AdminError("invalid_argument");
  const since = new Date(context.now().getTime() - days * DAY_MS);
  return context.transaction(async (query) => {
    const runs = await query<{
      id: RunId;
      wake_source: string;
      prompt_id: string;
      prompt_version: string;
      created_at: Date;
      outcome: string;
      code: string | null;
    }>(
      `select t.id, t.wake_source, t.prompt_id, t.prompt_version, t.created_at, e.event as outcome, e.code from ledger.runs t
       join lateral (${latestRow("r.event, r.code", "run", "t.id")}) e on true
       where t.created_at >= $1 and t.trial_model is null order by t.created_at desc, t.id collate "C" desc`,
      [stamp(since)],
    );
    const ids = runs.map((run) => run.id);
    const steps = await query<{
      run_id: string;
      kind: string;
      status: string | null;
      tool: string | null;
      code: string | null;
      n: number;
      cost: string | null;
      attempts: number;
    }>(
      `select run_id, kind, status, tool, code, count(*)::int as n, sum(cost_microusd)::text as cost, count(distinct attempt)::int as attempts
       from ledger.run_steps where run_id = any($1) group by run_id, kind, status, tool, code`,
      [ids],
    );
    const attempts = await query<{ run_id: string; n: number }>(
      "select run_id, count(*)::int as n from ledger.run_attempts where run_id = any($1) group by run_id",
      [ids],
    );
    const rows = await query<{
      row_kind: "opportunity" | "hypothesis";
      id: string;
      run_id: string;
      kind: string;
      compartments: string[];
      body_enc: Sealed;
      status: string;
    }>(
      `select x.* , (${latestRow("r.event", "x.row_kind", "x.id", { and: "r.event <> 'reported'" })}) as status from (
         select 'opportunity' as row_kind, o.id, o.run_id, o.kind, o.compartments, o.body_enc, o.created_at from ledger.opportunities o where o.run_id = any($1)
         union all
         select 'hypothesis', h.id, h.run_id, h.kind, h.compartments, h.body_enc, h.created_at from ledger.hypotheses h where h.run_id = any($1)
       ) x order by x.created_at, x.id collate "C"`,
      [ids],
    );
    const rowIds = rows.map((row) => row.id);
    // The owner's latest answer on each, with their note; else rung 0's latest decision.
    const answers = await query<{
      target_id: string;
      id: string;
      answer: string;
      decided_at: Date;
      compartments: string[];
      body_enc: Sealed;
    }>(
      `select distinct on (target_id) target_id, id, answer, decided_at, compartments, body_enc from knowledge.owner_decisions
       where kind = 'answer' and target_id = any($1) and tainted_at is null order by target_id, decided_at desc, id desc`,
      [rowIds],
    );
    const policy = await query<{ opportunity_id: string; decision: string; created_at: Date }>(
      `select distinct on (opportunity_id) opportunity_id, decision, created_at from ledger.opportunity_decisions
       where opportunity_id = any($1) and decided_by = 'policy' order by opportunity_id, id desc`,
      [rowIds],
    );
    const answered = new Map(answers.map((one) => [one.target_id, one]));
    const acceptedOf = (id: string): boolean => APPROVING.has(answered.get(id)?.answer ?? "");
    const used = await usedProposals(
      query,
      rows.filter((row) => acceptedOf(row.id)).map((row) => ({ rowKind: row.row_kind, id: row.id, kind: row.kind })),
      unrestrictedOf(context.keys),
    );
    const decided = new Map(policy.map((one) => [one.opportunity_id, one]));
    const decisionOf = (id: string): WorkReportProposal["decision"] => {
      const owner = answered.get(id);
      if (owner !== undefined) {
        const note = open(context.keys, owner, "knowledge.owner_decisions.body_enc", "withheld");
        return { answer: owner.answer, by: "owner", at: stamp(owner.decided_at), note };
      }
      const rung0 = decided.get(id);
      return rung0 === undefined
        ? null
        : { answer: rung0.decision, by: "policy", at: stamp(rung0.created_at), note: null };
    };
    const promptOf = new Map(runs.map((run) => [run.id as string, { id: run.prompt_id, version: run.prompt_version }]));
    const summary = reportSummary(
      rows.flatMap((row) => {
        const prompt = promptOf.get(row.run_id);
        return prompt === undefined
          ? []
          : [
              {
                prompt,
                rowKind: row.row_kind,
                kind: row.kind,
                status: row.status,
                answer: answered.get(row.id)?.answer ?? null,
              },
            ];
      }),
    );
    const reported = runs.map((run): WorkReportRun => {
      const own = steps.filter((step) => step.run_id === run.id);
      const proposals = rows.filter((row) => row.run_id === run.id);
      const sum = (keep: (step: (typeof own)[number]) => boolean): number =>
        own.filter(keep).reduce((total, step) => total + step.n, 0);
      const toolCalls: Record<string, number> = {};
      for (const step of own)
        if (step.kind === "tool_call" && step.tool !== null)
          toolCalls[step.tool] = (toolCalls[step.tool] ?? 0) + step.n;
      return {
        id: run.id,
        source: run.wake_source,
        prompt: { id: run.prompt_id, version: run.prompt_version },
        at: stamp(run.created_at),
        outcome: run.outcome,
        code: run.code,
        attempts: attempts.find((one) => one.run_id === run.id)?.n ?? 0,
        turns: sum((step) => step.kind === "model_call"),
        toolCalls,
        refused: sum((step) => step.kind === "tool_call" && step.status === "refused"),
        failed: sum((step) => step.kind === "tool_call" && step.status === "failed"),
        tooLarge: sum((step) => step.kind === "tool_call" && step.status === "too_large"),
        truncated: sum((step) => step.kind === "model_call" && step.code === "truncated"),
        outputChecks: sum((step) => step.kind === "output_check"),
        webSearches: sum((step) => step.kind === "web_search"),
        webFetches: sum((step) => step.kind === "web_fetch"),
        costMicroUsd: own.reduce((total, step) => total + Number(step.cost ?? 0), 0),
        yield: {
          proposed: proposals.length,
          answered: proposals.filter((row) => answered.has(row.id)).length,
          accepted: proposals.filter((row) => acceptedOf(row.id)).length,
          used: proposals.filter((row) => used.has(row.id)).length,
        },
        proposals: proposals.map((row) => ({
          rowKind: row.row_kind,
          id: row.id,
          kind: row.kind,
          status: row.status,
          summary:
            row.row_kind === "opportunity"
              ? open(context.keys, row, "ledger.opportunities.body_enc", "withheld")
              : open(context.keys, row, "ledger.hypotheses.body_enc", "withheld"),
          decision: decisionOf(row.id),
          accepted: acceptedOf(row.id),
          used: used.has(row.id),
        })),
      };
    });
    return {
      days,
      since: stamp(since),
      heldByExpiredCard: await heldByExpiredCard(query),
      runs: reported,
      summary,
      plannerYield: plannerWeeks(reported.map((run) => ({ ...run, at: new Date(run.at), prompt: run.prompt.id }))),
      coordination: await coordination(query, since),
      notices: await noticeCounts(query, since),
      lessons: await lessonsReport(query, since),
      marks: await marks(query, context.keys, since),
      settled: await settledReport(query, since),
      closes: await closesReport(query, since),
      declines: await declinesReport(query, since),
      triggers: await triggerCounts(query, since),
      outcomes: await outcomeTruth(query, since),
      dream: await dreamReport(query, since),
      decisions: await decisionRateReport(query, context.now(), days),
      explore: await exploreReport(query, since),
    };
  });
}

// Each report of the window opened for its marks (they are in its sealed body), counted by the
// client that reported it and the mark, in client and mark order.
async function marks(query: Query, keys: Keys, since: Date): Promise<WorkReportMarks[]> {
  const reported = await query<{ row_id: string; by: string; compartments: string[]; body_enc: Sealed }>(
    "select row_id, by, compartments, body_enc from ledger.record_events where row_kind = 'move' and event = 'reported' and at >= $1 and body_enc is not null order by id",
    [stamp(since)],
  );
  const counts = new Map<string, WorkReportMarks>();
  for (const row of reported) {
    const text = open(keys, { ...row, id: `${row.row_id}/reported` }, "ledger.record_events.body_enc", "withheld");
    if (text === null) continue;
    const client = row.by.startsWith("client:") ? row.by.slice("client:".length) : row.by;
    for (const mark of openedReport(text).marks) {
      const key = `${client}\u0000${mark}`;
      const one = counts.get(key) ?? { client, mark, n: 0 };
      one.n += 1;
      counts.set(key, one);
    }
  }
  return [...counts.values()].sort((a, b) => byText(a.client, b.client) || byText(a.mark, b.mark));
}
