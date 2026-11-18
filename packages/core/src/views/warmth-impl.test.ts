import { describe, expect, it } from "vitest";
import {
  type RankInput,
  rankAudience,
  type WarmthFields,
  type WarmthMessage,
  warmthOf,
  warmthRules,
} from "./warmth.ts";

// The implementation's own checks of the warmth tier; the tests written from the formulas alone
// are in warmth.test.ts. Synthetic rows only.

const rules = warmthRules();
const TODAY = "2026-10-31T12:00:00.000Z";
const UTC = "UTC";
const msg = (at: string, direction: "out" | "in", thread = "t1", recipients = 1): WarmthMessage => ({
  at: `${at}T10:00:00.000Z`,
  direction,
  recipients,
  thread,
  channel: "email",
});
const meeting = (at: string, attendees: number) => ({ at: `${at}T15:00:00.000Z`, attendees });
const dayBefore = (days: number): string => new Date(Date.parse(TODAY) - days * 86_400_000).toISOString().slice(0, 10);

describe("warmthOf", () => {
  it("scores ten unanswered cold emails zero and one-way", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(dayBefore(i), "out", `cold${i}`));
    const fields = warmthOf({ messages, meetings: [] }, rules, TODAY, UTC);
    expect(fields).toMatchObject({ active: 0, warmth: 0, twoWay: false, firstTwoWayAt: null, lastTwoWayAt: null });
  });

  it("weighs a 1:1 at 1.5, a 40-person meeting at 0", () => {
    expect(warmthOf({ messages: [], meetings: [meeting(dayBefore(0), 2)] }, rules, TODAY, UTC)).toMatchObject({
      active: 1.5,
      twoWay: true,
      channels: ["calendar"],
    });
    expect(warmthOf({ messages: [], meetings: [meeting(dayBefore(0), 40)] }, rules, TODAY, UTC)).toMatchObject({
      active: 0,
      twoWay: false,
      channels: [],
    });
  });

  it("counts fifty messages on one day as one day each way, and a message to five as a fifth", () => {
    const fifty = [
      ...Array.from({ length: 25 }, () => msg(dayBefore(0), "out")),
      ...Array.from({ length: 25 }, () => msg(dayBefore(0), "in")),
    ];
    expect(warmthOf({ messages: fifty, meetings: [] }, rules, TODAY, UTC).active).toBe(1.5); // 1 each way plus the answered thread's 0.5
    const shared = [msg(dayBefore(0), "out", "a", 5), msg(dayBefore(0), "in", "b", 1)];
    expect(warmthOf({ messages: shared, meetings: [] }, rules, TODAY, UTC).active).toBe(round(Math.sqrt(0.2)));
  });

  // One message out early and one in later must not give a last two-way contact before the first.
  // The last is never before the first.
  it("never serves a last two-way contact before the first", () => {
    const cases: WarmthMessage[][] = [
      [msg(dayBefore(10), "out"), msg(dayBefore(5), "in")],
      [msg(dayBefore(10), "in"), msg(dayBefore(5), "out")],
      [msg(dayBefore(20), "out"), msg(dayBefore(15), "in"), msg(dayBefore(2), "out")],
      [msg(dayBefore(30), "in", "a"), msg(dayBefore(30), "out", "a"), msg(dayBefore(1), "in", "b")],
    ];
    for (const messages of cases) {
      const fields = warmthOf({ messages, meetings: [] }, rules, TODAY, UTC);
      expect(fields.twoWay).toBe(true);
      expect(Date.parse(fields.lastTwoWayAt ?? "")).toBeGreaterThanOrEqual(Date.parse(fields.firstTwoWayAt ?? ""));
    }
    // The first is when both directions had occurred; the last, the latest contact since.
    const fields = warmthOf({ messages: cases[2]!, meetings: [] }, rules, TODAY, UTC);
    expect(fields.firstTwoWayAt?.slice(0, 10)).toBe(dayBefore(15));
    expect(fields.lastTwoWayAt?.slice(0, 10)).toBe(dayBefore(2));
    // A meeting kept after the mail is the last contact; one before it, the first.
    const met = warmthOf(
      { messages: cases[0]!, meetings: [meeting(dayBefore(12), 2), meeting(dayBefore(1), 3)] },
      rules,
      TODAY,
      UTC,
    );
    expect([met.firstTwoWayAt?.slice(0, 10), met.lastTwoWayAt?.slice(0, 10)]).toEqual([dayBefore(12), dayBefore(1)]);
  });

  it("credits a started thread on the answer's day, never the start's", () => {
    const fields = warmthOf(
      { messages: [msg(dayBefore(30), "out"), msg(dayBefore(0), "in")], meetings: [] },
      rules,
      TODAY,
      UTC,
    );
    const decayed = 0.5 ** (30 / 45);
    expect(fields.active).toBe(round(Math.sqrt(decayed * 1) + 0.5));
    expect(fields.past).toMatchObject({ active: 0, twoWay: false, lastTwoWayAt: null });
  });

  it("keeps depth 3 and warmth 1.5 for a tie at 6 two years ago", () => {
    const old = "2024-10-31"; // a month end, 730 days before TODAY
    const fields = warmthOf(
      { messages: [], meetings: Array.from({ length: 4 }, () => meeting(old, 2)) },
      rules,
      TODAY,
      UTC,
    );
    expect(fields).toMatchObject({ active: 0, depth: 3, warmth: 1.5, twoWay: true });
  });

  it("matches a direct sum at every day of the forward pass", () => {
    const days = [400, 380, 300, 200, 120, 60, 15, 3];
    const messages = days.flatMap((d, i) => [
      msg(dayBefore(d), "out", `x${i}`),
      msg(dayBefore(d), i % 2 === 0 ? "in" : "out", `y${i}`),
    ]);
    const w = (d: number) => 0.5 ** (d / 45);
    const sumOut = days.reduce((sum, d) => sum + w(d), 0); // two outs on an odd day cap at 1
    const sumIn = days.reduce((sum, d, i) => sum + (i % 2 === 0 ? w(d) : 0), 0);
    expect(warmthOf({ messages, meetings: [] }, rules, TODAY, UTC).active).toBe(round(Math.sqrt(sumOut * sumIn)));
  });

  it("counts reply runs in a window and states nothing below four", () => {
    const answered = (t: string, gap: number) => [msg(dayBefore(100), "out", t), msg(dayBefore(100 - gap), "in", t)];
    const four = [
      ...answered("a", 1),
      ...answered("b", 14),
      ...answered("c", 15),
      msg(dayBefore(50), "out", "d"),
      msg(dayBefore(49), "out", "d"),
    ];
    const fields = warmthOf({ messages: four, meetings: [] }, rules, TODAY, UTC);
    expect(fields.replyRate).toBe(0.5);
    expect(fields.replyHours).toBe(round((24 + 14 * 24) / 2));
    expect(fields.theyStart).toBe(0);
    expect(warmthOf({ messages: four.slice(0, 6), meetings: [] }, rules, TODAY, UTC).replyRate).toBeNull();
  });

  it("reads days in the owner's zone", () => {
    // 03:00 UTC on the 31st is still the 30th in New York, so the two messages share a day.
    const messages: WarmthMessage[] = [
      { at: "2026-10-31T03:00:00.000Z", direction: "out", recipients: 1, thread: "a", channel: "email" },
      { at: "2026-10-30T20:00:00.000Z", direction: "out", recipients: 1, thread: "b", channel: "email" },
      { at: "2026-10-30T21:00:00.000Z", direction: "in", recipients: 1, thread: "c", channel: "email" },
    ];
    const ny = warmthOf({ messages, meetings: [] }, rules, TODAY, "America/New_York");
    const utc = warmthOf({ messages, meetings: [] }, rules, TODAY, UTC);
    expect(ny.active).toBe(round(0.5 ** (1 / 45)));
    expect(utc.active).toBeGreaterThan(ny.active);
  });
});

