import type { GapTrigger, OpportunityId, PersonalLogger } from "@intelligence/contracts/personal";
import {
  type ExploredFlag,
  type GapSupply,
  gapKey,
  gapRoom,
  gapTriggerRoom,
  NO_SUPPLY,
  planExplore,
  planGapFlags,
  WARMTH_GAP_TRIGGERS,
} from "@intelligence/personal-core/planner";
import { opportunityGo } from "@intelligence/personal-ladder";
import type { Dispatch, GapFlags, GapRow } from "@intelligence/personal-store";

// One pass over the gaps: what the tick does, with its two writes handed in, so `pi-work work gaps`
// walks the very same plan with a raise that rolls back.

// Whether rung 0 would close a row no_go as soon as it was raised: what the raise asks before it
// spends one.
export const closesAtOnce = (facts: Parameters<typeof opportunityGo>[0]): boolean => {
  const answer = opportunityGo(facts);
  return answer !== "cannot_decide" && answer.output === "no_go";
};

type GapReads = Pick<Dispatch, "gapCandidates" | "gapFlags" | "gapSupply">;

// The tick's reads for the pass: every gap and flag but the three warmth lanes', which the
// pipeline's pass raises and closes after each day build, so the tick neither
// raises, closes nor counts one open.
export function tickGapReads(dispatch: GapReads): GapReads {
  const lane = (trigger: GapTrigger): boolean => WARMTH_GAP_TRIGGERS.includes(trigger);
  return {
    gapCandidates: async (now, rules) => (await dispatch.gapCandidates(now, rules)).filter((gap) => !lane(gap.trigger)),
    gapFlags: async (now) => {
      const flags = await dispatch.gapFlags(now);
      return { ...flags, open: flags.open.filter((flag) => !lane(flag.trigger)), explored: [] };
    },
    gapSupply: (now) => dispatch.gapSupply(now),
  };
}

type GapPassOutcome = "raised" | "waiting" | "withheld" | "capped" | "deferred";

export type GapPass = {
  // Every gap that holds now, and the flags as the pass first read them.
  found: GapRow[];
  flags: GapFlags;
  // Explore nodes with `hold` as planExplore set it.
  explore: GapRow[];
  // What became of each gap the plan got as far as, by its key.
  outcomes: Map<string, { gap: GapRow; outcome: GapPassOutcome }>;
  closing: string[];
  gaps: { raised: number; closed: number; deferred: number; waiting: number; withheld: number };
  held: { raised: number; capped: number };
  supply: Map<string, GapSupply>;
};

