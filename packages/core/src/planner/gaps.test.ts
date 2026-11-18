import { describe, expect, it } from "vitest";
import {
  GAP_FEW_FACTS,
  GAP_FLAGS_PER_TICK,
  GAP_LOW_TIE,
  GAP_RAISE_FLOOR_PER_DAY,
  GAP_VALUE_MIN_JUDGED,
  GAP_VALUE_MIN_SCORED,
  GAP_VALUE_WINDOW_DAYS,
  type GapCandidate,
  type GapStanding,
  type GapSupply,
  gapHold,
  gapKey,
  gapQualifies,
  gapQuietKey,
  gapRaiseCap,
  gapRoom,
  gapTriggerRoom,
  gapWeight,
  type OpenGapFlag,
  planGapFlags,
} from "./gaps.ts";

// The gap flags' rules, with no database.

const AT = "2026-10-13T09:00:00.000Z";
const candidate = (over: Partial<GapCandidate> = {}): GapCandidate => ({
  trigger: "unresolved_mention",
  subject: "s1",
  labelKey: "own",
  goal: null,
  source: "msg_1",
  at: AT,
  ...over,
});
const open = (over: Partial<OpenGapFlag> = {}): OpenGapFlag => ({
  id: "opp_1",
  trigger: "unresolved_mention",
  subject: "s1",
  labelKey: "own",
  held: false,
  ...over,
});
const plan = (
  candidates: GapCandidate[],
  flags: OpenGapFlag[] = [],
  history: { quiet?: string[]; declined?: [string, string[]][] } = {},
  cap?: number,
) =>
  planGapFlags({
    candidates,
    open: flags,
    history: {
      quiet: new Set(history.quiet ?? []),
      declined: new Map((history.declined ?? []).map(([key, sources]) => [key, new Set(sources)])),
    },
    ...(cap === undefined ? {} : { cap }),
  });
const raised = (result: ReturnType<typeof plan>) => result.raise.map(({ gap }) => gap);

