import {
  type DecisionPointCall,
  type DecisionPointId,
  EFFECT_CLASS,
  ESCALATING_EFFECTS,
  type ModelEntry,
  type Rung,
  type Rung2Output,
  type ThresholdName,
} from "@intelligence/contracts/personal";
import type { EffectiveValue } from "./calibrate.ts";
import { hashOf } from "./hash.ts";
import type { RegisteredPoint, Registry } from "./registry.ts";
import type { Rung0 } from "./rung0.ts";
import { bandFor } from "./thresholds.ts";

// The climb: a point's rungs in order. Rung 0's function, which holds the owner's own decisions;
// then each model rung through the runner the caller hands it, banded by code under the effective
// thresholds; then the fallback or rung 4. It never calls a model itself, and a runner never sees
// the registry. Pure but for the runners.

// A point by its id, which is its current version, or by id and version, which must be current:
// only the current version is run.
export type PointRef = DecisionPointId | { id: DecisionPointId; version: number };

// A runner's answer. `skipped`: the rung is not configured or suspended, and is passed over.
// `unavailable`: the caller's rule makes the subject wait. `rejected`: the output did not parse under
// the prompt's schema; it was saved as a rejection, whose id it carries, and bands as unsure. A rung 1
// that asks more than one question gives each probability.
type Rejected = { rejected: string };
export type Rung1Answer = { p: number | readonly number[]; savedCall: string } | Rejected | "unavailable" | "skipped";
// `verified`: every citation given was found in its slot.
export type Rung2Answer =
  | { output: Rung2Output; verified: boolean; savedCall: string }
  | Rejected
  | "unavailable"
  | "skipped";

export type ClimbInput<F> = {
  facts: F;
  rung0?: Rung0<F>;
  rung1?: () => Promise<Rung1Answer>;
  rung2?: () => Promise<Rung2Answer>;
  // The effective threshold values for this point version, read once when the run started; a name
  // left out is its pinned default.
  thresholds: Partial<Record<ThresholdName, EffectiveValue>>;
  // Code's choice of one output of the band's list (the entry's onAccept or onReject).
  choose: (band: "accept" | "reject", allowed: readonly string[]) => string;
  escalatedBefore: boolean;
};

// `wait`: no call is made. `model_unavailable`, or `escalated`: the subject waits for the owner to
// answer and the point holds nothing meanwhile.
export type ClimbResult = { call: DecisionPointCall; escalate: boolean } | { wait: "model_unavailable" | "escalated" };
type Settled = { call: DecisionPointCall; escalate: boolean };
type Base = Pick<DecisionPointCall, "point" | "version" | "definitionHash" | "inputHash">;
type Trail = { thresholdIds: string[]; last: { rung: Rung; savedCall: string } | null };

const escalating = new Set<string>(ESCALATING_EFFECTS);

export function resolve(registry: Registry, point: PointRef): RegisteredPoint {
  if (typeof point === "string") return registry.current(point);
  const current = registry.current(point.id);
  if (current.definition.version !== point.version)
    throw new Error(`${point.id}@${point.version} is not the current version`);
  return current;
}

export const baseOf = ({ definition, hash }: RegisteredPoint, facts: unknown): Base => ({
  point: definition.id,
  version: definition.version,
  definitionHash: hash,
  inputHash: hashOf(facts),
});

// A call that applies `output` at `rung`. An output whose effect escalates is applied by escalating,
// with the call at the rung that answered.
function applied(
  registered: RegisteredPoint,
  base: Base,
  rung: Rung,
  output: string | null,
  extra: Partial<DecisionPointCall> = {},
): Settled {
  const effect = output === null ? null : registered.definition.outputs[output];
  if (effect === undefined) throw new Error(`${output} is not an output of ${base.point}`);
  const escalate = effect !== null && escalating.has(effect);
  return {
    call: {
      ...base,
      rung,
      output,
      effect,
      effectClass: effect === null ? null : EFFECT_CLASS[effect],
      escalated: escalate,
      ...extra,
    },
    escalate,
  };
}

// An escalated subject holds the point's whileWaiting or fallback and calls no model; with neither
// it waits.
export function start<F>(
  registered: RegisteredPoint,
  base: Base,
  facts: F,
  rung0: Rung0<F> | undefined,
  escalatedBefore: boolean,
): Settled | { wait: "escalated" } | null {
  const { definition } = registered;
  if (definition.rungs.includes(0) && rung0 !== undefined) {
    const result = rung0(facts);
    if (result !== "cannot_decide") return applied(registered, base, 0, result.output);
  }
  if (!escalatedBefore) return null;
  const held = definition.whileWaiting ?? definition.fallback;
  return held === undefined ? { wait: "escalated" } : applied(registered, base, 0, held);
}