const fields = (score: number, extra: Partial<WarmthFields> = {}): WarmthFields => ({
  active: score,
  depth: score,
  warmth: score,
  twoWay: score > 0,
  firstTwoWayAt: null,
  lastTwoWayAt: null,
  replyRate: null,
  replyHours: null,
  theyStart: null,
  channels: [],
  // Every fixture above meets the tier floors unless a case sets its own.
  contactDays: score > 0 ? 30 : 0,
  past: {
    active: score,
    depth: score,
    warmth: score,
    twoWay: score > 0,
    lastTwoWayAt: null,
    contactDays: score > 0 ? 30 : 0,
  },
  ...extra,
});
const id = (i: number): string => `p${String(i).padStart(3, "0")}`;

describe("rankAudience", () => {
  const population = (): RankInput[] => Array.from({ length: 200 }, (_, i) => ({ id: id(i), fields: fields(200 - i) }));
  const count = (result: Map<string, { tier: string }>) =>
    [...result.values()].reduce<Record<string, number>>((acc, one) => {
      acc[one.tier] = (acc[one.tier] ?? 0) + 1;
      return acc;
    }, {});

  it("cuts 200 people at 5, 15, 50 and 150", () => {
    expect(count(rankAudience(population(), rules))).toEqual({
      inner: 5,
      close: 10,
      regular: 35,
      known: 100,
      outer: 50,
    });
  });

  it("gives labelled inner the inner slots first, and labelled dormant outer", () => {
    const people = population();
    people[150] = { ...people[150]!, closeness: "inner" };
    people[160] = { ...people[160]!, closeness: "inner" };
    people[0] = { ...people[0]!, closeness: "dormant" };
    const result = rankAudience([...people, { id: "zz", fields: fields(0) }], rules);
    expect([...result.values()].filter((one) => one.tier === "inner" && one.tierSource === "inferred")).toHaveLength(3);
    expect(result.get(id(0))).toEqual({ tier: "outer", tierSource: "owner", dormant: true });
    expect(result.get(id(150))).toMatchObject({ tier: "inner", tierSource: "owner" });
    expect(result.get(id(1))).toMatchObject({ tier: "inner", tierSource: "inferred" });
    expect(result.get("zz")).toEqual({ tier: "one-way", tierSource: "inferred", dormant: false });
  });

  it("serves the better of now and the past rank", () => {
    const people = population();
    const fell = { ...fields(1), past: { ...fields(1).past, warmth: 199.5, active: 199.5, depth: 199.5 } };
    people[199] = { id: id(199), fields: fell };
    expect(rankAudience(people, rules).get(id(199))?.tier).toBe("inner");
  });

  it("marks dormant a deep tie that is no longer active", () => {
    const people = population();
    people[199] = { id: id(199), fields: fields(0.01, { depth: 500, warmth: 250 }) };
    expect(rankAudience(people, rules).get(id(199))).toMatchObject({ dormant: true, tierSource: "inferred" });
    expect(rankAudience(people, rules).get(id(0))?.dormant).toBe(false);
  });
});

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// The floors exist because, without them, a one-exchange tie on a thin network reached `inner` and
// `close` by rank alone.
describe("tier floors", () => {
  it("counts the days the person wrote to or met the owner, within the window, as of now and as of the past day", () => {
    const messages = [
      msg(dayBefore(40), "out"),
      msg(dayBefore(40), "in"),
      msg(dayBefore(10), "in"),
      msg(dayBefore(10), "in"),
      msg(dayBefore(5), "out"),
      msg(dayBefore(400), "in"),
    ];
    const fields = warmthOf(
      { messages, meetings: [meeting(dayBefore(3), 2), meeting(dayBefore(2), 40)] },
      rules,
      TODAY,
      UTC,
    );
    // Days 40 and 10 (twice, one day), the 1:1 on day 3; not the crowd, not day 400, not the owner's own day 5.
    expect(fields.contactDays).toBe(3);
    expect(fields.past.contactDays).toBe(1);
  });

  it("keeps a one-exchange tie out of inner and close however few people rank above it", () => {
    const people: RankInput[] = [
      { id: id(1), fields: fields(5, { contactDays: 1, past: { ...fields(5).past, contactDays: 1 } }) },
      { id: id(2), fields: fields(4, { contactDays: 2, past: { ...fields(4).past, contactDays: 2 } }) },
      { id: id(3), fields: fields(1, { contactDays: 9 }) },
    ];
    const ranked = rankAudience(people, rules);
    expect(ranked.get(id(1))?.tier).toBe("regular");
    expect(ranked.get(id(2))?.tier).toBe("close");
    // The next person who qualifies takes the inner place the first left.
    expect(ranked.get(id(3))?.tier).toBe("inner");
  });

  it("applies the floors to the past rank too, and a label overrides them", () => {
    const fell = fields(5, { contactDays: 9, past: { ...fields(5).past, contactDays: 1 } });
    expect(rankAudience([{ id: id(1), fields: fell }], rules).get(id(1))?.tier).toBe("inner");
    const thin = fields(5, { contactDays: 0, past: { ...fields(5).past, contactDays: 0 } });
    expect(rankAudience([{ id: id(1), fields: thin, closeness: "inner" }], rules).get(id(1))).toMatchObject({
      tier: "inner",
      tierSource: "owner",
    });
  });

  it("the rule table carries the floors, inner 3 and close 2", () => {
    expect(rules.tierFloors).toEqual({ inner: 3, close: 2 });
  });
});
