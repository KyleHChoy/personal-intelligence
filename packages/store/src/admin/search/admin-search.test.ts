import type { Who } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { normalized } from "../../read/read-search.ts";
import { type Line, matching, matchOf, ranked } from "./admin-search.ts";

// Synthetic names and reserved domains only.

let serial = 0;
const person = (name: string, addresses: string[] = []) => {
  serial += 1;
  const who: Who = {
    id: `ent_01J9Z${String(serial).padStart(21, "0")}` as Who["id"],
    kind: "person",
    name: { untrusted: name },
    address: null,
  };
  return { who, names: [normalized(name)], addresses, domains: [] as string[] };
};
const ids = (term: string, entries: ReturnType<typeof person>[], lines: Map<string, Line> = new Map()): string[] =>
  ranked(matching(normalized(term), entries), lines).map((one) => one.who.id);

describe("owner search ranking (R-P5)", () => {
  it("a name word equal to the term comes before a surname that starts with it, whatever the warmth", () => {
    const wade = person("Wade Jonsen");
    const jon = person("Jon Avery");
    const lines = new Map<string, Line>([[wade.who.id, { tier: "inner", last: Date.parse("2026-10-28"), warmth: 9 }]]);
    expect(ids("jon", [wade, jon], lines)).toEqual([jon.who.id, wade.who.id]);
  });

  it("a full name that starts with the term comes before a surname that starts with it", () => {
    const wade = person("Wade Jonsen");
    const jonathan = person("Jonathan Ruiz");
    const lines = new Map<string, Line>([[wade.who.id, { tier: "inner", last: Date.parse("2026-10-28"), warmth: 9 }]]);
    expect(ids("jon", [wade, jonathan], lines)).toEqual([jonathan.who.id, wade.who.id]);
    expect(matchOf("jon", jonathan)?.rank).toBe(1);
    expect(matchOf("jon", wade)?.rank).toBe(2);
  });

  it("a name stored surname first still ranks its surname as a surname", () => {
    const wade = person("Jonsen, Wade");
    const jonathan = person("Jonathan Ruiz");
    const lines = new Map<string, Line>([[wade.who.id, { tier: "inner", last: Date.parse("2026-10-28"), warmth: 9 }]]);
    expect(matchOf("jon", wade)?.rank).toBe(2);
    expect(ids("jon", [wade, jonathan], lines)).toEqual([jonathan.who.id, wade.who.id]);
    // A prefix of a first or a last name comes before the term inside a word elsewhere.
    expect(ids("jon", [person("Ben Ajonte"), wade])).toEqual([wade.who.id, expect.any(String)]);
    expect(matchOf("wade", wade)?.rank).toBe(0);
    // The name as stored still matches whole; an organization's comma is no surname.
    expect(matchOf("jonsen, wade", wade)?.rank).toBe(0);
    const acme = { ...person("Acme, Inc."), who: { ...person("x").who, kind: "organization" as const } };
    expect(matchOf("acm", acme)?.rank).toBe(1);
  });

  it("a name, then a substring, then an address, then a domain", () => {
    const named = person("Ana Jonsdottir");
    const inside = person("Ben Ajonte");
    const address = person("Cleo Park", ["jon.mail@example.test"]);
    const domain = { ...person("Example Org"), domains: ["jonco.example"] };
    domain.who = { ...domain.who, kind: "organization" };
    expect(ids("jon", [domain, address, inside, named])).toEqual([
      named.who.id,
      inside.who.id,
      address.who.id,
      domain.who.id,
    ]);
    expect(ranked(matching("jon", [address, domain]), new Map()).map((one) => one.match)).toEqual([
      "address",
      "domain",
    ]);
  });

  it("a term of several words matches a run of words, and a whole name first", () => {
    const whole = person("Jon Avery");
    const longer = person("Jon Avery Smith");
    expect(matchOf("jon avery", whole)?.rank).toBe(0);
    expect(matchOf("avery smith", longer)?.rank).toBe(0);
    expect(matchOf("jon av", longer)?.rank).toBe(1);
    expect(matchOf("avery sm", longer)?.rank).toBe(2);
  });

  it("within a tier: the better warmth tier, then the most recent contact, then the warmer", () => {
    const [a, b, c, d] = [person("Jon Alpha"), person("Jon Beta"), person("Jon Gamma"), person("Jon Delta")];
    const lines = new Map<string, Line>([
      [a.who.id, { tier: "regular", last: Date.parse("2026-10-28"), warmth: 1 }],
      [b.who.id, { tier: "close", last: Date.parse("2026-01-01"), warmth: 1 }],
      [c.who.id, { tier: "close", last: Date.parse("2026-10-01"), warmth: 1 }],
    ]);
    // d has no warmth row: last.
    expect(ids("jon", [d, a, b, c], lines)).toEqual([c.who.id, b.who.id, a.who.id, d.who.id]);
  });

  it("no match is no hit", () => {
    expect(ids("zed", [person("Jon Avery")])).toEqual([]);
  });
});
