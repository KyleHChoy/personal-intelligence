import type {
  IntentionId,
  MoveId,
  OpportunityStatus,
  PersonalLogger,
  SamePersonRefused,
  WatchRef,
  WorkStateRefusal,
} from "@intelligence/contracts/personal";
import { OPEN_STATUSES, OpportunityId } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { stamp } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { latestEvent, moveStatus } from "../core/statements.ts";
import { heldAmong } from "../core/work-held.ts";
import { progressBody, progressLines } from "../core/work-progress.ts";
import {
  type Args,
  answered,
  type Done,
  invalidAs,
  isRefused,
  OWN_CLEARED_MOVE,
  openedReport,
  pinned,
  type Result,
  refIds,
  refKinds,
  refused,
  refusedAs,
  sealSummary,
  value,
  type WorkCall,
} from "../core/work-refs.ts";
import { opportunityViews } from "../core/work-views.ts";
import { servedOrNull } from "../read/read-ctx.ts";
import { writeCardAnswer } from "./card-attempt-report.ts";
import { writeSettlement } from "./dream-settle.ts";
import { appendFill, fillRefs } from "./research-fill.ts";
import { writeAnswers } from "./same-person-report.ts";
import { watchSeen } from "./work-expects.ts";
import { type Checked, checkReport, MOVE } from "./work-report.ts";

// Moves on the work a caller holds: plan_move, report_move (the report checked, an explore task's
// fill under its own savepoint, the watches; or its progress) and set_intention.

// A report and its fill, one or neither.
const ANSWERS_SAVEPOINT = "savepoint report_answers";
const ANSWERS_ROLLBACK = "rollback to savepoint report_answers";
const FILL_SAVEPOINT = "savepoint report_fill";
const FILL_RELEASE = "release savepoint report_fill";
const FILL_ROLLBACK = "rollback to savepoint report_fill";

// The statements, one for each function, with every argument typed.
const SQL = {
  recordSpend: "select ledger.record_spend($1::text, $2::text, $3::text, $4::bigint, $5::integer, $6::integer) as go",
  planMove: "select ledger.plan_move($1::text, $2::text, $3::text, $4::text, $5::text, $6::integer, $7::text) as id",
  // With the lessons the report names; `dropped`, those no brief of the session served.
  reportMove:
    "select status, dropped from ledger.report_move($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text[], $7::text[], $8::text[])",
  // With its note, sealed, or none.
  setIntention:
    "select ledger.set_intention($1::text, $2::text, $3::text, $4::text, $5::timestamptz, $6::boolean, $7::boolean, $8::jsonb) as id",
  // A move's watches.
  addWatches: "select ledger.add_watches($1::text, $2::text, $3::text[], $4::text[]) as added",
} as const;

// The evidence a move cites to watch, on the move just cleared or
// reported. Null, or a refusal of the call.
async function addWatch(
  call: WorkCall,
  move: string,
  watch: readonly WatchRef[] | undefined,
): Promise<Done<never> | null> {
  if (watch === undefined) return null;
  const { session, fn } = call;
  const rows = await fn<{ added: number }>(SQL.addWatches, [move, await session(), refKinds(watch), refIds(watch)]);
  return isRefused(rows) ? refused(rows) : null;
}

export async function planMove(call: WorkCall, valid: Args<"plan_move">): Promise<Done<Result<"plan_move">>> {
  const { ctx, session, fn } = call;
  if (valid.watch !== undefined && !(await watchSeen(ctx, valid.watch))) return refused("not_found");
  const point = pinned("move_clear");
  const rows = await fn<{ id: string | null }>(SQL.planMove, [
    newId("mov"),
    valid.opportunity,
    valid.stage,
    valid.requestId,
    await session(),
    point.version,
    point.hash,
  ]);
  if (isRefused(rows)) return refused(rows);
  const move = value(rows, "id");
  if (move === null) return refused("not_permitted");
  if (move.startsWith("refused:"))
    return {
      outcome: { ok: false, code: "not_permitted", refusal: move.slice("refused:".length) as WorkStateRefusal },
      rows: 0,
    };
  return (await addWatch(call, move, valid.watch)) ?? answered({ move: move as MoveId });
}

