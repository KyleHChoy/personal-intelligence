import type { OutcomeCandidate, OutcomeExpectation, OutcomeItem } from "@intelligence/contracts/personal";
import { byText } from "@intelligence/personal-core";

export type { OutcomeCandidate, OutcomeExpectation, OutcomeItem };

import type { OutcomeAnswer, OutcomeAttribution, OutcomeLinkKind, OutcomePath } from "@intelligence/contracts/personal";
import { type EvidenceItem, independentSources } from "@intelligence/personal-beliefs";
import { cutPassage } from "./cite.ts";
import { OUTCOME_JUDGE_POINT } from "./decision-points.ts";
import { citable, citesFound, type JudgeAnswer, type JudgeCall, judgeName } from "./judge.ts";
import { OUTCOME_JUDGE_PROMPT } from "./question-prompts.ts";

// The outcome judge, inside the relation step. For each candidate (an open expectation and an item
// that may show its outcome, found on a watched channel or from a touched subject), code judges
// first: an item the triage screen flagged or an agent record flagged never counts, and a decline
// on the work's watched thread after its move, typed by extraction as a reversal or an objection
// by its sender, fails the expectation by rule. The rest go to the model (rung 2, a closed schema,
// no tools), each asked in both orders; a link is written only when both orders agree and every
// cite is found in the passage shown. It is written unapplied: the tick applies it, with no owner's
// line, unless the owner's word outranks it or its closes were reversed past the bound, so a link
// the tick holds never takes effect anywhere. A model's `met` that depends on a named person counts only
// when the item is from that person, first-hand about them, or corroborated by an independent
// source; else it is `advances`. Attribution is `caused` only when the item came on a channel the
// work's own move used, after that move. Pure but for the model calls its caller hands in.
// Nothing here writes a status, a claim, a value or a label: a link's label is the union of its
// expectation's and its item's, which the store's trigger checks.

export type AskOutcome = (call: JudgeCall) => Promise<Exclude<JudgeAnswer<OutcomeAnswer>, "budget">>;

type OutcomeLinkRow = {
  expectationId: string;
  opportunityId: string;
  evidenceId: string;
  claimKey: string | null;
  kind: OutcomeLinkKind;
  path: OutcomePath;
  judge: string;
  attribution: OutcomeAttribution;
  passage: { start: number; end: number } | null;
  applied: boolean;
  compartments: string[];
};
type OutcomeCheck = {
  expectationId: string;
  evidenceId: string;
  claimKey: string | null;
  path: OutcomePath;
  state: "judged" | "unjudged";
  firstAnswer: string | null;
  secondAnswer: string | null;
  agreed: boolean | null;
  written: OutcomeLinkKind | null;
  code: string | null;
  compartments: string[];
};
export type OutcomeCounts = {
  candidates: number;
  calls: number;
  agreed: number;
  disagreed: number;
  uncited: number;
  rejected: number;
  flagged: number;
  ruled: number;
  bounded: number;
  links: number;
  unjudged: number;
};
type OutcomeRun = {
  links: OutcomeLinkRow[];
  checks: OutcomeCheck[];
  counts: OutcomeCounts;
  stopped: "ok" | "budget" | "unavailable";
};

export const OUTCOME_POINT = OUTCOME_JUDGE_POINT;
export const outcomeJudge = (modelId: string): string => judgeName(modelId, OUTCOME_JUDGE_PROMPT);
const RULE_JUDGE = "rule";

// A model's link is written unapplied; the tick's ledger.apply_outcome_link applies it.
const MODEL_LINK_APPLIED = false;

const labelOf = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])].sort(byText);
const candidateKey = (expectationId: string, evidenceId: string): string => `${expectationId}\n${evidenceId}`;

// The `case` slot, in one order: what is expected and the passage, cut as the relation step cuts
// one. Nothing else of the item or the work (no speaker, no address, no label, no id).
export function outcomeSlot(expectation: OutcomeExpectation, item: OutcomeItem, expectedFirst: boolean): string {
  const expected = { type: expectation.type, success: expectation.success, failure: expectation.failure };
  const passage = { text: item.passage === null ? null : cutPassage(item.passage), said: item.at.slice(0, 10) };
  return JSON.stringify(expectedFirst ? { expected, passage } : { passage, expected });
}

