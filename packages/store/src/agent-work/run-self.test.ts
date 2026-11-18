import { CompiledBelief, ContactCount, MeetingView, RunSelf } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { daysOf } from "../read/read-who.ts";
import { selfBriefOf } from "./run-self.ts";

// A planner run's owner brief, get_self's cut of stated, and an all-day event's days: pure, on
// synthetic values only.

const ulid = (n: number): string => String(n).padStart(26, "0");
const hex = (n: number): string => n.toString(16).padStart(64, "0");
const owner = { id: `ent_${ulid(1)}`, kind: "owner", name: null, address: null };
const at = (day: number): string => new Date(Date.UTC(2026, 8, day)).toISOString();

let serial = 100;
const belief = (
  kind: string,
  over: { status?: string; provenance?: string; day?: number; what?: string; record?: boolean; cites?: number } = {},
) => {
  serial += 1;
  const n = serial;
  const cite = (k: number) => ({
    id: hex(n * 10 + k),
    subject: owner,
    statedBy: owner,
    basis: "explicit_self",
    statementKind: "stated_fact",
    at: at(over.day ?? 1),
    message: over.record === true ? null : `msg_${ulid(n * 10 + k)}`,
    ...(over.record === true ? { record: `rec_${ulid(n)}` } : {}),
    document: null,
    passage: null,
    page: null,
    capture: null,
    segment: null,
    thirdParty: false,
    agentReported: false,
    provenance: "source",
    type: kind,
    fields:
      kind === "preference"
        ? { what: { untrusted: over.what ?? `words ${n}` }, polarity: "prefers" }
        : { what: { untrusted: over.what ?? `words ${n}` } },
  });
  return CompiledBelief.parse({
    fact: hex(n),
    state: hex(n + 1),
    kind,
    type: kind,
    status: over.status ?? "active",
    disputed: false,
    provenance: over.provenance ?? "source",
    confirmedAt: at(over.day ?? 1),
    reviewAfter: null,
    subject: owner,
    values: kind === "preference" ? { polarity: "prefers" } : {},
    cites: Array.from({ length: over.cites ?? 1 }, (_, k) => cite(k)),
  });
};

const meeting = (n: number, allDay = false) =>
  MeetingView.parse({
    id: `evt_${ulid(n)}`,
    title: { untrusted: `Call ${n}` },
    startsAt: allDay ? null : at(n),
    endsAt: allDay ? null : at(n),
    allDay,
    ...(allDay ? { date: "2026-09-04", lastDate: "2026-09-04" } : {}),
    cancelled: false,
    participants: [
      owner,
      { id: `ent_${ulid(500 + n)}`, kind: "person", name: { untrusted: `Person ${n}` }, address: null },
    ],
  });
const contact = (n: number) =>
  ContactCount.parse({
    id: `ent_${ulid(700 + n)}`,
    kind: "person",
    name: { untrusted: `Contact ${n}` },
    address: { untrusted: `c${n}@example.org` },
    emails30d: n,
    emails90d: n,
    meetings90d: 0,
  });

describe("a planner run's owner brief", () => {
  it("holds the owner's confirmed facts and their active stated ones, newest first, each one line with its ref, and their week and contacts", () => {
    const beliefs = [
      belief("goal", { day: 3, what: "Run a marathon" }),
      belief("preference", { day: 9, what: "Short calls" }),
      belief("goal", { day: 5, provenance: "owner", record: true, what: "Hire a designer" }),
      belief("situation", { day: 7, status: "stale" }),
      belief("capability", { day: 8, status: "closed" }),
    ];
    const { self, messages, dropped } = selfBriefOf({
      beliefs,
      upcoming: [meeting(2), meeting(4, true)],
      contacts: [contact(1)],
    });
    expect(RunSelf.parse(self)).toEqual(self);
    expect(self.confirmed).toEqual([
      { kind: "goal", what: { untrusted: "Hire a designer" }, ref: { kind: "agent_record", id: `rec_${ulid(103)}` } },
    ]);
    // Active only, newest first; a stale situation and a closed capability are not here.
    expect(self.stated.map((one) => one.what.untrusted)).toEqual(["Short calls", "Run a marathon"]);
    expect(self.stated[0]).toMatchObject({ kind: "preference", polarity: "prefers", ref: { kind: "message" } });
    expect(self.meetings).toEqual([
      { id: `evt_${ulid(2)}`, at: at(2), title: { untrusted: "Call 2" }, with: [{ untrusted: "Person 2" }] },
      { id: `evt_${ulid(4)}`, date: "2026-09-04", title: { untrusted: "Call 4" }, with: [{ untrusted: "Person 4" }] },
    ]);
    expect(self.contacts).toEqual([
      {
        id: `ent_${ulid(701)}`,
        name: { untrusted: "Contact 1" },
        address: { untrusted: "c1@example.org" },
        emails90d: 1,
        meetings90d: 0,
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("is cut to its budget, the oldest stated fact first, then the farthest contact, then the latest meeting, then the oldest confirmed", () => {
    const beliefs = [
      ...Array.from({ length: 30 }, (_, n) =>
        belief("preference", { day: 1 + (n % 28), what: `stated ${"x".repeat(200)} ${n}` }),
      ),
      ...Array.from({ length: 5 }, (_, n) =>
        belief("goal", { day: 1 + n, provenance: "owner", what: `confirmed ${n}` }),
      ),
    ];
    const input = { beliefs, upcoming: [meeting(2), meeting(3)], contacts: [contact(1), contact(2)] };
    const whole = selfBriefOf(input, 1_000_000);
    const size = (value: unknown): number => [...JSON.stringify(value)].length;
    const budget = size(whole.self) - 3_000;
    const cut = selfBriefOf(input, budget);
    expect(size(cut.self)).toBeLessThanOrEqual(budget);
    expect(cut.dropped).toBeGreaterThan(0);
    expect(cut.self.stated).toEqual(whole.self.stated.slice(0, cut.self.stated.length));
    expect([cut.self.confirmed, cut.self.meetings, cut.self.contacts]).toEqual([
      whole.self.confirmed,
      whole.self.meetings,
      whole.self.contacts,
    ]);
    // With no room for any stated fact, the contacts and meetings go next, the confirmed last.
    const tight = selfBriefOf(input, size({ ...whole.self, stated: [], contacts: [], meetings: [] }));
    expect([tight.self.stated, tight.self.contacts, tight.self.meetings, tight.self.confirmed]).toEqual([
      [],
      [],
      [],
      whole.self.confirmed,
    ]);
  });
});

describe("an all-day event's days", () => {
  it("are the UTC date of its start and the day before its end, which the calendar gives as the day after", () => {
    expect(daysOf(new Date("2026-10-09T00:00:00Z"), new Date("2026-10-10T00:00:00Z"))).toEqual({
      date: "2026-10-09",
      lastDate: "2026-10-09",
    });
    expect(daysOf(new Date("2026-10-09T00:00:00Z"), new Date("2026-10-12T00:00:00Z"))).toEqual({
      date: "2026-10-09",
      lastDate: "2026-10-11",
    });
    expect(daysOf(new Date("2026-10-09T00:00:00Z"), null)).toEqual({ date: "2026-10-09", lastDate: "2026-10-09" });
    expect(daysOf(null, null)).toBeNull();
  });
});