// A report the database did not keep, on the caller's own move: told by the work's state and the
// caller's own lease, as ledger.report_move reads them, since a report is what an agent loses if it
// takes a not_found to mean nothing happened. A lease it still holds is some other cause, a plain
// not_found.
const REPORT_STATE = `
  select (${latestEvent("opportunity", "$1")}) as status,
    exists (select 1 from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = $1
            and l.holder = (select c.id from policy.current_client() c) and ($2 <> 'task' or l.lease_until >= now())) as held`;

// The caller's own move's status: one no longer cleared takes no report.
const MOVE_STATUS = `select (${moveStatus("$1")}) as status`;

// `live`: the report needed a live lease whatever the work's tier, as progress does.
async function reportNotKept<T>(call: WorkCall, move: string, live = false): Promise<Done<T>> {
  const [own] = await call.ctx.run<{ opportunity_id: string; tier: string }>(MOVE, [move]);
  if (own === undefined) return refused("not_found");
  // First, as the function reads it first: a move already reported, or closed failed when the
  // caller's lease ended, is closed, whatever the work's state now.
  const [at] = await call.ctx.run<{ status: string | null }>(MOVE_STATUS, [move]);
  if (at?.status != null && at.status !== "cleared") return refusedAs("move_closed");
  const [state] = await call.ctx.run<{ status: OpportunityStatus | null; held: boolean }>(REPORT_STATE, [
    own.opportunity_id,
    live ? "task" : own.tier,
  ]);
  if (state?.status == null) return refused("not_found");
  if (!OPEN_STATUSES.includes(state.status)) return refusedAs("work_closed");
  return state.held ? refused("not_found") : refusedAs("work_not_held");
}

// The caller's own move with its work's label, which a progress report is sealed under.
const PROGRESS_MOVE = `
  select o.compartments from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id
  where m.id = $1
    and ${OWN_CLEARED_MOVE}`;

// The caller's own latest progress report on a move, which holds the request that made it.
const LAST_PROGRESS = `
  select r.compartments, r.body_enc from ledger.record_events r
  where r.row_kind = 'move' and r.row_id = $1 and r.event = 'reported' and r.code = 'progress' and r.tainted_at is null
    and r.by = 'client:' || (select c.id from policy.current_client() c)
  order by r.id desc
  limit 1`;

// Progress on a move: what is done, what comes next, what it waits on and when it resumes, sealed
// under the work's label, so whoever sees the work reads where it stands. The move stays open and
// the work claimed. One that says neither what is done nor what comes next is answered with the
// code and records nothing. A repeat of the request that made the caller's latest report on the
// move answers as that one did and writes nothing.
async function reportProgress(
  call: WorkCall,
  valid: Args<"report_move">,
  log: PersonalLogger,
): Promise<Done<Result<"report_move">>> {
  const { ctx, session, fn } = call;
  const [move] = await ctx.run<{ compartments: string[] }>(PROGRESS_MOVE, [valid.move]);
  if (move === undefined) return refused("not_found");
  const lines = progressLines(valid.report);
  if (lines === null) {
    log.info({ event: "report_refused", code: "needs_progress", counts: { codes: 1 } });
    return { outcome: { ok: true, value: { move: valid.move, refused: ["needs_progress"] } }, rows: 0, refused: true };
  }
  const at = { table: "ledger.record_events", id: `${valid.move}/reported`, column: "body_enc" };
  const [last] = await ctx.run<{ compartments: string[]; body_enc: unknown }>(LAST_PROGRESS, [valid.move]);
  const kept = last === undefined ? null : servedOrNull(ctx.keys, last.compartments, at, last.body_enc);
  if (kept !== null && openedReport(kept.untrusted).request === valid.requestId)
    return answered({ move: valid.move, opportunity: "claimed" });
  const body = sealSummary(ctx, move.compartments, at, progressBody(lines, valid.requestId));
  const rows = await fn<{ status: OpportunityStatus | null }>(SQL.reportMove, [
    valid.move,
    "progress",
    valid.requestId,
    await session(),
    body,
    [],
    [],
    [],
  ]);
  if (isRefused(rows)) return refused(rows);
  const status = value(rows, "status");
  if (status === null) return reportNotKept(call, valid.move, true);
  log.info({ event: "progress_reported", counts: { done: lines.done?.length ?? 0 } });
  return answered({ move: valid.move, opportunity: status });
}

