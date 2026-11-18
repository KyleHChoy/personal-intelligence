import type { QuestionTried } from "@intelligence/contracts/personal";
import { type Done, isRefused, refused, value, type WorkCall } from "../core/work-refs.ts";

// A question to the owner pays up front: its `tried` is checked against the caller's own call and
// read logs by ledger.pay_question, and written on the work when it holds. The queries and `why` are
// the agent's words and are kept nowhere.

// The items a source id names, each read under the caller's token, so one it cannot see is
// answered as one it never read (invariant 6). A record id is its own.
const ITEMS = `
  select m.id, m.evidence_id from knowledge.messages m where m.id = any($1) and not m.held
  union all
  select d.id, d.evidence_id from knowledge.documents d where d.id = any($1)
  union all
  select k.id, k.evidence_id from knowledge.captures k where k.id = any($1)`;
const PAY = "select ledger.pay_question($1::text, $2::text, $3::text[], $4::text[], $5::boolean) as paid";

// The fixed refusal, as vague_summary's: the agent API sends its hint and field beside it.
export const unpaid = <T>(): Done<T> => ({
  outcome: { ok: false, code: "invalid_request", refusal: "question_unpaid" },
  rows: 0,
});

// Checks `tried` on work the caller can see, and with `mark` writes it there. Null when it holds or
// the work is not one the caller can see (the tool's own call answers that), else the refusal.
export async function payQuestion(
  call: WorkCall,
  opportunity: string,
  tried: QuestionTried,
  mark: boolean,
): Promise<Done<never> | null> {
  const rows = await call.fn<{ paid: "paid" | "unpaid" | "unseen" }>(PAY, [
    await call.session(),
    opportunity,
    tried.searches.map((one) => one.tool),
    await triedSources(call, tried),
    mark,
  ]);
  if (isRefused(rows)) return refused(rows);
  return value(rows, "paid") === "unpaid" ? unpaid() : null;
}

// A `tried`'s sources as the logs hold them: an item's evidence id, a record's own. An item the
// caller cannot see keeps its own id, which no read log holds, so the check answers it unpaid, after
// it answers work the caller cannot see as unseen.
export async function triedSources(call: Pick<WorkCall, "ctx">, tried: QuestionTried): Promise<string[]> {
  const items = tried.sources.filter((id) => !id.startsWith("rec_"));
  const found = new Map(
    (items.length === 0 ? [] : await call.ctx.run<{ id: string; evidence_id: string }>(ITEMS, [items])).map((one) => [
      one.id,
      one.evidence_id,
    ]),
  );
  return tried.sources.map((id) => found.get(id) ?? id);
}
