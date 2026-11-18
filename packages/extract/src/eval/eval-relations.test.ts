import type { RelationAnswer } from "@intelligence/contracts/personal";
import { compareEvidence, type EvidenceItem, mayPrevail } from "@intelligence/personal-beliefs";
import {
  CONTRADICTIONS,
  type ContradictionClaim,
  type ContradictionPair,
  contradictionCounts,
} from "@intelligence/personal-core/testing";
import { relationRules } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import { type AskRelation, type RelationSide, relationSubject } from "../relations.ts";
import {
  evaluateRelations,
  R11_POSITIVES,
  type RelationEvalCase,
  relationEvalLines,
} from "../test-support/eval-relations.ts";

// The relation step scored per kind on the contradiction evaluation set, with false relations counted, over stub model calls (no model is called, and nothing is
// spent). An oracle stub shows what the set can certify per kind at best; a careless stub shows
// false relations counted. Code's evidence order is scored for real on the set's same-tier pairs.
// The report's lines are printed so a reader can see the per-kind numbers.

const RULES = relationRules();
const fingerprint = (text: string): string => Buffer.from(text).toString("hex").padEnd(64, "0").slice(0, 64);

// What a claim says, in the words the set gives it.
const phraseOf = (claim: ContradictionClaim): string => {
  const f = claim.fields;
  if (typeof f.what === "string") return f.what;
  if (typeof f.title === "string") return `${f.title} at ${String(f.organization_name ?? "")}`;
  return `${String(f.relation ?? "")} of ${String(f.organization_name ?? "")}`;
};
const sideOf = (claim: ContradictionClaim): RelationSide => ({
  key: fingerprint(claim.id),
  id: claim.id,
  type: claim.type,
  phrase: phraseOf(claim),
  passage: `${phraseOf(claim)}.`,
  evidenceId: claim.evidence.thread,
  at: claim.validFrom,
  compartments: ["own"],
});
const evidenceOf = (claim: ContradictionClaim): EvidenceItem => ({
  item: claim.id,
  domain: claim.statedBy.split("@")[1] ?? null,
  thread: claim.evidence.thread,
  agent: false,
  firstHand: claim.evidence.firstHand,
  authenticated: claim.evidence.authenticated,
  domainMatches: false,
  at: claim.validFrom,
  flagged: false,
});
const typeOf = (claim: ContradictionClaim): string => (claim.type === "project.status" ? "project.status" : claim.type);
const asClaim = (claim: ContradictionClaim) =>
  ({ content: { type: typeOf(claim), subject: claim.subject, fields: claim.fields } }) as never;

// Code's answer for a pair: a dispute of one kind and subject a `prevails` may settle,
// decided by the evidence order, or left equal for the model.
const disputeOf = (pair: ContradictionPair): boolean =>
  pair.a.type === pair.b.type &&
  pair.a.subject === pair.b.subject &&
  phraseOf(pair.a) !== phraseOf(pair.b) &&
  mayPrevail("person", asClaim(pair.a));
const codeVerdict = (pair: ContradictionPair) => compareEvidence([evidenceOf(pair.a)], [evidenceOf(pair.b)], RULES);

// The claim is the later `b`, the candidate the earlier `a`; the label in the claim's frame.
const expectedOf = (pair: ContradictionPair): string => {
  if (pair.relation === "unrelated" || pair.relation === "same_fact" || pair.relation === "contradicts")
    return pair.relation;
  if (pair.relation === "prevails") return pair.winner === "a" ? "prevails:other" : "prevails:claim";
  return `${pair.relation}:claim`;
};
const CASES: RelationEvalCase[] = CONTRADICTIONS.map((pair) => ({
  id: pair.id,
  label: pair.relation,
  expected: expectedOf(pair),
  claim: sideOf(pair.b),
  other: sideOf(pair.a),
  mayPrevail: disputeOf(pair) && codeVerdict(pair).winner === null,
}));
const bySubject = new Map(CASES.map((one) => [relationSubject(one.claim.key, one.other.key), one]));

