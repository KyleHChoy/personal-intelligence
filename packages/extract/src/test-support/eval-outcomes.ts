import type { OutcomeLinkKind } from "@intelligence/contracts/personal";
import { wilsonLow } from "@intelligence/personal-beliefs";
import { type AskOutcome, judgeOutcomes, type OutcomeCandidate, outcomeJudge } from "../outcome-judge.ts";
import { OUTCOME_JUDGE_PROMPT } from "../question-prompts.ts";
import { R11_POSITIVES } from "./eval-relations.ts";

// The outcome judge scored on a labelled set of expectations and passages, per link kind,
// precision and recall, with false links counted. Each case is one
// candidate, judged as a run judges it (code first, then both orders); its label is the link the
// system should record. A kind's precision is read as its 95% Wilson lower bound, and each kind's
// positives are reported against the 100 a kind needs before it may switch.
// Attribution is scored beside. Counts and rates only.

export const OUTCOME_KINDS: readonly OutcomeLinkKind[] = ["met", "not_met", "partial", "advances"];

// One case as the judge is given it: the set's shape, without importing the testing package here.
type OutcomeEvalInput = {
  id: string;
  path: "watched" | "open";
  expected: { type: string; success: string | null; failure: string | null; person: boolean };
  passage: string;
  at: string;
  label: OutcomeLinkKind | "unrelated";
  attribution: "caused" | "observed";
  item: {
    fromPerson: boolean;
    firstHand: boolean;
    afterMove: boolean;
    reply: boolean;
    decline: boolean;
    flagged: boolean;
    domain: string;
    thread: string;
  };
};

type OutcomeKindScore = {
  kind: OutcomeLinkKind;
  positives: number;
  written: number;
  correct: number;
  falseLinks: number;
  precision: number | null;
  low: number;
  recall: number | null;
  perfectLow: number;
  short: number;
};
type OutcomeEvalReport = {
  cases: number;
  calls: number;
  kinds: OutcomeKindScore[];
  unrelated: { cases: number; falseLinks: number };
  flagged: { cases: number; links: number };
  attribution: { links: number; correct: number };
  ruled: number;
  bounded: number;
  disagreed: number;
  uncited: number;
};

const JUDGE = outcomeJudge("eval/stub");

// One case as a candidate of the step.
function candidateOf(one: OutcomeEvalInput): OutcomeCandidate {
  return {
    expectation: {
      id: one.id,
      opportunityId: "opp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      type: one.expected.type,
      success: one.expected.success,
      failure: one.expected.failure,
      person: one.expected.person,
      compartments: ["own"],
    },
    item: {
      evidenceId: `${one.id}-item`,
      claimKey: null,
      passage: one.passage,
      at: one.at,
      compartments: ["own"],
      flagged: one.item.flagged,
      fromPerson: one.item.fromPerson,
      firstHand: one.item.firstHand,
      decline: one.item.decline,
      reply: one.item.reply,
      afterMove: one.item.afterMove,
      source: {
        item: `${one.id}-item`,
        domain: one.item.domain,
        thread: one.item.thread,
        agent: false,
        firstHand: one.item.firstHand,
        authenticated: false,
        domainMatches: false,
        at: one.at,
        flagged: one.item.flagged,
      },
    },
    path: one.path,
    unjudged: false,
  };
}

export async function evaluateOutcomes(
  cases: readonly OutcomeEvalInput[],
  ask: AskOutcome,
): Promise<OutcomeEvalReport> {
  const tally = new Map<OutcomeLinkKind, { positives: number; written: number; correct: number; falseLinks: number }>(
    OUTCOME_KINDS.map((kind) => [kind, { positives: 0, written: 0, correct: 0, falseLinks: 0 }]),
  );
  const report = {
    calls: 0,
    unrelatedFalse: 0,
    flaggedLinks: 0,
    attributed: 0,
    attributedRight: 0,
    ruled: 0,
    bounded: 0,
    disagreed: 0,
    uncited: 0,
  };
  const counted: AskOutcome = async (call) => {
    report.calls += 1;
    return ask(call);
  };
  for (const one of cases) {
    if (one.label !== "unrelated") (tally.get(one.label) as { positives: number }).positives += 1;
    const run = await judgeOutcomes([candidateOf(one)], counted, { calls: 2 }, JUDGE, () => `facts:${one.id}`);
    report.ruled += run.counts.ruled;
    report.bounded += run.counts.bounded;
    report.disagreed += run.counts.disagreed;
    report.uncited += run.counts.uncited;
    const [link] = run.links;
    if (link === undefined) continue;
    if (one.item.flagged) report.flaggedLinks += 1;
    report.attributed += 1;
    if (link.attribution === one.attribution) report.attributedRight += 1;
    const score = tally.get(link.kind) as { written: number; correct: number; falseLinks: number };
    score.written += 1;
    if (link.kind === one.label) score.correct += 1;
    else {
      score.falseLinks += 1;
      if (one.label === "unrelated") report.unrelatedFalse += 1;
    }
  }
  const kinds = OUTCOME_KINDS.map((kind): OutcomeKindScore => {
    const { positives, written, correct, falseLinks } = tally.get(kind) as {
      positives: number;
      written: number;
      correct: number;
      falseLinks: number;
    };
    return {
      kind,
      positives,
      written,
      correct,
      falseLinks,
      precision: written === 0 ? null : correct / written,
      low: wilsonLow(correct, written),
      recall: positives === 0 ? null : correct / positives,
      perfectLow: wilsonLow(positives, positives),
      short: Math.max(0, R11_POSITIVES - positives),
    };
  });
  return {
    cases: cases.length,
    calls: report.calls,
    kinds,
    unrelated: { cases: cases.filter((one) => one.label === "unrelated").length, falseLinks: report.unrelatedFalse },
    flagged: { cases: cases.filter((one) => one.item.flagged).length, links: report.flaggedLinks },
    attribution: { links: report.attributed, correct: report.attributedRight },
    ruled: report.ruled,
    bounded: report.bounded,
    disagreed: report.disagreed,
    uncited: report.uncited,
  };
}

const fixed = (value: number | null): string => (value === null ? "-" : value.toFixed(3));

// The report as lines: one a kind, then the unrelated cases, the flagged ones and attribution.
export function outcomeEvalLines(report: OutcomeEvalReport): string[] {
  return [
    `cases ${report.cases} calls ${report.calls} ruled ${report.ruled} bounded ${report.bounded} disagreed ${report.disagreed} uncited ${report.uncited} prompt ${OUTCOME_JUDGE_PROMPT.id}@${OUTCOME_JUDGE_PROMPT.version}`,
    ...report.kinds.map(
      (one) =>
        `${one.kind} positives ${one.positives} written ${one.written} correct ${one.correct} false ${one.falseLinks} precision ${fixed(one.precision)} low ${fixed(one.low)} recall ${fixed(one.recall)} perfect_low ${fixed(one.perfectLow)} short_of_${R11_POSITIVES} ${one.short}`,
    ),
    `unrelated cases ${report.unrelated.cases} false ${report.unrelated.falseLinks}`,
    `flagged cases ${report.flagged.cases} links ${report.flagged.links}`,
    `attribution links ${report.attribution.links} correct ${report.attribution.correct}`,
  ];
}
