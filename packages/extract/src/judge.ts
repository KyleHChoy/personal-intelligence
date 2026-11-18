import { normal } from "@intelligence/personal-beliefs";
import type { Prompt } from "@intelligence/personal-models";
import { cutPassage, strongCite } from "./cite.ts";

// The cited rung 2 judge: a closed schema, no tools, asked once per case; every cite is checked by
// code against the passages it sent, never the model's. The source check and the recall audit are
// configurations of it; the outcome judge, which asks each case in both orders, shares its name and
// its cite rule.

// Who judged: the model and the prompt, as the stored rows name a judge.
export const judgeName = (modelId: string, prompt: Pick<Prompt, "id" | "version">): string =>
  `model:${modelId}@${prompt.id}@${prompt.version}`;

// A judge's answer, a saved refusal, or why there is none: an outage or a reached budget.
export type JudgeAnswer<T> = { output: T } | { rejected: string } | "unavailable" | "budget";
export type JudgeCall = { slot: string; subject: string; refs: string[]; compartments: string[] };
export type JudgeAsk<T> = (call: JudgeCall) => Promise<JudgeAnswer<T>>;

// A passage as a cite is looked for in it: cut as it was shown, in grounding's normal form.
export const citable = (passage: string): string => normal(cutPassage(passage)).text;

// Every cite is strong and found in the shown passage it numbers, from 1.
export const citesFound = (cites: readonly { passage: number; text: string }[], shown: readonly string[]): boolean =>
  cites.every((cite) => {
    const text = normal(cite.text).text.trim();
    const where = shown[cite.passage - 1];
    return strongCite(text) && where?.includes(text) === true;
  });

export type JudgeCounts = {
  cases: number;
  calls: number;
  uncited: number;
  rejected: number;
  noPassage: number;
} & Record<string, number>;
export type JudgeRun<Row, Counts extends JudgeCounts> = {
  rows: Row[];
  counts: Counts;
  stopped: "ok" | "budget" | "unavailable";
};

// One judge's rules for a case: what is asked (null when it has no passage to show), the row of a
// case with no answer to read, and the row of a cited answer with the count it adds to (null when
// its cites are not found).
export type JudgeStep<Case, Output, Row, Counts extends JudgeCounts> = {
  call(one: Case): JudgeCall | null;
  unanswered(one: Case, code: "no_passage" | "rejected" | "uncited"): Row;
  answered(one: Case, output: Output): { row: Row; count: keyof Counts & string } | null;
};

// The cases given, in order, within `calls`. A case with no passage is recorded `no_passage` without
// a call; an outage or a reached budget stops the run, and a case not reached writes nothing. `each`
// is handed each row as it is made, so a run cut short keeps every row it made.
export async function judge<Case, Output, Row, Counts extends JudgeCounts>(
  step: JudgeStep<Case, Output, Row, Counts>,
  cases: readonly Case[],
  ask: JudgeAsk<Output>,
  budget: { calls: number },
  counts: Counts,
  each?: (row: Row) => Promise<void>,
): Promise<JudgeRun<Row, Counts>> {
  const run: JudgeRun<Row, Counts> = { rows: [], counts, stopped: "ok" };
  const tallies: Record<string, number> = run.counts;
  const tally = (count: string): void => {
    tallies[count] = (tallies[count] ?? 0) + 1;
  };
  const keep = async (row: Row): Promise<void> => {
    run.rows.push(row);
    await each?.(row);
  };
  for (const one of cases) {
    const call = step.call(one);
    if (call === null) {
      tally("cases");
      tally("noPassage");
      await keep(step.unanswered(one, "no_passage"));
      continue;
    }
    if (run.counts.calls + 1 > budget.calls) {
      run.stopped = "budget";
      break;
    }
    tally("calls");
    const answer = await ask(call);
    if (answer === "unavailable" || answer === "budget") {
      run.stopped = answer;
      break;
    }
    tally("cases");
    if ("rejected" in answer) {
      tally("rejected");
      await keep(step.unanswered(one, "rejected"));
      continue;
    }
    const answered = step.answered(one, answer.output);
    if (answered === null) {
      tally("uncited");
      await keep(step.unanswered(one, "uncited"));
      continue;
    }
    tally(answered.count);
    await keep(answered.row);
  }
  return run;
}
