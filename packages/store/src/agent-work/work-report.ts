import {
  type AgentRecordId,
  doneRequires,
  type EntityId,
  ExploreMissing,
  type Fill,
  keptFill,
  type MoveReport,
  type MoveReportBody,
  type OpportunityKind,
  type ReportCheckCode,
  type ReportMark,
  type ReportSource,
  type SamePersonAnswer,
  type SamePersonRefused,
  type Stage,
  type WorkRef,
  type WorkTier,
} from "@intelligence/contracts/personal";
import { filled } from "../core/work-progress.ts";
import { OWN_CLEARED_MOVE, type WorkCall } from "../core/work-refs.ts";
import { findPaths } from "../read/read-paths.ts";
import { readableFill } from "./research-fill.ts";
import { answersChecked } from "./same-person-report.ts";

// What "done" means for a move, checked in the store before ledger.report_move,
// which cannot read a sealed report; the body a report is sealed as; and how a reader opens it.

// The move the caller reports, as its token returns it, and only one it planned (its `cleared`
// event is by the caller; pi_reader is not granted ledger.moves.created_by): none for another
// client's move or one it cannot see, which the function then answers as not_found, so a check's
// codes never tell of a move that is not the caller's.
export const MOVE = `
  select m.stage, o.id as opportunity_id, o.kind, o.tier, o.about_kind, o.about_id, o.gap_trigger, o.gap_subject, o.gap_missing from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id
  where m.id = $1
    and ${OWN_CLEARED_MOVE}`;

// A finding alone; a proposal is not, so an agent with nothing new to write reports failed rather
// than proposing something to close the task. The database's own check in ledger.report_move still
// takes a proposal too, a looser backstop under this one. The reader is granted the writer's name,
// not its id.
const WRITTEN_BACK = `
  select exists (
    select 1 from ledger.agent_writes w
    where w.id = any($1::text[]) and w.client_name = (select c.name from policy.current_client() c)
      and w.kind = 'finding' and w.body_enc is not null
      and w.created_at >= (select min(r.at) from ledger.record_events r
                           where r.row_kind = 'opportunity' and r.row_id = $2 and r.event = 'claimed'
                             and r.by = 'client:' || (select c.id from policy.current_client() c))) as written`;

// The most entities a report's path check walks from: a bound for sanity, logged when reached.
const MAX_PATH_CHECKS = 20;

type ReportArgs = {
  move: string;
  outcome: "done" | "failed" | "blocked";
  summary?: string | undefined;
  basis?: WorkRef[] | undefined;
  report?: MoveReport | undefined;
};
type Move = {
  stage: Stage;
  opportunity_id: string;
  kind: OpportunityKind;
  tier: WorkTier;
  about_kind: string;
  about_id: string | null;
  gap_trigger?: string | null;
  gap_subject?: string | null;
  gap_missing?: string[] | null;
};

// Only an explore task's done report keeps one.
export function fillOf(move: Move, args: ReportArgs): { fill: Fill | null; dropped: number } {
  const given = args.report?.fill;
  if (given === undefined || move.gap_trigger !== "explore" || args.outcome !== "done")
    return { fill: null, dropped: 0 };
  const listed = keptFill(
    given,
    (move.gap_missing ?? []).flatMap((one) => (ExploreMissing.safeParse(one).success ? [one as ExploreMissing] : [])),
  );
  if (listed.fill === null) return listed;
  const read = readableFill(listed.fill);
  return { fill: read.fill, dropped: listed.dropped + read.dropped };
}

