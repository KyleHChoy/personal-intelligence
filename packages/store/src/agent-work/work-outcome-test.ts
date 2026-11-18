import type { Envelope } from "@intelligence/contracts";
import type {
  RecordHeldOutQuestionArgs,
  RecordHeldOutQuestionResult,
  RecordOutcomeTaskArgs,
  RecordOutcomeTaskResult,
  StartOutcomeTestArgs,
  StartOutcomeTestResult,
} from "@intelligence/contracts/personal";
import { stamp } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { openUnder } from "../core/seal.ts";
import { answered, type Done, isRefused, refused, refusedAs, sealSummary, type WorkCall } from "../core/work-refs.ts";
import { Unavailable } from "../read/read-ctx.ts";

// The outcome test's three tools, as pi_reader inside `pi mcp`. Ids are made and texts sealed here,
// under the caller's clearance; one definer function per call decides the rest. The only process
// that reads a question back holds the tools, and no default registration does.

const SQL = {
  start: `select run_id, go, code, at from ledger.start_outcome_test($1::text, $2::text, $3::text, $4::text, $5::integer, $6::text, $7::text)`,
  live: "select id, class, compartments, question_enc, key_enc from ledger.live_held_out_questions($1::text)",
  question:
    "select ledger.record_held_out_question($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb) as id",
  task: `select ledger.record_outcome_task($1::text, $2::text, $3::text, $4::text, $5::text, $6::boolean, $7::integer, $8::integer, $9::integer, $10::text, $11::text, $12::text[], $13::integer, $14::bigint, $15::jsonb, $16::jsonb) as outcome`,
} as const;

// A read of the session names removed evidence: the agent renews its session, as a record's write does.
const READ_REMOVED = "read_removed";

export async function startOutcomeTest(
  call: WorkCall,
  valid: StartOutcomeTestArgs,
): Promise<Done<StartOutcomeTestResult>> {
  const session = await call.session();
  const rows = await call.fn<{ run_id: string | null; go: boolean; code: string | null; at: Date | null }>(SQL.start, [
    newId("otr"),
    valid.requestId,
    session,
    valid.suite,
    valid.tasks,
    valid.answerModel,
    valid.judgeModel,
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  if (row === undefined) throw new Unavailable();
  if (!row.go) return answered({ go: false, code: row.code } as StartOutcomeTestResult);
  const live = await call.fn<{
    id: string;
    class: string;
    compartments: string[];
    question_enc: unknown;
    key_enc: unknown;
  }>(SQL.live, [session]);
  if (isRefused(live)) return refused(live);
  const opened = (row: { id: string; compartments: string[] }, column: string, sealed: unknown) => ({
    untrusted: openUnder(
      call.ctx.keys,
      row.compartments,
      { table: "ledger.held_out_questions", id: row.id, column },
      sealed as Envelope,
    ),
  });
  return answered({
    go: true,
    run: row.run_id,
    at: stamp(row.at as Date),
    heldOut: live
      .filter((one) => one.compartments.every((compartment) => call.ctx.keys.compartments.has(compartment)))
      .map((one) => ({
        id: one.id,
        class: one.class,
        question: opened(one, "question_enc", one.question_enc),
        key: opened(one, "key_enc", one.key_enc),
      })),
  } as StartOutcomeTestResult);
}

export async function recordHeldOutQuestion(
  call: WorkCall,
  valid: RecordHeldOutQuestionArgs,
): Promise<Done<RecordHeldOutQuestionResult>> {
  const id = newId("hoq");
  const sealed = (column: string, text: string) =>
    sealSummary(call.ctx, call.client.compartments, { table: "ledger.held_out_questions", id, column }, text);
  const rows = await call.fn<{ id: string }>(SQL.question, [
    id,
    valid.requestId,
    await call.session(),
    valid.class,
    sealed("question_enc", valid.question),
    sealed("key_enc", valid.key),
  ]);
  if (isRefused(rows)) return refused(rows);
  const stored = rows[0]?.id;
  if (stored === undefined) throw new Unavailable();
  if (stored === READ_REMOVED) return refusedAs("session_renewed");
  return answered({ id: stored } as RecordHeldOutQuestionResult);
}

export async function recordOutcomeTask(
  call: WorkCall,
  valid: RecordOutcomeTaskArgs,
): Promise<Done<RecordOutcomeTaskResult>> {
  const id = newId("ott");
  const sealed = (column: string, text: string) =>
    sealSummary(call.ctx, call.client.compartments, { table: "ledger.outcome_test_tasks", id, column }, text);
  const rows = await call.fn<{ outcome: string }>(SQL.task, [
    id,
    valid.requestId,
    await call.session(),
    valid.run,
    valid.task,
    valid.heldOut,
    valid.score,
    valid.codeCap,
    valid.judgeScore,
    valid.answerModel,
    valid.judgeModel,
    valid.failed,
    valid.toolCalls,
    valid.costMicroUsd,
    sealed("answer_enc", valid.answer),
    sealed("scoring_enc", valid.scoring),
  ]);
  if (isRefused(rows)) return refused(rows);
  if (rows[0]?.outcome === READ_REMOVED) return refusedAs("session_renewed");
  if (rows[0]?.outcome !== "ok") return { outcome: { ok: false, code: "not_found" }, rows: 0 };
  return answered({ recorded: true });
}
