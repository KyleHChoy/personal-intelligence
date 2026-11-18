import type { CheckPassage, SourceCase, SourceCheckRow } from "@intelligence/contracts/personal";
import { byText } from "@intelligence/personal-core";

export type { CheckPassage, SourceCase, SourceCheckRow };

import {
  REJECTED_CONTENT_FILTER,
  REJECTED_LENGTH,
  SOURCE_CHECK_VERDICTS,
  type SourceCheckAnswer,
} from "@intelligence/contracts/personal";
import { cutPassage } from "./cite.ts";
import { SOURCE_CHECK_POINT } from "./decision-points.ts";
import { citable, citesFound, type JudgeAsk, type JudgeRun, judge, judgeName } from "./judge.ts";
import { SOURCE_CHECK_PROMPT } from "./question-prompts.ts";

// The source check, and the dream pass's pure rules. A sample of the beliefs and model relations
// the owner's clearance holds is reread against the passages their claims cite: `supported`,
// `unsupported` or `wrong`, citing the passage. Rung 2, a closed schema and no tools, asked once;
// every cite is checked by code against the passages it sent, as the relation step checks its own.
// Each answer is one check row: a measure, never knowledge, never the owner's verdict, and nothing
// here writes a claim, a value or a label (a check's label is the union of what it read, set by the
// store). Pure but for the model calls its caller hands in.

export const sourceCheckJudge = (modelId: string): string => judgeName(modelId, SOURCE_CHECK_PROMPT);
export const SOURCE_POINT = SOURCE_CHECK_POINT;

export type AskSource = JudgeAsk<SourceCheckAnswer>;

export type SourceCheckCounts = {
  cases: number;
  calls: number;
  supported: number;
  unsupported: number;
  wrong: number;
  uncited: number;
  rejected: number;
  noPassage: number;
};

// The passages shown, numbered from 1 in the order given: those with text alone.
const shownOf = (passages: readonly CheckPassage[]): CheckPassage[] => passages.filter((one) => one.text !== null);

// The `case` slot: the statement and the numbered passages, each cut as the relation step cuts
// its own, with the day it was said. Nothing else of the claims (no speaker, no address, no label).
// A relation's passages are its two sides', `from` then `to`: each side names the number of the
// passage it was taken from, or null when that passage is not shown, as the judge saw each
// statement beside its own passage.
export function sourceSlot(one: Pick<SourceCase, "statement" | "passages">): string {
  const shown = shownOf(one.passages);
  const numberOf = (at: number): number | null => {
    const passage = one.passages[at];
    return passage === undefined || passage.text === null ? null : shown.indexOf(passage) + 1;
  };
  const statement =
    one.statement.kind === "relation"
      ? {
          ...one.statement,
          from: { ...one.statement.from, passage: numberOf(0) },
          to: { ...one.statement.to, passage: numberOf(1) },
        }
      : one.statement;
  return JSON.stringify({
    statement,
    passages: shown.map((passage, n) => ({
      n: n + 1,
      text: cutPassage(passage.text as string),
      said: passage.at.slice(0, 10),
    })),
  });
}

// Every cite must be strong and found, in grounding's normal form, in the passage it names, which
// must be one shown; a `supported` or a `wrong` needs at least one. The first cite's passage is the
// one recorded. Code reads the passages it sent, never the model's.
export function verifySourceCites(
  output: SourceCheckAnswer,
  passages: readonly CheckPassage[],
  relation = false,
): { ok: boolean; cited: number | null } {
  const shown = shownOf(passages).map((one) => citable(one.text as string));
  if (!citesFound(output.cites, shown)) return { ok: false, cited: null };
  if (output.verdict !== "unsupported" && output.cites.length === 0) return { ok: false, cited: null };
  // A relation held or refuted rests on both its sides, as the judge's own answer must cite each.
  if (
    relation &&
    output.verdict !== "unsupported" &&
    !shown.every((_, n) => output.cites.some((cite) => cite.passage === n + 1))
  )
    return { ok: false, cited: null };
  return { ok: true, cited: output.cites[0]?.passage ?? null };
}

// Why the schema refused an answer, as a code for the log, never its text: the length or filter
// marker, the replay's marker for a refusal the schema did not make, text that is no JSON object,
// keys other than verdict and cites, a verdict not one of the three, more than six cites, or a cite
// that breaks its own shape.
export function refusedShape(raw: string): string {
  if (raw === REJECTED_LENGTH) return "length";
  if (raw === REJECTED_CONTENT_FILTER) return "content_filter";
  // The keyed replay's marker for an answer the schema took and something else refused.
  if (raw.startsWith("rejected:not_by_schema")) return "not_by_schema";
  const text = raw.trim().replace(/^```[a-z]*\n([\s\S]*?)\n?```$/, "$1");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.includes("{") ? "prose_and_json" : "not_json";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "not_object";
  const answer = parsed as Record<string, unknown>;
  if (Object.keys(answer).some((one) => one !== "verdict" && one !== "cites")) return "extra_key";
  if (!(SOURCE_CHECK_VERDICTS as readonly unknown[]).includes(answer.verdict)) return "verdict";
  if (!Array.isArray(answer.cites)) return "cites_not_list";
  if (answer.cites.length > 6) return "too_many_cites";
  for (const cite of answer.cites as unknown[]) {
    if (typeof cite !== "object" || cite === null) return "cite_shape";
    const one = cite as Record<string, unknown>;
    if (Object.keys(one).some((key) => key !== "passage" && key !== "text")) return "cite_keys";
    if (!Number.isInteger(one.passage) || (one.passage as number) < 1 || (one.passage as number) > 20)
      return "cite_passage";
    if (typeof one.text !== "string" || one.text === "" || [...one.text].length > 300) return "cite_text";
  }
  return "other";
}

