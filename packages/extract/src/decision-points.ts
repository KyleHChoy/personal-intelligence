import type { AppliedThreshold } from "@intelligence/contracts/personal";
import { baseVersion, LANE_VERSIONS } from "./lane-versions.ts";
import { promptOf } from "./prompts.ts";
import {
  CLAIM_RELATIONS_PROMPT,
  DECIDE_RECORD,
  DECIDE_RECOVERY,
  DECIDE_SAID,
  DECIDE_SCREEN,
  DECIDE_STANDALONE,
  OUTCOME_JUDGE_PROMPT,
  RECALL_AUDIT_PROMPT,
  SOURCE_CHECK_PROMPT,
} from "./question-prompts.ts";
import { DEFAULT_LANE_LINE } from "./triage.ts";

// The decision points of extraction, as plain frozen data. Earlier versions' pins stay in the
// contracts' DECISION_POINT_PINS, which records every version already made. The ladder copies these
// into its registry and tests them against this constant, field for field: `id`, `version`,
// `rungs`, `outputs` and `prompts` are the contract's DecisionPointDefinition; `effectClasses`,
// `pins` and `thresholds` are what the tests check beside it. A threshold is part of its point: a
// change is a new version. Each rung 1 point's threshold has a default, a floor and a ceiling,
// which the contracts' THRESHOLD_PINS pin.

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") for (const inner of Object.values(value)) deepFreeze(inner);
  return Object.freeze(value);
};

// The prompts a run asks with no switch on: each lane's base version, from its row.
const pins = (["correspondence", "transaction", "agent", "document", "meeting", "moment"] as const).map((lane) => {
  const { promptId: id } = LANE_VERSIONS[lane];
  const version = baseVersion(lane);
  return { lane, id, version, textHash: promptOf(id, version).textHash };
});
const decideOf = (prompt: typeof DECIDE_SCREEN) => ({
  prompts: [{ id: prompt.id, version: prompt.version }],
  pins: [{ id: prompt.id, version: prompt.version, textHash: prompt.textHash }],
});
const decideModel = decideOf(DECIDE_SCREEN);
const bounds = (value: number, floor: number, ceiling: number) => ({ default: value, floor, ceiling });

export const EXTRACT_DECISION_POINTS = deepFreeze([
  {
    id: "extract_triage",
    version: 5,
    rungs: [0, 1],
    outputs: {
      correspondence: "set_lane",
      transaction: "set_lane",
      skip: "set_lane",
      document: "set_lane",
      meeting: "set_lane",
      moment: "set_lane",
    },
    effectClasses: { set_lane: "internal_reversible" },
    ...decideModel,
    thresholds: { lane: bounds(DEFAULT_LANE_LINE, 0.2, 0.8) },
  },
  {
    id: "extract_claims",
    version: 26,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    effectClasses: { to_checker: "internal_reversible", withhold_item: "narrow" },
    prompts: pins.map(({ id, version }) => ({ id, version })),
    pins,
  },
  {
    id: "extract_injection",
    version: 2,
    rungs: [1],
    outputs: { quarantine: "withhold_item", none: "record_silence" },
    effectClasses: { withhold_item: "narrow", record_silence: "narrow" },
    ...decideModel,
    thresholds: { hold: bounds(0.7, 0.5, 0.99) },
  },
  {
    id: "extract_sensitivity",
    version: 2,
    rungs: [1],
    outputs: { special_category: "withhold_item", none: "record_silence" },
    effectClasses: { withhold_item: "narrow", record_silence: "narrow" },
    ...decideModel,
    thresholds: { hold: bounds(0.7, 0.5, 0.99) },
  },
  // Account-recovery mail beyond the term list, and instructions in an agent's finding.
  {
    id: "extract_recovery",
    version: 1,
    rungs: [1],
    outputs: { recovery: "hold_message", none: "record_silence" },
    effectClasses: { hold_message: "narrow", record_silence: "narrow" },
    ...decideOf(DECIDE_RECOVERY),
    thresholds: { hold: bounds(0.7, 0.3, 0.95) },
  },
  {
    id: "record_injection",
    // jev_record version 2: an agent's own judgment about its work is reporting.
    version: 3,
    rungs: [1],
    outputs: { quarantine: "withhold_item", none: "record_silence" },
    effectClasses: { withhold_item: "narrow", record_silence: "narrow" },
    ...decideOf(DECIDE_RECORD),
    thresholds: { hold: bounds(0.7, 0.5, 0.99) },
  },
] as const);

