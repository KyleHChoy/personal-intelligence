// What code files into the improvement store, with no model. A filing carries ids, codes and counts
// and the fixed words below, and nothing else: the store's text can reach a builder and a repository
// with a public copy, so nothing evidence said may ride along, and an instruction inside evidence
// must not reach code. Every value that is not a number passes `codeOf`, and `filingWords` refuses a
// cause or state that is not codes.

import { leverDefault, leverUnread } from "@intelligence/personal-core/planner";
import { failingSide, type HealthyTest, worsened } from "../../core/outcome-thresholds.ts";

type CauseKind =
  | "lever_change"
  | "measure_floor"
  | "outcome_drop"
  | "outcome_gap"
  | "standing_check"
  | "refusal_pattern"
  | "tool_refusals"
  | "nightly_red"
  | "box_health"
  | "ruling_detached";

type Area = "mcp" | "extraction" | "knowledge" | "work" | "sources" | "deploy" | "other";
type Severity = "medium" | "high";

export const CAUSE_KINDS: Record<CauseKind, { title: string; measures: string; severity: Severity }> = {
  lever_change: {
    title: "Measure worse after a lever change",
    measures:
      "Within seven days of an agent's change to a lever, the measure that judges it is failing and worse than its last reading before the change. The pass undoes nothing: set the lever back with set_lever (list_levers shows the value before), or the owner does. Closed when the measure reads ok or is no worse than before the change, the seven days pass or the owner changes the lever.",
    severity: "medium",
  },
  // The title says which side of its line the measure is on: `measureTitle`.
  measure_floor: {
    title: "Measure on the wrong side of its healthy line",
    measures:
      "A measure get_health serves was failing on two filing passes in a row: its state says the value, the line and the side (above a line it must stay under, below one it must reach). Read the measure and its parts with get_health. Closed when it reads ok, or as no_data when it has no data on two passes in a row.",
    severity: "medium",
  },
  outcome_drop: {
    title: "Outcome test score dropped",
    measures:
      "A visible task's score fell from the run before, or the held-out mean fell on two runs in a row; closed when it is back.",
    severity: "medium",
  },
  outcome_gap: {
    title: "Visible and held-out scores differ",
    measures:
      "The visible tasks' mean is well over the held-out mean, so the visible ones may be tuned to; closed when the gap narrows.",
    severity: "medium",
  },
  standing_check: {
    title: "Standing check failing",
    measures: "The end-to-end check's latest result for one source is not ok; closed when it is.",
    severity: "high",
  },
  refusal_pattern: {
    title: "Extraction refusals over the threshold",
    measures:
      "Candidates of one type refused for one reason, counted over the window; closed when the count is under the threshold.",
    severity: "medium",
  },
  tool_refusals: {
    title: "Agent tool refused most of the time",
    measures: "One agent tool's refused share of its calls over the window; closed when it falls under the threshold.",
    severity: "medium",
  },
  box_health: {
    title: "Box health card open",
    measures:
      "A box health condition stands: the cause names its kind and what it is about, and get_health lists the card. One defect for one condition, however many cards it raised. Closed when no card of the condition stands open, however the last one closed.",
    severity: "high",
  },
  // Filed and closed by the carry-over sweep (admin-reattach.ts), never by the daily pass.
  ruling_detached: {
    title: "Owner's ruling has no unique carry",
    measures:
      "After a change of generation one of the owner's rulings names no claim, and its evidence does not hold exactly one fact of its type naming its entities. Find why: two records of one person, an item not yet read again, or a fact now stated twice. Nothing here re-attaches it: the next carry-over sweep does when exactly one fact matches, and asks the owner when this task has ended. Closed when the ruling is carried, is gone, is lifted or the owner is asked.",
    severity: "medium",
  },
  nightly_red: {
    title: "Nightly tests red",
    measures: "Test files the last nightly report found failing, as a count; closed on a green report.",
    severity: "high",
  },
};