// The checks of the cases given, in order, within `calls`. A case with no passage kept, or a
// relation missing either side's, is recorded `no_passage` without a call; an outage or a reached
// budget stops the run, and a case not reached writes nothing (the next night samples again). `each` (the dream pass's checkpoint):
// handed each row as it is made, so a pass cut short keeps every check it made.
export function checkSources(
  cases: readonly SourceCase[],
  ask: AskSource,
  budget: { calls: number },
  each?: (row: SourceCheckRow) => Promise<void>,
): Promise<JudgeRun<SourceCheckRow, SourceCheckCounts>> {
  const baseOf = (one: SourceCase) => ({
    target: one.target,
    kind: one.kind,
    targetKey: one.targetKey,
    relationId: one.relationId,
    relationJudge: one.relationJudge,
    onCited: one.onCited,
    compartments: [...one.compartments].sort(byText),
    claimKeys: [...new Set(one.passages.map((passage) => passage.claimKey))].sort(byText),
    evidenceIds: [...new Set(one.passages.map((passage) => passage.evidenceId))].sort(byText),
    ...(one.hot === undefined ? {} : { hot: one.hot }),
  });
  const relation = (one: SourceCase): boolean => one.statement.kind === "relation";
  return judge<SourceCase, SourceCheckAnswer, SourceCheckRow, SourceCheckCounts>(
    {
      call: (one) => {
        const shownCount = shownOf(one.passages).length;
        if (shownCount === 0 || (relation(one) && shownCount < one.passages.length)) return null;
        const base = baseOf(one);
        return { slot: sourceSlot(one), subject: one.subject, refs: base.evidenceIds, compartments: base.compartments };
      },
      unanswered: (one, code) => ({
        ...baseOf(one),
        ...(code === "no_passage" ? { onCited: false } : {}),
        verdict: null,
        code,
        cited: null,
      }),
      answered: (one, output) => {
        const cites = verifySourceCites(output, one.passages, relation(one));
        if (!cites.ok) return null;
        return {
          row: { ...baseOf(one), verdict: output.verdict, code: null, cited: cites.cited },
          count: output.verdict,
        };
      },
    },
    cases,
    ask,
    budget,
    { cases: 0, calls: 0, supported: 0, unsupported: 0, wrong: 0, uncited: 0, rejected: 0, noPassage: 0 },
    each,
  );
}

// The night's sample: up to `total` cases, stratified by stratum (a belief kind, or a model
// relation kind), taken one from each stratum in turn, in stratum order, each stratum in an order
// `random` shuffles. A stratum that runs out leaves its turns to the others.
export function stratifiedSample<T>(
  strata: ReadonlyMap<string, readonly T[]>,
  total: number,
  random: () => number,
): T[] {
  const queues = [...strata.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([, members]) => {
      const shuffled = [...members];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j] as T, shuffled[i] as T];
      }
      return shuffled;
    });
  const out: T[] = [];
  while (out.length < total && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next !== undefined && out.length < total) out.push(next);
    }
  }
  return out;
}

// The audit: a switched-on kind's relation raises an audit card when its selector (a number
// in [0, 1) the store derives from the relation's keyed fingerprint, so a relation is in the tenth
// or not, every night alike) is under `share`; at most `perDay` in a day, less those raised in the
// last day; oldest first by the order given. Those already audited are passed over.
export function pickAudits(
  relations: readonly { id: string; selector: number; audited: boolean }[],
  rules: { share: number; perDay: number; raisedToday: number },
): string[] {
  const room = Math.max(0, rules.perDay - rules.raisedToday);
  return relations
    .filter((one) => !one.audited && one.selector < rules.share)
    .slice(0, room)
    .map((one) => one.id);
}

// The relations sweep's order: oldest first, one subject at a time. A subject's claims are taken
// together, the subject whose oldest claim is oldest first; within a subject, oldest first; ties by
// claim key.
export function sweepOrder<T extends { key: string; subject: string; at: string }>(claims: readonly T[]): T[] {
  const time = (one: T): number => Date.parse(one.at);
  const sorted = [...claims].sort((a, b) => time(a) - time(b) || byText(a.key, b.key));
  const first = new Map<string, number>();
  sorted.forEach((one, n) => {
    if (!first.has(one.subject)) first.set(one.subject, n);
  });
  return sorted
    .map((one, n) => ({ one, n }))
    .sort((a, b) => (first.get(a.one.subject) as number) - (first.get(b.one.subject) as number) || a.n - b.n)
    .map(({ one }) => one);
}