// The caller's own cleared move on a task: the task's id.
const TASK_OF_MOVE = `
  select o.id from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id
  where m.id = $1 and o.tier = 'task'
    and ${OWN_CLEARED_MOVE}`;
const WAIT_SAVEPOINT = "savepoint report_waiting";
const WAIT_ROLLBACK = "rollback to savepoint report_waiting";
const WAIT_DAYS = 7;
// A text as one progress line: its first line, at most 500 code points.
const oneLine = (text: string): string => [...(text.trim().split(/[\n\r]/)[0] ?? "")].slice(0, 500).join("");

// A task reported blocked with what it waits on: the work is not given up. Its report is kept as
// progress (what is done, the next step or the reason, what it waits on), and a check-back holds
// the work for the caller to `report.resumeAt`, or for WAIT_DAYS, with what it waits on as the
// note. Both or neither: a time the check-back refuses takes the progress back. Null for work that
// is no task of the caller's, which is reported as any blocked move is.
async function reportWaiting(
  call: WorkCall,
  valid: Args<"report_move">,
  log: PersonalLogger,
  now: () => Date,
): Promise<Done<Result<"report_move">> | null> {
  const [task] = await call.ctx.run<{ id: string }>(TASK_OF_MOVE, [valid.move]);
  if (task === undefined) return null;
  const report = valid.report ?? {};
  const waitingOn = (report.waitingOn ?? "").trim();
  const heldUntil = report.resumeAt ?? stamp(new Date(now().getTime() + WAIT_DAYS * DAY_MS));
  await call.ctx.run(WAIT_SAVEPOINT, []);
  const kept = await reportProgress(
    call,
    {
      ...valid,
      outcome: "progress",
      report: {
        ...(report.done === undefined ? {} : { done: report.done }),
        next: oneLine(report.next ?? report.reason ?? `Waiting on: ${waitingOn}`),
        waitingOn,
        resumeAt: heldUntil,
      },
    },
    log,
  );
  if (!kept.outcome.ok || !("opportunity" in kept.outcome.value)) return kept;
  const held = await setIntention(call, {
    opportunity: OpportunityId.parse(task.id),
    dueAt: heldUntil,
    note: waitingOn,
    requestId: valid.requestId,
  });
  if (!held.outcome.ok) {
    await call.ctx.run(WAIT_ROLLBACK, []);
    return { outcome: held.outcome, rows: 0 };
  }
  log.info({ event: "blocked_held" });
  return answered({ move: valid.move, opportunity: "claimed", heldUntil: heldUntil });
}

type Reported = Done<Result<"report_move">>;
type Accepted = Exclude<Checked, { refused: unknown }>;

// A report answered with refusal codes, which records nothing.
const refusedReport = (
  move: MoveId,
  codes: NonNullable<Extract<Result<"report_move">, { refused?: unknown }>["refused"]>,
  samePersonRefused?: SamePersonRefused[],
): Reported => ({
  outcome: {
    ok: true,
    value: { move, refused: codes, ...(samePersonRefused === undefined ? {} : { samePersonRefused }) },
  },
  rows: 0,
  refused: true,
});

