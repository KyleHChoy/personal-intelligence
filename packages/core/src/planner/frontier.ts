import type { ExploreMissing, SecondDegreeRules } from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { DAY_MS, utcDayOf } from "../days.ts";
import { secondDegreeRules } from "../views/second-degree.ts";
import { type GapCandidate, type GapHistory, gapKey, type OpenGapFlag } from "./gaps.ts";

// No model, no clock, no database: the pass hands in `now`.

// One node's parts under one label. `namerTiers`: one tier code for each distinct person with an
// own tie who names it, from the warmth row built for an audience equal to the label (`none` when
// there is none). `namedDays`: the days since a claim under the label last named it, if one did.
export type FrontierParts = {
  goalTarget: boolean;
  goalPath: boolean;
  meetingSoon: boolean;
  namerTiers: readonly string[];
  namedDays: number | null;
  missing: readonly ExploreMissing[];
};

// The value and each of its parts, as `pia work report` shows them: the three flags' weights, the
// namers' sum, the base a naming claim alone earns, the recency factor, and whether the node lacks
// anything (else the value is 0).
export type FrontierScore = {
  value: number;
  parts: {
    goalTarget: number;
    goalPath: number;
    meetingSoon: number;
    namers: number;
    base: number;
    recency: number;
    lacking: boolean;
  };
};

// The five numeric parts in the order a flag stores them (`ledger.opportunities.gap_parts`); `lacking`
// is the value being above 0. `base` is not stored: the stored value includes it.
export const FRONTIER_PARTS = Object.freeze(["goalTarget", "goalPath", "meetingSoon", "namers", "recency"] as const);
export const storedParts = (score: FrontierScore): number[] => FRONTIER_PARTS.map((part) => score.parts[part]);

// The base keeps a node only a claim names explorable within the day's budget, below any namer.
export function frontierValue(parts: FrontierParts, rules: SecondDegreeRules = secondDegreeRules()): FrontierScore {
  const weights = rules.value;
  const factors: Readonly<Record<string, number>> = weights.tierFactor;
  const goalTarget = parts.goalTarget ? weights.goalTarget : 0;
  const goalPath = parts.goalPath ? weights.goalPath : 0;
  const meetingSoon = parts.meetingSoon ? weights.meetingSoon : 0;
  const namers = parts.namerTiers.reduce((sum, tier) => sum + weights.perNamer * (factors[tier] ?? 1), 0);
  const base = parts.namedDays === null ? 0 : weights.base;
  const days = Math.max(0, parts.namedDays ?? 0);
  const recency = 0.5 ** (days / weights.recencyHalfLifeDays);
  const lacking = parts.missing.length > 0;
  const value = lacking ? (goalTarget + goalPath + meetingSoon + namers + base) * recency : 0;
  return { value, parts: { goalTarget, goalPath, meetingSoon, namers, base, recency, lacking } };
}

// An explore flag raised before: its node, label, when, the value it was raised at, and whether it
// was raised for a goal (so outside the day's budget).
export type ExploredFlag = { subject: string; labelKey: string; at: string; value: number; goal: boolean };

// A frontier candidate: a gap of trigger `explore` with its parts. `hold` (set by planExplore): it
// holds, so an open flag on it stays open, but it is not raised now.
export type ExploreCandidate = GapCandidate & { frontier: FrontierParts };
export type ScoredCandidate<C extends ExploreCandidate> = C & { score: FrontierScore; hold: boolean };

// Of the rest, one open, one the owner declined (invariant 11), and one explored within
// exploreRestDays whose value is not above the value it was last raised at are not raised. Every
// goal-relevant node is; then at most explorePerDay others of the label a day, less those already
// raised today, highest value first, ties by the lower id. The rest hold.
export function planExplore<C extends ExploreCandidate>(input: {
  candidates: readonly C[];
  open: readonly OpenGapFlag[];
  history: GapHistory;
  explored: readonly ExploredFlag[];
  now: Date;
  rules?: SecondDegreeRules;
}): ScoredCandidate<C>[] {
  const rules = input.rules ?? secondDegreeRules();
  const open = new Set(input.open.map(gapKey));
  const restFrom = input.now.getTime() - rules.exploreRestDays * DAY_MS;
  const today = utcDayOf(input.now);
  const last = new Map<string, ExploredFlag>();
  const usedToday = new Map<string, number>();
  for (const flag of input.explored) {
    const key = gapKey({ trigger: "explore", subject: flag.subject, labelKey: flag.labelKey });
    const seen = last.get(key);
    if (Date.parse(flag.at) >= restFrom && (seen === undefined || byText(seen.at, flag.at) < 0)) last.set(key, flag);
    if (!flag.goal && utcDayOf(flag.at) === today)
      usedToday.set(flag.labelKey, (usedToday.get(flag.labelKey) ?? 0) + 1);
  }
  const scored = input.candidates
    .map((candidate) => ({ ...candidate, score: frontierValue(candidate.frontier, rules), hold: true }))
    .filter((candidate) => candidate.score.value > 0);
  const eligible = scored.filter((candidate) => {
    const key = gapKey(candidate);
    if (open.has(key) || input.history.declined.has(key)) return false;
    const rested = last.get(key);
    return rested === undefined || candidate.score.value > rested.value;
  });
  const goalRelevant = (candidate: ScoredCandidate<C>): boolean =>
    candidate.frontier.goalTarget || candidate.frontier.goalPath;
  const chosen = new Set<ScoredCandidate<C>>(eligible.filter(goalRelevant));
  const byLabel = new Map<string, ScoredCandidate<C>[]>();
  for (const candidate of eligible)
    if (!goalRelevant(candidate))
      byLabel.set(candidate.labelKey, [...(byLabel.get(candidate.labelKey) ?? []), candidate]);
  for (const [label, others] of byLabel) {
    const budget = Math.max(0, rules.explorePerDay - (usedToday.get(label) ?? 0));
    others.sort((a, b) => b.score.value - a.score.value || byText(a.subject, b.subject));
    for (const one of others.slice(0, budget)) chosen.add(one);
  }
  return scored.map((candidate) => ({ ...candidate, hold: !chosen.has(candidate) }));
}
