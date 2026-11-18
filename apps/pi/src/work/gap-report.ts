import { GapTrigger, type PersonalLogger } from "@intelligence/contracts/personal";
import { autonomyRules, type GapHold, gapHold, gapKey, gapRoom } from "@intelligence/personal-core/planner";
import { createDispatch, type Dispatch } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { print } from "../owner/owner-kit.ts";
import { closesAtOnce, gapPass, tickGapReads } from "./gap-pass.ts";

// `pi-work work gaps`: why the board holds what it holds, per trigger: the gaps found, what holds
// each and what a tick would do with the rest. It walks the tick's own plan with a raise that rolls
// back, so it writes nothing and cannot disagree with the tick. Ids and counts alone: a subject is an
// id, a name's fingerprint or a fact key's. As pi_work, because only that role may run the scans: the
// three warmth lanes, which the pipeline raises, show their flags' states alone.

// How many ids each list shows; its count is always whole.
const IDS_SHOWN = 20;

const BUCKETS = [
  "raises",
  "held_open",
  "held_quiet",
  "held_rest",
  "held_owner_no",
  "held_not_chosen",
  "held_unqualified",
  "capped",
  "deferred",
  "withheld",
  "waiting",
] as const;
type Bucket = (typeof BUCKETS)[number];

export type TriggerReport = {
  found: number;
  flags: Record<string, number>;
  counts: Partial<Record<Bucket, number>>;
  ids: Partial<Record<Bucket, string[]>>;
};
export type GapReport = {
  at: string;
  triggers: Record<GapTrigger, TriggerReport>;
  closing: string[];
  labels: { label: string; raisedToday: number; room: number }[];
  // deadline_soon's shape, while its switch is off: what turning it on would have to work through.
  deadlineSoonOff?: { found: number; ids: string[] };
};

const HOLD_BUCKET: Record<Exclude<GapHold, "quiet">, Bucket> = {
  unqualified: "held_unqualified",
  open: "held_open",
  declined: "held_owner_no",
  not_chosen: "held_not_chosen",
};

const OUTCOME_BUCKET = {
  raised: "raises",
  capped: "capped",
  deferred: "deferred",
  withheld: "withheld",
  waiting: "waiting",
} as const satisfies Record<string, Bucket>;

const QUIET_LOG: PersonalLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export async function gapReport(
  dispatch: Pick<Dispatch, "gapCandidates" | "gapFlags" | "gapSupply" | "probeGapFlag">,
  at: Date,
): Promise<GapReport> {
  const pass = await gapPass(tickGapReads(dispatch), at, {
    raise: (gap, decide) => dispatch.probeGapFlag(gap, decide, { now: at, closesAtOnce }),
    close: async () => false,
    log: QUIET_LOG,
    rollsBack: true,
  });
  const triggers = Object.fromEntries(
    GapTrigger.options.map((trigger) => [
      trigger,
      { found: 0, flags: pass.flags.states[trigger] ?? {}, counts: {}, ids: {} } as TriggerReport,
    ]),
  ) as Record<GapTrigger, TriggerReport>;
  const put = (trigger: GapTrigger, bucket: Bucket, id: string): void => {
    const one = triggers[trigger];
    one.counts[bucket] = (one.counts[bucket] ?? 0) + 1;
    const ids = (one.ids[bucket] ??= []);
    if (ids.length < IDS_SHOWN) ids.push(id);
  };
  // Explore nodes carry `hold` only as planExplore set it.
  const chosen = new Map(pass.explore.map((gap) => [gapKey(gap), gap]));
  const open = new Set(pass.flags.open.map(gapKey));
  const seen = new Set<string>();
  for (const found of pass.found) {
    const key = gapKey(found);
    if (seen.has(key)) continue;
    seen.add(key);
    const gap = chosen.get(key) ?? found;
    triggers[gap.trigger].found += 1;
    const outcome = pass.outcomes.get(key)?.outcome;
    if (outcome !== undefined) {
      put(gap.trigger, OUTCOME_BUCKET[outcome], gap.subject);
      continue;
    }
    const hold = gapHold(gap, open, pass.flags.history);
    // Held by nothing here and not reached: rung 0 withheld what stood before it, and a later plan
    // took it. Counted where the plan left it, which is open to the next tick.
    if (hold === null) put(gap.trigger, "deferred", gap.subject);
    else if (hold === "quiet") put(gap.trigger, pass.flags.resting.has(key) ? "held_rest" : "held_quiet", gap.subject);
    else put(gap.trigger, HOLD_BUCKET[hold], gap.subject);
  }
  const labels = [...new Set(pass.found.map((gap) => gap.labelKey))].sort();
  const rules = autonomyRules();
  const offGaps =
    rules.deadlineSoonOn === true
      ? undefined
      : (await dispatch.gapCandidates(at, { ...rules, deadlineSoonOn: true })).filter(
          (gap) => gap.trigger === "deadline_soon",
        );
  return {
    at: at.toISOString(),
    triggers,
    closing: pass.closing,
    ...(offGaps === undefined
      ? {}
      : { deadlineSoonOff: { found: offGaps.length, ids: offGaps.slice(0, IDS_SHOWN).map((gap) => gap.subject) } }),
    labels: labels.map((label) => {
      const numbers = pass.supply.get(label) ?? { raisedToday: 0, claimed: 0, done: 0 };
      return { label, raisedToday: numbers.raisedToday, room: gapRoom(numbers) };
    }),
  };
}

// The dispatch from PI_DATABASE_URL_WORK and PI_ERASURE_JOURNAL, as the tick's: nothing is read
// before the erasures made since a restore are applied.
export async function gapsCommand(context: CommandContext): Promise<0> {
  const { env, log } = context;
  const dispatch = createDispatch({
    url: env.PI_DATABASE_URL_WORK ?? "",
    log,
    journal: env.PI_ERASURE_JOURNAL ?? "",
  });
  try {
    if ((await dispatch.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    print(context, JSON.stringify(await gapReport(dispatch, new Date())));
    return 0;
  } finally {
    await dispatch.close();
  }
}