// `raise` answers an id, null (no intent authorizes it yet, gone, or vetoed since the scan), or
// `withheld` (rung 0 would close it at once). A withheld gap holds no place: the pass plans again
// without it, so what it holds, which may rest on a no a viewer cannot see, goes to the next
// (invariant 6). Each gap is tried once.
export async function gapPass(
  dispatch: GapReads,
  at: Date,
  {
    raise,
    close,
    log,
    rollsBack = false,
  }: {
    raise: (gap: GapRow, decide: boolean) => Promise<OpportunityId | null | "withheld">;
    close: (id: string) => Promise<boolean>;
    log: PersonalLogger;
    rollsBack?: boolean;
  },
): Promise<GapPass> {
  const found = await dispatch.gapCandidates(at);
  const gaps = { raised: 0, closed: 0, deferred: 0, waiting: 0, withheld: 0 };
  const held = { raised: 0, capped: 0 };
  const tried = new Set<string>();
  const outcomes: GapPass["outcomes"] = new Map();
  let supply = new Map<string, GapSupply>();
  let first: Pick<GapPass, "flags" | "explore" | "closing"> | undefined;
  // What a report's raises would have written, which its next plan would have read.
  const rolledBack = { limited: new Map<string, number>(), explored: [] as ExploredFlag[] };
  for (let again = true; again; ) {
    again = false;
    const flags = await dispatch.gapFlags(at);
    const untried = found.filter((gap) => !tried.has(gapKey(gap)));
    const explore = planExplore({
      candidates: untried.flatMap((gap) =>
        gap.trigger === "explore" && gap.frontier !== undefined ? [{ ...gap, frontier: gap.frontier }] : [],
      ),
      open: flags.open,
      history: flags.history,
      explored: [...flags.explored, ...rolledBack.explored],
      now: at,
    });
    const candidates = [...untried.filter((gap) => gap.trigger !== "explore"), ...explore];
    if (candidates.length > 0) {
      supply = await dispatch.gapSupply(at);
      for (const [label, n] of rolledBack.limited) {
        const numbers = supply.get(label) ?? { raisedToday: 0, claimed: 0, done: 0 };
        supply.set(label, { ...numbers, raisedToday: numbers.raisedToday + n });
      }
    }
    const plan = planGapFlags({ candidates, open: flags.open, history: flags.history, supply });
    gaps.deferred = plan.deferred;
    held.capped = plan.capped;
    for (const { gap, why } of plan.left) outcomes.set(gapKey(gap), { gap, outcome: why });
    // What to close is read once, with every gap that holds still among the candidates.
    if (first === undefined) {
      first = { flags, explore, closing: plan.close };
      if (explore.length > 0)
        log.info({
          event: "explore_plan",
          counts: {
            chosen: explore.filter((gap) => !gap.hold).length,
            held: explore.filter((gap) => gap.hold).length,
          },
        });
      for (const id of plan.close) if (await close(id)) gaps.closed += 1;
    }
    // Raising is capped by what finishes, label by label; what the cap holds stays a candidate. Only
    // a raise that happened takes room: a candidate vetoed or declined takes none, tick after tick.
    const room = new Map([...supply].map(([label, numbers]) => [label, gapRoom(numbers)]));
    // A trigger's own room, by what its work was worth: what it raises in this pass comes off it.
    const taken = new Map<string, number>();
    for (const { gap, card, limited } of plan.raise) {
      const left = room.get(gap.labelKey) ?? gapRoom({ raisedToday: 0, claimed: 0, done: 0 });
      const ofTrigger = `${gap.labelKey}\n${gap.trigger}`;
      const trigger = gapTriggerRoom(supply.get(gap.labelKey) ?? NO_SUPPLY, gap.trigger) - (taken.get(ofTrigger) ?? 0);
      if (limited && (left === 0 || trigger <= 0)) {
        held.capped += 1;
        outcomes.set(gapKey(gap), { gap, outcome: "capped" });
        continue;
      }
      tried.add(gapKey(gap));
      const raised = await raise(gap, !card);
      if (raised === "withheld") {
        gaps.withheld += 1;
        outcomes.set(gapKey(gap), { gap, outcome: "withheld" });
        again = true;
        continue;
      }
      if (raised === null) {
        gaps.waiting += 1;
        outcomes.set(gapKey(gap), { gap, outcome: "waiting" });
        continue;
      }
      gaps.raised += 1;
      outcomes.set(gapKey(gap), { gap, outcome: "raised" });
      if (limited) {
        room.set(gap.labelKey, left - 1);
        taken.set(ofTrigger, (taken.get(ofTrigger) ?? 0) + 1);
        held.raised += 1;
      }
      if (rollsBack) {
        if (limited) rolledBack.limited.set(gap.labelKey, (rolledBack.limited.get(gap.labelKey) ?? 0) + 1);
        if (gap.trigger === "explore" && gap.score !== undefined)
          rolledBack.explored.push({
            subject: gap.subject,
            labelKey: gap.labelKey,
            at: at.toISOString(),
            value: gap.score.value,
            goal: gap.goal !== null,
          });
      }
    }
  }
  if (first === undefined) throw new Error("gap pass planned nothing");
  return { found, ...first, outcomes, gaps, held, supply };
}
