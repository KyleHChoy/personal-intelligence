import type { RelationJob, RelationSide } from "@intelligence/contracts/personal";
import { byText } from "@intelligence/personal-core";

export type { RelationJob, RelationSide };

import type { ClaimRelationKind, RelationAnswer } from "@intelligence/contracts/personal";
import { normal } from "@intelligence/personal-beliefs";
import { cutPassage, strongCite } from "./cite.ts";
import { CLAIM_RELATIONS_POINT } from "./decision-points.ts";
import { CLAIM_RELATIONS_PROMPT } from "./question-prompts.ts";

// The relation step's rules.
// For each claim to judge, its candidates (the claims supporting its subject's current beliefs and
// open commitments, which the store computes with beliefAt under the owner's clearance), at most
// the budget's number, in claim key order; each pair asked in both orders, under a closed schema
// with no tools; only a relation both orders agree on, every cite found in the passages shown, is
// written; each pair's answers are a relation check. Past the run's call budget, a claim is marked
// unjudged and taken first by the next run. Pure but for the model calls its caller hands in: the
// store gives the claims and writes what this returns. Code's relations (rung 0) are written at
// commit (personal-beliefs' `codeRelations`); this is rung 2. Nothing here writes a value, a claim
// or a label: a relation's label is the union of its two claims', set by the
// store.

// One order's answer, or why there is none: an outage or a reached budget (the step stops, as
// `unavailable` or `budget`), or a saved refusal.
type AskAnswer = { output: RelationAnswer; savedCall: string } | { rejected: string } | "unavailable" | "budget";
export type AskRelation = (call: {
  first: RelationSide;
  second: RelationSide;
  slot: string;
  subject: string;
}) => Promise<AskAnswer>;

export type RelationCheck = {
  claimKey: string;
  claimId: string;
  otherKey: string;
  firstAnswer: string | null;
  secondAnswer: string | null;
  agreed: boolean | null;
  written: ClaimRelationKind | null;
  code: string | null;
  compartments: string[];
};
type ModelRelation = { from: string; to: string; kind: ClaimRelationKind; compartments: string[] };
type RelationMark = { claimKey: string; claimId: string; state: "judged" | "unjudged"; compartments: string[] };
export type RelationCounts = {
  claims: number;
  pairs: number;
  calls: number;
  agreed: number;
  disagreed: number;
  written: number;
  uncited: number;
  refused: number;
  rejected: number;
  unjudged: number;
};
type RelationRun = {
  relations: ModelRelation[];
  checks: RelationCheck[];
  marks: RelationMark[];
  counts: RelationCounts;
  stopped: "ok" | "budget" | "unavailable";
};

// The judge every model relation of this step names.
export const relationJudge = (modelId: string): string =>
  `model:${modelId}@${CLAIM_RELATIONS_PROMPT.id}@${CLAIM_RELATIONS_PROMPT.version}`;
export const RELATION_POINT = { id: CLAIM_RELATIONS_POINT.id, version: CLAIM_RELATIONS_POINT.version } as const;

const labelOf = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])].sort(byText);
// The keyed replay's subject: the two claim keys, sorted (`facts:` subjects).
export const relationSubject = (a: string, b: string): string => (a < b ? `facts:${a}:${b}` : `facts:${b}:${a}`);

// The `pair` slot: what each statement is, its passage cut, the day it was said, and whether a
// `prevails` may settle it. Nothing else of the claims (no speaker, no address, no label).
export const relationSlot = (first: RelationSide, second: RelationSide, mayPrevail: boolean): string =>
  JSON.stringify({
    first: {
      type: first.type,
      phrase: first.phrase,
      passage: first.passage === null ? null : cutPassage(first.passage),
      said: first.at.slice(0, 10),
    },
    second: {
      type: second.type,
      phrase: second.phrase,
      passage: second.passage === null ? null : cutPassage(second.passage),
      said: second.at.slice(0, 10),
    },
    may_prevail: mayPrevail,
  });

const SYMMETRIC: ReadonlySet<string> = new Set(["same_fact", "contradicts"]);

// An answer in the claim's frame (`from` stands in `kind` to `to`):
// `<kind>:claim` when the judged claim stands in it to the other, `<kind>:other` when the other
// does, a symmetric kind alone, or `unrelated`. `claimFirst`: the order showed the claim first.
export function framed(output: RelationAnswer, claimFirst: boolean): string {
  if (output.relation === "unrelated" || SYMMETRIC.has(output.relation)) return output.relation;
  const claimStands = (output.from === "first") === claimFirst;
  return `${output.relation}:${claimStands ? "claim" : "other"}`;
}

// Code reads the passages it sent.
export function verifyRelationCites(output: RelationAnswer, first: RelationSide, second: RelationSide): boolean {
  const passage = (side: RelationSide): string | null =>
    side.passage === null ? null : normal(cutPassage(side.passage)).text;
  const shown = { first: passage(first), second: passage(second) };
  for (const cite of output.cites) {
    const text = normal(cite.text).text.trim();
    const where = shown[cite.slot];
    if (!strongCite(text) || where === null || !where.includes(text)) return false;
  }
  if (output.relation === "unrelated") return true;
  return output.cites.some((cite) => cite.slot === "first") && output.cites.some((cite) => cite.slot === "second");
}

const zero = (): RelationCounts => ({
  claims: 0,
  pairs: 0,
  calls: 0,
  agreed: 0,
  disagreed: 0,
  written: 0,
  uncited: 0,
  refused: 0,
  rejected: 0,
  unjudged: 0,
});

