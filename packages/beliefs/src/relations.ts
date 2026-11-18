import type { EvidenceItem } from "@intelligence/contracts/personal";
import { byText } from "@intelligence/personal-core";

export type { EvidenceItem };

import type { Claim } from "@intelligence/contracts";
import type {
  BeliefClaim,
  BeliefRelation,
  ClaimRelationKind,
  ClaimTier,
  EvidenceComparison,
  RelationRules,
  RelationSwitchRow,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { PERSONAL_ONTOLOGY } from "./ontology.ts";
import { claimTier, ranksAbove } from "./tier.ts";

// The rules of claim relations, pure: the evidence order, code's relations at commit, which
// relations apply at read (the switch and the hold below), the precedence bounds, and the switching
// rule. No database, no model, no clock but the times handed in.

const at = (time: string): number => Date.parse(time);

// ---------------------------------------------------------------------------------------------
// Who judged a relation, and whether it applies.
// ---------------------------------------------------------------------------------------------

export type JudgeKind = "rule" | "model" | "owner";
export const judgeKindOf = (judge: string): JudgeKind =>
  judge.startsWith("rule:") ? "rule" : judge.startsWith("owner:") ? "owner" : "model";

// The evaluation-set hold: the system's switching job turns no model relation kind on by the
// evaluation set until each kind has at least 100 positives in it, since a smaller set cannot show
// a 0.95 precision at its lower bound. A hard hold on the system: while it is set, the job turns a
// kind on only when its source checks on the owner's own data reach their bound (`decideSwitch`'s
// `source_check`). The owner's own switch outranks the system's (invariant 11): the owner's latest
// row for a kind decides it, on or off.
export const R11_HOLD = true;

// The latest switch row of a kind for one judge (its model and prompt version) as of `asOf`, of
// `by` alone when given; the owner's on a tie.
function latestRow(
  kind: ClaimRelationKind,
  judge: string,
  switches: readonly RelationSwitchRow[],
  asOf: string,
  by?: RelationSwitchRow["by"],
): RelationSwitchRow | undefined {
  let latest: RelationSwitchRow | undefined;
  for (const row of switches) {
    if (row.kind !== kind || row.judge !== judge || at(row.at) > at(asOf) || (by !== undefined && row.by !== by))
      continue;
    if (latest === undefined || at(row.at) > at(latest.at) || (at(row.at) === at(latest.at) && row.by === "owner"))
      latest = row;
  }
  return latest;
}

// A model kind's switch for one judge as of `asOf`: the latest row at or before it. With no row it
// is off.
export function switchedOn(
  kind: ClaimRelationKind,
  judge: string,
  switches: readonly RelationSwitchRow[],
  asOf: string,
): boolean {
  return latestRow(kind, judge, switches, asOf)?.on === true;
}

// A code relation and an owner's applies; a model's only when its kind's switch is on as of the
// read's `asOf`: the owner's latest row for the kind when they have one, on or off, whatever the
// system's says (invariant 11); else the system's latest row, which the hold lets on only through
// the kind's source checks.
export function appliedAt(
  relation: Pick<BeliefRelation, "kind" | "judge">,
  switches: readonly RelationSwitchRow[],
  asOf: string,
): boolean {
  const judge = judgeKindOf(relation.judge);
  if (judge !== "model") return true;
  const owner = latestRow(relation.kind, relation.judge, switches, asOf, "owner");
  if (owner !== undefined) return owner.on;
  return latestRow(relation.kind, relation.judge, switches, asOf, "system")?.on === true;
}

// ---------------------------------------------------------------------------------------------
// The evidence order.
// ---------------------------------------------------------------------------------------------

export type EvidenceVerdict =
  | { winner: "a" | "b"; by: EvidenceComparison }
  | { winner: null; by: "equal" | "no_evidence" };

// Independent sources: items are one source when they share a sender domain or a thread, and an
// agent's records count once together. The count of such groups.
export function independentSources(items: readonly EvidenceItem[]): number {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (a: string, b: string): void => {
    const [x, y] = [find(a), find(b)].sort(byText) as [string, string];
    if (x !== y) parent.set(y, x);
  };
  for (const one of items) {
    const self = `item:${one.item}`;
    if (!parent.has(self)) parent.set(self, self);
    const marks = one.agent
      ? ["agent"]
      : [
          ...(one.domain === null ? [] : [`domain:${one.domain}`]),
          ...(one.thread === null ? [] : [`thread:${one.thread}`]),
        ];
    for (const mark of marks) {
      if (!parent.has(mark)) parent.set(mark, mark);
      union(self, mark);
    }
  }
  return new Set(items.map((one) => find(`item:${one.item}`))).size;
}

// Each comparison in the rule table's order, the first difference deciding. A side's flagged items
// are left out first; a side left with nothing is no evidence, and code decides nothing (nor may a
// model be asked to settle it).
export function compareEvidence(
  a: readonly EvidenceItem[],
  b: readonly EvidenceItem[],
  rules: Pick<RelationRules, "evidenceOrder" | "margins">,
): EvidenceVerdict {
  const left = a.filter((one) => !one.flagged);
  const right = b.filter((one) => !one.flagged);
  if (left.length === 0 || right.length === 0) return { winner: null, by: "no_evidence" };
  const any = (side: readonly EvidenceItem[], test: (one: EvidenceItem) => boolean): boolean => side.some(test);
  const newest = (side: readonly EvidenceItem[]): number => Math.max(...side.map((one) => at(one.at)));
  for (const comparison of rules.evidenceOrder) {
    let winner: "a" | "b" | null = null;
    if (comparison === "independent_sources") {
      const [x, y] = [independentSources(left), independentSources(right)];
      const { independentSourcesWin: win, independentSourcesLose: lose } = rules.margins;
      winner = x >= win && y <= lose ? "a" : y >= win && x <= lose ? "b" : null;
    } else if (comparison === "newer_statement") {
      const gap = newest(left) - newest(right);
      const margin = rules.margins.newerStatementDays * DAY_MS;
      winner = gap > margin ? "a" : -gap > margin ? "b" : null;
    } else {
      const test =
        comparison === "first_hand"
          ? (one: EvidenceItem) => one.firstHand
          : comparison === "authenticated_mail"
            ? (one: EvidenceItem) => one.authenticated
            : (one: EvidenceItem) => one.domainMatches;
      const [x, y] = [any(left, test), any(right, test)];
      winner = x && !y ? "a" : y && !x ? "b" : null;
    }
    if (winner !== null) return { winner, by: comparison };
  }
  return { winner: null, by: "equal" };
}

// ---------------------------------------------------------------------------------------------
// Code's relations at commit.
// ---------------------------------------------------------------------------------------------

// The kinds a `prevails` never settles: a fact about the owner (only the owner's word settles their word), a
// commitment, a consent and a contact rule.
const NEVER_PREVAILS: ReadonlySet<string> = new Set(["commitment", "consent", "contact_rule"]);
// The belief kinds whose keys hold a value that can differ (belief-rules.ts' `disputes` and
// `differs` rows): the only kinds where two values on one key are a dispute to settle.
const DISPUTABLE: ReadonlySet<string> = new Set([
  "role",
  "affiliation",
  "relationship",
  "situation",
  "project_status",
  "contact_rule",
]);
const STATING: ReadonlySet<string> = new Set(["stated_fact", "decision"]);
const kindOf = (claim: Claim): string | undefined => PERSONAL_ONTOLOGY.get(claim.content.type)?.beliefKind;

// Whether a `prevails` may settle a dispute between these two claims at all: never about the owner,
// never for the four excluded kinds, and only for a kind whose key can hold two values.
export function mayPrevail(subjectKind: string, claim: Claim): boolean {
  const kind = kindOf(claim);
  return subjectKind !== "owner" && kind !== undefined && DISPUTABLE.has(kind) && !NEVER_PREVAILS.has(kind);
}

// One claim on a fact key, as the commit sees it: its claim key, its id, its item, the claim, its
// subject's kind, its tier, its `value` fingerprint and its item's evidence.
export type KeyedClaim = {
  key: string;
  id: string;
  item: string;
  claim: Claim;
  subjectKind: string;
  tier: ClaimTier;
  valueFp: string;
  evidence: EvidenceItem;
};
export type CodeRelation = { from: string; to: string; kind: "supersedes" | "same_fact" | "prevails"; judge: string };

export const RULE_SUPERSEDES = "rule:supersedes.reversal";
export const RULE_SAME_FACT = "rule:same_fact.value";
export const RULE_PREVAILS = "rule:prevails.evidence";

// For one fact key: every claim on it (`onKey`, the new ones among them, named by `added`), the
// relations code judges. A reversal supersedes each earlier claim it reverses; the same value from
// two items is `same_fact`; a same-tier dispute the evidence order decides is `prevails`, from the
// winning side's newest claim to the losing side's newest. Each relation has a new claim on one
// side, so a commit judges only what it changed. In claim key order.
export function codeRelations(
  onKey: readonly KeyedClaim[],
  added: ReadonlySet<string>,
  rules: Pick<RelationRules, "evidenceOrder" | "margins">,
): CodeRelation[] {
  const out: CodeRelation[] = [];
  const seen = new Set<string>();
  const push = (relation: CodeRelation): void => {
    const id = `${relation.from}\n${relation.to}\n${relation.kind}`;
    if (relation.from === relation.to || seen.has(id)) return;
    seen.add(id);
    out.push(relation);
  };
  const isNew = (one: KeyedClaim): boolean => added.has(one.id);
  for (const r of onKey) {
    if (r.claim.statementKind !== "reversal") continue;
    for (const s of onKey) {
      if (
        !STATING.has(s.claim.statementKind) ||
        !(isNew(r) || isNew(s)) ||
        at(r.claim.validFrom) <= at(s.claim.validFrom)
      )
        continue;
      push({ from: r.key, to: s.key, kind: "supersedes", judge: RULE_SUPERSEDES });
    }
  }
  const stating = onKey.filter((one) => STATING.has(one.claim.statementKind));
  for (const x of stating) {
    if (!isNew(x)) continue;
    for (const y of stating) {
      if (y.item === x.item || y.valueFp !== x.valueFp) continue;
      push({ from: x.key, to: y.key, kind: "same_fact", judge: RULE_SAME_FACT });
    }
  }
  // The sides of a dispute: the stating claims by value.
  const sides = new Map<string, KeyedClaim[]>();
  for (const one of stating) sides.set(one.valueFp, [...(sides.get(one.valueFp) ?? []), one]);
  const list = [...sides.values()];
  const newestOf = (side: readonly KeyedClaim[]): KeyedClaim =>
    [...side].sort((p, q) => at(q.claim.validFrom) - at(p.claim.validFrom) || byText(p.key, q.key))[0] as KeyedClaim;
  const tierOf = (side: readonly KeyedClaim[]): ClaimTier =>
    side.map((one) => one.tier).reduce((best, tier) => (ranksAbove(tier, best) ? tier : best));
  for (const [i, a] of list.entries()) {
    for (const b of list.slice(i + 1)) {
      if (!a.some(isNew) && !b.some(isNew)) continue;
      const [x, y] = [newestOf(a), newestOf(b)];
      if (!mayPrevail(x.subjectKind, x.claim) || !mayPrevail(y.subjectKind, y.claim) || tierOf(a) !== tierOf(b))
        continue;
      const verdict = compareEvidence(
        a.map((one) => one.evidence),
        b.map((one) => one.evidence),
        rules,
      );
      if (verdict.winner === "a") push({ from: x.key, to: y.key, kind: "prevails", judge: RULE_PREVAILS });
      if (verdict.winner === "b") push({ from: y.key, to: x.key, kind: "prevails", judge: RULE_PREVAILS });
    }
  }
  return out.sort((p, q) => byText(p.from, q.from) || byText(p.to, q.to) || byText(p.kind, q.kind));
}

// ---------------------------------------------------------------------------------------------
// The precedence bounds, at read.
// ---------------------------------------------------------------------------------------------

// A relation as the build applies it: the stored relation, with the claims it names in this read.
export type ReadRelation = BeliefRelation & { fromIds: string[]; toIds: string[] };

// The relations that apply for one audience as of `asOf`: judged by then, labelled within the
// audience, applied by the switch (or code's or the owner's), and naming two claims this read holds
// (invariant 6: a relation applies only when the caller sees both of its claims).
export function readRelations(
  claims: readonly BeliefClaim[],
  relations: readonly BeliefRelation[],
  switches: readonly RelationSwitchRow[],
  audience: readonly string[],
  asOf: string,
): ReadRelation[] {
  const byKey = new Map<string, string[]>();
  for (const one of claims)
    for (const key of one.keys ?? []) byKey.set(key, [...new Set([...(byKey.get(key) ?? []), one.claim.id as string])]);
  const out: ReadRelation[] = [];
  for (const relation of relations) {
    if (
      at(relation.judgedAt) > at(asOf) ||
      !relation.compartments.every((one) => audience.includes(one)) ||
      !appliedAt(relation, switches, asOf)
    )
      continue;
    const fromIds = byKey.get(relation.from) ?? [];
    const toIds = byKey.get(relation.to) ?? [];
    if (fromIds.length === 0 || toIds.length === 0) continue;
    out.push({ ...relation, fromIds, toIds });
  }
  return out.sort((a, b) => byText(a.judgedAt, b.judgedAt) || byText(a.id, b.id));
}

const OWNER_WORD: ReadonlySet<ClaimTier> = new Set(["owner", "owner_confirmed"]);

// For a `supersedes` or a `refines`: the newer claim removes the older only if it is at least as
// authoritative and newer; about the owner, only the owner's own word supersedes their own word. Code's
// `supersedes` (a reversal) does no more than the reversal could alone: it applies only where the
// kind's rule ends a fact by its reversal (`reversalEnds`), and elsewhere the pair stays disputed,
// as the belief rules leave it.
export function supersedeHolds(from: BeliefClaim, to: BeliefClaim, judge: string, reversalEnds: boolean): boolean {
  const [a, b] = [claimTier(from, true), claimTier(to, true)];
  if (ranksAbove(b, a) || at(from.claim.validFrom) <= at(to.claim.validFrom)) return false;
  if (to.subjectKind === "owner" && OWNER_WORD.has(b) && !OWNER_WORD.has(a)) return false;
  return judgeKindOf(judge) !== "rule" || reversalEnds;
}

// The claims of one fact key's kept set that an applied `supersedes` or `refines` removes. Each
// pair is judged on the claims as given, so a chain (a over b, b over c) removes both b and c.
export function supersededIn(
  kept: readonly BeliefClaim[],
  relations: readonly ReadRelation[],
  reversalEnds: boolean,
): Set<string> {
  const byId = new Map(kept.map((one) => [one.claim.id as string, one]));
  const removed = new Set<string>();
  for (const relation of relations) {
    if (relation.kind !== "supersedes" && relation.kind !== "refines") continue;
    for (const fromId of relation.fromIds) {
      const from = byId.get(fromId);
      if (from === undefined) continue;
      for (const toId of relation.toIds) {
        const to = byId.get(toId);
        if (to !== undefined && toId !== fromId && supersedeHolds(from, to, relation.judge, reversalEnds))
          removed.add(toId);
      }
    }
  }
  return removed;
}

// At read: whether an applied `prevails` between these two claims may settle their dispute: never
// about the owner or for an excluded kind, never for a lower tier over a higher, and never one the
// owner judged (the owner's word on a dispute is a ruling).
export function prevailHolds(from: BeliefClaim, to: BeliefClaim, judge: string): boolean {
  if (judgeKindOf(judge) === "owner") return false;
  if (!mayPrevail(from.subjectKind, from.claim) || !mayPrevail(to.subjectKind, to.claim)) return false;
  return !ranksAbove(claimTier(to, true), claimTier(from, true));
}

// ---------------------------------------------------------------------------------------------
// The system's switch.
// ---------------------------------------------------------------------------------------------

// The 95% Wilson lower bound of a precision of `correct` out of `judged` (how the switch reads
// 0.95).
export function wilsonLow(correct: number, judged: number): number {
  if (judged === 0) return 0;
  const z = 1.96;
  const p = correct / judged;
  const denominator = 1 + (z * z) / judged;
  const centre = p + (z * z) / (2 * judged);
  const half = z * Math.sqrt((p * (1 - p)) / judged + (z * z) / (4 * judged * judged));
  return Math.max(0, (centre - half) / denominator);
}

// What the switch reads for one kind and judge. `evaluation`: its score on the evaluation set (null
// when none is recorded); `sourceCheck`: the source checks of the judge's relations of the kind
// that read the passages those relations cite, and how many found them supported (absent or null
// when none is read); `applied`, the applied version's lower bound for a new version, when one is
// applied; `agreement`, the order-swap check's live pairs and the days they span; `overturns` and
// `laterContradictions`, over the rate window, of the applied relations of the kind; `audits`, the
// owner's answers on the kind's audit cards over the rate window, and the owner's `wrong`s among them;
// `quietDays`, the whole days, most recent first, on which every rate stayed under
// `reenableFraction` of its bound.
export type SwitchMeasures = {
  evaluation: { correct: number; judged: number } | null;
  sourceCheck?: { supported: number; scored: number } | null;
  audits?: { wrong: number; answered: number } | null;
  applied?: number | null;
  agreement: { agreed: number; checked: number; days: number };
  overturns: { overturned: number; applied: number };
  laterContradictions: { contradicted: number; applied: number };
  quietDays: number;
  // The kind's own line, set by the owner from the trials (null while unset,
  // and the kind stays off), and whether the checker's verdicts agree with the owner's marks enough
  // for any line it supports to be live. Absent, the evaluation set's rule (`precisionMin`) holds.
  line?: number | null;
  checkerTrusted?: boolean;
  // The owner set no line for the kind and a trusted second model checks every finding before it takes
  // effect: the kind is on by that check alone, and goes off by its bounds.
  checkedEach?: boolean;
};
type SwitchCode =
  | "holds"
  | "overturn_bound"
  | "contradiction_bound"
  | "criteria"
  | "source_check"
  | "held_r11"
  | "no_evaluation"
  | "precision"
  | "agreement"
  | "regression"
  | "not_quiet"
  | "no_line"
  | "checked_each"
  | "unchecked"
  | "checker_paused"
  | "below_line";
export type SwitchDecision = { on: boolean; code: SwitchCode };

const rate = (n: number, of: number): number => (of === 0 ? 0 : n / of);

// An applied kind goes off when its overturn rate passes its bound (the owner's overturns of its
// relations over those applied, or the owner's audit `wrong`s over their audit answers: either one) or its
// later contradiction rate passes its own; an off kind goes on when its precision's lower bound,
// the order agreement over `orderAgreementDays`, and (for a new version) the applied version's
// precision all hold, and, when a bound switched it off, only after `reenableDays` quiet days. The
// precision is the evaluation set's, or the source checks' on the owner's own data: either lower
// bound at `precisionMin` passes. While the evaluation-set hold is set, an off kind goes on only by
// its source checks (`source_check`); by the evaluation set alone it is `held_r11`.
export function decideSwitch(
  current: { on: boolean; offByBound: boolean },
  measures: SwitchMeasures,
  rules: RelationRules["switch"],
  hold: boolean = R11_HOLD,
): SwitchDecision {
  const overturn = Math.max(
    rate(measures.overturns.overturned, measures.overturns.applied),
    rate(measures.audits?.wrong ?? 0, measures.audits?.answered ?? 0),
  );
  const later = rate(measures.laterContradictions.contradicted, measures.laterContradictions.applied);
  const checks = measures.sourceCheck ?? null;
  const lined = measures.line !== undefined;
  if (current.on) {
    if (overturn > rules.overturnRateMax) return { on: false, code: "overturn_bound" };
    if (later > rules.laterContradictionRateMax) return { on: false, code: "contradiction_bound" };
    // On by each finding's check alone, and that check is gone or no longer trusted: off.
    if (!lined && measures.checkedEach === false) return { on: false, code: "unchecked" };
    if (lined) {
      // With no line it stops, whatever the checker's trust: a kind on with none waits for the owner's.
      if (measures.line === null) return { on: false, code: "no_line" };
      // A checker that drifted from the owner pauses the line: what took effect stays.
      if (measures.checkerTrusted !== true) return { on: true, code: "checker_paused" };
      // Below its line by the sample's own precision, it stops by itself.
      if (checks !== null && checks.scored > 0 && checks.supported / checks.scored < (measures.line ?? 1))
        return { on: false, code: "below_line" };
    }
    return { on: true, code: "holds" };
  }
  if (lined && measures.line === null) return { on: false, code: "no_line" };
  if (lined && measures.checkerTrusted !== true) return { on: false, code: "checker_paused" };
  if (!lined && measures.checkedEach === true) {
    if (current.offByBound && measures.quietDays < rules.reenableDays) return { on: false, code: "not_quiet" };
    return { on: true, code: "checked_each" };
  }
  const min = lined ? (measures.line as number) : rules.precisionMin;
  const checked = checks !== null && wilsonLow(checks.supported, checks.scored) >= min;
  const evaluated =
    measures.evaluation === null ? null : wilsonLow(measures.evaluation.correct, measures.evaluation.judged);
  if (evaluated === null && !checked) return { on: false, code: checks === null ? "no_evaluation" : "precision" };
  if (!checked && (evaluated ?? 0) < min) return { on: false, code: "precision" };
  const { agreed, checked: asked, days } = measures.agreement;
  if (days < rules.orderAgreementDays || rate(agreed, asked) < rules.orderAgreementMin)
    return { on: false, code: "agreement" };
  if (evaluated !== null && measures.applied !== undefined && measures.applied !== null && evaluated < measures.applied)
    return { on: false, code: "regression" };
  if (current.offByBound && measures.quietDays < rules.reenableDays) return { on: false, code: "not_quiet" };
  if (checked) return { on: true, code: "source_check" };
  return hold ? { on: false, code: "held_r11" } : { on: true, code: "criteria" };
}

// Whether the checker's verdicts agree with the owner's own marks on the owner's weekly
// sample at the rate the owner set over at least the marks the owner set. With no gate ever set
// (`undefined`) the checker is trusted: findings take effect without the owner's marks. A gate the
// owner set is a veto until it is met, and one the owner unset (`null`) trusts nothing.
export function checkerTrusted(
  agreement: { agreed: number; marked: number },
  gate: { rate: number; marks: number } | null | undefined,
): boolean {
  if (gate === undefined) return true;
  if (gate === null || agreement.marked < gate.marks || agreement.marked === 0) return false;
  return agreement.agreed / agreement.marked >= gate.rate;
}

// Whether one day's rates are quiet: both under `reenableFraction` of their bounds.
export const quietDay = (overturn: number, later: number, rules: RelationRules["switch"]): boolean =>
  overturn < rules.overturnRateMax * rules.reenableFraction &&
  later < rules.laterContradictionRateMax * rules.reenableFraction;