// The codes a report is refused with: none for one that may be recorded. `wroteBack`: whether it
// cites a write-back, asked only of a task's last stage.
export function reportRefusals(move: Move, args: ReportArgs, wroteBack = false): ReportCheckCode[] {
  if (args.report?.fill !== undefined && move.gap_trigger !== "explore") return ["fill_not_explore"];
  if (args.report?.samePerson !== undefined && move.gap_trigger !== "same_person") return ["same_person_not_asked"];
  if (args.report?.card !== undefined && (move.gap_trigger !== "card_question" || args.outcome !== "done"))
    return ["card_not_asked"];
  // A settlement only on a dream_finding task's done report, of its own finding.
  const settle = args.report?.settle;
  if (
    settle !== undefined &&
    (move.gap_trigger !== "dream_finding" || args.outcome !== "done" || settle.finding !== move.gap_subject)
  )
    return ["settle_not_asked"];
  if (args.outcome === "done" && move.gap_trigger === "same_person")
    return (args.report?.samePerson ?? []).length === 0 ? ["needs_same_person"] : [];
  if (args.outcome !== "done") return filled(args.report?.reason) || filled(args.summary) ? [] : ["needs_reason"];
  const codes: ReportCheckCode[] = [];
  if (move.gap_trigger === "card_question" && args.report?.card === undefined) codes.push("needs_card_answer");
  if (move.gap_trigger === "dream_finding" && settle === undefined) codes.push("needs_settle");
  if (move.gap_trigger === "explore" && fillOf(move, args).fill === null) codes.push("needs_fill");
  for (const need of doneRequires(move.kind, move.stage, move.tier)) {
    if (need === "answer_owner_question") codes.push("ask_owner");
    if (need === "deliverable" && !filled(args.report?.deliverable)) codes.push("needs_deliverable");
    if (need === "next" && !filled(args.report?.next)) codes.push("needs_next");
    if (need === "draft" && !filled(args.report?.draft)) codes.push("needs_draft");
    if (need === "sources" && (args.report?.sources ?? []).length === 0) codes.push("needs_sources");
    if (need === "writeback" && !wroteBack) codes.push("needs_writeback");
  }
  return codes;
}

// People work found outside the owner's network (find_paths, under the caller's token). A report
// that names candidates is marked unless one of them is someone the owner has a path to: a name
// from a web page is none. Otherwise, an opportunity about a person or organization is marked when
// the people and organizations it checks (the one it is about and those its basis and sources cite)
// include one find_paths can route to and none has a path. find_paths routes to an organization
// through anyone at it, so an organization nobody the owner knows is at is marked too. A client
// without the people view, find_paths' own, has no path to show. Stated hops only: this runs inside a
// write's deadline, for up to MAX_PATH_CHECKS people, and says whether a stated route exists.
const entityIds = (refs: readonly (ReportSource | WorkRef)[]): string[] =>
  refs.flatMap((one) => (typeof one !== "string" && one.kind === "entity" ? [one.id] : []));

async function webOnly(call: WorkCall, move: Move, args: ReportArgs, now: Date): Promise<boolean> {
  const candidates = args.report?.candidates ?? [];
  const about = move.about_kind === "entity" && move.about_id !== null ? [move.about_id] : [];
  if (about.length === 0 && candidates.length === 0) return false;
  if (!call.client.views.includes("people")) return true;
  const named = candidates.length > 0;
  const entities = [
    ...new Set(
      named
        ? entityIds(candidates)
        : [...about, ...entityIds([...(args.basis ?? []), ...(args.report?.sources ?? [])])],
    ),
  ];
  if (entities.length > MAX_PATH_CHECKS)
    call.ctx.log.warn({
      event: "report_paths_capped",
      counts: { entities: entities.length, checked: MAX_PATH_CHECKS },
    });
  let people = 0;
  for (const target of entities.slice(0, MAX_PATH_CHECKS)) {
    const found = await findPaths(call.ctx, { target: target as EntityId }, now, { statedOnly: true });
    if (found === null) continue;
    if (found.value.paths.length > 0) return false;
    people += 1;
  }
  return named || people > 0;
}

// The agent records a report cites, in its sources, candidates or basis.
export const recordsCited = (args: Pick<ReportArgs, "report" | "basis">): AgentRecordId[] =>
  [...(args.report?.sources ?? []), ...(args.report?.candidates ?? []), ...(args.basis ?? [])].flatMap((one) =>
    typeof one !== "string" && one.kind === "agent_record" ? [one.id] : [],
  );

async function wroteBack(call: WorkCall, move: Move, args: ReportArgs): Promise<boolean> {
  const cited = recordsCited(args);
  if (cited.length === 0) return false;
  const [row] = await call.ctx.run<{ written: boolean }>(WRITTEN_BACK, [cited, move.opportunity_id]);
  return row?.written === true;
}

// The mark narrows nothing.
const SESSION_PATH = "select untrusted, sensitive from ledger.session_path($1)";

async function mixedSession(call: WorkCall): Promise<boolean> {
  const [row] = await call.ctx.run<{ untrusted: boolean; sensitive: boolean }>(SESSION_PATH, [await call.session()]);
  return row?.untrusted === true && row.sensitive === true;
}