describe("why a gap that holds is not raised", () => {
  const history = (quiet: string[] = [], declined: [string, string[]][] = []) => ({
    quiet: new Set(quiet),
    declined: new Map(declined.map(([key, sources]) => [key, new Set(sources)])),
  });
  const none = new Set<string>();

  it("a meeting's day moves what finished work holds, and nothing else", () => {
    const meeting = { trigger: "meeting_soon", subject: "evt_1", labelKey: "own" } as const;
    const quietKey = (due: string): string => gapQuietKey({ ...meeting, due });
    expect(quietKey("2026-01-02T09:00:00.000Z")).toBe(quietKey("2026-01-02T15:00:00.000Z"));
    expect(quietKey("2026-01-02T09:00:00.000Z")).not.toBe(quietKey("2026-01-03T09:00:00.000Z"));
    const attendee = { trigger: "unknown_attendee", subject: "ent_1", labelKey: "own" } as const;
    expect(gapQuietKey({ ...attendee, due: "2026-01-02T00:00:00.000Z" })).toBe(gapKey(attendee));
    const deadline = { ...meeting, trigger: "deadline_soon" as const };
    expect(gapQuietKey({ ...deadline, due: "2026-01-02T00:00:00.000Z" })).not.toBe(
      gapQuietKey({ ...deadline, due: "2026-01-03T00:00:00.000Z" }),
    );
  });

  it("closes a waiting task for a meeting moved to another day, and leaves what is further along", () => {
    const gap = candidate({
      trigger: "meeting_soon",
      subject: "evt_1",
      due: "2026-01-03T09:00:00.000Z",
      source: "evt_1",
    });
    const flag = { id: "opp_1", trigger: "meeting_soon", subject: "evt_1", labelKey: gap.labelKey } as const;
    const plan = (open: OpenGapFlag): { close: string[]; raised: number } => {
      const { close, raise } = planGapFlags({ candidates: [gap], open: [open], history: history() });
      return { close, raised: raise.length };
    };
    expect(plan({ ...flag, held: false, goDue: "2026-01-02T09:00:00.000Z" })).toEqual({ close: ["opp_1"], raised: 1 });
    expect(plan({ ...flag, held: false, goDue: "2026-01-03T15:00:00.000Z" })).toEqual({ close: [], raised: 0 });
    expect(plan({ ...flag, held: true, goDue: "2026-01-02T09:00:00.000Z" })).toEqual({ close: [], raised: 0 });
    expect(plan({ ...flag, held: false })).toEqual({ close: [], raised: 0 });
  });

  it("the owner's no on a meeting holds on any day", () => {
    const gap = candidate({ trigger: "meeting_soon", subject: "evt_1", due: "2026-01-03T09:00:00.000Z" });
    expect(gapHold(gap, none, history([], [[gapKey(gap), [gap.source]]]))).toBe("declined");
  });

  it("names one reason, and none for a gap free to raise", () => {
    const gap = candidate();
    const key = gapKey(gap);
    expect(gapHold(gap, none, history())).toBeNull();
    expect(gapHold(candidate({ trigger: "no_warm_path" }), none, history())).toBe("unqualified");
    expect(gapHold(gap, new Set([key]), history())).toBe("open");
    expect(gapHold(gap, none, history([key]))).toBe("quiet");
    expect(gapHold(gap, none, history([], [[key, ["msg_1"]]]))).toBe("declined");
    expect(gapHold({ ...gap, hold: true }, none, history())).toBe("not_chosen");
  });

  it("agrees with the plan: raised exactly when it names no reason", () => {
    const gaps = [
      candidate(),
      candidate({ subject: "s2" }),
      candidate({ subject: "s3" }),
      candidate({ subject: "s4" }),
    ];
    const keys = gaps.map(gapKey);
    const made = history([keys[1] as string], [[keys[2] as string, ["msg_1"]]]);
    const opened = new Set([keys[3] as string]);
    const planned = planGapFlags({ candidates: gaps, open: gaps.slice(3).map((gap) => open(gap)), history: made });
    expect(planned.raise.map(({ gap }) => gap.subject)).toEqual(
      gaps.filter((gap) => gapHold(gap, opened, made) === null).map((gap) => gap.subject),
    );
  });

  it("a declined explore node is declined, and one outside the day's budget is not chosen", () => {
    const node = candidate({ trigger: "explore", subject: "ent_1", source: "ent_1" });
    expect(gapHold(node, none, history())).toBe("not_chosen");
    expect(gapHold({ ...node, hold: false }, none, history())).toBeNull();
    expect(gapHold(node, none, history([], [[gapKey(node), ["ent_1"]]]))).toBe("declined");
    expect(gapHold({ ...node, hold: false }, none, history([gapKey(node)]))).toBeNull();
  });
});

describe("what the plan leaves out names the gaps, as the counts count them", () => {
  it("lists what the day's cap holds and what the per-tick cut defers", () => {
    const gaps = [candidate(), candidate({ subject: "s2" }), candidate({ subject: "s3" })];
    const full = new Map([["own", { raisedToday: GAP_RAISE_FLOOR_PER_DAY, claimed: 0, done: 0 }]]);
    const held = planGapFlags({
      candidates: gaps,
      open: [],
      history: { quiet: new Set(), declined: new Map() },
      supply: full,
    });
    expect(held.capped).toBe(3);
    expect(held.left.map(({ gap, why }) => [gap.subject, why])).toEqual([
      ["s1", "capped"],
      ["s2", "capped"],
      ["s3", "capped"],
    ]);
    const cut = plan(gaps, [], {}, 1);
    expect(cut.deferred).toBe(2);
    expect(cut.left.map(({ why }) => why)).toEqual(["deferred", "deferred"]);
  });
});

describe("a close person's gaps key by subject", () => {
  it("close_no_role, as close_no_tie: a label widened by the owner's no is the same gap", () => {
    const gap = { trigger: "close_no_role" as const, subject: "ent_hash", labelKey: "own" };
    expect(gapKey(gap)).toBe(gapKey({ ...gap, labelKey: "own,work" }));
    expect(gapQualifies(candidate({ trigger: "close_no_role", goal: null }))).toBe(true);
  });
});