// Every cite must be strong and found, in the normal form, in the passage shown; any answer but
// `unrelated` needs one. Code reads the passage it sent.
export function verifyOutcomeCites(output: OutcomeAnswer, passage: string | null): boolean {
  const shown = passage === null ? [] : [citable(passage)];
  const found = citesFound(
    output.cites.map((cite) => ({ passage: 1, text: cite.text })),
    shown,
  );
  return found && (output.outcome === "unrelated" || output.cites.length > 0);
}

// Code's verdict (rung 0) on a reply from the expected person on the work's watched thread, after
// its move: a decline fails the expectation; any other reply meets an `answered` one. The tick's
// ledger.match_outcomes writes that `met` from clear columns, so the step leaves the model out of
// it and writes only the decline, which needs the opened claim.
export function ruleOutcome(
  candidate: Pick<OutcomeCandidate, "expectation" | "item" | "path">,
): "met" | "not_met" | null {
  const { expectation, item, path } = candidate;
  if (path !== "watched" || !item.reply || !item.fromPerson || !item.afterMove) return null;
  if (item.decline) return "not_met";
  return expectation.type === "answered" ? "met" : null;
}

// Attribution: `caused` only when the outcome came on a channel the work's own move used,
// after that move.
export const attributionOf = (item: Pick<OutcomeItem, "afterMove">): OutcomeAttribution =>
  item.afterMove ? "caused" : "observed";

// The bound on a model's `met`: when the work waits on a named person, the item must be from that
// person or first-hand about them, or another independent item must show the same; else it is
// `advances` at most. `others`: the other items this run's model agreed met the same expectation.
export function boundedKind(
  kind: OutcomeLinkKind,
  expectation: Pick<OutcomeExpectation, "person">,
  item: Pick<OutcomeItem, "fromPerson" | "firstHand" | "source">,
  others: readonly EvidenceItem[],
): OutcomeLinkKind {
  if (kind !== "met" || !expectation.person || item.fromPerson || item.firstHand) return kind;
  return independentSources([item.source, ...others]) >= 2 ? "met" : "advances";
}

// The first cite's span in the item's text, in UTF-16 code units, when it is found there as given.
const spanOf = (passage: string | null, output: OutcomeAnswer): { start: number; end: number } | null => {
  if (passage === null) return null;
  for (const cite of output.cites) {
    const start = passage.indexOf(cite.text);
    if (start >= 0) return { start, end: start + cite.text.length };
  }
  return null;
};

const zero = (): OutcomeCounts => ({
  candidates: 0,
  calls: 0,
  agreed: 0,
  disagreed: 0,
  uncited: 0,
  rejected: 0,
  flagged: 0,
  ruled: 0,
  bounded: 0,
  links: 0,
  unjudged: 0,
});

// A link written for a candidate, under its check's label, and the check marked written.
function linked(
  run: OutcomeRun,
  { expectation, item, path }: OutcomeCandidate,
  check: OutcomeCheck,
  link: Pick<OutcomeLinkRow, "kind" | "judge" | "applied" | "passage">,
): void {
  run.links.push({
    expectationId: expectation.id,
    opportunityId: expectation.opportunityId,
    evidenceId: item.evidenceId,
    claimKey: item.claimKey,
    path,
    attribution: attributionOf(item),
    compartments: check.compartments,
    ...link,
  });
  check.written = link.kind;
  run.counts.links += 1;
}