// The claim intake's two rung 1 points, as the contracts' DECISION_POINTS give
// them, with their thresholds beside: `standalone` over the line alone, `said` beside the quote.
// At or above the accept line the line is kept; below it, or with no answer, the claim is refused.
export const CLAIM_INTAKE_POINTS = deepFreeze([
  {
    id: "claims_standalone",
    version: 1,
    question: "standalone",
    refusal: "not_standalone",
    prompt: { id: DECIDE_STANDALONE.id, version: DECIDE_STANDALONE.version, textHash: DECIDE_STANDALONE.textHash },
    thresholds: { accept: bounds(0.5, 0.2, 0.9) },
  },
  {
    id: "claims_said",
    version: 1,
    question: "said",
    refusal: "not_what_was_said",
    prompt: { id: DECIDE_SAID.id, version: DECIDE_SAID.version, textHash: DECIDE_SAID.textHash },
    thresholds: { accept: bounds(0.5, 0.2, 0.9) },
  },
] as const);

// The relation step's point. Rung 0 is code's relations at the store's commit; rung 2 is the
// model's, over `personal_claim_relations@1`, asked in both orders. Every model relation it writes
// is in shadow until the system's measured switch turns its kind on, and none may while the
// switching hold stands (`R11_HOLD`, personal-beliefs' relations.ts). Its model relations are
// judged `model:<model>@personal_claim_relations@1`.
export const CLAIM_RELATIONS_POINT = deepFreeze({
  id: "claim_relations",
  version: 1,
  rungs: [0, 2],
  outputs: {
    supersedes: "write_relation",
    contradicts: "write_relation",
    fulfils: "write_relation",
    refines: "write_relation",
    same_fact: "write_relation",
    prevails: "write_relation",
    unrelated: "record_silence",
  },
  effectClasses: { write_relation: "internal_reversible", record_silence: "narrow" },
  prompt: {
    id: CLAIM_RELATIONS_PROMPT.id,
    version: CLAIM_RELATIONS_PROMPT.version,
    textHash: CLAIM_RELATIONS_PROMPT.textHash,
  },
} as const);

// The outcome judge, rung 0 (code's reply and decline rules) and rung 2
// (`personal_outcome_judge@1`, asked in both orders). Every model link it writes is in shadow until
// the system's measured switch turns its kind on, and none may while the switching hold stands
// (`R11_HOLD`, personal-beliefs' relations.ts). Its model links are judged
// `model:<model>@personal_outcome_judge@1`.
export const OUTCOME_JUDGE_POINT = deepFreeze({
  id: "outcome_judge",
  version: 1,
  rungs: [0, 2],
  outputs: {
    met: "write_outcome_link",
    not_met: "write_outcome_link",
    partial: "write_outcome_link",
    advances: "write_outcome_link",
    unrelated: "record_silence",
  },
  effectClasses: { write_outcome_link: "internal_reversible", record_silence: "narrow" },
  prompt: {
    id: OUTCOME_JUDGE_PROMPT.id,
    version: OUTCOME_JUDGE_PROMPT.version,
    textHash: OUTCOME_JUDGE_PROMPT.textHash,
  },
} as const);

// The source check, rung 2 (`personal_source_check@4`, asked once). Its answer is a measure: one
// check row, which the relation switch reads per relation kind. Its checks are judged
// `model:<model>@personal_source_check@4`.
export const SOURCE_CHECK_POINT = deepFreeze({
  id: "source_check",
  version: 1,
  rungs: [2],
  outputs: { supported: "record_check", unsupported: "record_check", wrong: "record_check" },
  effectClasses: { record_check: "narrow" },
  prompt: { id: SOURCE_CHECK_PROMPT.id, version: SOURCE_CHECK_PROMPT.version, textHash: SOURCE_CHECK_PROMPT.textHash },
} as const);