describe("a defect's task", () => {
  const defect = (over: Partial<GapCandidate> = {}) =>
    candidate({ trigger: "defect", subject: "imp_1_0", source: "imp_1", labelKey: "agent:a,own", ...over });

  it("is raised with no goal, keyed by its subject alone, outside the day's cap", () => {
    expect(gapQualifies(defect())).toBe(true);
    expect(gapKey(defect())).toBe(gapKey(defect({ labelKey: "own" })));
    const supply = new Map<string, GapSupply>([["agent:a,own", { raisedToday: 99, claimed: 0, done: 0 }]]);
    const result = planGapFlags({
      candidates: [defect(), defect({ trigger: "defect_untriaged", subject: "imp_2", source: "imp_2" })],
      open: [],
      history: { quiet: new Set(), declined: new Map() },
      supply,
    });
    expect(result.raise.map(({ gap, limited }) => [gap.subject, limited])).toEqual([
      ["imp_1_0", false],
      ["imp_2", false],
    ]);
    expect(result.capped).toBe(0);
  });

  it("is one task while it is open, and closes when the defect no longer holds", () => {
    const flag = open({ id: "opp_d", trigger: "defect", subject: "imp_1_0", labelKey: "agent:a,own" });
    expect(raised(plan([defect()], [flag]))).toEqual([]);
    expect(plan([defect()], [flag]).close).toEqual([]);
    expect(plan([], [flag]).close).toEqual(["opp_d"]);
    // An agent holds it: code leaves it to that agent.
    expect(plan([], [{ ...flag, held: true }]).close).toEqual([]);
  });

  it("a reopened defect is a new gap: the quiet days of its first opening's task do not hold it", () => {
    const quiet = [gapQuietKey(defect())];
    expect(raised(plan([defect()], [], { quiet }))).toEqual([]);
    expect(raised(plan([defect({ subject: "imp_1_1" })], [], { quiet })).map((gap) => gap.subject)).toEqual([
      "imp_1_1",
    ]);
  });
});

describe("a flag widened by the owner's no under another label", () => {
  const gap = {
    trigger: "close_no_tie" as const,
    subject: "ent_hash",
    labelKey: "own",
    goal: null,
    source: "ent",
    at: "2026-01-01T00:00:00.000Z",
  };
  const widened = { ...gap, labelKey: "employer:example,own" };

  it("still holds its gap: an open one is not raised again, nor closed", () => {
    const plan = planGapFlags({
      candidates: [gap],
      open: [
        { id: "opp", trigger: widened.trigger, subject: widened.subject, labelKey: widened.labelKey, held: false },
      ],
      history: { quiet: new Set(), declined: new Map() },
    });
    expect(plan).toMatchObject({ raise: [], close: [] });
  });

  it("rests and is declined under its gap's key", () => {
    expect(gapKey(widened)).toBe(gapKey(gap));
    expect(
      planGapFlags({ candidates: [gap], open: [], history: { quiet: new Set([gapKey(widened)]), declined: new Map() } })
        .raise,
    ).toEqual([]);
  });

  it("a gap read from a source row still keys by its label", () => {
    const mention = { ...gap, trigger: "unresolved_mention" as const };
    expect(gapKey(mention)).not.toBe(gapKey({ ...mention, labelKey: "employer:example" }));
  });
});

