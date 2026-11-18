import type { Claim } from "@intelligence/contracts";
import type { BeliefClaim, FactGrouping, FactRuling, GroupingMode } from "@intelligence/contracts/personal";
import { FACT_GROUP_MAX } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { canonicalClaim, groupOf, joinedSets } from "./fact-groups.ts";

// The joined sets of one audience and the canonical claim, pure. Made-up fingerprints only.

const fp = (char: string): string => char.repeat(64);
const [A, B, C, D, E, F, G] = ["a", "b", "c", "d", "e", "f", "0"].map(fp) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const AT = "2026-06-01T10:00:00.000Z";
const sorted = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
const ruling = (verdict: FactRuling["verdict"], x: string, y: string, compartments = ["own"]): FactRuling => {
  const [a, b] = sorted(x, y);
  return { id: `rul_${verdict}${a.slice(0, 2)}${b.slice(0, 2)}`, verdict, a, b, at: AT, compartments };
};
const grouping = (
  x: string,
  y: string,
  state: FactGrouping["state"] = "accepted",
  audience = ["own"],
): FactGrouping => ({ audience, keys: sorted(x, y), band: "accept", rung: 1, state, calls: [] });
const own = (compartments: readonly string[]): boolean => compartments.every((one) => one === "own");
const sets = (
  present: string[],
  rulings: FactRuling[],
  groupings: FactGrouping[] = [],
  mode: GroupingMode = "shadow",
  covers = own,
) => joinedSets(present, rulings, groupings, mode, covers);

