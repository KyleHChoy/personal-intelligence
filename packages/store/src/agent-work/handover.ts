import { type OwnerQueueBrief, ownerQueueLink, ownerQueueWords } from "@intelligence/contracts/personal";
import { attemptsOn } from "../cards/agent-attempts.ts";
import type { Ctx } from "../read/read-ctx.ts";

// An owner_queue task's brief, as pi_reader: how many cards the owner's page shows waiting within
// the task's label, by kind in words, and the link to the owner's queue. Only the agent holding the
// task's lease is answered.

// ledger.owner_queue_question, given whether agents' attempts are on, as the page reads it: each
// kind's count, and the host on a row of its own with no kind.
type QuestionRow = { kind: string | null; n: number; host: string | null };
const QUESTION = "select kind, n, host from ledger.owner_queue_question($1, $2)";

// Counts and kind names in words, the most first, a kind with no words of its own among the other
// questions, and the link: never a card's id or text.
export function handoverOf(rows: readonly QuestionRow[]): OwnerQueueBrief {
  const host = rows.find((row) => row.kind === null)?.host ?? null;
  const counts = new Map<string, { kind: string; words: string; count: number }>();
  for (const row of rows) {
    if (row.kind === null || row.n <= 0) continue;
    const said = ownerQueueWords(row.kind);
    const was = counts.get(said.kind);
    counts.set(said.kind, { ...said, count: (was?.count ?? 0) + row.n });
  }
  const waiting = [...counts.values()].sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
  return { waiting, link: ownerQueueLink(host) };
}

// The task's hand-over under the caller's token, or null when the caller does not hold it.
export async function handoverBrief(ctx: Ctx, opportunity: string): Promise<OwnerQueueBrief | null> {
  const rows = await ctx.run<QuestionRow>(QUESTION, [opportunity, attemptsOn()]);
  return rows.length === 0 ? null : handoverOf(rows);
}