export async function reportMove(
  call: WorkCall,
  valid: Args<"report_move">,
  log: PersonalLogger,
  now: () => Date,
): Promise<Reported> {
  const { client, ctx, session, fn } = call;
  if (valid.outcome === "progress") return reportProgress(call, valid, log);
  if (valid.outcome === "blocked" && valid.report?.waitingOn !== undefined && valid.report.waitingOn.trim() !== "") {
    const waiting = await reportWaiting(call, valid, log, now);
    if (waiting !== null) return waiting;
  }
  const outcome = valid.outcome;
  // What done means for the opportunity's kind. A report that lacks it is
  // answered with the codes and records nothing.
  const checked = await checkReport(call, { ...valid, outcome }, now());
  if ("refused" in checked) {
    log.info({
      event: "report_refused",
      code: checked.refused[0],
      counts: { codes: checked.refused.length },
    });
    return refusedReport(valid.move, checked.refused, checked.samePersonRefused);
  }
  // The report's own event on the move, under the reporter's clearance. It has no id of its own
  // before it is written; the move's id and the word bind it. Every watched ref one the caller
  // sees, before the report.
  if (valid.watch !== undefined && !(await watchSeen(ctx, valid.watch))) return refused("not_found");
  const body =
    checked.body === null
      ? null
      : sealSummary(
          ctx,
          client.compartments,
          { table: "ledger.record_events", id: `${valid.move}/reported`, column: "body_enc" },
          checked.body,
        );
  const basis = valid.basis ?? [];
  // A fill names only what the caller's token shows (its sources become the record's cites); a
  // hidden id, a handle, is answered as an absent one, before anything is written. A fill lands
  // with its report or neither does.
  const fillCites = checked.fill === undefined ? null : await fillRefs(ctx, checked.fill.fill);
  if (checked.fill !== undefined && fillCites === null) return refused("not_found");
  if (checked.fill !== undefined) await ctx.run(FILL_SAVEPOINT, []);
  const samePersonRefused: SamePersonRefused[] = [];
  if (checked.samePerson !== undefined) {
    const first = await samePersonFirst(call, log, valid, checked.samePerson);
    if ("done" in first) return first.done;
    samePersonRefused.push(...first.refused);
  }
  // A card_question task's answer, before the report it belongs to.
  const card = checked.card;
  if (card !== undefined) {
    const write = () => writeCardAnswer(ctx, { ...card, move: valid.move }, valid.requestId);
    const { code, stop } = await answerFirst(call, valid.move, write, "card_answer_refused");
    if (stop !== null) {
      log.info({ event: "card_answer_refused", code });
      return stop;
    }
    log.info({ event: "card_answered", code });
  }
  // A dream_finding task's settlement, in the report's transaction, as a card's answer is.
  const settle = checked.settle;
  if (settle !== undefined) {
    const write = () => writeSettlement(ctx, { ...settle, move: valid.move }, valid.requestId);
    const { code, stop } = await answerFirst(call, valid.move, write, "settle_refused");
    if (stop !== null) {
      log.info({ event: "settle_refused", code });
      return stop;
    }
    log.info({ event: "belief_settled", code });
  }
  const rows = await fn<{ status: OpportunityStatus | null; dropped: number | null }>(SQL.reportMove, [
    valid.move,
    outcome,
    valid.requestId,
    await session(),
    body,
    refKinds(basis),
    refIds(basis),
    valid.lessonsApplied ?? [],
  ]);
  // A report that does not land takes its answers with it.
  if (
    (checked.samePerson !== undefined || checked.card !== undefined || checked.settle !== undefined) &&
    (isRefused(rows) || value(rows, "status") === null)
  )
    await ctx.run(ANSWERS_ROLLBACK, []);
  if (isRefused(rows)) return refused(rows);
  const status = value(rows, "status");
  if (status === null) return reportNotKept(call, valid.move);
  if (checked.fill !== undefined) {
    const stop = await landFill(call, log, checked.fill, fillCites?.cites ?? [], valid.requestId);
    if (stop !== null) return stop;
  }
  const watched = await addWatch(call, valid.move, valid.watch);
  if (watched !== null) return watched;
  for (const mark of checked.marks) log.info({ event: "report_marked", code: mark });
  // Advisory: the count of named lessons no brief of the session served.
  const dropped = value(rows, "dropped");
  return answered({
    move: valid.move,
    opportunity: status,
    ...(checked.marks.length === 0 ? {} : { marks: checked.marks }),
    ...(dropped === null ? {} : { dropped }),
    ...(samePersonRefused.length === 0 ? {} : { samePersonRefused }),
  });
}

