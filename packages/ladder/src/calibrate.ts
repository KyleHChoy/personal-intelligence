import {
  POINT_THRESHOLDS,
  type PointThresholds,
  type PointVerdict,
  type ThresholdBounds,
  type ThresholdGrant,
  type ThresholdName,
} from "@intelligence/contracts/personal";

// Calibration: pure functions, no clock, no I/O. Every function here is handed the owner's
// deliberate verdicts only. The caller leaves out a hurried review answer, a batch card answer, an
// answer given with the queue over its cap, and never turns a release or an override into a
// verdict: a release says the owner wants the item used, not that the point's question was answered
// wrongly.

// A verdict with the call's probability and its weight (`weightOf` when it was drawn).
export type ScoredVerdict = { p: number; verdict: PointVerdict; weight: number };
export type Interval = { low: number; high: number };
export type Threshold = { name: ThresholdName; value: number };

// The six review bands. Each is [low, high), but the last, which is closed so that 1 has a band.
export const BANDS: readonly (readonly [number, number])[] = Object.freeze([
  [0, 0.05],
  [0.05, 0.2],
  [0.2, 0.5],
  [0.5, 0.8],
  [0.8, 0.95],
  [0.95, 1],
] as const);

export function bandOf(p: number): number {
  if (!(p >= 0 && p <= 1)) throw new RangeError("probability outside [0, 1]");
  const band = BANDS.findIndex(([, high]) => p < high);
  return band === -1 ? BANDS.length - 1 : band;
}

// The version's calls in a band when it was drawn, over the number drawn from that band: a
// sample drawn near equally across bands is reweighted to the calls the point actually made.
export function weightOf(population: number, drawn: number): number {
  if (!Number.isInteger(drawn) || drawn < 1 || !Number.isInteger(population) || population < drawn)
    throw new RangeError("drawn must be 1 to population");
  return population / drawn;
}

// Weighted verdicts count for fewer than their total weight: Kish's effective sample size.
export function effectiveSampleSize(weights: readonly number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const squares = weights.reduce((sum, weight) => sum + weight * weight, 0);
  return squares === 0 ? 0 : (total * total) / squares;
}