// What no rung settled: rung 4 with the whileWaiting output in force, else the fallback, at the
// last model rung that answered, or at rung 0 when none did. A point with model entries carries
// its band, saved call and grants; a point without them carries none (the call it always made).
export function end(registered: RegisteredPoint, base: Base, trail: Trail): Settled {
  const { definition } = registered;
  const model = (band: "next" | "fallback") =>
    definition.models === undefined
      ? {}
      : { band, savedCall: trail.last?.savedCall ?? null, thresholdIds: trail.thresholdIds, run: null };
  if (definition.rungs.includes(4)) {
    const held = applied(registered, base, 4, definition.whileWaiting ?? null, model("next"));
    return { call: { ...held.call, escalated: true }, escalate: true };
  }
  if (definition.fallback !== undefined)
    return applied(registered, base, trail.last?.rung ?? 0, definition.fallback, model("fallback"));
  throw new Error(`rung 0 cannot decide ${base.point}, and it has no rung 4`);
}

// A threshold's effective value and the grant it rests on, if any: the caller's, else the default.
function threshold(
  registered: RegisteredPoint,
  given: ClimbInput<unknown>["thresholds"],
  name: ThresholdName,
  ids: string[],
): number {
  const value =
    given[name] ??
    (registered.thresholds?.[name] === undefined
      ? undefined
      : { value: registered.thresholds[name].default, source: "default" });
  if (value === undefined)
    throw new Error(`no threshold ${name} for ${registered.definition.id}@${registered.definition.version}`);
  if (value.source !== "default") ids.push(value.source.replace(/^carried:/, ""));
  return value.value;
}

type Banded = { band: "accept" | "reject" | "next"; savedCall: string } | "skipped" | "unavailable";

// Rung 1: the answer under the effective thresholds; an output that did not parse is next.
async function rungOne<F>(
  registered: RegisteredPoint,
  entry: Extract<ModelEntry, { rung: 1 }>,
  input: ClimbInput<F>,
  trail: Trail,
): Promise<Banded> {
  if (input.rung1 === undefined) return "skipped";
  const answer = await input.rung1();
  if (answer === "skipped" || answer === "unavailable") return answer;
  const { accept, reject } = entry.thresholds;
  const ids: string[] = [];
  const acceptAt = threshold(registered, input.thresholds, accept, ids);
  const rejectAt =
    reject === null || reject === "below_accept" ? reject : threshold(registered, input.thresholds, reject, ids);
  trail.thresholdIds = ids;
  if ("rejected" in answer) return { band: "next", savedCall: answer.rejected };
  return { band: bandFor(answer.p, acceptAt, rejectAt), savedCall: answer.savedCall };
}

// Rung 2: a verified yes is accept and a verified no reject; anything else, including an output that
// did not parse, is unsure, which the entry sends to next or to reject.
async function rungTwo<F>(entry: Extract<ModelEntry, { rung: 2 }>, input: ClimbInput<F>): Promise<Banded> {
  if (input.rung2 === undefined) return "skipped";
  const answer = await input.rung2();
  if (answer === "skipped" || answer === "unavailable") return answer;
  const unsure = entry.unsure === "reject" ? "reject" : "next";
  if ("rejected" in answer) return { band: unsure, savedCall: answer.rejected };
  const { output, verified, savedCall } = answer;
  return {
    band: verified && output.answer === "yes" ? "accept" : verified && output.answer === "no" ? "reject" : unsure,
    savedCall,
  };
}

export async function climb<F>(registry: Registry, point: PointRef, input: ClimbInput<F>): Promise<ClimbResult> {
  const registered = resolve(registry, point);
  const { definition } = registered;
  const base = baseOf(registered, input.facts);
  const early = start(registered, base, input.facts, input.rung0, input.escalatedBefore);
  if (early !== null) return early;

  const trail: Trail = { thresholdIds: [], last: null };
  for (const rung of definition.rungs) {
    const entry = definition.models?.find((one) => one.rung === rung);
    if (entry === undefined) continue;
    const banded = entry.rung === 1 ? await rungOne(registered, entry, input, trail) : await rungTwo(entry, input);
    if (banded === "skipped") continue;
    if (banded === "unavailable") return { wait: "model_unavailable" };
    const { band, savedCall } = banded;
    trail.last = { rung, savedCall };
    if (band === "next") continue;
    // An empty onReject makes a reject answer the next band.
    const allowed = band === "accept" ? entry.onAccept : entry.onReject;
    if (allowed.length === 0) continue;
    const output = input.choose(band, allowed);
    if (!allowed.includes(output))
      throw new Error(`${output} is not an output of the band ${band} of ${definition.id}`);
    return applied(registered, base, rung, output, { band, savedCall, thresholdIds: trail.thresholdIds, run: null });
  }
  return end(registered, base, trail);
}
