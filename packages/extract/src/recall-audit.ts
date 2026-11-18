import type { RecallCase, RecallRow } from "@intelligence/contracts/personal";

export type { RecallCase };

import type { RecallAuditAnswer } from "@intelligence/contracts/personal";
import { cutPassage } from "./cite.ts";
import { RECALL_AUDIT_POINT } from "./decision-points.ts";
import { citable, citesFound, type JudgeAsk, type JudgeRun, judge, judgeName } from "./judge.ts";
import { RECALL_AUDIT_PROMPT } from "./question-prompts.ts";

// The recall audit's pure part. The closed filters (a mailing's word lists, the commitment bar) drop
// lines by words, and nothing else measures what they lose: a stronger model reads a sample of what
// each dropped, blind to why it is here, and answers whether the passage says something the owner owes
// or a promise. Rung 2, a closed schema and no tools, asked once. Each answer is one row of ids and
// codes: a measure, never knowledge, never a card and never a change to a filter. Pure but for the
// model calls its caller hands in.

export const recallJudge = (modelId: string): string => judgeName(modelId, RECALL_AUDIT_PROMPT);
export const RECALL_POINT = RECALL_AUDIT_POINT;

export type RecallAsk = JudgeAsk<RecallAuditAnswer>;
export type RecallCounts = {
  cases: number;
  calls: number;
  missed: number;
  rightlyDropped: number;
  uncited: number;
  rejected: number;
  noPassage: number;
};

const shownOf = (one: Pick<RecallCase, "passages">): { text: string; at: string }[] =>
  one.passages.flatMap((passage) => (passage.text === null ? [] : [{ text: passage.text, at: passage.at }]));

// The `case` slot: what is asked, the line and the numbered passages. Never the filter.
export function recallSlot(one: Pick<RecallCase, "question" | "line" | "passages">): string {
  return JSON.stringify({
    question: one.question,
    line: one.line,
    passages: shownOf(one).map((passage, n) => ({
      n: n + 1,
      text: cutPassage(passage.text),
      said: passage.at.slice(0, 10),
    })),
  });
}

// A `found` needs a cite, and every cite must be strong and found in the passage it names: code reads
// the passages it sent, never the model's.
function citedOf(output: RecallAuditAnswer, one: RecallCase): { ok: boolean; cited: number | null } {
  const shown = shownOf(one).map((passage) => citable(passage.text));
  if (!citesFound(output.cites, shown)) return { ok: false, cited: null };
  if (output.verdict === "found" && output.cites.length === 0) return { ok: false, cited: null };
  return { ok: true, cited: output.verdict === "found" ? (output.cites[0]?.passage ?? null) : null };
}

// The cases given, in order, within `calls`. A case not reached writes nothing: the next night samples
// again. An outage or a reached budget stops the run.
export function auditRecall(
  cases: readonly RecallCase[],
  ask: RecallAsk,
  budget: { calls: number },
): Promise<JudgeRun<RecallRow, RecallCounts>> {
  const baseOf = (one: RecallCase) => ({
    filter: one.filter,
    targetKey: one.targetKey,
    evidenceId: one.evidenceId,
    population: one.population,
    compartments: [...one.compartments].sort(),
  });
  return judge<RecallCase, RecallAuditAnswer, RecallRow, RecallCounts>(
    {
      call: (one) =>
        shownOf(one).length === 0
          ? null
          : {
              slot: recallSlot(one),
              subject: one.subject,
              refs: [one.evidenceId],
              compartments: baseOf(one).compartments,
            },
      unanswered: (one, code) => ({ ...baseOf(one), verdict: null, code, cited: null }),
      answered: (one, output) => {
        const cites = citedOf(output, one);
        if (!cites.ok) return null;
        return output.verdict === "found"
          ? { row: { ...baseOf(one), verdict: "missed", code: null, cited: cites.cited }, count: "missed" }
          : {
              row: { ...baseOf(one), verdict: "rightly_dropped", code: null, cited: null },
              count: "rightlyDropped",
            };
      },
    },
    cases,
    ask,
    budget,
    { cases: 0, calls: 0, missed: 0, rightlyDropped: 0, uncited: 0, rejected: 0, noPassage: 0 },
  );
}
