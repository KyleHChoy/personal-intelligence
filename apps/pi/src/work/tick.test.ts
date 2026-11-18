import type { PersonalLogEvent, PersonalLogger } from "@intelligence/contracts/personal";
import { GAP_FLAGS_PER_TICK, type OpenGapFlag } from "@intelligence/personal-core/planner";
import { REGISTRY } from "@intelligence/personal-ladder";
import type { Dispatch, GapRow } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command-types.ts";
import { runGapLanes } from "../extract/gap-lanes.ts";
import { runTick, tickCommand } from "./tick.ts";

// The tick's two outcome steps, after its others, over a fake of the store's Dispatch.
// tick.db.test.ts drives the real one.

const NOW = new Date("2026-10-05T12:00:00.000Z");

type Fake = { dispatch: Dispatch; calls: string[] };

// A dispatch with nothing to do: every list empty, the switch as given, the two outcome steps
// answering the counts given, or throwing.
function fakeDispatch(
  options: {
    killSwitch?: boolean;
    links?: number | Error;
    assessed?: number | Error;
    stale?: { client: string; caseKey: string }[];
    supply?: Map<string, { raisedToday: number; claimed: number; done: number }>;
    gaps?: GapRow[];
    flags?: OpenGapFlag[];
    clock?: Error;
    triggers?: Error;
    outcomes?: (string | Error)[];
    // A step's read that throws.
    vetoes?: Error;
    wakes?: Error;
  } = {},
): Fake {
  const calls: string[] = [];
  const answer = (name: string, value: number | Error) => async (now: Date) => {
    calls.push(`${name}:${now.toISOString()}`);
    if (value instanceof Error) throw value;
    return value;
  };
  const none = (name: string) => async () => {
    calls.push(name);
    return [];
  };
  const fake = {
    proposeQuestionRules: async () => null,
    erasureLevel: async () => "current",
    withWorkLock: async <T>(fn: () => Promise<T>) => fn(),
    killSwitch: async () => options.killSwitch ?? false,
    stopRuns: async () => {
      calls.push("stopRuns");
    },
    fallBackPings: async () => 0,
    vetoedOpen: async () => {
      calls.push("vetoedOpen");
      if (options.vetoes !== undefined) throw options.vetoes;
      return [];
    },
    expired: none("expired"),
    draftsToExpire: none("draftsToExpire"),
    gapFlags: async () => ({
      open: options.flags ?? [],
      history: { quiet: new Set<string>(), declined: new Map<string, Set<string>>() },
      explored: [],
    }),
    gapCandidates: async () => {
      calls.push("gapCandidates");
      return options.gaps ?? [];
    },
    // The gap pass lock, around the whole pass.
    underGapPass: async <T>(fn: () => Promise<T>): Promise<T> => {
      calls.push("gapPass:take");
      try {
        return await fn();
      } finally {
        calls.push("gapPass:give");
      }
    },
    // Room to spare unless a test says otherwise: most tests are not about the day's cap.
    gapSupply: async () =>
      options.supply ?? new Map([["own", { raisedToday: 0, claimed: 7_000, done: 7_000, used: 7_000 }]]),
    raiseGapFlag: async (gap: GapRow, _decide: boolean) => {
      calls.push(`raiseGapFlag:${gap.subject}`);
      return `opp_${gap.subject}`;
    },
    closeGapFlag: async (id: string) => {
      calls.push(`closeGapFlag:${id}`);
      return true;
    },
    dueIntentions: none("dueIntentions"),
    lapsedHolds: none("lapsedHolds"),
    // The clock's rechecks, and the trigger rows marked (none here, so no line).
    clockRechecks: async (at: Date) => {
      calls.push(`clockRechecks:${at.toISOString()}`);
      if (options.clock !== undefined) throw options.clock;
    },
    raiseTriggers: async (at: Date) => {
      calls.push(`raiseTriggers:${at.toISOString()}`);
      if (options.triggers !== undefined) throw options.triggers;
      return { marked: 0, byRaise: {}, byCause: {} };
    },
    // The works an outcome row waits on; "moved" moves a status and wakes, "quiet" does neither, its
    // model links held for the owner, an Error fails.
    outcomeWorks: async () => {
      calls.push("outcomeWorks");
      return (options.outcomes ?? []).map((one, n) => (one instanceof Error ? `opp_fail${n}` : `opp_${one}${n}`));
    },
    raiseOutcome: async (id: string, at: Date) => {
      calls.push(`raiseOutcome:${id}:${at.toISOString()}`);
      const one = (options.outcomes ?? [])[Number(id.replace(/\D/g, ""))];
      if (one instanceof Error) throw one;
      return one === "moved"
        ? { rows: 1, status: "outcome_met", woke: "cli_a", skip: null, held: null }
        : { rows: 1, status: null, woke: null, skip: null, held: "owner" };
    },
    wakeCandidates: async () => {
      calls.push("wakeCandidates");
      if (options.wakes !== undefined) throw options.wakes;
      return [];
    },
    proposedOpportunities: none("proposedOpportunities"),
    ownerHypothesesWithoutCard: none("ownerHypothesesWithoutCard"),
    plannerHypothesesWithoutCard: none("plannerHypothesesWithoutCard"),
    handedWithoutCard: none("handedWithoutCard"),
    reportsWithoutCard: none("reportsWithoutCard"),
    withdrawTaskResultCards: async () => {
      calls.push("withdrawTaskResultCards");
      return 0;
    },
    draftsWithoutCard: none("draftsWithoutCard"),
    staleRestatements: async () => {
      calls.push("staleRestatements");
      return options.stale ?? [];
    },
    // A pair's card is raised once: a second raise for the same case key answers null.
    raiseStaleCard: async (stale: { caseKey: string }) => {
      calls.push(`raiseStaleCard:${stale.caseKey}`);
      return calls.filter((call) => call === `raiseStaleCard:${stale.caseKey}`).length === 1
        ? `crd_${stale.caseKey}`
        : null;
    },
    failedRunStreak: async () => {
      calls.push("failedRunStreak");
      return null;
    },
    matchOutcomes: answer("matchOutcomes", options.links ?? 0),
    assessOutcomes: answer("assessOutcomes", options.assessed ?? 0),
  };
  return { dispatch: fake as unknown as Dispatch, calls };
}