// `fill`: an explore task's fill that lands, with its node and how many fields it dropped.
export type Checked =
  | { refused: ReportCheckCode[]; samePersonRefused?: SamePersonRefused[] }
  | {
      body: string | null;
      marks: ReportMark[];
      fill?: { node: string; fill: Fill; dropped: number };
      samePerson?: {
        opportunity: string;
        answers: SamePersonAnswer[];
        rows: ReadonlyMap<string, string[]>;
        refused: SamePersonRefused[];
      };
      // A card_question task's answer, written with the report. `cited`: the refs among the report's
      // sources, kept on an agent ruling the answer makes.
      card?: { opportunity: string; answer: string; cited: { kind: string; id: string }[] };
      // A dream_finding task's settlement, written with the report.
      settle?: { opportunity: string; finding: string; holds: "a" | "b"; cited: { kind: string; id: string }[] };
    };

// The refs a card answer's ruling keeps of a report's sources: a ref by id in the ruling's form, never
// a one-time handle, which is never stored, nor a page's address. ledger.answer_card refuses any other,
// so a source outside the form is left off the ruling rather than refusing the answer.
const CITED_KIND = /^[a-z][a-z0-9_]{0,31}$/;
const CITED_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const citedOf = (sources: readonly (string | { kind: string; id: string })[]): { kind: string; id: string }[] =>
  sources.flatMap((one) =>
    typeof one === "string" || one.id.startsWith("hdl_") || !CITED_KIND.test(one.kind) || !CITED_ID.test(one.id)
      ? []
      : [{ kind: one.kind, id: one.id }],
  );

// The report checked and, when it may be recorded, the text it is sealed as: a summary alone as
// its text, as older reports were; a report or a mark as MoveReportBody's JSON. A move the
// caller cannot see is not checked: the function answers it.
export async function checkReport(call: WorkCall, args: ReportArgs, now: Date): Promise<Checked> {
  const [move] = await call.ctx.run<Move>(MOVE, [args.move]);
  if (move === undefined) return { body: args.summary ?? null, marks: [] };
  const refused = reportRefusals(
    move,
    args,
    args.outcome === "done" &&
      doneRequires(move.kind, move.stage, move.tier).includes("writeback") &&
      (await wroteBack(call, move, args)),
  );
  if (refused.length > 0) return { refused };
  const marks: ReportMark[] = args.outcome === "done" && (await webOnly(call, move, args, now)) ? ["web_only"] : [];
  if (args.outcome === "done" && filled(args.report?.draft) && (await mixedSession(call))) marks.push("mixed_session");
  const answers = args.outcome === "done" ? args.report?.samePerson : undefined;
  let samePerson: Extract<Checked, { body: unknown }>["samePerson"];
  if (answers !== undefined) {
    const read =
      move.gap_subject == null
        ? { taken: answers, rows: new Map<string, string[]>(), refused: [] }
        : await answersChecked(call, move.gap_subject, answers);
    // Nothing to take: the report is refused, and names each pair.
    if (read.taken.length === 0)
      return {
        refused: [
          read.refused.every((one) => one.code === "not_asked") ? "same_person_not_asked" : "same_person_no_evidence",
        ],
        samePersonRefused: read.refused,
      };
    samePerson = { opportunity: move.opportunity_id, answers: read.taken, rows: read.rows, refused: read.refused };
  }
  const said = args.outcome === "done" && move.gap_trigger === "card_question" ? args.report?.card : undefined;
  const cited = citedOf(args.report?.sources ?? []);
  const card = said === undefined ? undefined : { opportunity: move.opportunity_id, answer: said.answer, cited };
  const settled = args.outcome === "done" && move.gap_trigger === "dream_finding" ? args.report?.settle : undefined;
  const settle =
    settled === undefined
      ? undefined
      : { opportunity: move.opportunity_id, finding: settled.finding, holds: settled.holds, cited };
  const landed = fillOf(move, args);
  const fill =
    landed.fill === null || move.about_kind !== "entity" || move.about_id === null
      ? undefined
      : { node: move.about_id, fill: landed.fill, dropped: landed.dropped };
  if (args.report === undefined && marks.length === 0) return { body: args.summary ?? null, marks };
  const body: MoveReportBody = {
    v: 1,
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    ...(args.report === undefined ? {} : { report: args.report }),
    marks,
  };
  return {
    body: JSON.stringify(body),
    marks,
    ...(fill === undefined ? {} : { fill }),
    ...(samePerson === undefined ? {} : { samePerson }),
    ...(card === undefined ? {} : { card }),
    ...(settle === undefined ? {} : { settle }),
  };
}
