// The lever registry: every tunable number an agent or the owner may move without a deploy. A lever
// has a type, a range, a default (the value the constant it replaced had), who may move it, and the
// outcome measure that judges it. Anything not here is frozen. Pure: nothing here reads a row.
//
// A lever whose change could widen access, spend more money, send anything or weaken a kernel
// check is the owner's. So are the thresholds of the system's own alarms (`detect.*`, `filing.*`):
// they decide when a failure is raised against the work agents do.

export type LeverMover = "owner" | "agent";

export type LeverSpec = {
  type: "integer" | "number";
  min: number;
  max: number;
  default: number;
  mover: LeverMover;
  // A key of the store's OUTCOME_THRESHOLDS, held to it by a test there.
  measure: string;
  // No rule reads it: a move of it changes nothing, so the guard never blames one and no defect is
  // ever credited to one. Kept registered until it is retired or given a rule.
  unread?: true;
};

// Whether a lever's value is read by no rule (`unread`).
export const leverUnread = (key: string): boolean => isLeverKey(key) && specOf(key).unread === true;

export const LEVERS = {
  // Once the most lesson cards raised for the owner in one ISO week. It limits nothing since the
  // owner's ruling (no cap on the questions that reach them): no rule reads it, an
  // agent's move of it is never credited or blamed, and it stays only because the lever tests rest on
  // it, the one lever an agent may move.
  "lessons.digest_weekly": {
    type: "integer",
    min: 1,
    max: 10,
    default: 5,
    mover: "agent",
    measure: "owner_questions_per_week",
    unread: true,
  },
  // The outcome cards on a report that reach the owner in a week, and the share of reports drawn
  // for them. The sample is the check on what code settles without the owner, so neither reaches
  // zero and both are the owner's: an agent may not thin the check on what is settled without them.
  "outcomes.sample_weekly": {
    type: "integer",
    min: 1,
    max: 10,
    default: 3,
    mover: "owner",
    measure: "settled_without_owner_overturned",
  },
  "outcomes.sample_share": {
    type: "number",
    min: 0.05,
    max: 0.5,
    default: 0.15,
    mover: "owner",
    measure: "settled_without_owner_overturned",
  },
  // How often an item that failed because the model vendor was away is tried again, and the wait
  // before the first of those tries. The day's budget still bounds what a retry may spend, and a
  // retry is spend, so both are the owner's.
  "extract.vendor_retry_max": {
    type: "integer",
    min: 0,
    max: 8,
    default: 5,
    mover: "owner",
    measure: "mail_to_claim_24h",
  },
  "extract.vendor_retry_base_minutes": {
    type: "integer",
    min: 5,
    max: 240,
    default: 30,
    mover: "owner",
    measure: "mail_to_claim_24h",
  },
  // The carry-over gate: the most of the owner's rulings a change of generation may leave with no
  // carry by code before a run stops taking the items due again by it. None by default: raising it
  // is the owner's word that those rulings may be asked about again.
  "extract.carry_gate_max": {
    type: "integer",
    min: 0,
    max: 1000,
    default: 0,
    mover: "owner",
    measure: "owner_questions_per_week",
  },
  // The box health detectors' thresholds.
  "detect.quiet_days": { type: "integer", min: 2, max: 7, default: 3, mover: "owner", measure: "box_health_told" },
  "detect.active_days": { type: "integer", min: 8, max: 14, default: 12, mover: "owner", measure: "box_health_told" },
  "detect.budget_runs": { type: "integer", min: 2, max: 10, default: 3, mover: "owner", measure: "box_health_told" },
  "detect.backlog_over": {
    type: "integer",
    min: 10,
    max: 500,
    default: 50,
    mover: "owner",
    measure: "box_health_told",
  },
  "detect.stopped_after_days": {
    type: "integer",
    min: 2,
    max: 7,
    default: 3,
    mover: "owner",
    measure: "box_health_told",
  },
  // The filing pass's floors: when a refusal cluster or a refused tool becomes a defect.
  "filing.refusal_floor": {
    type: "integer",
    min: 5,
    max: 200,
    default: 20,
    mover: "owner",
    measure: "candidates_refused",
  },
  "filing.tool_refusal_share": {
    type: "number",
    min: 0.2,
    max: 0.9,
    default: 0.5,
    mover: "owner",
    measure: "tasks_claimed_no_result_per_day",
  },
} as const satisfies Record<string, LeverSpec>;

export type LeverKey = keyof typeof LEVERS;

export const LEVER_KEYS = Object.freeze(Object.keys(LEVERS).sort()) as readonly LeverKey[];
export const isLeverKey = (key: unknown): key is LeverKey => typeof key === "string" && Object.hasOwn(LEVERS, key);
const specOf = (key: LeverKey): LeverSpec => LEVERS[key];

// What a key marked `agent` may never name.
export const NEVER_AN_AGENTS = /spend|budget|model|grant|release|send|clearance|healthy|retry|sample/;

export const leverDefault = (key: LeverKey): number => specOf(key).default;

// Whether a value is of the lever's type and inside its range.
export function leverAdmits(key: LeverKey, value: unknown): boolean {
  const spec = specOf(key);
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (spec.type === "integer" && !Number.isInteger(value)) return false;
  return value >= spec.min && value <= spec.max;
}

// The value a lever has: the stored one when there is a row, the lever admits its value and, for a lever that is the owner's, the
// owner wrote it; the default otherwise. A stored row's author is `owner`, or `client:<client id>`.
export function leverValue(key: LeverKey, stored: { value: unknown; by: string } | null | undefined): number {
  if (stored === null || stored === undefined || !leverAdmits(key, stored.value)) return leverDefault(key);
  if (specOf(key).mover === "owner" && stored.by !== "owner") return leverDefault(key);
  return stored.value as number;
}

// Why a change is refused, or null when it may be written.
export function leverRefusal(
  key: string,
  value: unknown,
  by: LeverMover,
): "not_found" | "not_permitted" | "invalid_request" | null {
  if (!isLeverKey(key)) return "not_found";
  if (by === "agent" && specOf(key).mover !== "agent") return "not_permitted";
  return leverAdmits(key, value) ? null : "invalid_request";
}

// A lever as it is listed: its registration, without its value. Every lever is undone one way:
// set the value the history holds as the one before.
export type LeverListing = LeverSpec & { key: LeverKey; undo: "previous_value" };
export const leverListing = (key: LeverKey): LeverListing => {
  const { type, min, max, default: value, mover, measure } = specOf(key);
  return { key, type, min, max, default: value, mover, undo: "previous_value", measure };
};
