// `pi work show`: one run, move, opportunity or hypothesis with its chain, its summaries opened
// for the owner alone.
import { ProposalDetails } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { type Query, stamp } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { openedReport } from "../../core/work-refs.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { namedMessages } from "../search/admin-sources.ts";

// One run, opportunity, hypothesis or move with its chain, its summaries opened: for the owner alone, at
// a terminal or on their page's Work room, which renders them as text. A run's steps are tools, statuses,
// codes and costs: nothing a model said is kept. Null for an id that is none of them.
export async function showWork(context: AdminContext, id: string): Promise<Record<string, unknown> | null> {
  return context.transaction(async (query) => {
    const events = (kind: string, rowId: string) =>
      query<{ event: string; at: Date; by: string; code: string | null }>(
        "select event, at, by, code from ledger.record_events where row_kind = $1 and row_id = $2 and event <> 'reported' order by id",
        [kind, rowId],
      ).then((rows) => rows.map((row) => ({ event: row.event, at: stamp(row.at), by: row.by, code: row.code })));
    const basis = (kind: string, rowId: string) =>
      query<{ ref_kind: string; ref_id: string; tainted: boolean }>(
        "select ref_kind, ref_id, tainted_at is not null as tainted from ledger.basis where row_kind = $1 and row_id = $2 order by id",
        [kind, rowId],
      ).then((rows) => rows.map((row) => ({ kind: row.ref_kind, id: row.ref_id, tainted: row.tainted })));
    const reports = (move: string) =>
      query<{ row_id: string; at: Date; compartments: string[]; body_enc: Sealed }>(
        "select row_id, at, compartments, body_enc from ledger.record_events where row_kind = 'move' and row_id = $1 and event = 'reported' order by id",
        [move],
      ).then((rows) =>
        rows.map((row) => {
          // A report with its parts, its draft and its marks; one sealed before it is its summary.
          const text = open(
            context.keys,
            { ...row, id: `${row.row_id}/reported` },
            "ledger.record_events.body_enc",
            "withheld",
          );
          if (text === null) return { at: stamp(row.at), summary: null };
          const { v: _v, ...body } = openedReport(text);
          return {
            at: stamp(row.at),
            summary: body.summary ?? null,
            ...(body.report === undefined ? {} : { report: body.report }),
            marks: body.marks,
          };
        }),
      );
    const move = async (moveId: string) => {
      const [row] = await query<{
        id: string;
        opportunity_id: string;
        stage: string;
        created_by: string;
        created_at: Date;
        intent_id: string;
      }>("select id, opportunity_id, stage, created_by, created_at, intent_id from ledger.moves where id = $1", [
        moveId,
      ]);
      return row === undefined
        ? null
        : {
            kind: "move",
            id: row.id,
            opportunity: row.opportunity_id,
            stage: row.stage,
            by: row.created_by,
            at: stamp(row.created_at),
            intent: row.intent_id,
            events: await events("move", row.id),
            reports: await reports(row.id),
          };
    };
    const prefix = id.slice(0, 4);
    if (prefix === "run_") {
      const [row] = await query<{
        id: string;
        wake_source: string;
        wake_key: string;
        created_at: Date;
        compartments: string[];
      }>("select id, wake_source, wake_key, created_at, compartments from ledger.runs where id = $1", [id]);
      if (row === undefined) return null;
      const steps = await query<{
        attempt: number;
        ordinal: number;
        kind: string;
        tool: string | null;
        status: string | null;
        code: string | null;
        cost_microusd: string | null;
        input_tokens: number | null;
        output_tokens: number | null;
        ms: number | null;
        result_code_points: number | null;
      }>(
        "select attempt, ordinal, kind, tool, status, code, cost_microusd, input_tokens, output_tokens, ms, result_code_points from ledger.run_steps where run_id = $1 order by attempt, ordinal",
        [id],
      );
      // What it read and made: the distinct items shown in its attempts' sessions, and the rows
      // it wrote, by run id. Counted only within the key
      // file's compartments but the restricted ones, as the ledger counts (no count over rows the
      // owner cannot see).
      const [did] = await query<{ read: number; opportunities: number; hypotheses: number; cards: number }>(
        `select
           (select count(distinct x) from ledger.read_log l cross join unnest(l.shown) as x
            where l.session_id in (select a.session_id from ledger.run_attempts a where a.run_id = $1) and l.compartments <@ $2::text[])::int as read,
           (select count(*) from ledger.opportunities where run_id = $1 and compartments <@ $2::text[])::int as opportunities,
           (select count(*) from ledger.hypotheses where run_id = $1 and compartments <@ $2::text[])::int as hypotheses,
           (select count(*) from ledger.cards where run_id = $1 and compartments <@ $2::text[])::int as cards`,
        [id, unrestrictedOf(context.keys)],
      );
      return {
        ...(did === undefined
          ? {}
          : {
              read: did.read,
              made: { opportunities: did.opportunities, hypotheses: did.hypotheses, cards: did.cards },
            }),
        kind: "run",
        id: row.id,
        source: row.wake_source,
        wakeKey: row.wake_key,
        at: stamp(row.created_at),
        compartments: row.compartments,
        anchors: await basis("run", id),
        events: await events("run", id),
        steps: steps.map((step) => ({
          ...step,
          cost_microusd: step.cost_microusd === null ? null : Number(step.cost_microusd),
        })),
      };
    }
    if (prefix === "mov_") return move(id);
    if (prefix === "opp_" || prefix === "hyp_") {
      const kind = prefix === "opp_" ? "opportunity" : "hypothesis";
      const table = prefix === "opp_" ? "ledger.opportunities" : "ledger.hypotheses";
      const [row] = await query<{
        id: string;
        kind: string;
        about_kind: string;
        about_id: string | null;
        created_by: string;
        created_at: Date;
        compartments: string[];
        body_enc: Sealed;
        tainted: boolean;
      }>(
        `select id, kind, about_kind, about_id, created_by, created_at, compartments, body_enc, tainted_at is not null as tainted from ${table} where id = $1`,
        [id],
      );
      if (row === undefined) return null;
      const shown = {
        kind,
        id: row.id,
        workKind: row.kind,
        about: { kind: row.about_kind, id: row.about_id },
        by: row.created_by,
        at: stamp(row.created_at),
        compartments: row.compartments,
        tainted: row.tainted,
        summary:
          kind === "opportunity"
            ? open(context.keys, row, "ledger.opportunities.body_enc", "withheld")
            : open(context.keys, row, "ledger.hypotheses.body_enc", "withheld"),
        // An opportunity's or a task's details, the agent's words, opened for the owner.
        ...(kind === "opportunity"
          ? { details: await opportunityDetails(query, context.keys, id, row.compartments) }
          : {}),
        basis: await basis(kind, id),
        events: await events(kind, id),
      };
      if (kind === "hypothesis") {
        const tests = await query<{ id: string; result: string; counts: boolean; created_by: string }>(
          'select id, result, counts, created_by from ledger.hypothesis_tests where hypothesis_id = $1 order by created_at, id collate "C"',
          [id],
        );
        return {
          ...shown,
          tests: tests.map((test) => ({
            id: test.id,
            result: test.result,
            counts: test.counts,
            by: test.created_by,
          })),
        };
      }
      const decisions = await query<{
        decision: string;
        decided_by: string;
        rung: number;
        reason: string | null;
        intent_id: string | null;
        ruling_id: string | null;
        created_at: Date;
      }>(
        "select decision, decided_by, rung, reason, intent_id, ruling_id, created_at from ledger.opportunity_decisions where opportunity_id = $1 order by id",
        [id],
      );
      const moves = await query<{ id: string }>(
        'select id from ledger.moves where opportunity_id = $1 order by created_at, id collate "C"',
        [id],
      );
      const intentions = await query<{ id: string; kind: string; due_at: Date }>(
        'select id, kind, due_at from ledger.intentions where opportunity_id = $1 order by due_at, id collate "C"',
        [id],
      );
      const shownMoves = await Promise.all(moves.map((one) => move(one.id)));
      // The messages its reports cite, by subject and sender, for the owner's page.
      const cited = shownMoves.flatMap((one) =>
        (one?.reports ?? []).flatMap((report) =>
          ((report as { report?: { sources?: unknown[] } }).report?.sources ?? []).flatMap((source) =>
            typeof source === "object" &&
            source !== null &&
            (source as { kind?: unknown }).kind === "message" &&
            typeof (source as { id?: unknown }).id === "string"
              ? [(source as { id: string }).id]
              : [],
          ),
        ),
      );
      return {
        ...shown,
        decisions: decisions.map((one) => ({
          decision: one.decision,
          by: one.decided_by,
          rung: one.rung,
          reason: one.reason,
          intent: one.intent_id,
          ruling: one.ruling_id,
          at: stamp(one.created_at),
        })),
        moves: shownMoves,
        messages: await namedMessages({ query, keys: context.keys }, cited),
        intentions: await Promise.all(
          intentions.map(async (one) => ({
            id: one.id,
            kind: one.kind,
            dueAt: stamp(one.due_at),
            events: await events("intention", one.id),
          })),
        ),
      };
    }
    return null;
  });
}

// An opportunity's details, opened and parsed; null when it has none, or when they
// cannot be opened or are not the details' shape.
async function opportunityDetails(
  query: Query,
  keys: Keys,
  id: string,
  compartments: string[],
): Promise<ProposalDetails | null> {
  const [row] = await query<{ details_enc: Sealed }>("select details_enc from ledger.opportunities where id = $1", [
    id,
  ]);
  if (row === undefined || row.details_enc === null) return null;
  const text = open(
    keys,
    { id, compartments, details_enc: row.details_enc },
    "ledger.opportunities.details_enc",
    "withheld",
  );
  if (text === null) return null;
  try {
    const parsed = ProposalDetails.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