// The Wilson score interval of a share over `effectiveN` trials, 95 percent by default.
export function wilson(share: number, effectiveN: number, z = 1.96): Interval {
  if (!(effectiveN > 0)) throw new RangeError("no trials");
  const z2 = z * z;
  const scale = 1 + z2 / effectiveN;
  const centre = (share + z2 / (2 * effectiveN)) / scale;
  const half = (z / scale) * Math.sqrt((share * (1 - share)) / effectiveN + z2 / (4 * effectiveN * effectiveN));
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

// What a threshold decides, as an answer to its point's question. A `hold` holds, an `accept`
// accepts and the `lane` lanes correspondence at or above it: each says yes when p >= t. A
// `clear` passes a draft and a `reject` rejects at or below it: each says no when p <= t, and
// otherwise leaves yes standing (the item goes on to the owner).
export function decides(threshold: Threshold, p: number): PointVerdict {
  if (threshold.name === "clear" || threshold.name === "reject") return p <= threshold.value ? "no" : "yes";
  return p >= threshold.value ? "yes" : "no";
}

type Share = { share: number; interval: Interval };

// The weighted share of `subset` for which `counted` holds, with its interval; null when the
// subset is empty, so a value with no denominator is null and never 0.
function shareOf(subset: readonly ScoredVerdict[], counted: (verdict: ScoredVerdict) => boolean): Share | null {
  const total = subset.reduce((sum, verdict) => sum + verdict.weight, 0);
  if (total === 0) return null;
  const hit = subset.reduce((sum, verdict) => sum + (counted(verdict) ? verdict.weight : 0), 0);
  const share = hit / total;
  return { share, interval: wilson(share, effectiveSampleSize(subset.map((verdict) => verdict.weight))) };
}

const isYes = (verdict: ScoredVerdict): boolean => verdict.verdict === "yes";
const agreesWith =
  (threshold: Threshold) =>
  (verdict: ScoredVerdict): boolean =>
    decides(threshold, verdict.p) === verdict.verdict;

const tooFew = (verdicts: readonly ScoredVerdict[]): boolean => {
  const yes = verdicts.filter(isYes).length;
  return verdicts.length < 30 || yes < 5 || verdicts.length - yes < 5;
};

type BandRow = { band: number; n: number; yesShare: number | null; meanP: number | null };
export type CalibrationReport = {
  n: number;
  bands: BandRow[];
  precision: number | null;
  recall: number | null;
  agreement: number | null;
  agreement28d: number | null;
  intervals: {
    precision: Interval | null;
    recall: Interval | null;
    agreement: Interval | null;
    agreement28d: Interval | null;
  };
  insufficient: boolean;
};

// The weekly report of one point version: counts, weighted shares and intervals, naming no item.
// At the threshold, precision is the weighted share of yes among the verdicts it decided yes
// (for a hold, the held items) and recall the weighted share of the yes verdicts it decided yes
// (for a hold, those held); agreement is the weighted share it decided as the owner answered,
// over every verdict and over `recent`, the last 28 days'. `threshold` null is identity_rank,
// which has none: its report is the bands alone.
export function report(
  verdicts: readonly ScoredVerdict[],
  threshold: Threshold | null,
  recent?: readonly ScoredVerdict[],
): CalibrationReport {
  const bands = BANDS.map((_, band): BandRow => {
    const inBand = verdicts.filter((verdict) => bandOf(verdict.p) === band);
    const weight = inBand.reduce((sum, verdict) => sum + verdict.weight, 0);
    return {
      band,
      n: inBand.length,
      yesShare: shareOf(inBand, isYes)?.share ?? null,
      meanP: weight === 0 ? null : inBand.reduce((sum, verdict) => sum + verdict.p * verdict.weight, 0) / weight,
    };
  });
  const decidedYes = (verdict: ScoredVerdict): boolean => threshold !== null && decides(threshold, verdict.p) === "yes";
  const precision = threshold && shareOf(verdicts.filter(decidedYes), isYes);
  const recall = threshold && shareOf(verdicts.filter(isYes), decidedYes);
  const agreement = threshold && shareOf(verdicts, agreesWith(threshold));
  const agreement28d = threshold && recent ? shareOf(recent, agreesWith(threshold)) : null;
  return {
    n: verdicts.length,
    bands,
    precision: precision?.share ?? null,
    recall: recall?.share ?? null,
    agreement: agreement?.share ?? null,
    agreement28d: agreement28d?.share ?? null,
    intervals: {
      precision: precision?.interval ?? null,
      recall: recall?.interval ?? null,
      agreement: agreement?.interval ?? null,
      agreement28d: agreement28d?.interval ?? null,
    },
    insufficient: tooFew(verdicts),
  };
}

export type ProposalTarget = { recall?: number; miss?: number; precision?: number };
export type ProposalCode = "insufficient" | "no_target" | "none";

// Which target each threshold is proposed by; the lane needs none.
const TARGET_OF: Readonly<Record<ThresholdName, keyof ProposalTarget | null>> = {
  hold: "recall",
  clear: "miss",
  accept: "precision",
  reject: "miss",
  lane: null,
};
const NEAR = 1e-12;

// A proposal from the scored verdicts themselves, never from band totals: a share at a threshold
// other than the effective one cannot be computed from them. Every share changes only at a
// verdict's probability, so the candidates are those within [floor, ceiling], and the floor and the
// ceiling. For a hold or an accept the verdict's own probability is the highest or lowest threshold
// that keeps its set; for a clear or a reject it is the lowest that does, which leaves unseen
// probabilities above the last verdict undecided rather than passed. A proposal applies nothing:
// the owner grants it.
export function proposeThreshold(
  verdicts: readonly ScoredVerdict[],
  target: ProposalTarget | null,
  bounds: ThresholdBounds,
  name: ThresholdName,
  options: { current?: number; accept?: number } = {},
): { value: number } | ProposalCode {
  if (tooFew(verdicts)) return "insufficient";
  const wanted = TARGET_OF[name];
  const goal = wanted === null ? null : target?.[wanted];
  if (wanted !== null && goal === undefined) return "no_target";

  const inRange = verdicts.map((verdict) => verdict.p).filter((p) => p >= bounds.floor && p <= bounds.ceiling);
  const candidates = [...new Set([bounds.floor, bounds.ceiling, ...inRange])].sort((a, b) => a - b);
  const yes = verdicts.filter(isYes);
  const missAt = (t: number) =>
    shareOf(
      verdicts.filter((verdict) => verdict.p <= t),
      isYes,
    );
  const meets = (t: number): boolean => {
    if (goal === undefined || goal === null) return false;
    if (name === "hold") return (shareOf(yes, (verdict) => verdict.p >= t)?.interval.low ?? -1) >= goal;
    if (name === "accept")
      return (
        (shareOf(
          verdicts.filter((verdict) => verdict.p >= t),
          isYes,
        )?.interval.low ?? -1) >= goal
      );
    if (name === "reject" && options.accept !== undefined && t >= options.accept) return false;
    return (missAt(t)?.interval.high ?? 2) <= goal;
  };

  let found: number | undefined;
  if (name === "lane") {
    const current = options.current ?? bounds.default;
    let best = -1;
    for (const t of candidates) {
      const agreement = shareOf(verdicts, agreesWith({ name, value: t }))?.share ?? -1;
      const better =
        agreement > best + NEAR ||
        (agreement > best - NEAR && found !== undefined && Math.abs(t - current) < Math.abs(found - current) - NEAR);
      if (better) [best, found] = [agreement, t];
    }
  } else if (name === "accept") {
    found = candidates.find(meets);
  } else {
    found = candidates.findLast(meets);
  }
  return found === undefined ? "none" : { value: found };
}

export const checkGrant = (value: number, bounds: ThresholdBounds): "out_of_bounds" | null =>
  value >= bounds.floor && value <= bounds.ceiling ? null : "out_of_bounds";

export type EffectiveValue = { value: number; source: string };

// A raised grant, or one set above the default, is not carried: the new version's default holds more.
export function effectiveThreshold(
  grants: readonly ThresholdGrant[],
  point: string,
  version: number,
  name: ThresholdName,
  constants: Readonly<Record<string, PointThresholds>> = POINT_THRESHOLDS,
): EffectiveValue | null {
  const bounds = constants[`${point}@${version}`]?.[name];
  if (!bounds) return null;
  const own = grants.find((grant) => grant.point === point && grant.version === version && grant.name === name);
  const r7: EffectiveValue = own ? { value: own.value, source: own.id } : { value: bounds.default, source: "default" };
  if (name !== "hold" && name !== "clear") return r7;

  const lowered = grants.filter((grant) => {
    const earlier = constants[`${point}@${grant.version}`]?.[name];
    return (
      grant.point === point &&
      grant.name === name &&
      grant.version < version &&
      earlier !== undefined &&
      grant.value < earlier.default
    );
  });
  const carried = lowered.reduce<ThresholdGrant | undefined>(
    (latest, grant) => (latest && latest.version > grant.version ? latest : grant),
    undefined,
  );
  if (!carried) return r7;
  const value = Math.max(carried.value, bounds.floor);
  return value < r7.value ? { value, source: `carried:${carried.id}` } : r7;
}

// Every point version's effective values, `<point>@<version>` to name to value and source: what
// a run reads once when it starts (the extract package's `runThresholds`).
export function effectiveThresholds(
  grants: readonly ThresholdGrant[],
  constants: Readonly<Record<string, PointThresholds>> = POINT_THRESHOLDS,
): Record<string, Record<string, EffectiveValue>> {
  const all: Record<string, Record<string, EffectiveValue>> = {};
  for (const [key, thresholds] of Object.entries(constants)) {
    const at = key.lastIndexOf("@");
    const [point, version] = [key.slice(0, at), Number(key.slice(at + 1))];
    const values: Record<string, EffectiveValue> = {};
    for (const name of Object.keys(thresholds) as ThresholdName[]) {
      const value = effectiveThreshold(grants, point, version, name, constants);
      if (value) values[name] = value;
    }
    all[key] = values;
  }
  return all;
}

// A hold point is never suspended and its threshold never moved by the system, since either would
// hold fewer items.
export const SUSPENDED_ON_DRIFT: ReadonlySet<string> = new Set(["extract_triage", "draft_disclosure"]);

// Drift over the last 28 days' deliberate verdicts: at least 20 of them, and a weighted
// disagreement at the effective threshold more than 0.10 above that of the report the owner's
// last grant was made from, or above 0.25 with no grant. identity_rank has no threshold and
// never drifts. This only reports: raising the card, keeping one pending per point version and
// writing the suspension are the caller's, and no threshold is changed here.
export function findDrift(input: {
  point: string;
  version: number;
  recent: readonly ScoredVerdict[];
  threshold: Threshold | null;
  grantedDisagreement: number | null;
}): { drift: boolean; suspend: boolean } {
  const { point, recent, threshold, grantedDisagreement } = input;
  if (threshold === null || recent.length < 20) return { drift: false, suspend: false };
  const agreement = shareOf(recent, agreesWith(threshold));
  const disagreement = agreement === null ? 0 : 1 - agreement.share;
  const drift = grantedDisagreement === null ? disagreement > 0.25 : disagreement > grantedDisagreement + 0.1;
  return { drift, suspend: drift && SUSPENDED_ON_DRIFT.has(point) };
}