// The step over the jobs given, unjudged ones first and then by claim key, within `budget`: at most
// `candidates` a claim and `calls` model calls a run, a pair starting only while both its calls fit.
// `checked` are the pairs already asked under this judge (`<claim key>\n<other key>`), never asked
// twice. An outage stops the step; every claim not finished is marked unjudged. `only` (the dream
// pass's fulfilled-commitments sweep): a pair is offered for that kind alone, and an agreed answer
// of another kind is recorded in its check with code `not_offered` and not written. `each` (the dream
// pass's checkpoint): handed what each pair and each claim's mark added, as it is made, so a pass
// cut short can keep every pair it asked; the run still holds all of it.
export async function relateClaims(
  jobs: readonly RelationJob[],
  ask: AskRelation,
  budget: { candidates: number; calls: number },
  checked: ReadonlySet<string> = new Set(),
  options: {
    only?: ClaimRelationKind;
    each?: (part: Pick<RelationRun, "relations" | "checks" | "marks">) => Promise<void>;
  } = {},
): Promise<RelationRun> {
  const run: RelationRun = { relations: [], checks: [], marks: [], counts: zero(), stopped: "ok" };
  const handed = { relations: 0, checks: 0, marks: 0 };
  const hand = async (): Promise<void> => {
    const part = {
      relations: run.relations.slice(handed.relations),
      checks: run.checks.slice(handed.checks),
      marks: run.marks.slice(handed.marks),
    };
    Object.assign(handed, { relations: run.relations.length, checks: run.checks.length, marks: run.marks.length });
    if (options.each !== undefined && part.relations.length + part.checks.length + part.marks.length > 0)
      await options.each(part);
  };
  const ordered = [...jobs].sort((a, b) => Number(b.unjudged) - Number(a.unjudged) || byText(a.claim.key, b.claim.key));
  // A pair is asked both ways at once, so one asked in this run from either side is not asked again.
  const askedNow = new Set<string>();
  for (const job of ordered) {
    const { claim } = job;
    const leave = (): void => {
      run.marks.push({
        claimKey: claim.key,
        claimId: claim.id,
        state: "unjudged",
        compartments: [...claim.compartments],
      });
      run.counts.unjudged += 1;
    };
    if (run.stopped !== "ok") {
      leave();
      continue;
    }
    run.counts.claims += 1;
    const candidates = job.candidates
      .filter((one) => one.other.key !== claim.key)
      .sort((a, b) => byText(a.other.key, b.other.key))
      .slice(0, budget.candidates);
    let finished = true;
    for (const { other, mayPrevail } of candidates) {
      if (checked.has(`${claim.key}\n${other.key}`) || askedNow.has(`${other.key}\n${claim.key}`)) continue;
      if (run.counts.calls + 2 > budget.calls) {
        run.stopped = "budget";
        finished = false;
        break;
      }
      askedNow.add(`${claim.key}\n${other.key}`);
      run.counts.pairs += 1;
      const subject = relationSubject(claim.key, other.key);
      const compartments = labelOf(claim.compartments, other.compartments);
      const answers: (string | null)[] = [];
      let uncited = false;
      let rejected = false;
      let away: false | "unavailable" | "budget" = false;
      for (const claimFirst of [true, false]) {
        const [first, second] = claimFirst ? [claim, other] : [other, claim];
        run.counts.calls += 1;
        const answer = await ask({ first, second, slot: relationSlot(first, second, mayPrevail), subject });
        if (answer === "unavailable" || answer === "budget") {
          away = answer;
          break;
        }
        if ("rejected" in answer) {
          rejected = true;
          answers.push(null);
          continue;
        }
        if (!verifyRelationCites(answer.output, first, second)) uncited = true;
        answers.push(framed(answer.output, claimFirst));
      }
      if (away !== false) {
        run.stopped = away;
        finished = false;
        break;
      }
      const [firstAnswer = null, secondAnswer = null] = answers;
      const agreed = firstAnswer !== null && secondAnswer !== null ? firstAnswer === secondAnswer : null;
      let written: ClaimRelationKind | null = null;
      let code: string | null = null;
      if (rejected) code = "rejected";
      else if (agreed !== true) code = "disagreed";
      else if (uncited) code = "uncited";
      else if (firstAnswer !== null && firstAnswer !== "unrelated") {
        const [kind, stands] = firstAnswer.split(":") as [ClaimRelationKind, string | undefined];
        // A model's `prevails` counts only where the evidence order left the sides equal.
        if (kind === "prevails" && !mayPrevail) code = "prevails_refused";
        else if (options.only !== undefined && kind !== options.only) code = "not_offered";
        else {
          const [from, to] = stands === "other" ? [other.key, claim.key] : [claim.key, other.key];
          run.relations.push({ from, to, kind, compartments });
          written = kind;
        }
      }
      if (agreed === true) run.counts.agreed += 1;
      if (agreed === false) run.counts.disagreed += 1;
      if (code === "uncited") run.counts.uncited += 1;
      if (code === "prevails_refused") run.counts.refused += 1;
      if (code === "rejected") run.counts.rejected += 1;
      if (written !== null) run.counts.written += 1;
      run.checks.push({
        claimKey: claim.key,
        claimId: claim.id,
        otherKey: other.key,
        firstAnswer,
        secondAnswer,
        agreed,
        written,
        code,
        compartments,
      });
      await hand();
    }
    if (finished)
      run.marks.push({
        claimKey: claim.key,
        claimId: claim.id,
        state: "judged",
        compartments: [...claim.compartments],
      });
    else leave();
    await hand();
  }
  await hand();
  return run;
}