describe("gap flags", () => {
  it("each trigger raises: a mention and an attendee with no goal, a missing path and a close person's role with one", () => {
    expect(gapQualifies(candidate())).toBe(true);
    expect(gapQualifies(candidate({ trigger: "unknown_attendee", facts: 0, ties: 0 }))).toBe(true);
    expect(gapQualifies(candidate({ trigger: "no_warm_path", goal: "gol_1" }))).toBe(true);
    expect(gapQualifies(candidate({ trigger: "close_no_role" }))).toBe(true);
    // A missing path with no active goal is no flag.
    expect(gapQualifies(candidate({ trigger: "no_warm_path" }))).toBe(false);
  });

  it("a close person with no tie raises with no goal, once per person and label, and closes when the tie exists", () => {
    const tie = candidate({ trigger: "close_no_tie", subject: `ent_1_${"b".repeat(32)}`, source: "ent_1" });
    expect(gapQualifies(tie)).toBe(true);
    expect(plan([tie, tie]).raise).toHaveLength(1);
    expect(plan([tie], [open({ trigger: "close_no_tie", subject: tie.subject })]).raise).toEqual([]);
    expect(plan([], [open({ id: "opp_9", trigger: "close_no_tie", subject: tie.subject })]).close).toEqual(["opp_9"]);
    // The owner declined it: never raised again by code for that person (the same source).
    expect(plan([tie], [], { declined: [[gapKey(tie), ["ent_1"]]] }).raise).toEqual([]);
  });

  it("intro_path needs an own tie before the second-degree hop", () => {
    // facts counts the introducers: people the owner has an own tie with, linked to the target.
    const intro = candidate({ trigger: "intro_path", subject: "ent_t", goal: "gol_1", source: "gol_1", facts: 2 });
    expect(gapQualifies(intro)).toBe(true);
    expect(gapQualifies({ ...intro, facts: 0 })).toBe(false);
    expect(gapQualifies(candidate({ trigger: "intro_path", subject: "ent_t", goal: "gol_1", source: "gol_1" }))).toBe(
      false,
    );
    // Always with its goal.
    expect(gapQualifies({ ...intro, goal: null })).toBe(false);
    // One per target and label, however many goals reach it: two goals' rows raise one flag.
    expect(plan([intro, { ...intro, goal: "gol_2", source: "gol_2" }]).raise).toHaveLength(1);
    expect(plan([intro, { ...intro, labelKey: "employer:x" }]).raise).toHaveLength(2);
  });

  it("a meeting soon, a commitment due and mail owed a reply raise with no goal, whatever the counts", () => {
    for (const trigger of ["meeting_soon", "commitment_due", "reply_owed"] as const) {
      expect(gapQualifies(candidate({ trigger })), trigger).toBe(true);
      expect(gapQualifies(candidate({ trigger, facts: GAP_FEW_FACTS + 5, ties: GAP_LOW_TIE + 5 })), trigger).toBe(true);
    }
    // One per trigger, subject and label, and closed when its gap stops holding, as every flag.
    const due = candidate({
      trigger: "commitment_due",
      subject: `${"a".repeat(64)}_20261028`,
      due: "2026-10-28T09:00:00.000Z",
    });
    expect(plan([due, due]).raise).toHaveLength(1);
    expect(plan([], [open({ trigger: "reply_owed", subject: "msg_1" })]).close).toEqual(["opp_1"]);
    // A meeting soon is raised before a mention, by its time.
    const meeting = candidate({ trigger: "meeting_soon", subject: "evt_1", due: "2026-10-28T09:00:00.000Z" });
    expect(raised(plan([candidate(), meeting]))[0]).toEqual(meeting);
  });

  it("an attendee is little known below both thresholds only", () => {
    const attendee = (facts: number, ties: number) =>
      gapQualifies(candidate({ trigger: "unknown_attendee", facts, ties }));
    expect(attendee(GAP_FEW_FACTS - 1, GAP_LOW_TIE - 1)).toBe(true);
    expect(attendee(GAP_FEW_FACTS, 0)).toBe(false);
    expect(attendee(0, GAP_LOW_TIE)).toBe(false);
  });

  it("one flag per trigger, subject and label: duplicates in one scan, and a gap with a flag open, raise nothing more", () => {
    expect(plan([candidate(), candidate({ at: "2026-10-14T00:00:00.000Z" })]).raise).toHaveLength(1);
    expect(plan([candidate()], [open()])).toMatchObject({ raise: [], close: [], deferred: 0, capped: 0 });
    // Another label, another trigger or another subject is another flag.
    expect(
      plan(
        [candidate({ labelKey: "own,work" }), candidate({ subject: "s2" }), candidate({ trigger: "close_no_role" })],
        [open()],
      ).raise,
    ).toHaveLength(3);
  });

  it("closes an open flag when its gap no longer holds, unless an agent holds it", () => {
    expect(plan([], [open({ id: "opp_2" }), open({ id: "opp_3", subject: "s3", held: true })])).toMatchObject({
      raise: [],
      close: ["opp_2"],
      deferred: 0,
      capped: 0,
    });
    // An attendee who is now known: the gap is gone.
    expect(
      plan(
        [candidate({ trigger: "unknown_attendee", facts: GAP_FEW_FACTS, ties: 0 })],
        [open({ trigger: "unknown_attendee" })],
      ).close,
    ).toEqual(["opp_1"]);
  });

  it("a gap in its quiet days is not raised again", () => {
    expect(plan([candidate()], [], { quiet: [gapKey(candidate())] }).raise).toEqual([]);
  });

  it("invariant 11: a gap the owner declined is not raised again from the same source, and from a new one only as the owner's card", () => {
    const key = gapKey(candidate());
    expect(plan([candidate()], [], { declined: [[key, ["msg_1"]]] }).raise).toEqual([]);
    expect(plan([candidate({ source: "msg_2" })], [], { declined: [[key, ["msg_1"]]] }).raise).toEqual([
      { gap: candidate({ source: "msg_2" }), card: true, limited: false },
    ]);
    // Never declined: decided by code.
    expect(plan([candidate()]).raise).toEqual([{ gap: candidate(), card: false, limited: false }]);
  });

  it("raises the most urgent first: a meeting by its time, then those with a goal, then by time", () => {
    const later = candidate({ subject: "late", at: "2026-10-20T00:00:00.000Z" });
    const goal = candidate({ trigger: "no_warm_path", subject: "g", goal: "gol_1", at: "2026-10-30T00:00:00.000Z" });
    const early = candidate({ subject: "early", at: "2026-10-01T00:00:00.000Z" });
    const soon = candidate({
      trigger: "unknown_attendee",
      subject: "soon",
      source: "evt_1",
      at: "2026-10-14T09:00:00.000Z",
      due: "2026-10-14T09:00:00.000Z",
      facts: 0,
      ties: 0,
    });
    const sooner = { ...soon, subject: "sooner", due: "2026-10-13T12:00:00.000Z", at: "2026-10-13T12:00:00.000Z" };
    expect(raised(plan([later, early, goal, soon, sooner]))).toEqual([sooner, soon, goal, early, later]);
  });

  it("at most the cap a label; the rest wait and are counted, and one label's backlog never delays another's", () => {
    const many = Array.from({ length: GAP_FLAGS_PER_TICK + 3 }, (_, n) =>
      candidate({ subject: `s${String(n).padStart(2, "0")}` }),
    );
    const other = candidate({ subject: "work-1", labelKey: "employer:example", at: "2026-12-01T00:00:00.000Z" });
    const result = plan([...many, other]);
    expect(result.deferred).toBe(3);
    expect(raised(result)).toHaveLength(GAP_FLAGS_PER_TICK + 1);
    expect(raised(result)).toContainEqual(other);
    expect(plan([candidate(), candidate({ subject: "s2" })], [], {}, 1)).toMatchObject({ deferred: 1 });
  });
});