function logger(): PersonalLogger & { events: PersonalLogEvent[] } {
  const events: PersonalLogEvent[] = [];
  return { events, info: (e) => events.push(e), warn: (e) => events.push(e), error: (e) => events.push(e) };
}

const ZERO = { queued: 0, silenced: 0, decided: 0, cards: 0, expired: 0, vetoed: 0 };

describe("the tick's rewrite card", () => {
  it("the tick raises one stale_restatement card for each pair the store counts, counts only those raised, and queues no run", async () => {
    const stale = [
      { client: "cli_a", caseKey: "cli_a:fact-one" },
      { client: "cli_a", caseKey: "cli_a:fact-two" },
    ];
    const { dispatch, calls } = fakeDispatch({ stale: [...stale, stale[0] as (typeof stale)[number]] });
    expect(await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW })).toEqual({
      ...ZERO,
      cards: 2,
      links: 0,
      assessed: 0,
    });
    expect(calls.filter((call) => call.startsWith("raiseStaleCard"))).toEqual([
      "raiseStaleCard:cli_a:fact-one",
      "raiseStaleCard:cli_a:fact-two",
      "raiseStaleCard:cli_a:fact-one",
    ]);
    expect(calls.some((call) => call.startsWith("queueRun"))).toBe(false);
  });
});