describe("joinedSets", () => {
  it("the owner's joins connect their keys transitively, each set sorted", () => {
    expect(sets([A, B, C, D], [ruling("join", B, A), ruling("join", C, B)])).toEqual({ sets: [[A, B, C]], refused: 0 });
  });

  it("a key with no claim for the audience is no member, but still connects the keys joined through it", () => {
    expect(sets([A, C], [ruling("join", A, B), ruling("join", B, C)])).toEqual({ sets: [[A, C]], refused: 0 });
    // A join of a present key with an absent one alone joins nothing.
    expect(sets([A], [ruling("join", A, B)])).toEqual({ sets: [], refused: 0 });
  });

  it("a join the audience cannot read joins nothing for it", () => {
    expect(sets([A, B], [ruling("join", A, B, ["employer:example", "own"])])).toEqual({ sets: [], refused: 0 });
  });

  it("a split binds every audience, even one that cannot read its label", () => {
    // B also has a claim under the employer's compartment, so the split is labelled with both;
    // the audience that holds `own` alone still never joins the pair, by a grouping row or by
    // the owner's own joins through another key.
    const split = ruling("split", A, B, ["employer:example", "own"]);
    expect(sets([A, B], [split], [grouping(A, B)], "apply")).toEqual({ sets: [], refused: 0 });
    expect(sets([A, B], [split], [{ ...grouping(A, B), rung: 0 }], "shadow")).toEqual({ sets: [], refused: 0 });
    expect(sets([A, B, C], [ruling("join", A, C), ruling("join", C, B), split])).toEqual({ sets: [], refused: 1 });
    expect(sets([A, B, C], [ruling("join", A, C), split], [grouping(B, C)], "apply")).toEqual({
      sets: [[A, C]],
      refused: 0,
    });
  });

  it("joins that bring a pair the owner split together are not joined, and counted", () => {
    expect(sets([A, B, C], [ruling("join", A, B), ruling("join", B, C), ruling("split", A, C)])).toEqual({
      sets: [],
      refused: 1,
    });
  });

  it(`a set of more than ${FACT_GROUP_MAX} keys is not joined, and counted`, () => {
    const keys = [A, B, C, D, E, F];
    const joins = keys.slice(1).map((key) => ruling("join", A, key));
    expect(sets(keys, joins)).toEqual({ sets: [], refused: 1 });
    expect(sets(keys.slice(0, FACT_GROUP_MAX), joins)).toEqual({
      sets: [keys.slice(0, FACT_GROUP_MAX).sort()],
      refused: 0,
    });
  });

  it("an accepted grouping joins only in apply mode", () => {
    expect(sets([A, B], [], [grouping(A, B)], "shadow")).toEqual({ sets: [], refused: 0 });
    expect(sets([A, B], [], [grouping(A, B)], "off")).toEqual({ sets: [], refused: 0 });
    expect(sets([A, B], [], [grouping(A, B)], "apply")).toEqual({ sets: [[A, B]], refused: 0 });
    // Only an accepted row, and only one the audience may read.
    for (const state of ["proposed", "rejected", "joined", "split"] as const)
      expect(sets([A, B], [], [grouping(A, B, state)], "apply").sets).toEqual([]);
    expect(sets([A, B], [], [grouping(A, B, "accepted", ["employer:example"])], "apply").sets).toEqual([]);
  });

  it("an equal-phrase row code accepted at rung 0 joins in every mode, unless split", () => {
    const equal: FactGrouping = { ...grouping(A, B), rung: 0 };
    for (const mode of ["off", "shadow", "apply"] as const)
      expect(sets([A, B], [], [equal], mode)).toEqual({ sets: [[A, B]], refused: 0 });
    expect(sets([A, B], [ruling("split", A, B)], [equal], "shadow")).toEqual({ sets: [], refused: 0 });
  });

  it("invariant 11: a split holds against an accepted grouping, directly and through another key", () => {
    expect(sets([A, B], [ruling("split", A, B)], [grouping(A, B)], "apply")).toEqual({ sets: [], refused: 0 });
    // A grouping of B and C may join, but not one that would bring A and C together.
    expect(sets([A, B, C], [ruling("join", A, B), ruling("split", A, C)], [grouping(B, C)], "apply")).toEqual({
      sets: [[A, B]],
      refused: 0,
    });
  });

  it("invariant 11: a join holds against a rejected grouping row, whatever its band", () => {
    expect(sets([A, B], [ruling("join", A, B)], [{ ...grouping(A, B, "rejected"), band: "reject" }], "apply")).toEqual({
      sets: [[A, B]],
      refused: 0,
    });
  });

  it("a grouping never makes a set of the owner's larger than the cut, nor joins a refused set", () => {
    const joins = [B, C, D, E].map((key) => ruling("join", A, key));
    expect(sets([A, B, C, D, E, F], joins, [grouping(E, F)], "apply")).toEqual({ sets: [[A, B, C, D, E]], refused: 0 });
    const refused = [ruling("join", A, B), ruling("join", B, C), ruling("split", A, C)];
    expect(sets([A, B, C, G], refused, [grouping(C, G)], "apply")).toEqual({ sets: [], refused: 1 });
  });

  it("groupOf is the same for one set in any order, and differs for another", () => {
    expect(groupOf([B, A])).toBe(groupOf([A, B]));
    expect(groupOf([A, B])).toMatch(/^[0-9a-f]{64}$/);
    expect(groupOf([A, C])).not.toBe(groupOf([A, B]));
  });
});

describe("canonicalClaim", () => {
  const claim = (id: string, validFrom: string, extra: Partial<BeliefClaim> = {}): BeliefClaim => ({
    claim: { id, validFrom, basis: "explicit_self", pipelineVersion: "1" } as unknown as Claim,
    origin: "source",
    subjectKind: "owner",
    ...extra,
  });
  const older = "2026-05-01T10:00:00.000Z";
  const newer = "2026-05-02T10:00:00.000Z";

  it("the highest tier first, however old", () => {
    expect(canonicalClaim([claim("source-new", newer), claim("owner-old", older, { ownerSaid: true })])).toBe(
      "owner-old",
    );
    expect(canonicalClaim([claim("source-new", newer), claim("confirmed-old", older, { ownerConfirmed: true })])).toBe(
      "confirmed-old",
    );
    expect(
      canonicalClaim([
        claim("confirmed-new", newer, { ownerConfirmed: true }),
        claim("owner-old", older, { ownerSaid: true }),
      ]),
    ).toBe("owner-old");
  });

  it("then the newest, then the lowest id; none for no claim", () => {
    expect(canonicalClaim([claim("old", older), claim("new", newer)])).toBe("new");
    expect(canonicalClaim([claim("z", newer), claim("m", newer)])).toBe("m");
    expect(canonicalClaim([])).toBeUndefined();
  });
});
