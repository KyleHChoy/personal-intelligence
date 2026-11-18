import {
  AnswerOwnerQuestionArgs,
  answerOf,
  OPEN_STATUSES,
  type OpportunityView,
  type OwnerAnswerBody,
  type WorkStateRefusal,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { type Appended, appended, prepareAppend } from "../agent-writes/record.ts";
import { newId } from "../core/ids.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { moveStatus } from "../core/statements.ts";
import { opportunityViews } from "../core/work-views.ts";

// Reader.answerOwnerQuestion's work, inside the call's one read committed transaction under the
// client's token, after the shared taint lock: the question opened under the caller's keys, then
// record's steps 3 and 4 over the body, then ledger.answer_owner_question, which decides who may
// answer, once, and writes the record, the owner's decision, the test and the move's report
// together.

const ANSWER =
  "select outcome, record_id from ledger.answer_owner_question($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)";

// The strict arguments. An agent's `facts`, which it may still send, are dropped: the owner's quote
// is typed by the agent lane's model (process-item.ts processStatement), each claim's phrases
// slices of the owner's words, so nothing the agent chose reaches a claim.
export const parseAnswerArgs = (args: unknown): AnswerOwnerQuestionArgs | null => {
  const parsed = AnswerOwnerQuestionArgs.safeParse(args);
  if (!parsed.success) return null;
  return { ...parsed.data, answer: answerOf(parsed.data) };
};

// The status of the caller's latest move on the question, as the function reads it. A reader holds
// no grant on a move's author, and its events say who wrote them.
const MOVE = `
  select (${moveStatus()}) as event
  from ledger.moves m
  where m.opportunity_id = $1
    and exists (select 1 from ledger.record_events r where r.row_kind = 'move' and r.row_id = m.id
                and r.by = 'client:' || (select c.id from policy.current_client() c))
  order by m.created_at desc, m.id collate "C" desc limit 1`;

// Which step is missing on a question the caller sees, from its own view and its own move, after
// the function refused it. What is left then is the owner's go, which only the function reads.
async function missingStep(ctx: Ctx, view: OpportunityView): Promise<WorkStateRefusal> {
  if (view.status === "done") return "question_answered";
  if (!OPEN_STATUSES.includes(view.status)) return "work_closed";
  if (view.leaseUntil === null) return "work_not_held";
  const [move] = await ctx.run<{ event: string | null }>(MOVE, [view.id]);
  return move?.event === "cleared" ? "question_needs_owner_go" : "move_not_cleared";
}

export async function answerOwnerQuestion(ctx: Ctx, args: AnswerOwnerQuestionArgs): Promise<Appended> {
  // The question is the opportunity's summary, as the caller sees it; one it cannot see is
  // answered as the function answers it, not_found.
  const view = (await opportunityViews(ctx, [args.opportunity])).get(args.opportunity)?.view;
  if (view === undefined) return { outcome: { ok: false, code: "not_found" }, rows: 0 };
  if (view.kind !== "owner_question")
    return { outcome: { ok: false, code: "not_found", refusal: "not_a_question" }, rows: 0 };
  // parseAnswerArgs dropped any facts: the body is the owner's words, their effect, and `typed`.
  const body: OwnerAnswerBody = {
    opportunity: view.id as OwnerAnswerBody["opportunity"],
    question: view.summary?.untrusted ?? null,
    quote: args.answer.quote,
    ...(args.answer.about === undefined ? {} : { about: args.answer.about }),
    typed: true,
  };
  const prepared = await prepareAppend(ctx, canonicalJson(body), []);
  if (prepared === null) return { outcome: { ok: false, code: "not_found" }, rows: 0 };
  const { session, recordId, contentFp, citesFp, label, bodyEnc, stamps } = prepared;
  const [answer] = await ctx.run<{ outcome: string; record_id: string | null }>(ANSWER, [
    session,
    recordId,
    args.requestId,
    view.id,
    newId("tst"),
    newId("rul"),
    args.answer.about ?? "neither",
    contentFp,
    citesFp,
    stamps,
    label,
    bodyEnc,
  ]);
  return answer?.outcome === "not_found"
    ? { outcome: { ok: false, code: "not_found", refusal: await missingStep(ctx, view) }, rows: 0 }
    : appended(answer);
}