describe("the tick's gap flags", () => {
  const gap = (subject: string): GapRow => ({
    trigger: "unresolved_mention",
    subject,
    labelKey: "own",
    goal: null,
    source: "msg_1",
    at: NOW.toISOString(),
    aboutKind: "message",
    aboutId: "msg_1",
    sourceKind: "message",
    dueAt: null,
  });

  // A gap withheld writes nothing to rest on, so what it holds, which may rest on a no the viewer
  // cannot see, must go to the next in the same pass (invariant 6). Explore is the pipeline's pass,
  // the tick's own gap pass with the lanes' store.
  it("a withheld raise holds no place in the day's explore budget", async () => {
    const node = (subject: string, tier: string): GapRow => ({
      ...gap(subject),
      trigger: "explore",
      aboutKind: "entity",
      sourceKind: "entity",
      frontier: {
        goalTarget: false,
        goalPath: false,
        meetingSoon: false,
        namerTiers: [tier],
        namedDays: 1,
        missing: ["identity"],
        goals: [],
      },
    });
    const { dispatch, calls } = fakeDispatch({
      gaps: [node("a_top", "inner"), node("b_top", "inner"), node("c_next", "close"), node("d_next", "close")],
    });
    const raising = dispatch.raiseGapFlag.bind(dispatch);
    dispatch.raiseGapFlag = async (one: GapRow, decide: boolean) =>
      one.subject.endsWith("_top") ? "withheld" : raising(one, decide);
    const log = logger();
    await runGapLanes(dispatch, NOW, log);
    expect(calls.filter((call) => call.startsWith("raiseGapFlag"))).toEqual([
      "raiseGapFlag:c_next",
      "raiseGapFlag:d_next",
    ]);
    expect(log.events.find((one) => one.event === "gap_lanes")?.counts).toMatchObject({ raised: 2, withheld: 2 });
    // The lanes' pass runs whole under the gap pass lock the tick's pass takes.
    expect(calls[0]).toBe("gapPass:take");
    expect(calls.at(-1)).toBe("gapPass:give");
  });

  it("the tick neither raises, closes nor counts open a warmth lane's gap or flag: the pipeline's pass does", async () => {
    const lanes = (["close_no_tie", "close_no_role", "explore"] as const).map((trigger) => ({
      ...gap(`${trigger}_gap`),
      trigger,
      aboutKind: "entity" as const,
      sourceKind: "entity" as const,
    }));
    const { dispatch, calls } = fakeDispatch({
      gaps: [...lanes, gap("kept")],
      flags: (["close_no_tie", "close_no_role", "explore"] as const).map((trigger) => ({
        id: `opp_${trigger}`,
        trigger,
        subject: `${trigger}_open`,
        labelKey: "own",
        held: false,
      })),
    });
    const log = logger();
    await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW });
    expect(calls.filter((call) => call.startsWith("raiseGapFlag") || call.startsWith("closeGapFlag"))).toEqual([
      "raiseGapFlag:kept",
    ]);
    expect(log.events.find((one) => one.event === "gap_flags")?.counts).toMatchObject({ raised: 1, closed: 0 });
  });

  it("a withheld raise holds no place in the tick's cut, and a gap is tried once a tick", async () => {
    const many = Array.from({ length: GAP_FLAGS_PER_TICK + 2 }, (_, n) => gap(`s${String(n).padStart(2, "0")}`));
    const { dispatch } = fakeDispatch({ gaps: many });
    const tried: string[] = [];
    const raising = dispatch.raiseGapFlag.bind(dispatch);
    dispatch.raiseGapFlag = async (one: GapRow, decide: boolean) => {
      tried.push(one.subject);
      return one.subject < "s05" ? "withheld" : raising(one, decide);
    };
    const log = logger();
    await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW });
    expect(new Set(tried).size).toBe(tried.length);
    expect(tried).toHaveLength(many.length);
    expect(log.events.find((one) => one.event === "gap_flags")?.counts).toMatchObject({
      raised: many.length - 5,
      withheld: 5,
      deferred: 0,
    });
  });

  it("closes the flags whose gap filled, raises the rest up to the threshold, and logs counts and the overflow", async () => {
    const many = Array.from({ length: GAP_FLAGS_PER_TICK + 2 }, (_, n) => gap(`s${String(n).padStart(2, "0")}`));
    const { dispatch, calls } = fakeDispatch({
      gaps: many,
      flags: [{ id: "opp_gone", trigger: "unresolved_mention", subject: "gone", labelKey: "own", held: false }],
    });
    const log = logger();
    expect(await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW })).toEqual({
      ...ZERO,
      links: 0,
      assessed: 0,
    });
    expect(calls.filter((call) => call.startsWith("closeGapFlag"))).toEqual(["closeGapFlag:opp_gone"]);
    expect(calls.filter((call) => call.startsWith("raiseGapFlag"))).toHaveLength(GAP_FLAGS_PER_TICK);
    expect(log.events.slice(0, 3)).toEqual([
      {
        event: "gap_raise_cap",
        counts: { labels: 1, raised_today: 0, claimed: 7_000, done: 7_000, raised: GAP_FLAGS_PER_TICK, capped: 0 },
      },
      { event: "gap_flags", counts: { raised: GAP_FLAGS_PER_TICK, closed: 1, deferred: 2, waiting: 0, withheld: 0 } },
      { event: "gap_flags_over_threshold", counts: { deferred: 2 } },
    ]);
  });

  it("a candidate the store will not raise takes none of the day's room", async () => {
    const many = Array.from({ length: 12 }, (_, n) => gap(`s${String(n).padStart(2, "0")}`));
    const { dispatch, calls } = fakeDispatch({ gaps: many, supply: new Map() });
    const raising = dispatch.raiseGapFlag.bind(dispatch);
    // The first six are vetoed or the owner's no: the store answers null each tick.
    dispatch.raiseGapFlag = async (one: GapRow, decide: boolean) =>
      Number(one.subject.slice(1)) < 6 ? null : raising(one, decide);
    await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW });
    expect(calls.filter((call) => call.startsWith("raiseGapFlag"))).toHaveLength(5);
  });

  it("raising stops at the day's cap, by what finished, logged in counts, and resumes as work finishes", async () => {
    const many = Array.from({ length: 8 }, (_, n) => gap(`s${n}`));
    const raisedBy = async (supply: Map<string, { raisedToday: number; claimed: number; done: number }>) => {
      const { dispatch, calls } = fakeDispatch({ gaps: many, supply });
      const log = logger();
      await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW });
      return { raised: calls.filter((call) => call.startsWith("raiseGapFlag")).length, log };
    };
    const stopped = await raisedBy(new Map([["own", { raisedToday: 5, claimed: 0, done: 0 }]]));
    expect(stopped.raised).toBe(0);
    expect(stopped.log.events.find((one) => one.event === "gap_raise_cap")).toEqual({
      event: "gap_raise_cap",
      counts: { labels: 1, raised_today: 5, claimed: 0, done: 0, raised: 0, capped: 8 },
    });
    // A new day, with nothing raised yet: the floor.
    expect((await raisedBy(new Map())).raised).toBe(5);
    // The same day, once work was used; finishing alone earns no room.
    expect((await raisedBy(new Map([["own", { raisedToday: 5, claimed: 14, done: 14, used: 60 }]]))).raised).toBe(2);
  });

  // The tick's pass and the pipeline's lanes both read a label's supply and raise against its cap:
  // each runs whole under the one gap pass lock, so neither spends room the other already has.
  it("reads the gaps and raises them inside the gap pass lock", async () => {
    const { dispatch, calls } = fakeDispatch({ gaps: [gap("s1")] });
    await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW });
    const at = (call: string): number => calls.indexOf(call);
    expect(at("gapPass:take")).toBeGreaterThanOrEqual(0);
    expect(at("gapPass:take")).toBeLessThan(at("gapCandidates"));
    expect(at("raiseGapFlag:s1")).toBeLessThan(at("gapPass:give"));
  });

  it("raises nothing while the kill switch is on", async () => {
    const { dispatch, calls } = fakeDispatch({ killSwitch: true, gaps: [gap("s1")] });
    await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW });
    expect(calls.some((call) => call.startsWith("raiseGapFlag"))).toBe(false);
  });
});

