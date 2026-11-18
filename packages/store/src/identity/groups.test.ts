import { describe, expect, it } from "vitest";
import {
  conflict,
  eligible,
  exceptionOf,
  groupOf,
  groupsOf,
  type IdentityRuling,
  namesakesRuled,
  pathBetween,
  settles,
} from "./groups.ts";

// n3.7: the one computation of who rulings join. Fingerprints here are plain letters; the function
// never reads one.

let serial = 0;
const ruling = (
  verdict: IdentityRuling["verdict"],
  aFp: string,
  bFp: string | null = null,
  liftedAt: string | null = null,
): IdentityRuling => {
  serial += 1;
  return { id: `rul_${serial}`, verdict, aFp, bFp, liftedAt };
};

describe("groupsOf", () => {
  it("three addresses joined two by two are one group", () => {
    const rulings = [ruling("same", "a", "b"), ruling("same", "b", "c")];
    const groups = groupsOf(rulings, []);
    expect([...groupOf(groups, "a")].sort()).toEqual(["a", "b", "c"]);
    expect(groupOf(groups, "c")).toEqual(groupOf(groups, "a"));
    expect([...groupOf(groups, "d")]).toEqual(["d"]);
  });

  it("a lifted ruling, a different, a shared and a single ruling join nothing", () => {
    const groups = groupsOf(
      [
        ruling("same", "a", "b", "2026-09-01T00:00:00Z"),
        ruling("different", "a", "c"),
        ruling("shared", "a"),
        ruling("single", "b"),
      ],
      [],
    );
    for (const fp of ["a", "b", "c"]) expect([...groupOf(groups, fp)]).toEqual([fp]);
  });

  it("an owner fingerprint joins nothing", () => {
    const groups = groupsOf([ruling("same", "a", "owner"), ruling("same", "owner", "c")], ["owner"]);
    expect([...groupOf(groups, "a")]).toEqual(["a"]);
    expect([...groupOf(groups, "c")]).toEqual(["c"]);
  });

  it("is the same for any order of the rulings", () => {
    const rulings = [ruling("same", "a", "b"), ruling("same", "c", "d"), ruling("same", "b", "c")];
    const one = groupsOf(rulings, []);
    const other = groupsOf([...rulings].reverse(), []);
    expect([...groupOf(one, "d")].sort()).toEqual([...groupOf(other, "a")].sort());
  });
});

describe("settles and conflict", () => {
  it("settles names the rulings that join a pair", () => {
    const ab = ruling("same", "a", "b");
    const bc = ruling("same", "b", "c");
    const rulings = [ab, bc, ruling("same", "x", "y")];
    const groups = groupsOf(rulings, []);
    expect(settles(groups, rulings, "a", "c")).toEqual({ by: "same", rulings: [ab.id, bc.id].sort() });
    expect(settles(groups, rulings, "a", "x")).toEqual({ by: "open" });
  });

  it("settles a different pair, through a third address too", () => {
    const differ = ruling("different", "a", "d");
    const rulings = [ruling("same", "c", "d"), differ];
    const groups = groupsOf(rulings, []);
    expect(settles(groups, rulings, "a", "c")).toEqual({ by: "different", rulings: [differ.id] });
    expect(
      settles(groups, [...rulings.slice(0, 1), { ...differ, liftedAt: "2026-09-01T00:00:00Z" }], "a", "c"),
    ).toEqual({ by: "open" });
  });

  it("a same across a different is a conflict, through a third address too", () => {
    const rulings = [ruling("different", "a", "c"), ruling("same", "b", "c")];
    const groups = groupsOf(rulings, []);
    expect(conflict(groups, rulings, "a", "b", "same")).toBe(true);
    expect(conflict(groups, rulings, "a", "c", "same")).toBe(true);
    expect(conflict(groups, rulings, "a", "d", "same")).toBe(false);
  });

  it("a different inside a group is a conflict", () => {
    const rulings = [ruling("same", "a", "b"), ruling("same", "b", "c")];
    const groups = groupsOf(rulings, []);
    expect(conflict(groups, rulings, "a", "c", "different")).toBe(true);
    expect(conflict(groups, rulings, "a", "d", "different")).toBe(false);
  });
});