// The step over the candidates given, unjudged ones first and then by expectation and item, within
// `calls` model calls, a candidate starting only while both its calls fit. `checked`: the
// candidates already judged under this judge, never asked twice. `subjectOf` keys each candidate's
// saved calls. An outage stops the step; every candidate not judged is marked unjudged.
export async function judgeOutcomes(
  candidates: readonly OutcomeCandidate[],
  ask: AskOutcome,
  budget: { calls: number },
  judge: string,
  subjectOf: (candidate: OutcomeCandidate) => string,
  checked: ReadonlySet<string> = new Set(),
): Promise<OutcomeRun> {
  const run: OutcomeRun = { links: [], checks: [], counts: zero(), stopped: "ok" };
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(b.unjudged) - Number(a.unjudged) ||
      byText(a.expectation.id, b.expectation.id) ||
      byText(a.item.evidenceId, b.item.evidenceId),
  );
  // Model `met` answers that wait on the bound, by expectation, decided once every candidate is asked.
  const pending: { candidate: OutcomeCandidate; output: OutcomeAnswer; check: OutcomeCheck }[] = [];
  // Every item the model agreed met an expectation in this run, by expectation: what corroborates.
  const metBy = new Map<string, EvidenceItem[]>();
  for (const candidate of ordered) {
    const { expectation, item, path } = candidate;
    if (checked.has(candidateKey(expectation.id, item.evidenceId))) continue;
    const compartments = labelOf(expectation.compartments, item.compartments);
    const check: OutcomeCheck = {
      expectationId: expectation.id,
      evidenceId: item.evidenceId,
      claimKey: item.claimKey,
      path,
      state: "judged",
      firstAnswer: null,
      secondAnswer: null,
      agreed: null,
      written: null,
      code: null,
      compartments,
    };
    if (run.stopped !== "ok") {
      run.checks.push({ ...check, state: "unjudged" });
      run.counts.unjudged += 1;
      continue;
    }
    run.counts.candidates += 1;
    // An injection-flagged item never counts, by rule or by the model.
    if (item.flagged) {
      run.checks.push({ ...check, code: "flagged" });
      run.counts.flagged += 1;
      continue;
    }
    // Code decides a reply from the expected person on the work's thread, after its move.
    const rule = ruleOutcome(candidate);
    if (rule === "not_met")
      linked(run, candidate, check, { kind: "not_met", judge: RULE_JUDGE, applied: true, passage: null });
    if (rule !== null) {
      run.checks.push({ ...check, code: rule === "met" ? "rule_reply" : "rule_decline" });
      run.counts.ruled += 1;
      continue;
    }
    if (item.passage === null) {
      run.checks.push({ ...check, code: "no_passage" });
      continue;
    }
    if (run.counts.calls + 2 > budget.calls) {
      run.stopped = "budget";
      run.checks.push({ ...check, state: "unjudged" });
      run.counts.unjudged += 1;
      continue;
    }
    const subject = subjectOf(candidate);
    const answers: (OutcomeAnswer | null)[] = [];
    let uncited = false;
    let rejected = false;
    let away = false;
    for (const expectedFirst of [true, false]) {
      run.counts.calls += 1;
      const answer = await ask({
        slot: outcomeSlot(expectation, item, expectedFirst),
        subject,
        refs: [item.evidenceId],
        compartments,
      });
      if (answer === "unavailable") {
        away = true;
        break;
      }
      if ("rejected" in answer) {
        rejected = true;
        answers.push(null);
        continue;
      }
      if (!verifyOutcomeCites(answer.output, item.passage)) uncited = true;
      answers.push(answer.output);
    }
    if (away) {
      run.stopped = "unavailable";
      run.checks.push({ ...check, state: "unjudged" });
      run.counts.unjudged += 1;
      continue;
    }
    const [first = null, second = null] = answers;
    check.firstAnswer = first?.outcome ?? null;
    check.secondAnswer = second?.outcome ?? null;
    check.agreed = first !== null && second !== null ? first.outcome === second.outcome : null;
    if (check.agreed === true) run.counts.agreed += 1;
    if (check.agreed === false) run.counts.disagreed += 1;
    if (rejected) {
      check.code = "rejected";
      run.counts.rejected += 1;
    } else if (check.agreed !== true) check.code = "disagreed";
    else if (uncited) {
      check.code = "uncited";
      run.counts.uncited += 1;
    } else if (first !== null && first.outcome !== "unrelated") {
      if (first.outcome === "met") metBy.set(expectation.id, [...(metBy.get(expectation.id) ?? []), item.source]);
      if (first.outcome === "met" && expectation.person && !item.fromPerson && !item.firstHand) {
        pending.push({ candidate, output: first, check });
        continue;
      }
      linked(run, candidate, check, {
        kind: first.outcome,
        judge,
        applied: MODEL_LINK_APPLIED,
        passage: spanOf(item.passage, first),
      });
    }
    run.checks.push(check);
  }
  // The bound, with every agreed `met` of this run in hand: corroborated by an independent item,
  // or `advances`.
  for (const { candidate, output, check } of pending) {
    const others = (metBy.get(candidate.expectation.id) ?? []).filter((one) => one !== candidate.item.source);
    const kind = boundedKind("met", candidate.expectation, candidate.item, others);
    if (kind !== "met") {
      check.code = "bound_advances";
      run.counts.bounded += 1;
    }
    linked(run, candidate, check, {
      kind,
      judge,
      applied: MODEL_LINK_APPLIED,
      passage: spanOf(candidate.item.passage, output),
    });
    run.checks.push(check);
  }
  return run;
}
