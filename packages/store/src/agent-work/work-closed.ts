import type { Envelope } from "@intelligence/contracts";
import type {
  AgentRecordId,
  ClosedWork,
  MoveReportBody,
  OpportunityStatus,
  RoleName,
  WorkTier,
} from "@intelligence/contracts/personal";
import { stamp } from "../core/db.ts";
import { labelJoined } from "../core/labels.ts";
import { open } from "../core/seal.ts";
import { latestRow, moveStatus, OPPORTUNITY_ROUTED, ROUTED_ROLE } from "../core/statements.ts";
import { type Done, openedReport, type Result, refused, type WorkCall } from "../core/work-refs.ts";
import { opportunityViews } from "../core/work-views.ts";
import { type Ctx, Unavailable } from "../read/read-ctx.ts";
import { recordsCited } from "./work-report.ts";

// list_opportunities, scope closed: what work ended as, newest first. Every statement runs under the
// caller's token, so a row or a report its policies do not return changes nothing it is served
// (invariant 6). Like the board, another agent's row shows only once it went `go`, and code's own
// no_go, which says nothing of the work, is left out.

const ENDED: readonly OpportunityStatus[] = ["done", "expired", "withdrawn", "no_go", "outcome_met", "outcome_not_met"];

const ROWS = `
  select b.id, b.at, b.at::text as at_text, md5($1 || b.id) as tie, b.by, b.code, b.created_by = $1 as owned from (
    select o.id, o.created_by, o.tier, e.event, e.at, e.by, e.code,
      case when exists (${OPPORTUNITY_ROUTED})
        then (${ROUTED_ROLE})
        else o.role end as role
    from ledger.opportunities o
    cross join lateral (${latestRow("r.event, r.at, r.by, r.code", "opportunity", "o.id")}) e
    where o.tainted_at is null
  ) b
  where b.event = any ($2) and not (b.event = 'no_go' and b.by <> 'owner')
    and (b.created_by = $1 or exists (select 1 from ledger.record_events g where g.row_kind = 'opportunity' and g.row_id = b.id and g.event = 'go'))
    and ($4::text is null or b.tier = $4) and ($5::text is null or b.role is not distinct from $5)
    and ($6::timestamptz is null or (b.at, md5($1 || b.id)) < ($6::timestamptz, $7::text))
  order by b.at desc, md5($1 || b.id) desc
  limit $3`;
// Each row's latest report of how a move ended that the token returns, so a blocked report's words never
// stand for a later end; bound to `<move id>/reported`, as report_move seals it.
const REPORTS = `
  select distinct on (m.opportunity_id) m.opportunity_id, m.id as move, r.by, r.compartments, r.body_enc
  from ledger.moves m
  join ledger.record_events r on r.row_kind = 'move' and r.row_id = m.id and r.event = 'reported'
    and r.code is distinct from 'progress'
  where m.opportunity_id = any ($1) and m.tainted_at is null and r.tainted_at is null and r.body_enc is not null
    and (${moveStatus("m.id", "e")}) in ('done', 'failed')
  order by m.opportunity_id, r.id desc`;
// The record's own policy holds its label and its writer's views. An erased one has no body.
const READABLE =
  "select w.id, w.compartments from ledger.agent_writes w where w.id = any ($1::text[]) and w.body_enc is not null";

type Row = { id: string; at: Date; at_text: string; tie: string; by: string; code: string | null; owned: boolean };
type ReportRow = { opportunity_id: string; move: string; by: string; compartments: string[]; body_enc: Envelope };
type Opened = { row: ReportRow; body: MoveReportBody; cites: AgentRecordId[] };
// A served list is cut; every cite still counts toward whether the words are served.
const MOST_FINDINGS = 20;

// A report whose compartment key the call was not given is no report to this caller.
function openReport(ctx: Ctx, row: ReportRow): Opened | null {
  if (!row.compartments.every((compartment) => ctx.keys.compartments.has(compartment))) return null;
  let body: MoveReportBody;
  try {
    const at = { ...row, id: `${row.move}/reported` };
    body = openedReport(open(ctx.keys, at, "ledger.record_events.body_enc", "throw"));
  } catch {
    throw new Unavailable();
  }
  return { row, body, cites: recordsCited({ report: body.report }) };
}

