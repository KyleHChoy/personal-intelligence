import type { CompiledBelief, FactView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  ATTENDEE_FACT_KINDS,
  attendeeFacts,
  byBeliefOrder,
  compileFacts,
  isAttendeeFact,
  MAX_BELIEFS,
  MAX_CLAIMS,
  ownStatement,
  PER_ATTENDEE_FACTS,
  SHORT_TIME_WORDS,
  saysShortTime,
} from "./facts.ts";

// compileFacts orders and cuts what the reader read.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const person = { id: `ent_${ULID}`, kind: "person" as const, name: null, address: { untrusted: "nora@alder.example" } };
const hex = (n: number) => n.toString(16).padStart(64, "0");
const at = (day: number) => new Date(Date.UTC(2026, 4, 1 + day)).toISOString();

const fact = (n: number, day = n): FactView =>
  ({
    id: hex(n),
    type: "need",
    subject: person,
    statedBy: person,
    basis: "explicit_self",
    statementKind: "stated_fact",
    at: at(day),
    message: `msg_${ULID}`,
    document: null,
    passage: null,
    page: null,
    capture: null,
    segment: null,
    thirdParty: true,
    agentReported: false,
    provenance: "source",
    fields: { what: { untrusted: "I need a kitchen designer." } },
  }) as FactView;

const belief = (
  n: number,
  kind: CompiledBelief["kind"],
  status: CompiledBelief["status"],
  day: number,
  cites = [fact(n)],
): CompiledBelief =>
  ({
    fact: hex(1000 + n),
    state: hex(2000 + n),
    kind,
    type: kind === "need" ? "need" : "role",
    status,
    disputed: false,
    provenance: "source",
    confirmedAt: at(day),
    reviewAfter: null,
    subject: person,
    values: {},
    cites,
  }) as CompiledBelief;

describe("compileFacts", () => {
  it("orders beliefs by the subject kind's kinds, then open first, then the latest confirmed, then by fact", () => {
    const compiled = compileFacts({
      subjectKind: "person",
      beliefs: [
        belief(1, "role", "active", 3),
        belief(2, "need", "expired", 9),
        belief(3, "need", "active", 1),
        belief(4, "need", "active", 5),
        belief(5, "need", "stale", 5),
      ],
      claims: [],
      more: false,
    });
    // person: need before role; open (active, stale) before expired; later first; fact breaks a tie.
    expect(compiled.beliefs.map((one) => one.fact)).toEqual([hex(1004), hex(1005), hex(1003), hex(1002), hex(1001)]);
    expect(compiled.more).toBe(false);
  });

  it("leaves out a belief with no citing claim, and orders claims newest first", () => {
    const compiled = compileFacts({
      subjectKind: "person",
      beliefs: [belief(1, "need", "active", 1, [])],
      claims: [fact(7, 2), fact(8, 4), fact(6, 4)],
      more: false,
    });
    expect(compiled.beliefs).toEqual([]);
    expect(compiled.claims.map((one) => one.id)).toEqual([hex(6), hex(8), hex(7)]);
  });

  it("keeps at most 200 beliefs and 20 claims, and says more", () => {
    const many = Array.from({ length: MAX_BELIEFS + 1 }, (_, n) => belief(n, "need", "active", n % 28));
    const claims = Array.from({ length: MAX_CLAIMS + 1 }, (_, n) => fact(n, n % 28));
    expect(compileFacts({ subjectKind: "person", beliefs: many, claims: [], more: false })).toMatchObject({
      more: true,
    });
    expect(compileFacts({ subjectKind: "person", beliefs: many, claims: [], more: false }).beliefs).toHaveLength(
      MAX_BELIEFS,
    );
    expect(compileFacts({ subjectKind: "person", beliefs: [], claims, more: false }).claims).toHaveLength(MAX_CLAIMS);
    expect(compileFacts({ subjectKind: "person", beliefs: [], claims: [], more: true }).more).toBe(true);
  });

  it("is the same whatever order it is given", () => {
    const beliefs = [belief(1, "role", "active", 3), belief(2, "need", "active", 9), belief(3, "need", "closed", 1)];
    const claims = [fact(4, 1), fact(5, 2)];
    expect(
      compileFacts({
        subjectKind: "person",
        beliefs: [...beliefs].reverse(),
        claims: [...claims].reverse(),
        more: false,
      }),
    ).toEqual(compileFacts({ subjectKind: "person", beliefs, claims, more: false }));
  });
});

describe("byBeliefOrder (get_beliefs)", () => {
  const owner = { id: `ent_${"1".repeat(26)}`, kind: "owner" as const, name: null, address: null };
  const ownerBelief = (n: number, kind: CompiledBelief["kind"], day: number): CompiledBelief =>
    ({ ...belief(n, kind, "active", day), subject: owner }) as CompiledBelief;

  it("orders each belief by its own subject kind's kinds, then open first, then the latest confirmed, then by fact", () => {
    // For the owner, goal comes before need; for a person, need before goal.
    const mixed = [
      belief(1, "goal", "active", 9),
      ownerBelief(2, "need", 9),
      ownerBelief(3, "goal", 1),
      belief(4, "need", "stale", 1),
      belief(5, "need", "dormant", 9),
    ];
    const order = (one: CompiledBelief) => ({
      kind: one.kind,
      status: one.status,
      confirmedAt: one.confirmedAt,
      fact: one.fact,
      subjectKind: one.subject.kind,
    });
    const sorted = [...mixed].sort((a, b) => byBeliefOrder(order(a), order(b)));
    expect(sorted.map((one) => one.fact)).toEqual([3, 4, 5, 2, 1].map((n) => hex(1000 + n)));
  });

  it("is compileFacts' order for one subject", () => {
    const beliefs = [belief(1, "role", "active", 3), belief(2, "need", "active", 1), belief(3, "need", "stale", 5)];
    const order = (one: CompiledBelief) => ({
      kind: one.kind,
      status: one.status,
      confirmedAt: one.confirmedAt,
      fact: one.fact,
      subjectKind: one.subject.kind,
    });
    expect([...beliefs].sort((a, b) => byBeliefOrder(order(a), order(b)))).toEqual(
      compileFacts({ subjectKind: "person", beliefs, claims: [], more: false }).beliefs,
    );
  });
});

