import {
  type ClientName,
  type MoveReport,
  type MoveReportBody,
  PROGRESS_LINES,
  PROJECT_REPORTS_LISTED,
  type RoleName,
  type WorkProgress,
  type WorkTrail,
} from "@intelligence/contracts/personal";
import { stamp } from "./db.ts";
import { type Ctx, servedOrNull } from "./read-ctx.ts";
import { openedReport } from "./work-refs.ts";

// Progress on work that lasts days: what a progress report keeps, the body it is sealed as, and the
// latest one on each piece of work, as every reader of it serves it (the brief, the pack's my_work,
// the board).
//
// A progress report is a `reported` event on its move with the code `progress`, its lines sealed
// under the work's own label and bound to `<move id>/reported`, as any report is. Its body is a
// MoveReportBody holding only the four progress fields and the request that made it, so a reader
// of reports opens it as one and a repeat of the request is known.

type Lines = Pick<MoveReport, "done" | "next" | "waitingOn" | "resumeAt">;

export const filled = (text: string | undefined): text is string => text !== undefined && text.trim().length > 0;

// What a progress report keeps of its `report`: the lines done, each filled, and the next step,
// what it waits on and when it resumes, where given. Null when it says neither what is done nor
// what comes next, or its next step is not one line of at most 500 code points.
export function progressLines(report: MoveReport | undefined): Lines | null {
  const done = (report?.done ?? []).filter(filled);
  const next = filled(report?.next) ? report.next.trim() : undefined;
  if (done.length === 0 && next === undefined) return null;
  if (next !== undefined && (/[\n\r]/.test(next) || [...next].length > 500)) return null;
  return {
    ...(done.length === 0 ? {} : { done }),
    ...(next === undefined ? {} : { next }),
    ...(filled(report?.waitingOn) ? { waitingOn: report.waitingOn } : {}),
    ...(report?.resumeAt === undefined ? {} : { resumeAt: report.resumeAt }),
  };
}

// The text a progress report is sealed as, with the request that made it.
export const progressBody = (lines: Lines, request: string): string =>
  JSON.stringify({ v: 1, report: lines, marks: [], request } satisfies MoveReportBody);

// A progress report's opened text as it is served: every line the agent's own, untrusted.
export function openedProgress(text: string, at: Date, by: string): WorkProgress {
  const report = openedReport(text).report;
  const line = (value: string | undefined) => (value === undefined ? null : { untrusted: value });
  return {
    done: (report?.done ?? []).slice(0, PROGRESS_LINES).map((untrusted) => ({ untrusted })),
    next: line(report?.next),
    waitingOn: line(report?.waitingOn),
    resumeAt: report?.resumeAt ?? null,
    at: stamp(at),
    by: by as ClientName,
  };
}

// The latest progress on each piece of work named that the caller can see, by the work's id. The
// database picks the event and joins the reporter's name (ledger.work_progress); the lines are
// opened here under the event's label. One whose key the call was not given is left out.
const PROGRESS =
  "select opportunity_id, move_id, at, by_name, compartments, body_enc from ledger.work_progress($1::text[])";

export async function progressOf(ctx: Ctx, ids: readonly string[]): Promise<Map<string, WorkProgress>> {
  const found = new Map<string, WorkProgress>();
  if (ids.length === 0) return found;
  const rows = await ctx.run<{
    opportunity_id: string;
    move_id: string;
    at: Date;
    by_name: string;
    compartments: string[];
    body_enc: unknown;
  }>(PROGRESS, [ids]);
  for (const row of rows) {
    const text = servedOrNull(
      ctx.keys,
      row.compartments,
      { table: "ledger.record_events", id: `${row.move_id}/reported`, column: "body_enc" },
      row.body_enc,
    );
    if (text !== null) found.set(row.opportunity_id, openedProgress(text.untrusted, row.at, row.by_name));
  }
  return found;
}

// How each piece of work named went, within the caller's label (ledger.work_trail): its last
// progress reports, its latest check-back and its latest hand-off, by the work's id. A report or a
// note whose key the call was not given is left out; the check-back's due time is served without
// its note.
const TRAIL =
  "select opportunity_id, kind, place, ref_id, at, by_name, due_at, code, role, compartments, body_enc from ledger.work_trail($1::text[], $2::integer)";

export async function trailOf(ctx: Ctx, ids: readonly string[]): Promise<Map<string, WorkTrail>> {
  const found = new Map<string, WorkTrail>();
  if (ids.length === 0) return found;
  const rows = await ctx.run<{
    opportunity_id: string;
    kind: "progress" | "check_back" | "hand_off";
    place: number;
    ref_id: string | null;
    at: Date;
    by_name: string;
    due_at: Date | null;
    code: string | null;
    role: string | null;
    compartments: string[];
    body_enc: unknown;
  }>(TRAIL, [ids, PROJECT_REPORTS_LISTED]);
  const reports = new Map<string, { place: number; report: WorkProgress }[]>();
  for (const row of rows) {
    const trail = found.get(row.opportunity_id) ?? {};
    found.set(row.opportunity_id, trail);
    const by = row.by_name as ClientName;
    if (row.kind === "hand_off") {
      trail.handOff = {
        at: stamp(row.at),
        by,
        to: row.role as RoleName | null,
        reason: row.role === "owner" ? null : (row.code as NonNullable<WorkTrail["handOff"]>["reason"]),
      };
    } else if (row.kind === "check_back" && row.due_at !== null && row.ref_id !== null) {
      trail.checkBack = {
        dueAt: stamp(row.due_at),
        note:
          row.body_enc === null
            ? null
            : servedOrNull(
                ctx.keys,
                row.compartments,
                { table: "ledger.intentions", id: row.ref_id, column: "body_enc" },
                row.body_enc,
              ),
        by,
        waiting: row.code === "set",
      };
    } else if (row.kind === "progress") {
      const text = servedOrNull(
        ctx.keys,
        row.compartments,
        { table: "ledger.record_events", id: `${row.ref_id}/reported`, column: "body_enc" },
        row.body_enc,
      );
      if (text === null) continue;
      const listed = reports.get(row.opportunity_id) ?? [];
      reports.set(row.opportunity_id, listed);
      listed.push({ place: row.place, report: openedProgress(text.untrusted, row.at, row.by_name) });
    }
  }
  for (const [id, listed] of reports) {
    const trail = found.get(id);
    if (trail !== undefined) trail.reports = listed.sort((a, b) => a.place - b.place).map((one) => one.report);
  }
  return found;
}
