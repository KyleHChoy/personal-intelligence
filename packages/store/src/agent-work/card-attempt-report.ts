import type { CardAttemptBrief } from "@intelligence/contracts/personal";
import { cardAnswerId } from "../core/ids.ts";
import { derivedId } from "../core/work-refs.ts";
import type { Ctx } from "../read/read-ctx.ts";

// A card_question task's side of its brief and of report_move: the card as ids and code words, and
// the one write of the agent's answer. Code checks; the agent only says, and the definer decides
// whether the answer is taken and whether it settles the card.

type CardRow = {
  card_id: string;
  kind: string;
  options: string[];
  target_kind: string | null;
  target_id: string | null;
  ref_kinds: string[];
  ref_ids: string[];
  own: boolean;
};

// The task's card under the caller's token, or null when the caller can't see it or it is gone.
export async function cardBrief(ctx: Ctx, opportunity: string): Promise<CardAttemptBrief | null> {
  const [row] = await ctx.run<CardRow>(
    "select card_id, kind, options, target_kind, target_id, ref_kinds, ref_ids, own from ledger.card_question($1)",
    [opportunity],
  );
  if (row === undefined) return null;
  return { ...cardFields(row), own: row.own };
}

// A card row's id, kind, options, target and refs, as a task's brief shows them.
export const cardFields = (
  row: Pick<CardRow, "card_id" | "kind" | "options" | "target_kind" | "target_id" | "ref_kinds" | "ref_ids">,
) => ({
  id: row.card_id,
  kind: row.kind,
  options: row.options,
  target: row.target_kind === null || row.target_id === null ? null : { kind: row.target_kind, id: row.target_id },
  refs: row.ref_kinds.flatMap((kind, at) => {
    const id = row.ref_ids[at];
    return id === undefined ? [] : [{ kind, id }];
  }),
});

// The answer, in the report's transaction, through the one definer. Its request id is the report's,
// so a retried report replays it. `ok`: taken; `settled`: taken, and the card withdrawn as an
// agent's, with the agent's ruling where its kind's answer is one, naming the refs the
// report cites; anything else is a refusal, and nothing was written.
export async function writeCardAnswer(
  ctx: Ctx,
  answer: { opportunity: string; move: string; answer: string; cited: { kind: string; id: string }[] },
  requestId: string,
): Promise<string> {
  const request = derivedId(`${requestId}\ncard`, 43);
  const [row] = await ctx.run<{ code: string }>("select ledger.answer_card($1, $2, $3, $4, $5, $6, $7) as code", [
    cardAnswerId(),
    request,
    answer.opportunity,
    answer.move,
    answer.answer,
    answer.cited.map((one) => one.kind),
    answer.cited.map((one) => one.id),
  ]);
  return row?.code ?? "not_found";
}
