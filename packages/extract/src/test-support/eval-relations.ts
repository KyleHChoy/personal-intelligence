import { CLAIM_RELATION_KINDS, type ClaimRelationKind } from "@intelligence/contracts/personal";
import { wilsonLow } from "@intelligence/personal-beliefs";
import { CLAIM_RELATIONS_PROMPT } from "../question-prompts.ts";
import { type AskRelation, type RelationSide, relateClaims } from "../relations.ts";

// The relation step scored on a labelled set of pairs, per kind, with false relations counted
//. Each case is one claim and one candidate, asked in both orders as a
// run asks them; a case's label is the answer a careful reader gives in the claim's frame. A
// kind's precision is read as its 95% Wilson lower bound, and each kind's count of positives is
// reported against the 100 a kind needs before it may switch. Counts and rates only.

export const R11_POSITIVES = 100;

// `expected`: the framed answer (relations.ts' `framed`): `<kind>:claim`, `<kind>:other`, a
// symmetric kind, or `unrelated`.
export type RelationEvalCase = {
  id: string;
  label: ClaimRelationKind | "unrelated";
  expected: string;
  claim: RelationSide;
  other: RelationSide;
  mayPrevail: boolean;
};

type RelationKindScore = {
  kind: ClaimRelationKind;
  positives: number;
  written: number;
  correct: number;
  // Written as this kind where the label is another kind, `unrelated`, or this kind the other way.
  falseRelations: number;
  precision: number | null;
  low: number;
  recall: number | null;
  // What even a perfect score on this many positives certifies, and how far short of the 100
  // positives a kind needs.
  perfectLow: number;
  short: number;
};

type RelationEvalReport = {
  pairs: number;
  calls: number;
  kinds: RelationKindScore[];
  unrelated: { pairs: number; falseRelations: number };
  disagreed: number;
  uncited: number;
  // The bytes each call sends, instructions and slot: the step's cost per claim scales with them.
  bytesPerCall: { mean: number; max: number };
};

export async function evaluateRelations(
  cases: readonly RelationEvalCase[],
  ask: AskRelation,
): Promise<RelationEvalReport> {
  const tally = new Map<
    ClaimRelationKind,
    { positives: number; written: number; correct: number; falseRelations: number }
  >(CLAIM_RELATION_KINDS.map((kind) => [kind, { positives: 0, written: 0, correct: 0, falseRelations: 0 }]));
  let calls = 0;
  let disagreed = 0;
  let uncited = 0;
  let unrelatedFalse = 0;
  const sizes: number[] = [];
  const counted: AskRelation = async (call) => {
    calls += 1;
    sizes.push(Buffer.byteLength(CLAIM_RELATIONS_PROMPT.instructions, "utf8") + Buffer.byteLength(call.slot, "utf8"));
    return ask(call);
  };
  for (const one of cases) {
    if (one.label !== "unrelated") (tally.get(one.label) as { positives: number }).positives += 1;
    const run = await relateClaims(
      [{ claim: one.claim, candidates: [{ other: one.other, mayPrevail: one.mayPrevail }], unjudged: false }],
      counted,
      { candidates: 1, calls: 2 },
    );
    const [check] = run.checks;
    if (check?.code === "disagreed") disagreed += 1;
    if (check?.code === "uncited") uncited += 1;
    const [relation] = run.relations;
    if (relation === undefined) continue;
    const kind = relation.kind;
    const score = tally.get(kind) as { written: number; correct: number; falseRelations: number };
    score.written += 1;
    const got = check?.firstAnswer ?? "";
    if (got === one.expected) score.correct += 1;
    else {
      score.falseRelations += 1;
      if (one.label === "unrelated") unrelatedFalse += 1;
    }
  }
  const kinds = CLAIM_RELATION_KINDS.map((kind): RelationKindScore => {
    const { positives, written, correct, falseRelations } = tally.get(kind) as {
      positives: number;
      written: number;
      correct: number;
      falseRelations: number;
    };
    return {
      kind,
      positives,
      written,
      correct,
      falseRelations,
      precision: written === 0 ? null : correct / written,
      low: wilsonLow(correct, written),
      recall: positives === 0 ? null : correct / positives,
      perfectLow: wilsonLow(positives, positives),
      short: Math.max(0, R11_POSITIVES - positives),
    };
  });
  const mean = sizes.length === 0 ? 0 : Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  return {
    pairs: cases.length,
    calls,
    kinds,
    unrelated: { pairs: cases.filter((one) => one.label === "unrelated").length, falseRelations: unrelatedFalse },
    disagreed,
    uncited,
    bytesPerCall: { mean, max: sizes.length === 0 ? 0 : Math.max(...sizes) },
  };
}

const fixed = (value: number | null): string => (value === null ? "-" : value.toFixed(3));

// The report as lines: one a kind, then the unrelated pairs and the call sizes.
export function relationEvalLines(report: RelationEvalReport): string[] {
  return [
    `pairs ${report.pairs} calls ${report.calls} disagreed ${report.disagreed} uncited ${report.uncited}`,
    ...report.kinds.map(
      (one) =>
        `${one.kind} positives ${one.positives} written ${one.written} correct ${one.correct} false ${one.falseRelations} precision ${fixed(one.precision)} low ${fixed(one.low)} recall ${fixed(one.recall)} perfect_low ${fixed(one.perfectLow)} short_of_${R11_POSITIVES} ${one.short}`,
    ),
    `unrelated pairs ${report.unrelated.pairs} false ${report.unrelated.falseRelations}`,
    `bytes_per_call mean ${report.bytesPerCall.mean} max ${report.bytesPerCall.max}`,
  ];
}
