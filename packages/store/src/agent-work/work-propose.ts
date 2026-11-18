import type {
  AgentRecordId,
  ExpectedOutcome,
  GoalProposalStatus,
  GoalTargetProposalStatus,
  HypothesisId,
  OpportunityId,
  OpportunityKind,
  OpportunityStatus,
  OwnerRequestQuote,
  OwnerRequestRef,
  PersonalLogger,
  ProposalDetails,
  ReadOutcome,
  TestId,
  WorkRef,
} from "@intelligence/contracts/personal";
import { PROPOSE_TASK_NEXT, TASK_KINDS } from "@intelligence/contracts/personal";
import { summaryStandsAlone } from "@intelligence/personal-core/checks";
import { secondDegreeRules } from "@intelligence/personal-core/views";
import { appendRecord } from "../agent-writes/record.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { goalProposalId, newId } from "../core/ids.ts";
import { TAINT_SHARED } from "../core/locks.ts";
import { orgNameFp } from "../core/org-names.ts";
import {
  type Args,
  aboutColumns,
  answered,
  type Done,
  derivedId,
  isRefused,
  pinned,
  type Refused,
  type Result,
  refIds,
  refKinds,
  refused,
  sealSummary,
  value,
  type WorkCall,
} from "../core/work-refs.ts";
import type { Ctx } from "../read/read-ctx.ts";
import { namedOrgState, withheldNamed } from "../read/read-named.ts";
import { ENTITY_OR_PROJECT } from "../read/read-tools.ts";
import { type BuiltExpectation, buildExpectations, expectationsOf } from "./work-expects.ts";
import { payQuestion, unpaid } from "./work-questions.ts";

// The proposal tools: propose_hypothesis, record_test, propose_opportunity, propose_task and
// propose_goal. A proposal's summary must stand alone; the owner's quoted requests, a new row's
// details and its expectations are written in the proposal's own transaction.

// The statements, one for each function, with every argument typed.
const SQL = {
  taintShared: TAINT_SHARED,
  // propose_task, task_go's point pinned.
  proposeTask:
    "select opportunity_id, status, merged from ledger.propose_task($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::timestamptz, $10::jsonb, $11::text[], $12::text[], $13::integer, $14::text, $15::text)",
  // A task the caller just proposed, marked a bet when its weekly budget holds.
  placeBet: "select ledger.place_bet($1::text, $2::text) as placed",
  // Work the proposal wrote, filed under a project and made to wait on other work.
  placeWork: "select ledger.place_work($1::text, $2::text, $3::text, $4::text[]) as placed",
  proposeHypothesis:
    "select ledger.propose_hypothesis($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::text[], $9::text[], $10::text) as id",
  recordTest:
    "select test_id, counts from ledger.record_test($1::text, $2::text, $3::text, $4::text, $5::text, $6::text[], $7::text[])",
  proposeOpportunity:
    "select ledger.propose_opportunity($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz, $9::jsonb, $10::text[], $11::text[]) as id",
  // A goal proposal and its card; an opportunity's or a task's details.
  proposeGoal:
    "select status from ledger.propose_goal($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::text, $8::text, $9::jsonb, $10::jsonb, $11::text[], $12::text[])",
  proposeGoalTarget:
    "select status from ledger.propose_goal_target($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::boolean, $9::jsonb, $10::text[], $11::text[], $12::integer)",
  setDetails: "select ledger.set_details($1::text, $2::text, $3::jsonb) as attached",
  // An opportunity's or a task's expectations.
  setExpectations: "select ledger.set_expectations($1::text, $2::text, $3::jsonb) as written",
} as const;

// A proposal's summary names the work itself (personal-core's summaryStandsAlone),
// checked before anything is written. Refused as invalid_request with the fixed code vague_summary,
// whose fixed hint the agent API sends; only the call's row is written, and never the text.
const vague = <T>(summary: string): Done<T> | null =>
  summaryStandsAlone(summary)
    ? null
    : { outcome: { ok: false, code: "invalid_request", refusal: "vague_summary" }, rows: 0 };