describe("raising capped by what finishes", () => {
  const supply = (raisedToday: number, claimed = 0, done = 0, label = "own") =>
    new Map([[label, { raisedToday, claimed, done }]]);
  const many = (n: number, over: Partial<GapCandidate> = {}) =>
    Array.from({ length: n }, (_, index) => candidate({ subject: `s${index}`, ...over }));
  const capped = (candidates: GapCandidate[], given: Map<string, GapSupply>, declined: [string, string[]][] = []) =>
    planGapFlags({
      candidates,
      open: [],
      history: { quiet: new Set(), declined: new Map(declined.map(([key, from]) => [key, new Set(from)])) },
      supply: given,
    });
  const limited = (plan: ReturnType<typeof capped>) => plan.raise.filter((one) => one.limited).length;

  it("the cap is the floor plus the mean daily count of work that was used, not of work that finished", () => {
    expect(gapRaiseCap({})).toBe(GAP_RAISE_FLOOR_PER_DAY);
    expect(gapRaiseCap({ used: GAP_VALUE_WINDOW_DAYS * 3 })).toBe(GAP_RAISE_FLOOR_PER_DAY + 3);
    expect(gapRoom({ raisedToday: GAP_RAISE_FLOOR_PER_DAY + 2, claimed: 0, done: 0 })).toBe(0);
    // Finishing alone earns nothing.
    expect(gapRoom({ raisedToday: 0, claimed: 700, done: 700 })).toBe(GAP_RAISE_FLOOR_PER_DAY);
  });

  describe("a trigger's room follows what its work was worth", () => {
    const standing = (over: Partial<GapStanding>): GapStanding => ({
      scored: 0,
      used: 0,
      kept: 0,
      dropped: 0,
      ...over,
    });
    it("low counts mean untried: under the sample a trigger keeps all its room", () => {
      expect(gapWeight(standing({ scored: GAP_VALUE_MIN_SCORED - 1 }))).toBe(1);
    });
    it("past the sample, the share used", () => {
      expect(gapWeight(standing({ scored: 10, used: 3 }))).toBeCloseTo(0.3);
    });
    it("the owner's answers outrank what code inferred, once there are enough of them", () => {
      expect(gapWeight(standing({ scored: 10, used: 10, dropped: GAP_VALUE_MIN_JUDGED }))).toBe(0);
      expect(gapWeight(standing({ scored: 10, used: 0, kept: GAP_VALUE_MIN_JUDGED }))).toBe(1);
      // Two answers are not yet enough to outrank.
      expect(gapWeight(standing({ scored: 10, used: 10, dropped: 2 }))).toBe(1);
    });
    it("a dropped trigger loses room to one a day, never below it, and never exceeds the label's room", () => {
      const numbers = (over: Partial<GapStanding & { raisedToday: number }>, raisedToday = 0): GapSupply => ({
        raisedToday,
        claimed: 0,
        done: 0,
        triggers: { close_no_tie: { ...standing(over), raisedToday: over.raisedToday ?? 0 } },
      });
      const dropped = { scored: 10, dropped: GAP_VALUE_MIN_JUDGED };
      expect(gapTriggerRoom(numbers(dropped), "close_no_tie")).toBe(1);
      expect(gapTriggerRoom(numbers({ ...dropped, raisedToday: 1 }), "close_no_tie")).toBe(0);
      // A half-used trigger takes half the label's cap.
      expect(gapTriggerRoom(numbers({ scored: 10, used: 5 }), "close_no_tie")).toBe(
        Math.ceil(GAP_RAISE_FLOOR_PER_DAY / 2),
      );
      // An untried trigger has the label's room, and the label's room bounds a used one.
      expect(gapTriggerRoom(numbers({}), "reply_owed")).toBe(GAP_RAISE_FLOOR_PER_DAY);
      expect(gapTriggerRoom(numbers({ scored: 10, used: 10 }, GAP_RAISE_FLOOR_PER_DAY), "close_no_tie")).toBe(0);
    });
  });

  it("a label with no room raises nothing the cap covers, and counts it; with room each is marked limited", () => {
    const stopped = capped(many(3), supply(GAP_RAISE_FLOOR_PER_DAY));
    expect(stopped.raise).toEqual([]);
    expect(stopped.capped).toBe(3);
    const open = capped(many(3), new Map());
    expect(limited(open)).toBe(3);
    expect(open.capped).toBe(0);
  });

  it("invariant 6: one label's numbers change nothing of another's raises", () => {
    const own = capped(many(3), supply(GAP_RAISE_FLOOR_PER_DAY, 0, 0, "agent:a"));
    expect(limited(own)).toBe(3);
  });

  it("a reply owed is never capped, however many goal-bearing gaps outrank it", () => {
    const reply = candidate({ trigger: "reply_owed", subject: "r1" });
    const plan = capped([...many(40, { goal: "gol_1" }), reply], supply(GAP_RAISE_FLOOR_PER_DAY));
    expect(plan.raise.map((one) => one.gap.subject)).toEqual(["r1"]);
    expect(plan.raise[0]?.limited).toBe(false);
  });

  it("a dated gap is never capped: a meeting booked late in the day is raised though the day's room is gone", () => {
    const meeting = candidate({ trigger: "meeting_soon", subject: "e1", due: "2026-10-13T20:00:00.000Z" });
    const due = candidate({ trigger: "commitment_due", subject: "c1", due: "2026-10-14T09:00:00.000Z" });
    const plan = capped([meeting, due], supply(GAP_RAISE_FLOOR_PER_DAY));
    expect(plan.raise.map((one) => one.gap.subject)).toEqual(["e1", "c1"]);
    expect(limited(plan)).toBe(0);
  });

  it("an explore node takes no room: its own day's budget bounds it", () => {
    const node = candidate({ trigger: "explore", subject: "n1", goal: "gol_1", hold: false });
    const plan = capped([node, ...many(2)], supply(GAP_RAISE_FLOOR_PER_DAY));
    expect(plan.raise.map((one) => one.gap.subject)).toEqual(["n1"]);
    expect(plan.raise[0]?.limited).toBe(false);
  });

  it("a card ranked below the per-tick cut is still raised: what the cap holds does not stand in front of it", () => {
    const back = candidate({ subject: "back", source: "msg_new", at: "2030-01-01T00:00:00.000Z" });
    const plan = capped([...many(GAP_FLAGS_PER_TICK + 5), back], supply(GAP_RAISE_FLOOR_PER_DAY), [
      [gapKey(back), ["msg_old"]],
    ]);
    expect(plan.raise).toEqual([{ gap: back, card: true, limited: false }]);
    expect(plan.capped).toBe(GAP_FLAGS_PER_TICK + 5);
  });

  it("with room, what the cap does not cover goes first, so the per-tick cut falls on capped gaps", () => {
    const replies = Array.from({ length: GAP_FLAGS_PER_TICK }, (_, n) =>
      candidate({ trigger: "reply_owed", subject: `r${n}`, at: "2030-01-01T00:00:00.000Z" }),
    );
    const plan = capped([...many(5, { goal: "gol_1" }), ...replies], new Map());
    expect(limited(plan)).toBe(0);
    expect(plan.raise).toHaveLength(GAP_FLAGS_PER_TICK);
    expect(plan.deferred).toBe(5);
  });
});