describe("attendeeFacts (meeting_prep@4)", () => {
  const other = { ...person, id: `ent_${"0".repeat(25)}1` };
  const VALUES: Partial<Record<CompiledBelief["kind"], Record<string, unknown>>> = {
    consent: { about: "introduce" },
    contact_rule: { rule: "do_not_contact", channel: "phone" },
    relationship: { counterparty: person, relation: "friend" },
    commitment: { counterparty: person },
  };
  const of = (
    who: typeof person,
    n: number,
    kind: CompiledBelief["kind"],
    status: CompiledBelief["status"],
    day: number,
  ): CompiledBelief =>
    ({ ...belief(n, kind, status, day), subject: who, values: VALUES[kind] ?? {} }) as CompiledBelief;

  it("takes the six fact kinds, five of them about a person", () => {
    expect(ATTENDEE_FACT_KINDS).toEqual(["role", "affiliation", "relationship", "need", "contact_rule", "consent"]);
    expect(Object.isFrozen(ATTENDEE_FACT_KINDS)).toBe(true);
    expect(PER_ATTENDEE_FACTS).toBe(5);
  });

  it("for each attendee in the order given, their open beliefs of those kinds, in compileFacts' order, at most five each", () => {
    const beliefs = [
      ...Array.from({ length: 7 }, (_, n) => of(person, n, "need", "active", n)),
      of(person, 20, "role", "active", 30),
      of(other, 30, "consent", "active", 1),
      of(other, 31, "contact_rule", "stale", 2),
      // Closed, expired and dormant beliefs, and kinds the pack leaves out, are not taken.
      of(other, 32, "relationship", "closed", 3),
      of(other, 33, "need", "expired", 4),
      of(other, 34, "goal", "active", 5),
      of(other, 35, "commitment", "active", 6),
      of(other, 36, "situation", "active", 7),
    ];
    const taken = attendeeFacts([other, person], beliefs);
    expect(taken.map((one) => one.fact)).toEqual([
      // The other's first, as the attendees are given: consent before contact rule, as compileFacts orders a person's kinds.
      hex(1030),
      hex(1031),
      // Then the person's: needs before the role, the latest first, five in all.
      hex(1006),
      hex(1005),
      hex(1004),
      hex(1003),
      hex(1002),
    ]);
    // Each is a belief of its attendee, unchanged.
    expect(taken[0]).toEqual(beliefs[8]);
  });

  it("isAttendeeFact is the one test of kind and status, which the reader also uses before it reads any claim", () => {
    expect(isAttendeeFact({ kind: "consent", status: "active" })).toBe(true);
    expect(isAttendeeFact({ kind: "need", status: "stale" })).toBe(true);
    expect(isAttendeeFact({ kind: "need", status: "expired" })).toBe(false);
    expect(isAttendeeFact({ kind: "role", status: "closed" })).toBe(false);
    expect(isAttendeeFact({ kind: "goal", status: "active" })).toBe(false);
    expect(isAttendeeFact({ kind: "commitment", status: "active" })).toBe(false);
  });

  it("an attendee with no belief adds nothing, and an absent attendee's beliefs are not taken", () => {
    expect(attendeeFacts([other], [of(person, 1, "role", "active", 1)])).toEqual([]);
    expect(attendeeFacts([], [of(person, 1, "role", "active", 1)])).toEqual([]);
  });
});

// The owner's own facts are what they wrote of themselves, stated.
describe("ownStatement", () => {
  it("is true only for the owner's own explicit statement, decision or reversal", () => {
    for (const statementKind of ["stated_fact", "decision", "reversal"])
      expect(ownStatement({ basis: "explicit_self", statementKind }, true), statementKind).toBe(true);
    for (const statementKind of ["question", "proposal", "objection", "hypothesis"])
      expect(ownStatement({ basis: "explicit_self", statementKind }, true), statementKind).toBe(false);
  });

  it("is false when someone else is the speaker, whatever basis the model gave", () => {
    expect(ownStatement({ basis: "explicit_self", statementKind: "stated_fact" }, false)).toBe(false);
    expect(ownStatement({ basis: "third_party", statementKind: "stated_fact" }, true)).toBe(false);
  });
});

// The same-day and next-day words, pinned.
describe("saysShortTime", () => {
  it("holds the pinned words", () => {
    expect(SHORT_TIME_WORDS).toEqual(
      expect.arrayContaining(["today", "tonight", "tomorrow", "this morning", "right now"]),
    );
  });

  it("finds each as a whole word or phrase, in any case", () => {
    for (const text of [
      "out sick today",
      "Tonight I am at the airport",
      "in a meeting this  morning",
      "busy RIGHT NOW",
      "back tmrw",
      "flying out tomorrow.",
    ])
      expect(saysShortTime(text), text).toBe(true);
  });

  it("finds none inside another word, and none in a lasting phrase", () => {
    for (const text of [
      "on parental leave",
      "moving to a new city",
      "todays-ish",
      "the tomorrowland festival",
      "a good immigration lawyer",
      "this weekend",
    ])
      expect(saysShortTime(text), text).toBe(false);
  });
});