describe("pathBetween", () => {
  it("names the rulings between two addresses and no other ruling of the group", () => {
    const [ab, bc, cd] = [ruling("same", "a", "b"), ruling("same", "c", "b"), ruling("same", "c", "d")];
    const rulings = [ab, bc, cd, ruling("different", "a", "x"), ruling("same", "b", "e", "2026-09-01T00:00:00Z")];
    const groups = groupsOf(rulings, []);
    expect(pathBetween(groups, rulings, "a", "b")).toEqual([ab.id]);
    expect(pathBetween(groups, rulings, "d", "a")).toEqual([cd.id, bc.id, ab.id]);
    expect(pathBetween(groups, rulings, "a", "e")).toBeUndefined();
    expect(pathBetween(groups, rulings, "a", "a")).toEqual([]);
  });

  it("a ruling naming an owner fingerprint is no step", () => {
    const rulings = [ruling("same", "a", "me"), ruling("same", "me", "b")];
    expect(pathBetween(groupsOf(rulings, ["me"]), rulings, "a", "b")).toBeUndefined();
  });
});

describe("eligible", () => {
  it("eligible is false for the owner, a shared address and a settled pair, through a third person too, and true otherwise", () => {
    const rulings = [
      ruling("shared", "s"),
      ruling("same", "a", "b"),
      ruling("different", "c", "d"),
      ruling("same", "d", "e"),
    ];
    const groups = groupsOf(rulings, ["owner"]);
    expect(eligible(groups, rulings, "owner", "x")).toBe(false);
    expect(eligible(groups, rulings, "x", "s")).toBe(false);
    expect(eligible(groups, rulings, "a", "b")).toBe(false);
    expect(eligible(groups, rulings, "c", "e")).toBe(false);
    expect(eligible(groups, rulings, "a", "a")).toBe(false);
    expect(eligible(groups, rulings, "a", "x")).toBe(true);
    expect(eligible(groups, rulings, "a", "c")).toBe(true);
    // A lifted shared mark no longer bars the address.
    const lifted = rulings.map((one) =>
      one.verdict === "shared" ? { ...one, liftedAt: "2026-09-01T00:00:00Z" } : one,
    );
    expect(eligible(groupsOf(lifted, ["owner"]), lifted, "x", "s")).toBe(true);
  });
});

// The exceptions that card a pair the standing rule would merge.
describe("exceptionOf", () => {
  const of = (
    rulings: IdentityRuling[],
    basis: "contact" | "name" | "local_part",
    namesakes = false,
    established = true,
  ) => exceptionOf(groupsOf(rulings, []), rulings, "a", "b", basis, namesakes, established);

  it("a pair no exception holds merges, on every basis", () => {
    for (const basis of ["contact", "name", "local_part"] as const) expect(of([], basis)).toBeUndefined();
  });

  it("invariant 11: a different ruling naming anyone joined to either person stands, though it names neither of the pair", () => {
    expect(of([ruling("same", "b", "c"), ruling("different", "c", "z")], "contact")).toBe("ruled_different");
    expect(of([ruling("different", "a", "z", "2026-10-01T00:00:00Z")], "contact")).toBeUndefined();
  });

  it("invariant 11: a lifted same, the owner's or the policy's, cards the pair", () => {
    expect(of([ruling("same", "a", "b", "2026-10-01T00:00:00Z")], "contact")).toBe("lifted_before");
  });

  it("a name known to be two people's is the name basis's exception alone; an unestablished person is the name and local part bases'", () => {
    expect(of([], "name", true)).toBe("common_name");
    expect(of([], "local_part", true)).toBeUndefined();
    expect(of([], "name", false, false)).toBe("unestablished");
    expect(of([], "local_part", false, false)).toBe("unestablished");
    expect(of([], "contact", true, false)).toBeUndefined();
  });
});

// A name many records carry is one person's unless the owner's different, or a same the owner
// lifted, sets two of its holders apart.
describe("namesakesRuled", () => {
  const holders = [["x1", "x2"], ["y1"], ["z1"]];

  it("records alone, however many, are not namesakes", () => {
    expect(namesakesRuled([], holders)).toBe(false);
    expect(namesakesRuled([ruling("same", "x1", "y1")], holders)).toBe(false);
  });

  it("a different in force, or a lifted same, between two holders' addresses makes them namesakes", () => {
    expect(namesakesRuled([ruling("different", "x2", "z1")], holders)).toBe(true);
    expect(namesakesRuled([ruling("same", "y1", "z1", "2026-10-01T00:00:00Z")], holders)).toBe(true);
  });

  it("a lifted different, a ruling within one holder, or one naming a non-holder sets no one apart", () => {
    expect(namesakesRuled([ruling("different", "x1", "z1", "2026-10-01T00:00:00Z")], holders)).toBe(false);
    expect(namesakesRuled([ruling("different", "x1", "x2")], holders)).toBe(false);
    expect(namesakesRuled([ruling("different", "x1", "q9")], holders)).toBe(false);
  });
});