// The defaults of the levers `filing.refusal_floor` and `filing.tool_refusal_share`: the pass hands
// `findCauses` each lever's value as `floors`.
export const REFUSAL_FLOOR = leverDefault("filing.refusal_floor");
const TOOL_REFUSAL_MIN_CALLS = 20;
const TOOL_REFUSAL_SHARE = leverDefault("filing.tool_refusal_share");
// How long after an agent's change to a lever its judging measure reading low files a defect.
export const LEVER_GUARD_DAYS = 7;
export const GAP_FLOOR = 0.75;
export const GAP_MIN_TASKS = 4;

const CODE = /^[a-z0-9][a-z0-9_.]{0,63}$/;
// A code, or `other`. Anything with a capital, a space or punctuation is not one of ours.
export const codeOf = (value: string): string => (CODE.test(value) ? value : "other");

export const CAUSE_FORM = /^[a-z0-9_:.-]{1,200}$/;
const STATE_FORM = /^[a-z0-9_:.= -]{0,200}$/;

export type FoundCause = {
  cause: string;
  kind: CauseKind;
  area: Area;
  severity: Severity;
  state: string;
  // When what it read was measured, where that is not this pass.
  measuredAt?: string;
  // The label it is filed under, where that is not the measures' own: a card's.
  label?: string[];
  // Its title, where the kind's own does not say enough: a measure's says the side of its line.
  title?: string;
};

export type FilingInput = {
  metrics: readonly {
    metric: string;
    state: "ok" | "failing" | "no_data";
    value: number | null;
    sample: number;
    healthy: number;
    // The line's direction; absent, a line the value must reach.
    test?: HealthyTest;
  }[];
  // Each metric's state on the last pass at least half a day ago.
  earlierStates: ReadonlyMap<string, string>;
  // `why`: the cluster's refused candidates by field and issue (`field.issue`, both code's own words
  // from the refusal rows, never a value), in any order.
  refusals: readonly {
    type: string;
    reason: string;
    count: number;
    why?: readonly { code: string; count: number }[];
  }[];
  // `why`: the tool's refused calls by what was wrong (outcome, reason and argument as one code),
  // most first.
  tools: readonly { tool: string; calls: number; refused: number; why?: readonly { code: string; calls: number }[] }[];
  // A code that says the check could not run (`UNDECIDED`) neither fails nor recovers.
  canary: readonly { source: string; code: string; at?: string }[];
  // The causes standing open now: a refusal cluster that has gone from the window has recovered.
  openCauses?: readonly string[];
  scoresAt?: string;
  nightlyAt?: string;
  // The visible tasks' scores on the latest complete run and the one before, and the baseline each
  // open drop was filed against.
  scores: {
    latest: ReadonlyMap<string, number>;
    before: ReadonlyMap<string, number>;
    baselines: ReadonlyMap<string, number>;
  };
  heldOut: {
    visibleMean: number;
    heldOutMean: number;
    visibleCount: number;
    heldOutCount: number;
    heldOutDropped: boolean;
  } | null;
  nightlyRed: number | null;
  // The box health cards standing open: each condition is a cause, named by its kind and what it
  // is about (`subject`, a code the pass made: never an account's or a client's id), under the
  // card's own label.
  healthCards?: readonly { subject: string; kind: string; compartments: string[]; at: string }[];
  // The two filing levers' values; the defaults when the pass hands none.
  floors?: { refusal: number; toolShare: number };
  // Each lever's latest change: its id, who made it, how many days ago, the measure it is judged
  // by, and that measure's last reading before the change, null where there was none.
  leverChanges?: readonly {
    id: number;
    key: string;
    measure: string;
    by: "owner" | "agent";
    ageDays: number;
    before: number | null;
  }[];
};