// Each quote of the owner's request is kept first as the caller's own note, in this transaction
// and under its request id, and cited by that note's id. propose_opportunity's, propose_task's and
// propose_goal's.
async function quotedBasis(
  ctx: Ctx,
  given: readonly (WorkRef | OwnerRequestQuote)[],
  requestId: string,
): Promise<(WorkRef | OwnerRequestRef)[] | ReadOutcome<never>> {
  const basis: (WorkRef | OwnerRequestRef)[] = [];
  if (given.some((ref) => "quote" in ref)) await ctx.run(SQL.taintShared, []);
  for (const [n, ref] of given.entries()) {
    if (!("quote" in ref)) {
      basis.push(ref);
      continue;
    }
    const noteRequest = derivedId(`${requestId}\n${n}`, 32);
    const note = await appendRecord(ctx, { kind: "note", body: ref.quote, requestId: noteRequest });
    if (!note.outcome.ok) return note.outcome;
    basis.push({ kind: "owner_request", id: note.outcome.value.recordId as AgentRecordId });
  }
  return basis;
}

// The owner's quoted requests are kept as notes only when the proposal that cites them is taken:
// a refusal, a ref not found or a merge into an open task undoes them.
// A quote is kept through the record tool, so a client without it is refused, not failed.
async function withNotes<R>(
  { ctx, client }: Pick<WorkCall, "ctx" | "client">,
  given: readonly (WorkRef | OwnerRequestQuote)[],
  requestId: string,
  work: (basis: (WorkRef | OwnerRequestRef)[]) => Promise<Done<R> & { undo?: boolean }>,
): Promise<Done<R>> {
  if (given.some((ref) => "quote" in ref) && !client.tools.includes("record"))
    return { outcome: { ok: false, code: "invalid_request" }, rows: 0 };
  // The call's session first, outside the savepoint: a session opened inside it would be undone with
  // the notes while the call still remembered it.
  await ctx.session();
  await ctx.run("savepoint proposal_notes", []);
  const basis = await quotedBasis(ctx, given, requestId);
  const done = Array.isArray(basis) ? await work(basis) : { outcome: basis, rows: 0 };
  const undo = !done.outcome.ok || ("undo" in done && done.undo === true);
  await ctx.run(undo ? "rollback to savepoint proposal_notes" : "release savepoint proposal_notes", []);
  return done;
}

export async function proposeHypothesis(
  { client, ctx, session, fn }: WorkCall,
  valid: Args<"propose_hypothesis">,
): Promise<Done<Result<"propose_hypothesis">>> {
  const refusal = vague<{ hypothesis: HypothesisId }>(valid.summary);
  if (refusal !== null) return refusal;
  const id = newId("hyp");
  const body = sealSummary(
    ctx,
    client.compartments,
    { table: "ledger.hypotheses", id, column: "body_enc" },
    valid.summary,
  );
  const rows = await fn<{ id: string | null }>(SQL.proposeHypothesis, [
    id,
    valid.requestId,
    await session(),
    valid.kind,
    ...aboutColumns(valid.about),
    body,
    refKinds(valid.basis),
    refIds(valid.basis),
    valid.idea ?? null,
  ]);
  if (isRefused(rows)) return refused(rows);
  const made = value(rows, "id");
  return made === null ? refused("not_found") : answered({ hypothesis: made as HypothesisId });
}