// Query-time triggers: the clock's rechecks, on every tick, and behind the switch the trigger rows'
// marks, before the wakes, which ledger.state_wakes reads from the trigger log; a failure of either
// is logged and stops nothing.
describe("the clock and the trigger rows", () => {
  it("asks for the clock's rechecks, then marks the trigger rows, then reads the wakes, with its switch on", async () => {
    const { dispatch, calls } = fakeDispatch();
    await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW, shadowTriggers: true });
    const at = NOW.toISOString();
    const order = [`clockRechecks:${at}`, `raiseTriggers:${at}`, "wakeCandidates"].map((one) => calls.indexOf(one));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // Neither ever stops the tick.
  it("a failing clock or trigger step is logged by its code, and the wakes, decisions and questions still run", async () => {
    for (const failing of [
      { clock: Object.assign(new Error("gone"), { code: "unavailable" }) },
      { triggers: Object.assign(new Error("gone"), { code: "unavailable" }) },
    ]) {
      const { dispatch, calls } = fakeDispatch(failing);
      const log = logger();
      expect(await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW, shadowTriggers: true })).toMatchObject(
        ZERO,
      );
      for (const step of ["wakeCandidates", "proposedOpportunities", "ownerHypothesesWithoutCard"])
        expect(calls).toContain(step);
      expect(log.events).toContainEqual({ event: "work_triggers_failed", code: "unavailable" });
      // The other step still ran.
      expect(calls).toContain(`raiseTriggers:${NOW.toISOString()}`);
    }
  });

  it("does neither while the kill switch is on", async () => {
    const { dispatch, calls } = fakeDispatch({ killSwitch: true });
    await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW, shadowTriggers: true });
    expect(
      calls.some(
        (call) =>
          call.startsWith("clockRechecks") || call.startsWith("raiseTriggers") || call.startsWith("outcomeWorks"),
      ),
    ).toBe(false);
  });
});

