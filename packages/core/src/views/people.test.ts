import { type CompiledBelief, CompiledFacts, type FactView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CARD_BELIEFS, capFacts, collapseGroup, currentOf, currentStanding, groupFactKey, sinceOf } from "./people.ts";

// People's cards and facts. Made-up values only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ";
const ent = (n: number) => `ent_${ULID}${n}`;
const person = (n: number) => ({ id: ent(n), kind: "person" as const, name: null, address: null });
const org = (n: number) => ({ id: ent(n), kind: "organization" as const, name: null, address: null });
const hex = (n: number) => n.toString(16).padStart(64, "0");
const at = (day: number) => new Date(Date.UTC(2026, 4, 1 + day)).toISOString();

let serial = 0;
const cite = (day: number, type: string, fields: Record<string, unknown>, subject = person(1)): FactView =>
  ({
    id: hex(++serial),
    type,
    subject,
    statedBy: subject,
    basis: "explicit_self",
    statementKind: "stated_fact",
    at: at(day),
    message: `msg_${ULID}0`,
    document: null,
    passage: null,
    page: null,
    capture: null,
    segment: null,
    thirdParty: false,
    agentReported: false,
    provenance: "source",
    fields,
  }) as FactView;

type Spec = {
  n: number;
  kind: "role" | "affiliation" | "need";
  days: number[];
  fields: Record<string, unknown>;
  values?: Record<string, unknown>;
  status?: CompiledBelief["status"];
  subject?: number;
  confirmed?: number;
};
const belief = ({
  n,
  kind,
  days,
  fields,
  values = {},
  status = "active",
  subject = 1,
  confirmed,
}: Spec): CompiledBelief =>
  ({
    fact: hex(1000 + n),
    state: hex(2000 + n),
    kind,
    type: kind,
    status,
    disputed: false,
    provenance: "source",
    confirmedAt: at(confirmed ?? Math.max(...days)),
    reviewAfter: null,
    subject: person(subject),
    values,
    // Latest first, as the reader cites.
    cites: [...days].sort((a, b) => b - a).map((day) => cite(day, kind, fields, person(subject))),
  }) as CompiledBelief;

const title = (text: string) => ({ title: { untrusted: text } });
const named = (text: string) => ({ untrusted: text });

describe("one belief list per group", () => {
  const same = (id: string) => (id === ent(2) ? ent(1) : id);

  it("two members' copies of one fact are one belief, the latest confirmed kept", () => {
    const a = belief({ n: 1, kind: "role", days: [3], fields: title("Head of Finance"), subject: 1 });
    const b = belief({ n: 2, kind: "role", days: [8], fields: title("head of  finance"), subject: 2 });
    const other = belief({ n: 3, kind: "role", days: [5], fields: title("Treasurer"), subject: 2 });
    expect(collapseGroup([a, b, other], same).map((one) => one.fact)).toEqual([b.fact, other.fact]);
  });

  it("an entity in a field is keyed by its group, and a moving value field is no part of the key", () => {
    const a = belief({
      n: 4,
      kind: "need",
      days: [1],
      fields: { what: named("a designer"), by: "2026-06-01", counterparty: person(2) },
    });
    const b = belief({
      n: 5,
      kind: "need",
      days: [2],
      fields: { what: named("a designer"), by: "2026-07-01", counterparty: person(1) },
    });
    expect(groupFactKey(a, same)).toBe(groupFactKey(b, same));
  });

  it("a belief whose latest cite is held is never collapsed", () => {
    const held = {
      ...belief({ n: 6, kind: "role", days: [1], fields: title("X") }),
      cites: [{ held: true, fact: hex(77), type: "role", at: at(1) }],
    } as CompiledBelief;
    const twin = { ...held, fact: hex(1007) } as CompiledBelief;
    expect(collapseGroup([held, twin], same)).toHaveLength(2);
  });

  it("the result does not depend on the order given", () => {
    const list = [1, 2, 3].map((n) =>
      belief({ n, kind: "role", days: [n], fields: title("Same"), subject: n === 3 ? 1 : 2 }),
    );
    expect(collapseGroup(list, same)).toEqual(collapseGroup([...list].reverse(), same));
  });
});

