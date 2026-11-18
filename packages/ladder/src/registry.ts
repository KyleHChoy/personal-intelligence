import {
  DECISION_POINTS,
  type DecisionPointDefinition,
  type DecisionPointId,
  DecisionPointDefinition as DefinitionSchema,
  EFFECT_CLASS,
  OWNER_ONLY_EFFECTS,
  type PointThresholds,
  type Sha256,
} from "@intelligence/contracts/personal";
import { hashOf } from "./hash.ts";

// Every version it is given is kept.

export type RegistryCode =
  | "unknown_effect"
  | "model_external"
  | "owner_only"
  | "bad_rungs"
  | "bad_queue"
  | "changed"
  | "no_prompt"
  | "no_threshold_pin"
  | "threshold_changed"
  | "duplicate"
  | "malformed"
  | "bad_models"
  | "bad_fallback"
  | "model_effect"
  | "never_climbs";

// Fields declared, not parameter properties: Node runs this file with type stripping only, and
// strip-only mode refuses a parameter property.
export class RegistryRefused extends Error {
  readonly code: RegistryCode;
  readonly point: string;

  constructor(code: RegistryCode, point: string) {
    super(`decision point ${point} refused: ${code}`);
    this.name = "RegistryRefused";
    this.code = code;
    this.point = point;
  }
}

// `thresholds` is set when the registry is loaded with them: a rung 1 point's pinned
// default, floor and ceiling for each of its thresholds.
export type RegisteredPoint = {
  readonly definition: DecisionPointDefinition;
  readonly hash: Sha256;
  readonly thresholds?: PointThresholds;
};

// A point version's default, floor and ceiling never change; the definition's own hash carries none
// of them.
export type ThresholdPins = {
  constants: Readonly<Record<string, PointThresholds>>;
  pins: Readonly<Record<string, Sha256>>;
};
// There is no lookup by id alone, so no caller takes an older version by mistake. Each throws for a
// point or version it lacks. `all()` is every version, for the checks over the whole registry.
export type Registry = {
  readonly current: (id: DecisionPointId) => RegisteredPoint;
  readonly at: (id: DecisionPointId, version: number) => RegisteredPoint;
  readonly ids: () => readonly DecisionPointId[];
  readonly all: () => readonly RegisteredPoint[];
};

// Frozen: a new point cannot leave `models` out. extract_triage@3 and extract_claims@4 stand in for
// extract_triage@2 and extract_claims@1, which they replaced. extract_claims gains a version with a
// lane's prompt and has no verdict for a band to read, so every version of it goes without entries;
// its pin in DECISION_POINT_PINS is what admits one.
export const UNBANDED: readonly string[] = Object.freeze([
  "extract_triage@3",
  "extract_injection@1",
  "extract_sensitivity@1",
  "extract_recovery@1",
  "record_injection@1",
  "identity_rank@1",
  "draft_disclosure@2",
  // The hold points at their new versions, and restrict_category@1, whose models entry is not yet
  // written.
  "extract_injection@2",
  "extract_sensitivity@2",
  "record_injection@2",
  // The record screen asking jev_record version 2.
  "record_injection@3",
  "restrict_category@1",
  // The meeting lane, and the moment lane.
  "extract_triage@4",
  "extract_triage@5",
  ...DECISION_POINTS.filter((point) => point.id === "extract_claims" && point.models === undefined).map(
    (point) => `${point.id}@${point.version}`,
  ),
]);

// A definition's hash: the SHA-256 of its canonical JSON, keys sorted.
export const definitionHash = (definition: DecisionPointDefinition): Sha256 => hashOf(definition);

// A point version's thresholds' hash: the SHA-256 of their canonical JSON, keys sorted.
export const thresholdsHash = (thresholds: PointThresholds): Sha256 => hashOf(thresholds);

const ownerOnly = new Set<string>(OWNER_ONLY_EFFECTS);
const isModelRung = (rung: number): boolean => rung >= 1 && rung <= 3;

function parse(input: unknown): DecisionPointDefinition {
  const parsed = DefinitionSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const point = String((input as { id?: unknown } | null)?.id ?? "unknown");
  const fields = new Set(parsed.error.issues.map((issue) => issue.path[0]));
  // L1: an output or a no-answer effect outside EFFECT_CLASS fails the effect enum.
  if (fields.has("outputs") || fields.has("onNoAnswer")) throw new RegistryRefused("unknown_effect", point);
  if (fields.has("rungs")) throw new RegistryRefused("bad_rungs", point);
  throw new RegistryRefused("malformed", point);
}