describe("goal_review and meeting_followup", () => {
  const review = candidate({ trigger: "goal_review", subject: "gol_1", source: "gol_1", goal: "gol_1" });
  const followUp = candidate({ trigger: "meeting_followup", subject: "evt_1", source: "evt_1" });
  const full: GapSupply = { raisedToday: GAP_RAISE_FLOOR_PER_DAY, claimed: 0, done: 0 };

  it("a goal's review needs its goal; a meeting's follow-up needs none", () => {
    expect(gapQualifies(review)).toBe(true);
    expect(gapQualifies({ ...review, goal: null })).toBe(false);
    expect(gapQualifies(followUp)).toBe(true);
  });

  it("each is keyed by its gap's label, and a follow-up's quiet key has no day", () => {
    expect(gapKey(review)).not.toBe(gapKey({ ...review, labelKey: "employer:example,own" }));
    expect(gapQuietKey({ ...followUp, due: "2026-01-02T00:00:00.000Z" })).toBe(gapKey(followUp));
  });

  it("both stand under the day's cap: limited, and held back when the label has no room", () => {
    const supply = (numbers: GapSupply) => new Map([["own", numbers]]);
    const room = planGapFlags({
      candidates: [review, followUp],
      open: [],
      history: { quiet: new Set(), declined: new Map() },
      supply: supply({ raisedToday: 0, claimed: 0, done: 0 }),
    });
    expect(room.raise.map(({ gap, limited }) => [gap.trigger, limited])).toEqual([
      ["goal_review", true],
      ["meeting_followup", true],
    ]);
    const none = planGapFlags({
      candidates: [review, followUp],
      open: [],
      history: { quiet: new Set(), declined: new Map() },
      supply: supply(full),
    });
    expect(none.raise).toEqual([]);
    expect(none.capped).toBe(2);
  });

  it("a trigger whose tasks went unused gets a smaller share of the label's room", () => {
    const unused: GapStanding = { scored: 10, used: 0, kept: 0, dropped: 0 };
    const numbers: GapSupply = {
      raisedToday: 0,
      claimed: 0,
      done: 0,
      triggers: { meeting_followup: { ...unused, raisedToday: 1 } },
    };
    expect(gapTriggerRoom(numbers, "meeting_followup")).toBe(0);
    expect(gapTriggerRoom(numbers, "goal_review")).toBe(gapRoom(numbers));
  });
});
