// The walk behind find_paths. No database: the walk is handed the owner, the owner's own ties, and
// the ties and affiliations of current beliefs. Each path starts with the owner's own tie, so a
// path of n hops is n - 1 hops past the owner's own contact.

import type { EntityId, FactId, MessageId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  AFFILIATION_HOP,
  type Affiliation,
  distinctRoutes,
  findPaths,
  findPathsWithObserved,
  hopWeight,
  MAX_LINKS,
  MAX_PATHS,
  MAX_STEPS,
  OWN_TIE_FLOOR,
  type Path,
  type PathHop,
  RELATIONSHIP_HOP,
  rankPathsByWeakestHop,
  type StatedVia,
  type Tie,
  type TieVia,
} from "./paths.ts";
import { secondDegreeRules } from "./second-degree.ts";

const OWNER = "ent_OWNER" as EntityId;
const e = (name: string) => `ent-${name}` as EntityId;
// A fact id of 64 hexadecimal characters, from a short name.
const fact = (id: string): FactId => Buffer.from(id).toString("hex").padEnd(64, "0").slice(0, 64);
const tie = (a: string, b: string, id = `${a}${b}`): Tie => ({ a: e(a), b: e(b), facts: [fact(id)] });
const works = (person: string, organization: string, id = `${person}@${organization}`): Affiliation => ({
  person: e(person),
  organization: e(organization),
  facts: [fact(id)],
});
const own = (...names: string[]) => new Set(names.map(e));
const routes = (paths: Path<TieVia>[]) =>
  paths.map((path) => [path.hops.map((hop) => `${hop.from}>${hop.to}:${hop.via}`).join(" "), path.score]);