function check(
  definition: DecisionPointDefinition,
  pins: Readonly<Record<string, Sha256>>,
  promptPins: Readonly<Record<string, Sha256>>,
): Sha256 {
  const refuse = (code: RegistryCode): never => {
    throw new RegistryRefused(code, definition.id);
  };
  const { rungs } = definition;
  const effects = Object.values(definition.outputs);

  // L2
  if (rungs.some(isModelRung) && effects.some((effect) => EFFECT_CLASS[effect] === "external"))
    refuse("model_external");
  // L3
  if (effects.some((effect) => ownerOnly.has(effect)) && rungs.some((rung) => rung !== 4)) refuse("owner_only");
  // L4
  if (rungs.length === 0 || rungs.some((rung, index) => index > 0 && rung <= (rungs[index - 1] ?? -1)))
    refuse("bad_rungs");
  if (
    rungs.includes(4) &&
    (definition.queue === undefined ||
      definition.onNoAnswer === undefined ||
      EFFECT_CLASS[definition.onNoAnswer] !== "narrow")
  ) {
    refuse("bad_queue");
  }
  // L5: no pin is a changed definition too.
  const hash = definitionHash(definition);
  if (pins[`${definition.id}@${definition.version}`] !== hash) refuse("changed");
  // L6
  const prompts = definition.prompts ?? [];
  if (rungs.some(isModelRung) && prompts.length === 0) refuse("no_prompt");
  if (prompts.some((prompt) => promptPins[`${prompt.id}@${prompt.version}`] === undefined)) refuse("no_prompt");
  return hash;
}

// A rung 1 point's thresholds have a pin, and the constants hash to it. A point with no rung 1 has
// none: rungs 2 and 3 apply no threshold.
function thresholdsOf(definition: DecisionPointDefinition, given: ThresholdPins): PointThresholds | undefined {
  if (!definition.rungs.includes(1)) return undefined;
  const key = `${definition.id}@${definition.version}`;
  const pin = given.pins[key];
  if (pin === undefined) throw new RegistryRefused("no_threshold_pin", definition.id);
  const constants = given.constants[key];
  if (constants === undefined || thresholdsHash(constants) !== pin)
    throw new RegistryRefused("threshold_changed", definition.id);
  return constants;
}

const refuseAs = (code: RegistryCode, definition: DecisionPointDefinition): never => {
  throw new RegistryRefused(code, definition.id);
};

// What a model entry, the fallback or whileWaiting can put in force: every output they name.
const modelOutputs = (definition: DecisionPointDefinition): string[] => [
  ...(definition.models ?? []).flatMap((entry) => [...entry.onAccept, ...entry.onReject]),
  ...(definition.fallback === undefined ? [] : [definition.fallback]),
  ...(definition.whileWaiting === undefined ? [] : [definition.whileWaiting]),
];

// L7. A definition with model entries has one for each rung 1 or 2 and none for another rung;
// each names a prompt of the definition and outputs of the point; a rung 1 entry's threshold
// names have their pinned constants, and a reject default is below its accept default. On a load
// with thresholds (the shipped one), a definition with a rung 1 or 2 and no entries must be one
// of UNBANDED.
function checkModels(
  definition: DecisionPointDefinition,
  thresholds: PointThresholds | undefined,
  loadedWithThresholds: boolean,
): void {
  const modelRungs = definition.rungs.filter((rung) => rung === 1 || rung === 2);
  const { models } = definition;
  if (models === undefined) {
    if (loadedWithThresholds && modelRungs.length > 0 && !UNBANDED.includes(`${definition.id}@${definition.version}`))
      refuseAs("bad_models", definition);
    return;
  }
  const entryRungs = models.map((entry) => entry.rung).sort();
  if (entryRungs.join() !== [...modelRungs].sort().join()) refuseAs("bad_models", definition);
  const prompts = new Set((definition.prompts ?? []).map((prompt) => `${prompt.id}@${prompt.version}`));
  for (const entry of models) {
    if (!prompts.has(`${entry.prompt.id}@${entry.prompt.version}`)) refuseAs("bad_models", definition);
    if ([...entry.onAccept, ...entry.onReject].some((output) => definition.outputs[output] === undefined))
      refuseAs("bad_models", definition);
    if (entry.rung !== 1 || !loadedWithThresholds) continue;
    const { accept: acceptName, reject: rejectName } = entry.thresholds;
    const accept = thresholds?.[acceptName];
    const reject = rejectName === null || rejectName === "below_accept" ? null : thresholds?.[rejectName];
    if (accept === undefined || reject === undefined) {
      refuseAs("bad_models", definition);
      return;
    }
    if (reject !== null && reject.default >= accept.default) refuseAs("bad_models", definition);
  }
}