// A same_person task's answers, before the report whose done they make good, and in its
// transaction. The report ends when one stops them or none had evidence; otherwise the answers
// refused go with the report.
async function samePersonFirst(
  { ctx }: WorkCall,
  log: PersonalLogger,
  valid: Args<"report_move">,
  samePerson: NonNullable<Accepted["samePerson"]>,
): Promise<{ done: Reported } | { refused: SamePersonRefused[] }> {
  await ctx.run(ANSWERS_SAVEPOINT, []);
  const written = await writeAnswers(ctx, samePerson, valid.requestId);
  const samePersonRefused = [...samePerson.refused, ...written.refused];
  if (written.stop !== null) {
    await ctx.run(ANSWERS_ROLLBACK, []);
    log.info({ event: "same_person_refused", code: written.stop });
    return { done: written.stop === "not_found" ? refused("not_found") : refusedAs("work_not_held") };
  }
  if (written.taken === 0) {
    await ctx.run(ANSWERS_ROLLBACK, []);
    log.info({ event: "same_person_refused", code: "no_evidence" });
    return { done: refusedReport(valid.move, ["same_person_no_evidence"], samePersonRefused) };
  }
  return { refused: samePersonRefused };
}

// A task's answer written before the report it belongs to and in its transaction: one the definer
// will not take is rolled back and refuses the report (`stop`, with `refusal` its code), and nothing
// is written. `stop` is null when it was taken.
async function answerFirst(
  { ctx }: WorkCall,
  move: MoveId,
  write: () => Promise<string>,
  refusal: "card_answer_refused" | "settle_refused",
): Promise<{ code: string; stop: Reported | null }> {
  await ctx.run(ANSWERS_SAVEPOINT, []);
  const code = await write();
  if (code !== "ok" && code !== "settled") {
    await ctx.run(ANSWERS_ROLLBACK, []);
    return { code, stop: code === "not_found" ? refusedAs("work_not_held") : refusedReport(move, [refusal]) };
  }
  return { code, stop: null };
}

// The explore task's fill, appended as the agent's record in the report's transaction; refused (its
// label wider than the node's, its quota spent), the report is undone with it. Null when it landed.
async function landFill(
  { ctx }: WorkCall,
  log: PersonalLogger,
  fill: NonNullable<Accepted["fill"]>,
  cites: NonNullable<Awaited<ReturnType<typeof fillRefs>>>["cites"],
  requestId: string,
): Promise<Reported | null> {
  const appended = await appendFill(ctx, { node: fill.node, fill: fill.fill, cites, requestId });
  if ("code" in appended) {
    await ctx.run(FILL_ROLLBACK, []);
    log.info({ event: "fill_refused", code: appended.code });
    if (appended.code === "read_removed") return refusedAs("session_renewed");
    return refused(
      appended.code === "rate_limited"
        ? "invalid_request"
        : appended.code === "not_found"
          ? "not_found"
          : "not_permitted",
    );
  }
  await ctx.run(FILL_RELEASE, []);
  log.info({ event: "fill_appended", counts: { dropped: fill.dropped } });
  return null;
}