// The outcome rows, raised after the trigger rows' marks and before the wakes, each work its own
// transaction; a work's failure is logged by its code and the others and the rest of the tick still
// run.
describe("the outcome rows", () => {
  it("raises each work's rows, counts what moved and who was told, and logs a failure by its code", async () => {
    const { dispatch, calls } = fakeDispatch({
      outcomes: ["moved", Object.assign(new Error("gone"), { code: "unavailable" }), "quiet"],
    });
    const log = logger();
    await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW });
    const at = NOW.toISOString();
    expect(calls.filter((call) => call.startsWith("raiseOutcome"))).toEqual([
      `raiseOutcome:opp_moved0:${at}`,
      `raiseOutcome:opp_fail1:${at}`,
      `raiseOutcome:opp_quiet2:${at}`,
    ]);
    const order = [`raiseTriggers:${at}`, "outcomeWorks", "wakeCandidates"].map((one) => calls.indexOf(one));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log.events).toContainEqual({ event: "work_outcomes_failed", code: "unavailable" });
    expect(log.events).toContainEqual({
      event: "work_outcomes",
      counts: { works: 2, moved: 1, woke: 1, skipped: 0, held_owner: 1, held_bound: 0, failed: 1 },
    });
  });

  it("logs nothing when no row waits", async () => {
    const log = logger();
    await runTick({ dispatch: fakeDispatch().dispatch, registry: REGISTRY, log, now: () => NOW });
    expect(log.events.some((event) => event.event.startsWith("work_outcomes"))).toBe(false);
  });
});