// Its words, or nothing. None with a cited record the token does not return, or one gone, as the owner's
// Results leaves it out (invariant 10). Its own report otherwise; another's only when a cite carries the
// report's own label, the writer's whole clearance: that record's policy vouches for the writer's views,
// which a record_events row does not hold, and a finding of the caller's own, under its label, vouches
// for nothing.
function wordsOf(
  { row, body, cites }: Opened,
  author: string,
  readable: ReadonlyMap<string, string>,
): ClosedWork["report"] {
  if (!cites.every((id) => readable.has(id))) return undefined;
  if (row.by !== author && !cites.some((id) => readable.get(id) === labelJoined(row.compartments))) return undefined;
  const words: NonNullable<ClosedWork["report"]> = { findings: cites.slice(0, MOST_FINDINGS) };
  if (body.summary !== undefined) words.summary = { untrusted: body.summary };
  for (const name of ["deliverable", "next", "uncertain", "reason"] as const) {
    const text = body.report?.[name];
    if (text !== undefined) words[name] = { untrusted: text };
  }
  return words;
}

const byOf = (by: string, author: string): ClosedWork["by"] =>
  by === author ? "you" : by === "owner" ? "owner" : by.startsWith("client:") ? "agent" : "system";

// A page's place: the last row's time and an md5 of its id salted by the caller, never the id, which a
// client with handles is not given, and nothing two clients could compare. Over rows the token returned, so
// it says nothing of any other. A date that does not exist is refused here, not by the database.
const CURSOR =
  /^([1-9]\d{3}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?[+-](?:0\d|1[0-5])(?::[0-5]\d)?\|([0-9a-f]{32})$/;
const cursorOf = (row: Row): string => Buffer.from(`${row.at_text}|${row.tie}`).toString("base64url");
function placeOf(after: string | undefined): [string | null, string | null] | null {
  if (after === undefined) return [null, null];
  const text = Buffer.from(after, "base64url").toString();
  const found = CURSOR.exec(text);
  const day = found?.[1];
  const tie = found?.[2];
  if (day === undefined || tie === undefined) return null;
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
  return [text.slice(0, text.indexOf("|")), tie];
}

export async function closedBoard(
  { client, ctx }: WorkCall,
  limit: number,
  filter: { tier: WorkTier | null; role: RoleName | null },
  after?: string,
): Promise<Done<Result<"list_opportunities">>> {
  const author = `client:${client.id}`;
  const place = placeOf(after);
  if (place === null) return refused("invalid_request");
  const found = await ctx.run<Row>(ROWS, [author, [...ENDED], limit + 1, filter.tier, filter.role, ...place]);
  const rows = found.slice(0, limit);
  const last = rows.at(-1);
  const next = found.length > limit && last !== undefined ? cursorOf(last) : undefined;
  const ids = rows.map((row) => row.id);
  const built = await opportunityViews(ctx, ids, new Set(rows.filter((row) => row.owned).map((row) => row.id)));
  const opened = new Map(
    (await ctx.run<ReportRow>(REPORTS, [ids])).flatMap((row) => {
      const one = openReport(ctx, row);
      return one === null ? [] : [[row.opportunity_id, one] as const];
    }),
  );
  const readable = new Map(
    (
      await ctx.run<{ id: string; compartments: string[] }>(READABLE, [
        [...opened.values()].flatMap((one) => one.cites),
      ])
    ).map((one) => [one.id, labelJoined(one.compartments)]),
  );
  const page = rows.flatMap((row) => {
    const one = built.get(row.id);
    if (one === undefined) return [];
    const found = opened.get(row.id);
    const report = found === undefined ? undefined : wordsOf(found, author, readable);
    const closed: ClosedWork = {
      at: stamp(row.at) as ClosedWork["at"],
      by: byOf(row.by, author),
      ...(row.code === "failed" ? { failed: true as const } : {}),
      ...(report === undefined ? {} : { report }),
    };
    return [{ view: { ...one.view, closed }, shown: [...one.shown, ...(report?.findings ?? [])], goals: one.goals }];
  });
  return {
    outcome: {
      ok: true,
      value: { opportunities: page.map(({ view }) => view), ...(next === undefined ? {} : { next }) },
    },
    rows: page.length,
    shown: [...new Set(page.flatMap(({ shown }) => shown))],
    goals: [...new Set(page.flatMap(({ goals }) => goals))],
  };
}