describe("one current role and affiliation", () => {
  it("since is the earliest cite", () => {
    expect(sinceOf(belief({ n: 10, kind: "role", days: [9, 2, 5], fields: title("A") }))).toBe(at(2));
  });

  it("the latest role by since wins, then by confirmation; a dormant, expired or closed one is never current", () => {
    const older = belief({ n: 11, kind: "role", days: [1], fields: title("Analyst") });
    const newer = belief({ n: 12, kind: "role", days: [4], fields: title("Director") });
    const dormant = belief({ n: 13, kind: "role", days: [9], fields: title("Chair"), status: "dormant" });
    const closed = belief({ n: 14, kind: "role", days: [9], fields: title("Chair"), status: "closed" });
    expect(currentOf([older, newer, dormant, closed]).role?.fact).toBe(newer.fact);
    const tie = belief({ n: 15, kind: "role", days: [4], fields: title("Partner"), confirmed: 20 });
    expect(currentOf([newer, tie]).role?.fact).toBe(tie.fact);
  });

  it("a newer employment affiliation at another organization closes an older role there", () => {
    const oldRole = belief({
      n: 20,
      kind: "role",
      days: [1],
      fields: { ...title("CTO"), organization_name: named("Old Co") },
    });
    const job = belief({
      n: 21,
      kind: "affiliation",
      days: [5],
      fields: { relation: "employee", organization_name: named("New Co") },
      values: { relation: "employee" },
    });
    expect(currentOf([oldRole, job])).toEqual({ affiliation: job });
    // An advisor's seat ends no job; nor does an older employment, nor one at the same organization.
    const advisor = { ...job, values: { relation: "advisor" } } as CompiledBelief;
    expect(currentOf([oldRole, advisor]).role?.fact).toBe(oldRole.fact);
    const sameOrg = belief({
      n: 22,
      kind: "affiliation",
      days: [5],
      fields: { relation: "employee", organization_name: named("old  co") },
      values: { relation: "employee" },
    });
    expect(currentOf([oldRole, sameOrg]).role?.fact).toBe(oldRole.fact);
    const newRole = belief({
      n: 23,
      kind: "role",
      days: [6],
      fields: { ...title("VP"), organization_name: named("New Co") },
    });
    expect(currentOf([oldRole, job, newRole]).role?.fact).toBe(newRole.fact);
  });

  it("organizations are compared by entity when the belief names one", () => {
    const oldRole = belief({
      n: 30,
      kind: "role",
      days: [1],
      fields: { ...title("CTO"), organization: org(8) },
      values: { organization: org(8) },
    });
    const job = belief({
      n: 31,
      kind: "affiliation",
      days: [5],
      fields: { relation: "founder", organization: org(9) },
      values: { relation: "founder", organization: org(9) },
    });
    expect(currentOf([oldRole, job]).role).toBeUndefined();
    expect(currentStanding([oldRole, job])).toEqual({
      affiliation: { relation: "founder", organization: org(9), organizationName: null, since: at(5) },
    });
  });

  it("the card's role carries the latest cite's title", () => {
    const role = belief({
      n: 40,
      kind: "role",
      days: [2, 7],
      fields: { ...title("Head of Data"), organization_name: named("Alder") },
    });
    expect(currentStanding([role])).toEqual({
      role: { title: named("Head of Data"), organization: null, organizationName: named("Alder"), since: at(2) },
    });
  });

  it("a role the owner confirmed from an agent's finding, citing no message, is the current role over an older one from mail", () => {
    const mail = belief({
      n: 50,
      kind: "role",
      days: [1],
      fields: { ...title("Volunteer"), organization_name: named("Alder") },
    });
    const confirmed = belief({
      n: 51,
      kind: "role",
      days: [6],
      fields: { ...title("Intern"), organization_name: named("Birch") },
    });
    const finding = {
      ...confirmed,
      provenance: "agent_reported",
      cites: confirmed.cites.map((one) => ({
        ...one,
        message: null,
        statedBy: null,
        agentReported: true,
        provenance: "agent_reported",
      })),
    } as CompiledBelief;
    expect(currentStanding([mail, finding])).toEqual({
      role: { title: named("Intern"), organization: null, organizationName: named("Birch"), since: at(6) },
    });
  });
});

describe("E2: get_entity's cap", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      belief({ n: 100 + i, kind: "need", days: [i, i + 1], fields: { what: named(`n${i}`) } }),
    );

  it("serves at most thirty beliefs with one cite each, and more when one was cut", () => {
    const capped = capFacts({ beliefs: many(31), claims: [], more: false }, new Set());
    expect(capped.beliefs).toHaveLength(CARD_BELIEFS);
    expect(capped.beliefs.every((one) => one.cites.length === 1)).toBe(true);
    expect(capped.more).toBe(true);
    expect(() => CompiledFacts.parse(capped)).not.toThrow();
    expect(capFacts({ beliefs: many(30), claims: [], more: false }, new Set()).more).toBe(false);
  });

  it("keeps a pinned belief past the cut, in its place", () => {
    const list = [...many(31), belief({ n: 300, kind: "role", days: [1], fields: title("Pinned") })];
    const capped = capFacts({ beliefs: list, claims: [], more: false }, new Set([hex(1300)]));
    expect(capped.beliefs).toHaveLength(CARD_BELIEFS);
    expect(capped.beliefs.at(-1)?.fact).toBe(hex(1300));
  });

  it("keeps every relationship to the owner past the cut, and chooses the rest by R29 (tier, then the newest cite), in the order given", () => {
    const owner = { id: ent(0), kind: "owner" as const, name: null, address: null };
    const tie = {
      ...belief({ n: 400, kind: "need", days: [0], fields: { counterparty: owner, relation: "friend" } }),
      kind: "relationship",
      type: "relationship",
      values: { counterparty: owner, relation: "friend" },
    } as CompiledBelief;
    const own = {
      ...belief({ n: 401, kind: "need", days: [0], fields: { what: named("the owner's word") } }),
      tier: "owner",
    } as CompiledBelief;
    // The relationship and the owner-tier need are the oldest and last in the order given.
    const capped = capFacts({ beliefs: [...many(40), own, tie], claims: [], more: false }, new Set());
    expect(capped.beliefs).toHaveLength(CARD_BELIEFS);
    expect(capped.more).toBe(true);
    expect(capped.beliefs.slice(-2).map((one) => one.fact)).toEqual([hex(1401), hex(1400)]);
    // The other twenty-eight are the newest needs, in the order given.
    expect(capped.beliefs.slice(0, -2).map((one) => one.fact)).toEqual(
      Array.from({ length: 28 }, (_, i) => hex(1112 + i)),
    );
  });
});