// Steps isolated, the shadow trigger work behind its switch, and a warning logged again only when
// its count changes.
describe("isolated steps, switches and repeated warnings", () => {
  it("a step that throws is one step_failed line with its code, counted, and every later step still runs", async () => {
    const { dispatch, calls } = fakeDispatch({
      vetoes: Object.assign(new Error("bad row"), { code: "write_refused" }),
      wakes: Object.assign(new Error("gone"), { code: "unavailable" }),
      links: 1,
    });
    const log = logger();
    const counts = await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW });
    expect(counts).toEqual({ ...ZERO, links: 1, assessed: 0, failed: 2 });
    for (const step of [
      "expired",
      "draftsToExpire",
      "dueIntentions",
      "proposedOpportunities",
      "ownerHypothesesWithoutCard",
      "failedRunStreak",
      `matchOutcomes:${NOW.toISOString()}`,
    ])
      expect(calls, step).toContain(step);
    expect(log.events).toEqual([
      { event: "step_failed", code: "write_refused", counts: { step_vetoes: 1 } },
      { event: "step_failed", code: "unavailable", counts: { step_wakes: 1 } },
      { event: "work_tick", counts: { ...ZERO, links: 1, assessed: 0, steps_failed: 2 } },
    ]);
  });

  it("a row that throws stops only itself: the rows after it in its step still run", async () => {
    const { dispatch, calls } = fakeDispatch({
      stale: [
        { client: "cli_a", caseKey: "bad" },
        { client: "cli_a", caseKey: "good" },
      ],
    });
    const raise = (dispatch as unknown as { raiseStaleCard: (stale: { caseKey: string }) => Promise<string | null> })
      .raiseStaleCard;
    (dispatch as unknown as { raiseStaleCard: typeof raise }).raiseStaleCard = async (stale) => {
      if (stale.caseKey === "bad") throw Object.assign(new Error("bad row"), { code: "write_refused" });
      return raise(stale);
    };
    const log = logger();
    expect(await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW })).toEqual({
      ...ZERO,
      cards: 1,
      links: 0,
      assessed: 0,
      failed: 1,
    });
    expect(calls).toContain("raiseStaleCard:good");
    expect(log.events).toContainEqual({ event: "step_failed", code: "write_refused", counts: { step_stale_cards: 1 } });
  });

  it("a due check-back returns claimed work only when its client holds it; an earlier holder's is cancelled", async () => {
    const { dispatch, calls } = fakeDispatch();
    const due = (id: string, client: string, holder: string) => ({
      id,
      kind: "check_back",
      opportunity: `opp_${id}`,
      client,
      opportunityStatus: "claimed",
      holder,
    });
    Object.assign(dispatch, {
      dueIntentions: async () => [due("stale", "cli_a", "cli_b"), due("own", "cli_b", "cli_b")],
      returnToGo: async (opportunity: string, _at: Date, preferred: { client: string; intention: string }) => {
        calls.push(`returnToGo:${opportunity}:${preferred.client}`);
        return true;
      },
      cancelIntention: async (id: string) => {
        calls.push(`cancelIntention:${id}`);
        return true;
      },
    });
    await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW });
    expect(calls.filter((call) => /^(returnToGo|cancelIntention):/.test(call))).toEqual([
      "cancelIntention:stale",
      "returnToGo:opp_own:cli_b",
    ]);
  });

  it("a kill switch that cannot be read stops the effects as the switch would, and the outcome steps still run", async () => {
    const { dispatch, calls } = fakeDispatch({ links: 1 });
    (dispatch as unknown as { killSwitch: () => Promise<boolean> }).killSwitch = async () => {
      throw Object.assign(new Error("gone"), { code: "unavailable" });
    };
    expect(await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW })).toEqual({
      ...ZERO,
      links: 1,
      assessed: 0,
      failed: 1,
    });
    expect(calls).toEqual([`matchOutcomes:${NOW.toISOString()}`, `assessOutcomes:${NOW.toISOString()}`]);
  });

  // The clock's rechecks are the only source of commitment_due wakes once the
  // rebuild's offers stop, so they run with the switch off; the trigger marks stay its.
  it("asks for the clock's rechecks before the wakes with its switch off, and marks no trigger row", async () => {
    const { dispatch, calls } = fakeDispatch();
    await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW });
    const clock = calls.indexOf(`clockRechecks:${NOW.toISOString()}`);
    expect(clock).toBeGreaterThanOrEqual(0);
    expect(clock).toBeLessThan(calls.indexOf("wakeCandidates"));
    expect(calls.some((call) => call.startsWith("raiseTriggers"))).toBe(false);
    // The outcome rows are not shadow work: they still run.
    expect(calls).toContain("outcomeWorks");
  });

  it("logs the over-threshold warning again only when its count changes, keeping the count for the next tick", async () => {
    const gap = (subject: string): GapRow => ({
      trigger: "unresolved_mention",
      subject,
      labelKey: "own",
      goal: null,
      source: "msg_1",
      at: NOW.toISOString(),
      aboutKind: "message",
      aboutId: "msg_1",
      sourceKind: "message",
      dueAt: null,
    });
    const many = (extra: number) =>
      Array.from({ length: GAP_FLAGS_PER_TICK + extra }, (_, n) => gap(`s${String(n).padStart(2, "0")}`));
    const warned: Record<string, number> = {};
    const warnings = async (extra: number): Promise<PersonalLogEvent[]> => {
      const log = logger();
      await runTick({
        dispatch: fakeDispatch({ gaps: many(extra) }).dispatch,
        registry: REGISTRY,
        log,
        now: () => NOW,
        warned,
      });
      return log.events.filter((event) => event.event === "gap_flags_over_threshold");
    };
    expect(await warnings(2)).toEqual([{ event: "gap_flags_over_threshold", counts: { deferred: 2 } }]);
    expect(await warnings(2)).toEqual([]);
    expect(await warnings(3)).toEqual([{ event: "gap_flags_over_threshold", counts: { deferred: 3 } }]);
    expect(await warnings(0)).toEqual([]);
    expect(warned).toEqual({ gap_flags_over_threshold: 0 });
    expect(await warnings(3)).toEqual([{ event: "gap_flags_over_threshold", counts: { deferred: 3 } }]);
  });

  it("proposes question rules for a day once, keeping the day beside the warning counts for the next tick", async () => {
    const warned: Record<string, number> = { gap_flags_over_threshold: 0 };
    const seen: (string | null)[] = [];
    const ticks = async (): Promise<PersonalLogEvent[]> => {
      const { dispatch } = fakeDispatch();
      dispatch.proposeQuestionRules = async (_now: Date, last: string | null) => {
        seen.push(last);
        return last === "2026-10-05" ? null : { day: "2026-10-05", proposed: 2 };
      };
      const log = logger();
      await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW, warned });
      return log.events.filter((event) => event.event === "question_rules_proposed");
    };
    expect(await ticks()).toEqual([{ event: "question_rules_proposed", counts: { proposed: 2 } }]);
    expect(warned).toEqual({ gap_flags_over_threshold: 0, question_rules_day: 20261005 });
    expect(await ticks()).toEqual([]);
    expect(seen).toEqual([null, "2026-10-05"]);
  });
});