const AREAS: readonly [RegExp, Area][] = [
  [/^(mail|capture|moment|notice|candidates|commitments|projects)/, "extraction"],
  [/^(top_people|people|dormant|merges|self_rows)/, "knowledge"],
  [/^(done_work|median|tasks|gap|code_no_go|goal|reasked|open_items)/, "work"],
  [/^backup/, "deploy"],
];
const areaOf = (metric: string): Area => AREAS.find(([form]) => form.test(metric))?.[1] ?? "other";

// What a standing check says when it could not finish, not that it failed.
const UNDECIDED = new Set(["already_running", "busy", "budget", "lane_off"]);

const count = (value: number): string => String(Math.round(value * 1000) / 1000);

// A defect state's codes: each made a code (`codeOf`), those that fold into one (`other`) added
// together, the three commonest, most first, as many as fit the state's 200 characters, so whoever
// takes the defect knows what to fix without the box.
const WHY_SHOWN = 3;
function withWhy(state: string, why: readonly { code: string; n: number }[]): string {
  const folded = new Map<string, number>();
  for (const one of why) folded.set(codeOf(one.code), (folded.get(codeOf(one.code)) ?? 0) + one.n);
  const commonest = [...folded].sort(([a, m], [b, n]) => n - m || (a < b ? -1 : a > b ? 1 : 0));
  let shown = state;
  for (const [code, n] of commonest.slice(0, WHY_SHOWN)) {
    const next = `${shown} ${code}=${n}`;
    if (next.length > 200) break;
    shown = next;
  }
  return shown;
}

// A tool's defect state: its counts, then why its calls were refused.
const toolState = (one: FilingInput["tools"][number]): string =>
  withWhy(
    `refused=${one.refused} calls=${one.calls}`,
    (one.why ?? []).map((why) => ({ code: why.code, n: why.calls })),
  );

// A refusal cluster's defect state: its count and floor, then the fields and issues refused.
const refusalState = (total: number, floor: number, why: readonly { code: string; count: number }[]): string =>
  withWhy(
    `count=${total} floor=${floor}`,
    why.map((one) => ({ code: one.code, n: one.count })),
  );

// A measure's defect title, by the side of its line it is on.
export const measureTitle = (test: HealthyTest | undefined): string =>
  failingSide(test ?? "at_least") === "above" ? "Measure above its healthy line" : "Measure below its healthy line";