export async function recordTest(
  { session, fn }: WorkCall,
  valid: Args<"record_test">,
): Promise<Done<Result<"record_test">>> {
  const rows = await fn<{ test_id: string; counts: boolean }>(SQL.recordTest, [
    newId("tst"),
    valid.requestId,
    await session(),
    valid.hypothesis,
    valid.result,
    refKinds(valid.basis),
    refIds(valid.basis),
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  return row === undefined ? refused("not_found") : answered({ test: row.test_id as TestId, counts: row.counts });
}

export async function proposeOpportunity(
  call: WorkCall,
  valid: Args<"propose_opportunity">,
  log: PersonalLogger,
): Promise<Done<Result<"propose_opportunity">>> {
  const bet = valid.bet === true;
  if (bet && valid.basis.some((ref) => ref.kind === "owner_request"))
    return { outcome: { ok: false, code: "invalid_request" }, rows: 0 };
  if (bet && (!TASK_KINDS.includes(valid.kind) || valid.details?.decisionNeeded !== undefined))
    return { outcome: { ok: false, code: "invalid_request", refusal: "bet_needs_owner" }, rows: 0 };
  // A question to the owner pays up front: checked on the row this call wrote, so a refusal undoes
  // it with the notes.
  if (valid.tried === undefined && (valid.kind === "owner_question" || valid.details?.decisionNeeded !== undefined))
    return unpaid();
  return (
    vague(valid.summary) ??
    withNotes(call, valid.basis, valid.requestId, async (basis) => {
      const { session, fn } = call;
      const fresh = await newOpportunity(call, valid);
      if (!("id" in fresh)) return fresh;
      const { id, expected, body } = fresh;
      const rows = await fn<{ id: string | null }>(SQL.proposeOpportunity, [
        id,
        valid.requestId,
        await session(),
        valid.kind,
        ...aboutColumns(valid.about),
        valid.hypothesis ?? null,
        valid.dueAt ?? null,
        body,
        refKinds(basis),
        refIds(basis),
      ]);
      if (isRefused(rows)) return refused(rows);
      const made = value(rows, "id");
      if (made === null) return refused("not_found");
      // A bet on the row this call wrote, in its transaction; a merge into open work or a repeat
      // places none and spends nothing. Past the budget the call writes nothing. A repeat of the
      // caller's own request answers as the first call did: `bet` when that call placed one.
      const wrote = bet && (await writtenNow(call, made));
      const placed = wrote ? await placeBet(call, made) : bet && (await repeatedBet(call, made, valid.requestId));
      if (isRefused(placed)) return refused(placed);
      if (placed === "spent")
        return { outcome: { ok: false, code: "invalid_request", refusal: "bet_budget_spent" }, rows: 0 };
      if (placed === "needs_owner")
        return { outcome: { ok: false, code: "invalid_request", refusal: "bet_needs_owner" }, rows: 0 };
      const attached =
        (valid.tried === undefined ? null : await payQuestion(call, made, valid.tried, await writtenNow(call, made))) ??
        (await placeWork(call, made, valid.project)) ??
        (await attachDetails(call, made, valid.details, log)) ??
        (await attachExpects(call, made, expected, valid.expects !== undefined, log));
      return (
        attached ??
        answered({ opportunity: made as OpportunityId, ...(placed === "placed" ? { bet: true as const } : {}) })
      );
    })
  );
}

// Whether this call wrote the row, as ledger.set_details tests it: in the caller's session, in this
// transaction. A merge into open work, or a repeat, answers another row, for which `tried` is
// checked and never written.
async function writtenNow({ ctx, session }: WorkCall, opportunity: string): Promise<boolean> {
  const [row] = await ctx.run<{ fresh: boolean }>(
    "select o.session_id = $2 and o.created_at = now() as fresh from ledger.opportunities o where o.id = $1",
    [opportunity, await session()],
  );
  return row?.fresh === true;
}

// `placed` when the row is the caller's own, written by an earlier call with this request id, and
// that call placed a bet on it; false for a merge into other open work, which places none.
async function repeatedBet(
  { ctx, client }: WorkCall,
  opportunity: string,
  requestId: string,
): Promise<"placed" | false> {
  const [row] = await ctx.run<{ bet: boolean }>(
    "select o.bet_at is not null as bet from ledger.opportunities o where o.id = $1 and o.request_id = $2 and o.created_by = $3",
    [opportunity, requestId, `client:${client.id}`],
  );
  return row?.bet === true ? "placed" : false;
}

// The proposal's project and what it waits on, set in the proposal's transaction on the row it
// wrote. A project that is not an active one the caller sees, or work to wait on that the caller
// cannot see, is a not_found, which undoes the proposal; a repeat or a merge into open work leaves
// that work as it is. Null, or a refusal of the call.
async function placeWork(
  call: WorkCall,
  opportunity: string,
  project: string | undefined,
  blockedBy: readonly string[] = [],
): Promise<Done<never> | null> {
  if (project === undefined && blockedBy.length === 0) return null;
  const { session, fn } = call;
  const rows = await fn<{ placed: "placed" | "kept" | null }>(SQL.placeWork, [
    opportunity,
    await session(),
    project ?? null,
    blockedBy,
  ]);
  if (isRefused(rows)) return refused(rows);
  return value(rows, "placed") === null ? refused("not_found") : null;
}

// The details sealed under the row's label (the caller's whole clearance, as its summary),
// attached in the proposal's transaction to a row it wrote. A merge into an open row, or a
// repeat, answers as it would without them and attaches nothing (the function says false):
// details are a new row's alone. Null, or a refusal of the call.
async function attachDetails(
  call: WorkCall,
  opportunity: string,
  details: ProposalDetails | undefined,
  log: PersonalLogger,
): Promise<Done<never> | null> {
  if (details === undefined) return null;
  const { client, ctx, session, fn } = call;
  const sealed = sealSummary(
    ctx,
    client.compartments,
    { table: "ledger.opportunities", id: opportunity, column: "details_enc" },
    JSON.stringify(details),
  );
  const rows = await fn<{ attached: boolean }>(SQL.setDetails, [opportunity, await session(), sealed]);
  if (isRefused(rows)) return refused(rows);
  if (value(rows, "attached") !== true) log.info({ event: "details_not_attached", code: "existing_row" });
  return null;
}

// The proposal's expectations, the agent's or the kind's default, each
// subject resolved and each value sealed before anything is written, under the new row's id.
// A refusal of the call, or the list (empty for a kind with no default).
async function expectedOf(
  call: WorkCall,
  id: string,
  kind: OpportunityKind,
  expects: ExpectedOutcome[] | undefined,
): Promise<BuiltExpectation[] | Done<never>> {
  const built = await buildExpectations(call.ctx, call.client.compartments, id, expectationsOf(kind, expects));
  return typeof built === "string" ? refused(built) : built;
}

// A proposal's new row id, its expected outcomes built, and its summary sealed under the caller's
// label; or the refusal of a bad expectation.
async function newOpportunity(
  call: WorkCall,
  valid: { kind: OpportunityKind; expects?: ExpectedOutcome[] | undefined; summary: string },
): Promise<{ id: string; expected: BuiltExpectation[]; body: ReturnType<typeof sealSummary> } | Done<never>> {
  const id = newId("opp");
  const expected = await expectedOf(call, id, valid.kind, valid.expects);
  if (!Array.isArray(expected)) return expected;
  const body = sealSummary(
    call.ctx,
    call.client.compartments,
    { table: "ledger.opportunities", id, column: "body_enc" },
    valid.summary,
  );
  return { id, expected, body };
}

// Attached in the proposal's transaction to a row it wrote, as details are: a merge into an open
// row, or a repeat, attaches none (the function says 0). Null, or a refusal of the call.
async function attachExpects(
  call: WorkCall,
  opportunity: string,
  expected: readonly BuiltExpectation[],
  stated: boolean,
  log: PersonalLogger,
): Promise<Done<never> | null> {
  if (expected.length === 0) return null;
  const { session, fn } = call;
  const rows = await fn<{ written: number }>(SQL.setExpectations, [
    opportunity,
    await session(),
    JSON.stringify(expected),
  ]);
  if (isRefused(rows)) return refused(rows);
  if (value(rows, "written") === 0 && stated) log.info({ event: "expects_not_attached", code: "existing_row" });
  return null;
}

// A goal or a change to one, as a card for the owner. The statement, the
// summary and the details are sealed under the caller's clearance; the statement's keyed
// fingerprint lets the owner's no bind the same words. The function decides the rest.
export async function proposeGoal(
  { client, ctx, session, fn }: WorkCall,
  valid: Args<"propose_goal">,
  log: PersonalLogger,
): Promise<Done<Result<"propose_goal">>> {
  // Its summary names the work, as every proposal's does.
  const refusal = vague<{ status: GoalProposalStatus }>(valid.summary);
  if (refusal !== null) return refusal;
  return withNotes({ ctx, client }, valid.basis, valid.requestId, async (basis) => {
    const id = goalProposalId();
    const at = (column: string) => ({ table: "ledger.goal_proposals", id, column });
    const statement =
      valid.statement === undefined
        ? null
        : sealSummary(ctx, client.compartments, at("statement_enc"), valid.statement);
    const statementFp = valid.statement === undefined ? null : fingerprint(ctx.keys, "goal_statement", valid.statement);
    const details =
      valid.details === undefined
        ? null
        : sealSummary(ctx, client.compartments, at("details_enc"), JSON.stringify(valid.details));
    const rows = await fn<{ status: GoalProposalStatus }>(SQL.proposeGoal, [
      id,
      valid.requestId,
      await session(),
      valid.change,
      valid.goal ?? null,
      statement,
      statementFp,
      valid.compartment ?? null,
      sealSummary(ctx, client.compartments, at("body_enc"), valid.summary),
      details,
      refKinds(basis),
      refIds(basis),
    ]);
    if (isRefused(rows)) return refused(rows);
    const status = value(rows, "status");
    if (status === null) return refused("not_found");
    log.info({ event: "goal_proposed", code: status });
    // Only a proposal written keeps its notes: the owner's no, a waiting card or a change in force
    // wrote none.
    return { ...answered({ status }), undo: status !== "proposed" };
  });
}

// Whether get_entity would serve this person or organization to the caller, by its own first checks.
async function servedEntity(ctx: Ctx, id: string): Promise<boolean> {
  const [entity] = await ctx.run<{ id: string; kind: string }>(ENTITY_OR_PROJECT, [id]);
  if (entity === undefined || entity.kind === "project") return false;
  return entity.kind === "organization" ? !(await namedOrgState(ctx, id)).withheld : !(await withheldNamed(ctx, [id]));
}

// The person or organization a goal is after, as a card for the owner. An id is one get_entity would
// serve this caller, so one withheld or hidden is a not_found as a missing one is. A name is taken
// as said, sealed under the caller's clearance: what anyone holds it is read only for the owner, on
// the card, so the answer rests on nothing the caller cannot see.
export async function proposeGoalTarget(
  { client, ctx, session, fn }: WorkCall,
  valid: Args<"propose_goal_target">,
  log: PersonalLogger,
): Promise<Done<Result<"propose_goal_target">>> {
  const refusal = vague<{ status: GoalTargetProposalStatus }>(valid.summary);
  if (refusal !== null) return refusal;
  if (valid.entity !== undefined && !(await servedEntity(ctx, valid.entity))) return refused("not_found");
  return withNotes({ ctx, client }, valid.basis, valid.requestId, async (basis) => {
    const id = goalProposalId();
    const name = valid.name?.trim();
    const organization = valid.organization === true;
    const nameFp =
      name === undefined ? null : organization ? orgNameFp(ctx.keys, name) : fingerprint(ctx.keys, "name", name);
    const rows = await fn<{ status: GoalTargetProposalStatus }>(SQL.proposeGoalTarget, [
      id,
      valid.requestId,
      await session(),
      valid.goal,
      valid.entity ?? null,
      nameFp,
      name === undefined
        ? null
        : sealSummary(ctx, client.compartments, { table: "ledger.goal_proposals", id, column: "statement_enc" }, name),
      organization,
      sealSummary(ctx, client.compartments, { table: "ledger.goal_proposals", id, column: "body_enc" }, valid.summary),
      refKinds(basis),
      refIds(basis),
      secondDegreeRules().goalTargetCardsOpen,
    ]);
    if (isRefused(rows)) return refused(rows);
    const status = value(rows, "status");
    if (status === null) return refused("not_found");
    log.info({ event: "goal_target_proposed", code: status });
    // Only a proposal written keeps its notes. An answer of `proposed` that wrote nothing keeps a
    // note the caller may read again, of its own words: as harmless as the proposal it thinks it made.
    return { ...answered({ status }), undo: status !== "proposed" };
  });
}

// Read-only work for another agent. The function writes the task and task_go's rung 0 decides it; a
// merge into an open task of the same kind and subject writes nothing.
export async function proposeTask(
  call: WorkCall,
  valid: Args<"propose_task">,
  log: PersonalLogger,
): Promise<Done<Result<"propose_task">>> {
  const bet = valid.bet === true;
  if (
    bet &&
    ((valid.role !== undefined && valid.role !== call.client.name) ||
      valid.basis.some((ref) => ref.kind === "owner_request"))
  )
    return { outcome: { ok: false, code: "invalid_request" }, rows: 0 };
  const role = bet ? call.client.name : valid.role;
  return (
    vague(valid.summary) ??
    withNotes(call, valid.basis, valid.requestId, async (basis) => {
      const { session, fn } = call;
      const fresh = await newOpportunity(call, valid);
      if (!("id" in fresh)) return fresh;
      const { id, expected, body } = fresh;
      const point = pinned("task_go");
      const rows = await fn<{ opportunity_id: string; status: OpportunityStatus; merged: boolean }>(SQL.proposeTask, [
        id,
        valid.requestId,
        await session(),
        valid.kind,
        ...aboutColumns(valid.about),
        role ?? null,
        valid.hypothesis ?? null,
        valid.dueAt ?? null,
        body,
        refKinds(basis),
        refIds(basis),
        point.version,
        point.hash,
        valid.parent ?? null,
      ]);
      if (isRefused(rows)) return refused(rows);
      const [row] = rows;
      if (row === undefined) return refused("not_found");
      // A merge attaches nothing to the open task, and is no bet: the work was already there. A task
      // code declined is no bet either, nor is a repeat, which answers the row an earlier call wrote.
      const placed =
        bet &&
        !row.merged &&
        row.status !== "no_go" &&
        (await writtenNow(call, row.opportunity_id)) &&
        (await placeBet(call, row.opportunity_id));
      if (isRefused(placed)) return refused(placed);
      if (placed === "spent")
        return { outcome: { ok: false, code: "invalid_request", refusal: "bet_budget_spent" }, rows: 0 };
      if (!row.merged) {
        const attached =
          (await placeWork(call, row.opportunity_id, valid.project, valid.blockedBy)) ??
          (await attachDetails(call, row.opportunity_id, valid.details, log)) ??
          (await attachExpects(call, row.opportunity_id, expected, valid.expects !== undefined, log));
        if (attached !== null) return attached;
      }
      log.info({ event: "task_proposed", code: row.merged ? "merged" : row.status });
      const next = row.merged
        ? PROPOSE_TASK_NEXT.merged
        : row.status === "no_go"
          ? PROPOSE_TASK_NEXT.no_go
          : row.status === "proposed"
            ? PROPOSE_TASK_NEXT.proposed
            : undefined;
      return {
        ...answered({
          opportunity: row.opportunity_id as OpportunityId,
          status: row.status,
          ...(row.merged ? { merged: true as const } : {}),
          ...(placed === "placed" ? { bet: true as const } : {}),
          ...(next === undefined ? {} : { next }),
        }),
        undo: row.merged,
      };
    })
  );
}

// Marks the caller's fresh work a bet when its budget holds (ledger.place_bet): `placed`, `spent`,
// `needs_owner` for work a bet cannot approve, or `unseen` for a row that is not its own fresh task
// routed to it or its own fresh proposal, which is then no bet.
type Placed = "placed" | "spent" | "needs_owner" | "unseen";
async function placeBet(call: WorkCall, opportunity: string): Promise<Placed | Refused> {
  const rows = await call.fn<{ placed: Placed }>(SQL.placeBet, [await call.session(), opportunity]);
  return isRefused(rows) ? rows : (value(rows, "placed") ?? "unseen");
}