// L8. A definition with models whose highest rung is 1 or 2 names a fallback; a point with rung 4 names
// none (its card's onNoAnswer is its fallback); a fallback or whileWaiting is an output of the point
// whose effect is narrow.
function checkFallback(definition: DecisionPointDefinition): void {
  const top = Math.max(...definition.rungs);
  if (definition.models !== undefined && (top === 1 || top === 2) && definition.fallback === undefined)
    refuseAs("bad_fallback", definition);
  if (definition.fallback !== undefined && definition.rungs.includes(4)) refuseAs("bad_fallback", definition);
  for (const output of [definition.fallback, definition.whileWaiting]) {
    if (output === undefined) continue;
    const effect = definition.outputs[output];
    if (effect === undefined || EFFECT_CLASS[effect] !== "narrow") refuseAs("bad_fallback", definition);
  }
}

// L9: every output a model entry, the fallback or whileWaiting can give maps to narrow or
// internal_reversible. A second check of L2, per entry, so a later change to L2 still cannot hand
// a model an external output. Exported for its tests, which reach it alone: on a full load L2
// refuses first.
export function checkModelEffects(definition: DecisionPointDefinition): void {
  for (const output of modelOutputs(definition)) {
    const effect = definition.outputs[output];
    if (effect !== undefined && EFFECT_CLASS[effect] !== "narrow" && EFFECT_CLASS[effect] !== "internal_reversible")
      refuseAs("model_effect", definition);
  }
}

// L10: an owner-only effect is named by no model entry, no fallback and no whileWaiting. A second
// check of L3 (and of L2, since every owner-only effect is external), exported for its tests.
export function checkNeverClimbs(definition: DecisionPointDefinition): void {
  for (const output of modelOutputs(definition)) {
    const effect = definition.outputs[output];
    if (effect !== undefined && ownerOnly.has(effect)) refuseAs("never_climbs", definition);
  }
}

const freezeRegistry = (points: readonly RegisteredPoint[]): Registry => {
  const byKey = new Map(points.map((point) => [`${point.definition.id}@${point.definition.version}`, point]));
  const current = new Map<DecisionPointId, RegisteredPoint>();
  for (const point of points) {
    const held = current.get(point.definition.id);
    if (held === undefined || point.definition.version > held.definition.version)
      current.set(point.definition.id, point);
  }
  const all = Object.freeze([...points]);
  const ids = Object.freeze([...current.keys()]);
  return Object.freeze({
    current: (id: DecisionPointId): RegisteredPoint => {
      const point = current.get(id);
      if (point === undefined) throw new Error(`decision point ${id} is not registered`);
      return point;
    },
    at: (id: DecisionPointId, version: number): RegisteredPoint => {
      const point = byKey.get(`${id}@${version}`);
      if (point === undefined) throw new Error(`decision point ${id}@${version} is not registered`);
      return point;
    },
    ids: () => ids,
    all: () => all,
  });
};

export function loadRegistry(
  definitions: readonly DecisionPointDefinition[],
  pins: Readonly<Record<string, Sha256>>,
  promptPins: Readonly<Record<string, Sha256>>,
  thresholds?: ThresholdPins,
): Registry {
  const points: RegisteredPoint[] = [];
  const seen = new Set<string>();
  for (const input of definitions) {
    const definition = parse(input);
    const hash = check(definition, pins, promptPins);
    const pinned = thresholds === undefined ? undefined : thresholdsOf(definition, thresholds);
    // L7 to L10, after the threshold-pin check.
    checkModels(definition, pinned, thresholds !== undefined);
    checkFallback(definition);
    checkModelEffects(definition);
    checkNeverClimbs(definition);
    const key = `${definition.id}@${definition.version}`;
    if (seen.has(key)) throw new RegistryRefused("duplicate", definition.id);
    seen.add(key);
    points.push(Object.freeze({ definition, hash, ...(pinned === undefined ? {} : { thresholds: pinned }) }));
  }
  return freezeRegistry(points);
}