describe("the tick's outcome steps", () => {
  it("the tick reports the links and assessments it wrote, after its other steps", async () => {
    const { dispatch, calls } = fakeDispatch({ links: 2, assessed: 5 });
    const log = logger();
    expect(await runTick({ dispatch, registry: REGISTRY, log, now: () => NOW })).toEqual({
      ...ZERO,
      links: 2,
      assessed: 5,
    });
    expect(calls.slice(-3)).toEqual([
      "failedRunStreak",
      `matchOutcomes:${NOW.toISOString()}`,
      `assessOutcomes:${NOW.toISOString()}`,
    ]);
    expect(log.events).toEqual([{ event: "work_tick", counts: { ...ZERO, links: 2, assessed: 5 } }]);
  });

  it("a tick with the kill switch on still links and assesses, since neither is an effect", async () => {
    const { dispatch, calls } = fakeDispatch({ killSwitch: true, links: 1, assessed: 1 });
    expect(await runTick({ dispatch, registry: REGISTRY, log: logger(), now: () => NOW })).toEqual({
      ...ZERO,
      links: 1,
      assessed: 1,
    });
    expect(calls).toEqual(["stopRuns", `matchOutcomes:${NOW.toISOString()}`, `assessOutcomes:${NOW.toISOString()}`]);
  });

  it("a failure of either is logged with its code, the other still runs, nothing of the tick is undone, and the tick then fails", async () => {
    for (const [failing, expected] of [
      [
        { links: Object.assign(new Error("refused"), { code: "write_refused" }), assessed: 4 },
        { links: 0, assessed: 4, code: "write_refused" },
      ],
      [
        { links: 3, assessed: Object.assign(new Error("gone"), { code: "unavailable" }) },
        { links: 3, assessed: 0, code: "unavailable" },
      ],
    ] as const) {
      const { dispatch, calls } = fakeDispatch(failing);
      const log = logger();
      await expect(runTick({ dispatch, registry: REGISTRY, log, now: () => NOW })).rejects.toMatchObject({
        code: expected.code,
      });
      expect(calls.slice(-2)).toEqual([`matchOutcomes:${NOW.toISOString()}`, `assessOutcomes:${NOW.toISOString()}`]);
      expect(log.events).toEqual([
        { event: "outcomes_failed", code: expected.code },
        { event: "work_tick", counts: { ...ZERO, links: expected.links, assessed: expected.assessed } },
      ]);
    }
  });
});

// A work URL the dispatch refuses still ends in the job's attempt to write its row, which is logged
// by its code when it cannot be written.
describe("pi work tick's job row", () => {
  it("is attempted, and logged as unrecorded, when the dispatch cannot be made", async () => {
    const lines: PersonalLogEvent[] = [];
    const record = (event: PersonalLogEvent): void => void lines.push(event);
    const log: PersonalLogger = { info: record, warn: record, error: record };
    const context = {
      env: { PI_DATABASE_URL_WORK: "not a url", PI_ERASURE_JOURNAL: "" },
      log,
    } as unknown as CommandContext;
    await expect(tickCommand(context)).rejects.toBeDefined();
    expect(lines.map((one) => one.event)).toContain("job_run_unrecorded");
  });
});