const names = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(5, "0")}`);
const walk = (
  target: string,
  ownTies: Set<EntityId>,
  ties: Tie<TieVia>[],
  affiliations: Affiliation[],
  maxHops: number,
) => findPaths({ owner: OWNER, target: e(target), ownTies, ties, affiliations, maxHops });

describe("find_paths: the walk", () => {
  it("starts with the owner's own tie, ends at the target, and every hop cites its facts", () => {
    const { paths, cut } = walk("t", own("a"), [tie("a", "b"), tie("b", "t")], [], 3);
    expect(routes(paths)).toEqual([
      ["ent_OWNER>ent-a:own_tie ent-a>ent-b:relationship ent-b>ent-t:relationship", 1 / 4],
    ]);
    // An own tie rests on mail and meetings, no belief: it cites no fact.
    expect(paths[0]?.hops.map((hop) => hop.facts)).toEqual([[], [fact("ab")], [fact("bt")]]);
    expect(cut).toBe(false);
  });

  it("goes no further than maxHops, own tie included, and a target the owner has an own tie to is one path of the own tie alone", () => {
    const ties = [tie("a", "b"), tie("b", "c"), tie("c", "t")];
    expect(walk("t", own("a"), ties, [], 3).paths).toEqual([]);
    expect(routes(walk("t", own("a"), [...ties, tie("b", "t")], [], 3).paths)).toHaveLength(1);
    expect(routes(walk("t", own("t", "a"), ties, [], 3).paths)).toEqual([["ent_OWNER>ent-t:own_tie", 1 / 2]]);
    expect(routes(walk("t", own("t"), [], [], 1).paths)).toEqual([["ent_OWNER>ent-t:own_tie", 1 / 2]]);
    // With one hop, only the own tie: a person tied to the target is a hop too far.
    expect(walk("t", own("a"), [tie("a", "t")], [], 1).paths).toEqual([]);
  });

  it("orders shorter paths first, then by the entities' ids, and holds at most MAX_PATHS", () => {
    const { paths } = walk(
      "t",
      own("a", "c", "z"),
      [tie("z", "t"), tie("c", "b"), tie("b", "t"), tie("a", "t")],
      [],
      3,
    );
    expect(routes(paths).map(([route]) => route)).toEqual([
      "ent_OWNER>ent-a:own_tie ent-a>ent-t:relationship",
      "ent_OWNER>ent-z:own_tie ent-z>ent-t:relationship",
      "ent_OWNER>ent-c:own_tie ent-c>ent-b:relationship ent-b>ent-t:relationship",
    ]);
    const many = names("p", MAX_PATHS + 5);
    const capped = walk(
      "t",
      own(...many),
      many.map((name) => tie(name, "t")),
      [],
      2,
    );
    expect(capped.paths).toHaveLength(MAX_PATHS);
    // More were found than one answer holds: a bound stopped it.
    expect(capped.cut).toBe(true);
    const exact = names("p", MAX_PATHS);
    expect(
      walk(
        "t",
        own(...exact),
        exact.map((name) => tie(name, "t")),
        [],
        2,
      ).cut,
    ).toBe(false);
  });

  it("most: a caller that ranks after the walk gets every found path, and a longer route past MAX_PATHS", () => {
    const many = names("p", MAX_PATHS + 5);
    const found = findPaths({
      owner: OWNER,
      target: e("t"),
      ownTies: own(...many),
      ties: [...many.map((name) => tie(name, "t")), tie("deep", "hub"), tie("hub", "t")],
      affiliations: [],
      maxHops: 3,
      most: MAX_PATHS + 6,
    });
    expect(found.paths).toHaveLength(MAX_PATHS + 5);
    expect(found.cut).toBe(false);
    const deep = findPaths({
      owner: OWNER,
      target: e("t"),
      ownTies: own(...many, "deep"),
      ties: [...many.map((name) => tie(name, "t")), tie("deep", "hub"), tie("hub", "t")],
      affiliations: [],
      maxHops: 3,
      most: MAX_PATHS + 6,
    });
    expect(deep.paths.map((path) => path.hops[0]?.to)).toContain(e("deep"));
  });

  it("bridges two people who share an organization, citing both affiliations of every organization they share", () => {
    const [path] = walk(
      "t",
      own("a"),
      [],
      [works("a", "o"), works("t", "o"), works("a", "q"), works("t", "q"), works("a", "r")],
      2,
    ).paths;
    expect(path?.hops.slice(1)).toEqual([
      {
        from: "ent-a",
        to: "ent-t",
        via: "affiliation",
        facts: [fact("a@o"), fact("a@q"), fact("t@o"), fact("t@q")].sort(),
      },
    ]);
    // An organization is never a hop inside a route: only the end of one.
    expect(path?.hops.map((hop) => hop.to)).toEqual(["ent-a", "ent-t"]);
  });

  it("an organization as the target is reached through anyone at it, the last hop citing that member's affiliations", () => {
    const affiliations = [works("a", "o"), works("b", "o"), works("b", "o", "b@o-2"), works("c", "q")];
    const { paths } = walk("o", own("a", "x"), [tie("x", "b")], affiliations, 3);
    expect(routes(paths).map(([route]) => route)).toEqual([
      "ent_OWNER>ent-a:own_tie ent-a>ent-o:affiliation",
      "ent_OWNER>ent-x:own_tie ent-x>ent-b:relationship ent-b>ent-o:affiliation",
    ]);
    expect(paths[1]?.hops[2]?.facts).toEqual([fact("b@o"), fact("b@o-2")].sort());
    // Nobody the owner knows is at it, or a member is past maxHops: no path.
    expect(walk("q", own("a"), [], affiliations, 3).paths).toEqual([]);
    expect(walk("o", own("x"), [tie("x", "b")], affiliations, 2).paths).toEqual([]);
  });

  it("paths rank by their weakest hop, then fewer hops, then their own tie's strength; a member's hop to the target organization counts for nothing", () => {
    const path = (...hops: [string, string, "own_tie" | "relationship" | "affiliation"][]): Path => ({
      score: 0,
      hops: hops.map(([from, to, via]) => ({ from: e(from), to: e(to), via, facts: [] })),
    });
    const strong = path(["OWNER", "a", "own_tie"], ["a", "t", "affiliation"]);
    const weakTie = path(["OWNER", "b", "own_tie"], ["b", "t", "relationship"]);
    const direct = path(["OWNER", "t", "own_tie"]);
    const ranked = rankPathsByWeakestHop(
      [weakTie, direct, strong],
      new Map([
        [e("a"), 4],
        [e("b"), 0.3],
        [e("t"), 0],
      ]),
      e("t"),
      false,
    );
    // a's bridge is 0.5; b's own tie 0.3; a direct tie with no mail is the floor.
    expect(ranked.map((one) => [one.hops[0]?.to, one.score])).toEqual([
      [e("a"), AFFILIATION_HOP],
      [e("b"), 0.3],
      [e("t"), OWN_TIE_FLOOR],
    ]);
    // To an organization, the member's hop is no tie: the own tie decides.
    const atOrg = path(["OWNER", "a", "own_tie"], ["a", "o", "affiliation"]);
    expect(rankPathsByWeakestHop([atOrg], new Map([[e("a"), 4]]), e("o"), true)[0]?.score).toBe(4);
    // Equal weakest hops: fewer hops first, then the stronger own tie.
    const long = path(["OWNER", "c", "own_tie"], ["c", "d", "relationship"], ["d", "t", "relationship"]);
    const short = path(["OWNER", "d", "own_tie"], ["d", "t", "relationship"]);
    const other = path(["OWNER", "e", "own_tie"], ["e", "t", "relationship"]);
    expect(
      rankPathsByWeakestHop(
        [long, other, short],
        new Map([
          [e("c"), 5],
          [e("d"), 2],
          [e("e"), 3],
        ]),
        e("t"),
        false,
      ).map((one) => one.hops[0]?.to),
    ).toEqual([e("e"), e("d"), e("c")]);
    expect(RELATIONSHIP_HOP).toBe(1);
  });

  it("keeps one link for each pair: a relationship stands over a bridge, and ties pool their facts", () => {
    const [path] = walk(
      "t",
      own("a"),
      [tie("t", "a", "y"), tie("a", "t", "z")],
      [works("a", "o"), works("t", "o")],
      2,
    ).paths;
    expect(path?.hops.slice(1)).toEqual([
      { from: "ent-a", to: "ent-t", via: "relationship", facts: [fact("y"), fact("z")].sort() },
    ]);
  });

  it("the order the rows come in changes nothing", () => {
    const ties = [tie("a", "b"), tie("c", "t"), tie("a", "c")];
    const affiliations = [works("b", "o"), works("t", "o")];
    const one = findPaths({ owner: OWNER, target: e("t"), ownTies: own("a", "c"), ties, affiliations, maxHops: 3 });
    const other = findPaths({
      owner: OWNER,
      target: e("t"),
      ownTies: own("c", "a"),
      ties: [...ties].reverse(),
      affiliations: [...affiliations].reverse(),
      maxHops: 3,
    });
    expect(JSON.stringify(other)).toBe(JSON.stringify(one));
  });

  it("6 000 ties walk the first 5 000 by entity id and set cut, and so do as many affiliations", () => {
    const filler = names("f", MAX_LINKS).map((name) => tie(name, `${name}x`));
    // The tie from "zz" sorts after every filler tie, so it is past the bound.
    const past = walk(
      "t",
      own("zz"),
      [...filler, ...names("g", 1_000).map((name) => tie(name, `${name}x`)), tie("zz", "t")],
      [],
      2,
    );
    expect(past).toEqual({ paths: [], cut: true });
    const within = walk("t", own("zz"), [...filler.slice(1), tie("zz", "t")], [], 2);
    expect(within.paths).toHaveLength(1);
    expect(within.cut).toBe(false);
    const staff = names("s", MAX_LINKS).map((name) => works(name, "o"));
    expect(walk("t", own("zz"), [], [...staff, works("zz", "q"), works("t", "q")], 2)).toEqual({
      paths: [],
      cut: true,
    });
  });

  it("looks at a bounded number of neighbours, so one large organization never makes the walk quadratic, and says so", () => {
    // The target works at an organization of MAX_LINKS people. The one route to the owner runs
    // through its last member, whom a walk over every pair of members would reach only after
    // some twenty-five million steps. The bounded walk stops long before.
    const staff = names("m", MAX_LINKS - 1);
    const last = staff[staff.length - 1] as string;
    const affiliations = [...staff, "t"].map((name) => works(name, "o"));
    expect(walk("t", own("x"), [tie(last, "x")], affiliations, 3)).toEqual({ paths: [], cut: true });
    // In a small organization the same route is found.
    expect(routes(walk("t", own("x"), [tie(last, "x")], [works(last, "o"), works("t", "o")], 3).paths)).toEqual([
      [`ent_OWNER>ent-x:own_tie ent-x>ent-${last}:relationship ent-${last}>ent-t:affiliation`, 1 / 4],
    ]);
  });

  it("the owner is the start and never a hop inside the walk: a tie or an affiliation of the owner's leads nowhere", () => {
    const toOwner = (other: string): Tie => ({ a: OWNER, b: e(other), facts: [fact(`owner-${other}`)] });
    expect(walk("t", own("a"), [toOwner("a"), toOwner("t")], [], 3)).toEqual({ paths: [], cut: false });
    const ownerAt = (organization: string): Affiliation => ({
      person: OWNER,
      organization: e(organization),
      facts: [fact(`owner@${organization}`)],
    });
    expect(walk("t", own("a"), [], [ownerAt("o"), works("a", "o"), ownerAt("p"), works("t", "p")], 3)).toEqual({
      paths: [],
      cut: false,
    });
    // Nor do they use up the bound: 5 000 of the owner's ties, which sort first, leave the walk
    // its 5 000 others and no cut.
    const owners = names("a", MAX_LINKS).map((name) => toOwner(name));
    expect(routes(walk("t", own("zz"), [...owners, tie("zz", "t")], [], 2).paths)).toHaveLength(1);
    expect(walk("t", own("zz"), [...owners, tie("zz", "t")], [], 2).cut).toBe(false);
    // The control: the same people tied to each other.
    expect(routes(walk("t", own("a"), [toOwner("a"), tie("a", "t")], [], 3).paths)).toEqual([
      ["ent_OWNER>ent-a:own_tie ent-a>ent-t:relationship", 1 / 3],
    ]);
  });
});

describe("find_paths: second-degree hops", () => {
  const rules = secondDegreeRules();
  const weighted = (a: string, b: string, via: StatedVia, offer?: "offered" | "suggested"): Tie<TieVia> => ({
    ...tie(a, b, `${a}${b}${via}${offer ?? ""}`),
    via,
    ...(offer === undefined ? {} : { offer }),
    weight: hopWeight(via, rules, offer),
  });
  const rank = (paths: Path<TieVia>[], ownTies: Record<string, number>) =>
    rankPathsByWeakestHop(
      paths,
      new Map(Object.entries(ownTies).map(([name, weight]) => [e(name), weight])),
      e("t"),
      false,
    );

  it("an acquaintance hop weighs 0.5 and a suggested offer 0.5; an offered one 1", () => {
    expect(hopWeight("acquaintance", rules)).toBe(0.5);
    expect(hopWeight("intro_offer", rules, "suggested")).toBe(0.5);
    expect(hopWeight("intro_offer", rules, "offered")).toBe(1);
    expect(hopWeight("connection", rules)).toBe(1);
    expect(hopWeight("relationship", rules)).toBe(1);
    expect(hopWeight("reported", rules)).toBe(0.3);
    expect(hopWeight("researched", rules)).toBe(0.3);
    // Ranked: an own tie of 1 and an acquaintance's hop make a path of 0.5.
    const [path] = rank(walk("t", own("a"), [weighted("a", "t", "acquaintance")], [], 2).paths, { a: 1 });
    expect(path?.score).toBe(0.5);
    expect(path?.hops[1]).toMatchObject({ via: "acquaintance", weight: 0.5 });
  });

  it("a path through a named person ranks by its weakest hop, and an offer's hop carries its offer", () => {
    // a offered to introduce n, a person known by name alone; n's reported tie to t is the weakest.
    const reported = walk(
      "t",
      own("a"),
      [weighted("a", "n", "intro_offer", "offered"), weighted("n", "t", "reported")],
      [],
      3,
    ).paths;
    const suggested = walk("t", own("b"), [weighted("b", "t", "intro_offer", "suggested")], [], 3).paths;
    const ranked = rank([...reported, ...suggested], { a: 1, b: 1 });
    expect(ranked.map((one) => [one.hops[0]?.to, one.score])).toEqual([
      [e("b"), 0.5],
      [e("a"), 0.3],
    ]);
    expect(ranked[1]?.hops.map((hop) => [hop.via, hop.offer])).toEqual([
      ["own_tie", undefined],
      ["intro_offer", "offered"],
      ["reported", undefined],
    ]);
  });

  it("of two ties between one pair the stronger is the hop, citing its own facts", () => {
    const [path] = walk(
      "t",
      own("a"),
      [
        weighted("a", "t", "reported"),
        weighted("a", "t", "intro_offer", "suggested"),
        weighted("a", "t", "connection"),
      ],
      [],
      2,
    ).paths;
    expect(path?.hops[1]).toEqual({
      from: e("a"),
      to: e("t"),
      via: "connection",
      facts: [fact("atconnection")],
      weight: 1,
    });
  });

  it("the rule file's four hops reach a node three people beyond the own tie", () => {
    const ties = [weighted("a", "b", "relationship"), weighted("b", "c", "reported"), weighted("c", "t", "reported")];
    expect(walk("t", own("a"), ties, [], 3).paths).toEqual([]);
    expect(rules.maxHops).toBe(4);
    expect(walk("t", own("a"), ties, [], rules.maxHops).paths[0]?.hops).toHaveLength(4);
  });
});

describe("find_paths: observed hops", () => {
  const rules = secondDegreeRules();
  const SEEN = { count: 1, lastAt: null, ref: null };
  const thread = (a: string, b: string): Tie<TieVia> => ({
    a: e(a),
    b: e(b),
    facts: [],
    via: "shared_thread",
    weight: rules.observedWeight.shared_thread,
    seen: SEEN,
  });
  const domain = (person: string, organization: string): Affiliation => ({
    person: e(person),
    organization: e(organization),
    facts: [],
    via: "same_domain",
    weight: rules.observedWeight.same_domain,
  });
  const input = (ties: Tie<TieVia>[], affiliations: Affiliation[], names: string[]) => ({
    owner: OWNER,
    target: e("t"),
    ownTies: own(...names),
    ties,
    affiliations,
    maxHops: 4,
  });

  it("every observed weight is under the weakest stated one", () => {
    const stated = [rules.reportedWeight, rules.acquaintanceWeight, ...Object.values(rules.introOfferWeight)];
    for (const weight of Object.values(rules.observedWeight)) expect(weight).toBeLessThan(Math.min(...stated));
  });

  it("a thread and a domain chain into one route, each hop marked", () => {
    const { paths } = findPathsWithObserved(input([], [], ["a"]), {
      ties: [thread("a", "b")],
      domains: [domain("b", "acme"), domain("t", "acme")],
    });
    expect(paths[0]?.hops.map((hop) => hop.via)).toEqual(["own_tie", "shared_thread", "same_domain"]);
    expect(paths[0]?.hops[2]).toMatchObject({ weight: rules.observedWeight.same_domain, seen: { count: 0 } });
  });

  it("someone reaches an organization that is the target by its domain, the hop's weight counted", () => {
    const { paths } = findPathsWithObserved(input([], [], ["a"]), { ties: [], domains: [domain("a", "t")] });
    expect(paths[0]?.hops.map((hop) => hop.via)).toEqual(["own_tie", "same_domain"]);
    const [ranked] = rankPathsByWeakestHop(paths, new Map([[e("a"), 0.9]]), e("t"), true);
    expect(ranked?.score).toBe(rules.observedWeight.same_domain);
  });

  it("between the same two, a stated tie and a stated shared organization stand over an observed hop", () => {
    const stated = findPathsWithObserved(input([tie("a", "t")], [], ["a"]), {
      ties: [thread("a", "t")],
      domains: [domain("a", "acme"), domain("t", "acme")],
    });
    expect(stated.paths.map((path) => path.hops[1]?.via)).toEqual(["relationship"]);
    expect(stated.paths[0]?.hops[1]?.seen).toBeUndefined();
    const shared = findPathsWithObserved(input([], [works("a", "acme"), works("t", "acme")], ["a"]), {
      ties: [thread("a", "t")],
      domains: [domain("a", "acme"), domain("t", "acme")],
    });
    expect(shared.paths.map((path) => path.hops[1]?.via)).toEqual(["affiliation"]);
    expect(shared.paths[0]?.hops[1]?.facts).toHaveLength(2);
  });

  it("a thread stands over a domain between the same two, and a domain with one stated side stays observed", () => {
    const both = findPathsWithObserved(input([], [], ["a"]), {
      ties: [thread("a", "t")],
      domains: [domain("a", "acme"), domain("t", "acme")],
    });
    expect(both.paths[0]?.hops[1]?.via).toBe("shared_thread");
    const half = findPathsWithObserved(input([], [works("a", "acme")], ["a"]), {
      ties: [],
      domains: [domain("t", "acme")],
    });
    expect(half.paths[0]?.hops[1]).toMatchObject({ via: "same_domain", facts: [fact("a@acme")] });
  });

  it("a stated path ranks before an observed one, even when its own tie is weaker", () => {
    const { paths } = findPathsWithObserved(input([tie("weak", "t")], [], ["weak", "warm"]), {
      ties: [thread("warm", "t")],
      domains: [],
    });
    const strength = new Map([
      [e("weak"), OWN_TIE_FLOOR],
      [e("warm"), 1],
    ]);
    const ranked = rankPathsByWeakestHop(paths, strength, e("t"), false);
    expect(ranked.map((path) => path.hops[0]?.to)).toEqual([e("weak"), e("warm")]);
    expect(ranked.map((path) => path.score)).toEqual([OWN_TIE_FLOOR, rules.observedWeight.shared_thread]);
  });

  it("what it weighs: a close person with a stated place at the target organization comes first, a colleague next, a shared list last", () => {
    const close = "close";
    const colleague = "colleague";
    const list = "list";
    const route = (start: string, hop: PathHop<TieVia>): Path<TieVia> => ({
      score: 0,
      hops: [{ from: OWNER, to: e(start), via: "own_tie", facts: [] }, hop],
    });
    const atTarget = (start: string): PathHop<TieVia> => ({
      from: e(start),
      to: e("firm"),
      via: "affiliation",
      facts: [fact("stated")],
    });
    const onAList: PathHop<TieVia> = {
      from: e(list),
      to: e("firm"),
      via: "shared_thread",
      facts: [],
      weight: 0.2,
      seen: { count: 3, lastAt: null, ref: null },
    };
    const weights = secondDegreeRules();
    expect(weights.maxHops).toBeGreaterThan(1);
    const ranked = rankPathsByWeakestHop(
      // The list's own tie is the strongest of the three: it still comes last.
      [route(list, onAList), route(colleague, atTarget(colleague)), route(close, atTarget(close))],
      new Map([
        [e(close), 1],
        [e(colleague), 0.6],
        [e(list), 1],
      ]),
      e("firm"),
      true,
    );
    expect(ranked.map((path) => [path.hops[0]?.to, path.score])).toEqual([
      [e(close), 1],
      [e(colleague), 0.6],
      [e(list), 0.2],
    ]);
  });

  describe("different routes, not one route twenty ways", () => {
    const via = (...people: string[]): Path<TieVia> => ({
      score: 0,
      hops: [
        { from: OWNER, to: e(people[0] as string), via: "own_tie", facts: [] },
        ...people.slice(1).map((one, index) => ({
          from: e(people[index] as string),
          to: e(one),
          via: "relationship" as const,
          facts: [],
        })),
      ],
    });
    const seen = (path: Path<TieVia>, ref: string): Path<TieVia> => ({
      ...path,
      hops: path.hops.map((hop, index) =>
        index === 1
          ? { ...hop, via: "shared_thread" as const, seen: { count: 1, lastAt: null, ref: ref as MessageId } }
          : hop,
      ),
    });

    it("keeps at most so many through one person, the best of them, and lets the others through", () => {
      const through = ["a", "b", "c", "d", "f"].map((start) => via(start, "hub", "t"));
      const others = ["x", "y"].map((start) => via(start, "t"));
      const kept = distinctRoutes([...through, ...others], e("t"));
      expect(kept.map((path) => path.hops[0]?.to)).toEqual([e("a"), e("b"), e("c"), e("x"), e("y")]);
    });

    it("counts one own tie as one person too", () => {
      const kept = distinctRoutes(
        ["p", "q", "r", "s"].map((mid) => via("start", mid, "t")),
        e("t"),
      );
      expect(kept).toHaveLength(3);
    });

    it("counts paths resting on one message together, whoever they pass", () => {
      const kept = distinctRoutes(
        ["a", "b", "c", "d"].map((start) => seen(via(start, `${start}${start}`, "t"), "msg_same")),
        e("t"),
      );
      expect(kept).toHaveLength(3);
    });

    it("the target is no intermediary: many people at it all stand", () => {
      const kept = distinctRoutes(
        ["a", "b", "c", "d", "f"].map((start) => via(start, "t")),
        e("t"),
      );
      expect(kept).toHaveLength(5);
    });
  });

  it("observed hops cannot crowd out or spend the steps of a stated route", () => {
    const crowd = names("n", MAX_PATHS * 3);
    const ties = crowd.map((one) => thread(one, "t"));
    const stated = findPathsWithObserved(input([tie("z-stated", "t")], [], ["z-stated", ...crowd]), {
      ties,
      domains: [],
    });
    expect(stated.paths).toHaveLength(MAX_PATHS);
    expect(stated.cut).toBe(true);
    expect(stated.paths[0]?.hops[0]?.to).toBe(e("z-stated"));

    const hub = names("m", MAX_STEPS + 1).map((one) => domain(one, "big"));
    const spent = findPathsWithObserved(input([tie("z-stated", "t")], [], ["z-stated"]), {
      ties: [],
      domains: [domain("t", "big"), ...hub.slice(0, MAX_LINKS - 1)],
    });
    expect(spent.paths[0]?.hops[0]?.to).toBe(e("z-stated"));
  });
});