// One model call's cost, and whether the caller may go on: under the day's budget and run limit,
// with the kill switch off.
export async function recordSpend(
  { session, fn }: WorkCall,
  valid: Args<"record_spend">,
): Promise<Done<Result<"record_spend">>> {
  const rows = await fn<{ go: boolean }>(SQL.recordSpend, [
    valid.requestId,
    await session(),
    valid.modelId,
    valid.costMicroUsd,
    valid.inputTokens ?? null,
    valid.outputTokens ?? null,
  ]);
  if (isRefused(rows)) return refused(rows);
  return answered({ go: rows[0]?.go === true });
}

// A check-back on work the caller holds, or held within 24 hours; its note, why the work waits,
// sealed under the caller's clearance, the intention's own label, and bound to the intention.
// Which bound a check-back's time broke, on the transaction's own clock, as the function reads it.
const DUE_FAULT = `
  select $1::timestamptz < now() + interval '1 hour' as soon,
    $1::timestamptz > now() + case when $2::boolean then interval '30 days' else interval '90 days' end as far`;
// How many of the caller's own check-backs wait on the work: the intention policy returns its own.
const WAITING = `
  select count(*)::int as n from ledger.intentions i
  where i.opportunity_id = $1 and i.kind = 'check_back' and (${latestEvent("intention", "i.id")}) = 'set'`;

// Why a check-back on work the caller sees was not set, from the work's view and whether the
// caller holds it by its own rows (work-held.ts), as ledger.set_intention reads them. A cause that
// is neither stays a plain not_found.
async function intentionNotSet<T>(ctx: WorkCall["ctx"], valid: Args<"set_intention">): Promise<Done<T>> {
  const seen = (await opportunityViews(ctx, [valid.opportunity])).get(valid.opportunity)?.view;
  if (seen === undefined) return refused("not_found");
  if (!OPEN_STATUSES.includes(seen.status)) return refusedAs("work_closed");
  if (!(await heldAmong(ctx, [valid.opportunity])).has(valid.opportunity)) return refusedAs("work_not_held");
  return refused("not_found");
}

export async function setIntention(
  { client, ctx, session, fn }: WorkCall,
  valid: Args<"set_intention">,
): Promise<Done<Result<"set_intention">>> {
  const id = newId("itn");
  const note =
    valid.note === undefined
      ? null
      : sealSummary(ctx, client.compartments, { table: "ledger.intentions", id, column: "body_enc" }, valid.note);
  const rows = await fn<{ id: string | null }>(SQL.setIntention, [
    id,
    valid.requestId,
    await session(),
    valid.opportunity,
    valid.dueAt,
    valid.keepEarlier === true,
    // A check-back holds the work unless the caller says otherwise (A5).
    valid.park !== false,
    note,
  ]);
  // The function refuses the time or the count only on work the caller holds or held: its time
  // too soon, too far or past the work's own expiry, or three of the caller's own check-backs kept
  // and waiting already.
  if (rows === "invalid_request") {
    const [due] = await ctx.run<{ soon: boolean; far: boolean }>(DUE_FAULT, [valid.dueAt, valid.park !== false]);
    if (due?.soon === true) return invalidAs("due_too_soon");
    if (due?.far === true) return invalidAs("due_too_far");
    // Neither bound: three of the caller's own kept and waiting, else a time past the work's own
    // expiry, the one cause left (the reader holds no row of the owner's go to say when).
    const [waiting] = valid.keepEarlier === true ? await ctx.run<{ n: number }>(WAITING, [valid.opportunity]) : [];
    return (waiting?.n ?? 0) >= 3 ? invalidAs("check_backs_full") : invalidAs("due_past_expiry");
  }
  if (isRefused(rows)) return refused(rows);
  const made = value(rows, "id");
  // The owner stopped all agent work, or the caller holds as much work by check-back as one client
  // may (ledger.set_intention's two codes): said so, from the stop and the caller's own count.
  if (made === "kill_switch" || made === "holds_full") return refusedAs(made);
  return made === null ? intentionNotSet(ctx, valid) : answered({ intention: made as IntentionId });
}