// An answer in the order shown, from an answer in the claim's frame, citing both phrases.
const answerFor = (
  framedAnswer: string,
  first: RelationSide,
  second: RelationSide,
  claimKey: string,
): RelationAnswer => {
  const [relation, stands] = framedAnswer.split(":") as [RelationAnswer["relation"], string | undefined];
  const claimFirst = first.key === claimKey;
  const from: RelationAnswer["from"] =
    stands === undefined ? "first" : (stands === "claim") === claimFirst ? "first" : "second";
  return {
    relation,
    from,
    cites: [
      { slot: "first", text: first.phrase },
      { slot: "second", text: second.phrase },
    ],
  };
};
const oracle: AskRelation = async ({ first, second, subject }) => {
  const one = bySubject.get(subject);
  if (one === undefined) return "unavailable";
  return { output: answerFor(one.expected, first, second, one.claim.key), savedCall: "dcc_stub" };
};
// Says `same_fact` of every pair, the cheapest wrong model.
const careless: AskRelation = async ({ first, second }) => ({
  output: {
    relation: "same_fact",
    from: "first",
    cites: [
      { slot: "first", text: first.phrase },
      { slot: "second", text: second.phrase },
    ],
  },
  savedCall: "dcc_stub",
});

describe("the relation evaluation on the contradiction set", () => {
  it("scores each kind with its lower bound and how far short of R11's 100 positives it is", async () => {
    const report = await evaluateRelations(CASES, oracle);
    const counts = contradictionCounts();
    expect(report.pairs).toBe(counts.total);
    for (const one of report.kinds) {
      expect(one.positives, one.kind).toBe(counts.byRelation[one.kind]);
      expect(one.short, one.kind).toBe(Math.max(0, R11_POSITIVES - one.positives));
      // A perfect score on fewer than 100 positives cannot certify 0.95 (a kind needs 100).
      if (one.positives < R11_POSITIVES) expect(one.perfectLow, one.kind).toBeLessThan(RULES.switch.precisionMin);
    }
    // The oracle writes no false relation; what it misses is code's to write (evidence-settled
    // prevails, which no model may write).
    expect(report.kinds.every((one) => one.falseRelations === 0)).toBe(true);
    expect(report.unrelated.falseRelations).toBe(0);
    expect(report.calls).toBe(2 * counts.total);
    process.stdout.write(`\nrelation evaluation (oracle stub)\n${relationEvalLines(report).join("\n")}\n`);
  });

  it("counts false relations: a model that calls everything one fact is caught on every other pair", async () => {
    const report = await evaluateRelations(CASES, careless);
    const sameFact = report.kinds.find((one) => one.kind === "same_fact");
    expect(sameFact?.written).toBe(CASES.length);
    expect(sameFact?.correct).toBe(CASES.filter((one) => one.label === "same_fact").length);
    expect(sameFact?.falseRelations).toBe(CASES.length - (sameFact?.correct ?? 0));
    expect(report.unrelated.falseRelations).toBe(CASES.filter((one) => one.label === "unrelated").length);
    expect(sameFact?.low).toBeLessThan(0.5);
    process.stdout.write(`\nrelation evaluation (careless stub)\n${relationEvalLines(report).join("\n")}\n`);
  });

  it("code's evidence order on the set's disputes: every evidence pair it settles is right, and it settles none the model must", () => {
    const disputes = CONTRADICTIONS.filter(disputeOf);
    const settled = disputes.filter((pair) => codeVerdict(pair).winner !== null);
    const right = settled.filter(
      (pair) =>
        pair.relation === "prevails" && pair.settledBy === "evidence" && pair.winner === codeVerdict(pair).winner,
    );
    const wrong = settled.filter((pair) => !right.includes(pair));
    const modelPairs = CONTRADICTIONS.filter((pair) => pair.settledBy === "model");
    // Every pair the set says evidence settles, and whose two sides state different values, code
    // settles the right way. One of the set's evidence pairs states one value on both sides (two
    // advisors of one organization), so it is no dispute: reported to the set's author.
    const evidencePairs = CONTRADICTIONS.filter((pair) => pair.settledBy === "evidence");
    expect(right.length).toBe(evidencePairs.filter(disputeOf).length);
    expect(evidencePairs.filter((pair) => !disputeOf(pair)).length).toBe(1);
    expect(modelPairs.every((pair) => codeVerdict(pair).winner === null)).toBe(true);
    // Its false relations by the set's labels are paraphrases (one title written two ways, labelled
    // same_fact): their values differ, so code reads a dispute and the first-hand side prevails.
    // At read a prevails acts only on a belief the rules already dispute, and leaves it disputed.
    expect(wrong.every((pair) => pair.scenario === "same_meaning_different_words")).toBe(true);
    process.stdout.write(
      `\ncode evidence order: disputes ${disputes.length} settled ${settled.length} right ${right.length} false ${wrong.length} (all same_meaning_different_words) left_for_model ${disputes.length - settled.length}\n`,
    );
  });
});