// `emptied`: the measure causes whose metric had no data on two passes in a row while their defect
// stood open: nothing recovered, and nothing is left to judge.
export function findCauses(input: FilingInput): {
  failing: FoundCause[];
  recovered: string[];
  emptied: string[];
} {
  const failing: FoundCause[] = [];
  const recovered: string[] = [];
  const emptied: string[] = [];
  const fail = (kind: CauseKind, subject: string | null, area: Area, state: string, measuredAt?: string): void => {
    failing.push({
      cause: subject === null ? kind : `${kind}:${subject}`,
      kind,
      area,
      severity: CAUSE_KINDS[kind].severity,
      state,
      ...(measuredAt === undefined ? {} : { measuredAt }),
    });
  };
  const recover = (kind: CauseKind, subject: string | null): void => {
    recovered.push(subject === null ? kind : `${kind}:${subject}`);
  };

  for (const one of input.metrics) {
    const name = codeOf(one.metric);
    if (one.state === "ok") recover("measure_floor", name);
    else if (one.state === "failing" && input.earlierStates.get(one.metric) === "failing") {
      const test = one.test ?? "at_least";
      failing.push({
        cause: `measure_floor:${name}`,
        kind: "measure_floor",
        area: areaOf(name),
        severity: CAUSE_KINDS.measure_floor.severity,
        state: `value=${one.value === null ? "none" : count(one.value)} sample=${one.sample} line=${test}_${count(one.healthy)} side=${failingSide(test)}`,
        title: measureTitle(test),
      });
    } else if (
      one.state === "no_data" &&
      input.earlierStates.get(one.metric) === "no_data" &&
      (input.openCauses ?? []).includes(`measure_floor:${name}`)
    )
      emptied.push(`measure_floor:${name}`);
  }

  // Summed after the codes: every type that is not one is one cluster, `other`.
  const clusters = new Map<string, number>();
  const whyOf = new Map<string, { code: string; count: number }[]>();
  for (const one of input.refusals) {
    const subject = `${codeOf(one.type)}:${codeOf(one.reason)}`;
    clusters.set(subject, (clusters.get(subject) ?? 0) + one.count);
    whyOf.set(subject, [...(whyOf.get(subject) ?? []), ...(one.why ?? [])]);
  }
  const refusalFloor = input.floors?.refusal ?? REFUSAL_FLOOR;
  const toolShare = input.floors?.toolShare ?? TOOL_REFUSAL_SHARE;
  for (const [subject, total] of clusters) {
    if (total >= refusalFloor)
      fail("refusal_pattern", subject, "extraction", refusalState(total, refusalFloor, whyOf.get(subject) ?? []));
    else recover("refusal_pattern", subject);
  }
  for (const cause of input.openCauses ?? [])
    if (cause.startsWith("refusal_pattern:") && !clusters.has(cause.slice("refusal_pattern:".length)))
      recovered.push(cause);

  for (const one of input.tools) {
    const subject = codeOf(one.tool);
    if (one.calls >= TOOL_REFUSAL_MIN_CALLS && one.refused / one.calls >= toolShare)
      fail("tool_refusals", subject, "mcp", toolState(one));
    else if (one.calls > 0) recover("tool_refusals", subject);
  }

  for (const one of input.canary) {
    const source = codeOf(one.source);
    if (one.code === "ok") recover("standing_check", source);
    else if (!UNDECIDED.has(one.code)) fail("standing_check", source, "sources", `code=${codeOf(one.code)}`, one.at);
  }

  for (const [task, score] of input.scores.latest) {
    const subject = codeOf(task);
    const baseline = input.scores.baselines.get(task) ?? input.scores.before.get(task);
    if (baseline !== undefined && score < baseline)
      fail("outcome_drop", subject, "mcp", `score=${score} baseline=${baseline}`, input.scoresAt);
    else recover("outcome_drop", subject);
  }

  const heldOut = input.heldOut;
  if (heldOut !== null && heldOut.visibleCount >= GAP_MIN_TASKS && heldOut.heldOutCount >= GAP_MIN_TASKS) {
    if (heldOut.visibleMean - heldOut.heldOutMean >= GAP_FLOOR)
      fail(
        "outcome_gap",
        null,
        "mcp",
        `visible=${count(heldOut.visibleMean)} held_out=${count(heldOut.heldOutMean)} count=${heldOut.heldOutCount}`,
        input.scoresAt,
      );
    else recover("outcome_gap", null);
    if (heldOut.heldOutDropped)
      fail("outcome_drop", "held_out", "mcp", `mean=${count(heldOut.heldOutMean)}`, input.scoresAt);
    else recover("outcome_drop", "held_out");
  }

  const cards = new Set<string>();
  for (const card of input.healthCards ?? []) {
    const cause = `box_health:${codeOf(card.kind)}:${card.subject}`;
    // One condition, one defect: a second card of it standing changes nothing.
    if (cards.has(cause)) continue;
    cards.add(cause);
    failing.push({
      cause,
      kind: "box_health",
      area: "deploy",
      severity: CAUSE_KINDS.box_health.severity,
      state: `kind=${codeOf(card.kind)}`,
      measuredAt: card.at,
      label: card.compartments,
    });
  }
  if (input.healthCards !== undefined)
    for (const cause of input.openCauses ?? [])
      if (cause.startsWith("box_health:") && !cards.has(cause)) recovered.push(cause);

  // The guard on a lever: a lever whose latest change was an agent's, within the guard's days, and
  // whose judging measure is failing now and worse than its last reading before the change. A
  // measure that was failing already and is no worse says nothing of the change; with no reading
  // before the change there is nothing to compare, and nothing is filed. Nothing is undone here.
  // The cause recovers when it no longer stands: the measure reads ok, is no worse than before or
  // has too little to judge, the days have passed, or the owner changed the lever since.
  if (input.leverChanges !== undefined) {
    const standing = new Set<string>();
    for (const change of input.leverChanges) {
      const measure = input.metrics.find((one) => one.metric === change.measure);
      // A lever no rule reads changed nothing, so its move is never the reason a measure fell.
      if (leverUnread(change.key)) continue;
      if (change.by !== "agent" || change.ageDays > LEVER_GUARD_DAYS || measure?.state !== "failing") continue;
      if (change.before === null || measure.value === null) continue;
      if (!worsened(measure.test ?? "at_least", change.before, measure.value)) continue;
      const key = codeOf(change.key);
      standing.add(`lever_change:${key}`);
      fail(
        "lever_change",
        key,
        areaOf(codeOf(change.measure)),
        `change=${Math.trunc(change.id)} measure=${codeOf(change.measure)} value=${count(measure.value)} before=${count(change.before)} line=${measure.test ?? "at_least"}_${count(measure.healthy)}`,
      );
    }
    for (const cause of input.openCauses ?? [])
      if (cause.startsWith("lever_change:") && !standing.has(cause)) recovered.push(cause);
  }

  if (input.nightlyRed !== null) {
    if (input.nightlyRed > 0) fail("nightly_red", null, "deploy", `red=${input.nightlyRed}`, input.nightlyAt);
    else recover("nightly_red", null);
  }
  return { failing, recovered, emptied };
}