// The recall audit, rung 2 (`personal_recall_audit@1`, asked once). Its answer is a measure of a closed
// filter: one row of ids and codes.
export const RECALL_AUDIT_POINT = deepFreeze({
  id: "recall_audit",
  version: 1,
  rungs: [2],
  outputs: { found: "record_check", none: "record_check" },
  effectClasses: { record_check: "narrow" },
  prompt: { id: RECALL_AUDIT_PROMPT.id, version: RECALL_AUDIT_PROMPT.version, textHash: RECALL_AUDIT_PROMPT.textHash },
} as const);

// The lines one run applies: at or above a line, the answer is yes. Read once when the run starts
// and used for the whole run. `laneSuspended` is the drift suspension of extract_triage's rung 1:
// triage then runs by rung 0's lines, and the injection and sensitivity holds are unaffected.
// `applied` is what the run records, each value with its source.
export type RunThresholds = {
  lane: number;
  quarantine: number;
  specialCategory: number;
  recovery: number;
  record: number;
  // The claim intake's two accept lines, null while drift suspends the rung.
  standalone: number | null;
  said: number | null;
  laneSuspended: boolean;
  applied: AppliedThreshold[];
};

// Each point version's effective values, by name, as the ladder's effectiveThresholds gives them
// from the owner's grants.
type EffectiveValues = Readonly<Record<string, Readonly<Record<string, { value: number; source: string }>>>>;

type IntakePoint = (typeof CLAIM_INTAKE_POINTS)[number];
type ExtractPoint = (typeof EXTRACT_DECISION_POINTS)[number];
const pointOf = <I extends ExtractPoint["id"]>(id: I) =>
  EXTRACT_DECISION_POINTS.find((point) => point.id === id) as Extract<ExtractPoint, { id: I }>;
const TRIAGE = pointOf("extract_triage");
const INJECTION = pointOf("extract_injection");
const SENSITIVITY = pointOf("extract_sensitivity");
const RECOVERY = pointOf("extract_recovery");
const RECORD = pointOf("record_injection");

export function runThresholds(effective: EffectiveValues, suspended: readonly string[]): RunThresholds {
  const applied: AppliedThreshold[] = [];
  const laneSuspended = suspended.includes(`${TRIAGE.id}@${TRIAGE.version}`);
  // A suspended rung applies no line, so the run records none for it.
  const read = (point: { id: string; version: number }, name: string, fallback: number, record = true): number => {
    const key = `${point.id}@${point.version}`;
    const given = effective[key]?.[name];
    const one = given ?? { value: fallback, source: "default" };
    if (record) applied.push({ point: key, name, value: one.value, source: one.source });
    return one.value;
  };
  const intake = (point: IntakePoint): number | null =>
    suspended.includes(`${point.id}@${point.version}`) ? null : read(point, "accept", point.thresholds.accept.default);
  return {
    lane: read(TRIAGE, "lane", TRIAGE.thresholds.lane.default, !laneSuspended),
    quarantine: read(INJECTION, "hold", INJECTION.thresholds.hold.default),
    specialCategory: read(SENSITIVITY, "hold", SENSITIVITY.thresholds.hold.default),
    recovery: read(RECOVERY, "hold", RECOVERY.thresholds.hold.default),
    record: read(RECORD, "hold", RECORD.thresholds.hold.default),
    standalone: intake(CLAIM_INTAKE_POINTS.find((point) => point.question === "standalone") as IntakePoint),
    said: intake(CLAIM_INTAKE_POINTS.find((point) => point.question === "said") as IntakePoint),
    laneSuspended,
    applied,
  };
}

// The defaults: a run with no grant and no suspension.
export const DEFAULT_THRESHOLDS: RunThresholds = deepFreeze(runThresholds({}, []));