// The only words a filing stores: the kind's, its cause and its state. Throws on anything else, so a
// value that slipped past `codeOf` stops the pass rather than reach the store.
export function filingWords(cause: FoundCause): { title: string; detail: string; note: string } {
  if (!CAUSE_FORM.test(cause.cause) || !STATE_FORM.test(cause.state)) throw new Error("not a code");
  const kind = CAUSE_KINDS[cause.kind];
  return {
    title: cause.title ?? kind.title,
    detail: `Cause ${cause.cause}. ${kind.measures} State: ${cause.state}.`,
    note: `Cause ${cause.cause}. State: ${cause.state}.`,
  };
}

// Words for a cause closed by its measure.
export const recoveredNote = (cause: string): string => {
  if (!CAUSE_FORM.test(cause)) throw new Error("not a code");
  return `Cause ${cause}. The measure recovered.`;
};

// A cause closed because its measure has no data left: the state the defect keeps, and the words.
export const NO_DATA_STATE = "closed=no_data";
export const emptiedNote = (cause: string): string => {
  if (!CAUSE_FORM.test(cause)) throw new Error("not a code");
  return `Cause ${cause}. The measure had no data on two passes in a row: nothing recovered, and nothing is left to judge. It is filed again if the measure fails again.`;
};

// What a box health card is about, as a code a cause may hold. A word (a job, a lane, a hold) is
// kept, its `/` a `.`; anything that names a row (an account, a client, a device) is cut to its
// kind and `fp`, a keyed fingerprint the caller gives, so a cause never holds a row's id.
export function healthSubject(about: string, fingerprintOf: (text: string) => string): string {
  const [kind = "", ...rest] = about.split("/");
  const id = rest.join("/");
  const word = /^[a-z][a-z0-9_]{0,63}$/;
  if (!word.test(kind)) return "other";
  if (id === "") return kind;
  return word.test(id)
    ? `${kind}.${id}`
    : `${kind}.${
        fingerprintOf(about)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 16) || "other"
      }`;
}

// The kind of a stored cause, for the owner's read.
export const kindOfCause = (cause: string): CauseKind | null => {
  const kind = cause.split(":")[0] as CauseKind;
  return kind in CAUSE_KINDS ? kind : null;
};
