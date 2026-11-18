import type { Belief } from "@intelligence/contracts";
import type { BeliefRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  blocking,
  compareBeliefs,
  noMismatches,
  type ShadowMismatch,
  type ShadowPass,
  type StoredBelief,
  switchHolds,
} from "./shadow.ts";

// The shadow comparison by code, and the switch's seven days.

const belief = (more: Partial<Belief> = {}): Belief =>
  ({
    kind: "role",
    factKey: "k",
    supportHash: "0".repeat(64),
    subject: "ent_0000000000000000000000NORA",
    type: "role",
    values: { title: "Head of Finance", organization: "ent_000000000000000000000ALDER" },
    label: { compartments: ["own"], readers: ["m-owner"] },
    status: "active",
    disputed: false,
    confidence: 1,
    lastConfirmedAt: "2026-06-01T00:00:00.000Z",
    changeKind: "live",
    support: ["claim-1", "claim-2"],
    ...more,
  }) as Belief;
const stored = (factKeyFp: string, more: Partial<Belief> = {}, tier = "source"): StoredBelief => ({
  factKeyFp,
  belief: belief(more),
  tier,
});
const computed = (factKeyFp: string, more: Partial<Belief> = {}, tier?: BeliefRecord["tier"]): BeliefRecord =>
  ({
    belief: belief(more),
    factKeyFp,
    compartments: ["own"],
    provenance: "source",
    ...(tier === undefined ? {} : { tier }),
  }) as BeliefRecord;

describe("compareBeliefs", () => {
  it("equal rows differ in nothing; a computed row with no tier is `source`, as the store writes it", () => {
    expect(compareBeliefs([stored("a"), stored("b")], [computed("a"), computed("b", {}, "source")])).toEqual({
      ...noMismatches(),
      compared: 2,
    });
  });

  it("counts each code once for each row that differs on it, values in any key order", () => {
    const counts = compareBeliefs(
      [stored("a"), stored("b"), stored("c"), stored("d"), stored("e", { values: { organization: "x", title: "y" } })],
      [
        computed("a", { values: { title: "Chief of Staff", organization: "ent_000000000000000000000ALDER" } }),
        computed("b", { status: "stale" }),
        computed("c", {}, "owner"),
        computed("d", { disputed: true, support: ["claim-2", "claim-1", "claim-3"] as Belief["support"] }),
        computed("e", { values: { title: "y", organization: "x" } }),
      ],
    );
    expect(counts).toEqual({ compared: 5, value: 1, status: 1, tier: 1, disputed: 1, support: 1 });
    expect(blocking(counts)).toBe(4);
  });

  it("a row on one side alone differs in value; support alone does not block", () => {
    expect(compareBeliefs([stored("a")], [computed("b")])).toEqual({ ...noMismatches(), compared: 2, value: 2 });
    const support = compareBeliefs([stored("a")], [computed("a", { support: ["claim-1"] as Belief["support"] })]);
    expect(support).toEqual({ ...noMismatches(), compared: 1, support: 1 });
    expect(blocking(support)).toBe(0);
  });

  it("names each row that blocks, by fact key and its first code, for the log; support alone is not named", () => {
    const named: ShadowMismatch[] = [];
    compareBeliefs(
      [stored("a"), stored("b"), stored("c")],
      [computed("b", { status: "stale" }), computed("c", { support: ["claim-1"] as Belief["support"] }), computed("d")],
      named,
    );
    expect(named).toEqual([
      { factKeyFp: "a", code: "stored_only" },
      { factKeyFp: "b", code: "status" },
      { factKeyFp: "d", code: "computed_only" },
    ]);
  });
});

describe("switchHolds", () => {
  const NOW = new Date("2026-11-10T12:00:00.000Z");
  const day = (n: number, more: Partial<ShadowPass["counts"]> = {}): ShadowPass => ({
    passedAt: new Date(Date.parse("2026-11-10T06:00:00.000Z") - n * 86_400_000).toISOString(),
    counts: { ...noMismatches(), compared: 3, ...more },
  });

  it("holds once seven days have passed since the first pass with no blocking mismatch, support differences allowed", () => {
    expect(
      switchHolds(
        [7, 6, 5, 4, 3, 2, 1, 0].map((n) => day(n, n === 3 ? { support: 2 } : {})),
        NOW,
      ),
    ).toEqual({ holds: true, days: 7 });
  });

  it("a quiet day is no evidence against: days with no reads or no comparison do not end the run, if four days compared rows", () => {
    expect(
      switchHolds(
        [7, 5, 3, 1].map((n) => day(n)),
        NOW,
      ),
    ).toEqual({ holds: true, days: 7 });
    expect(
      switchHolds(
        [7, 6, 5, 4, 3].map((n) => day(n, n === 6 ? { compared: 0 } : {})),
        NOW,
      ),
    ).toEqual({ holds: true, days: 7 });
  });

  it("needs rows compared on at least four distinct days", () => {
    expect(
      switchHolds(
        [7, 1, 0].map((n) => day(n)),
        NOW,
      ),
    ).toEqual({ holds: false, days: 7 });
    expect(
      switchHolds(
        [7, 6, 5, 4].map((n) => day(n, { compared: 0 })),
        NOW,
      ),
    ).toEqual({ holds: false, days: 7 });
  });

  it("a blocking mismatch starts the seven days again from that pass", () => {
    expect(
      switchHolds(
        [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => day(n, n === 2 ? { status: 1 } : {})),
        NOW,
      ),
    ).toEqual({ holds: false, days: 2 });
    expect(
      switchHolds(
        [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => day(n, n === 9 ? { value: 1 } : {})),
        NOW,
      ),
    ).toEqual({ holds: true, days: 9 });
  });

  it("not before seven days, and never with no pass", () => {
    expect(
      switchHolds(
        [5, 4, 3, 2, 1, 0].map((n) => day(n)),
        NOW,
      ),
    ).toEqual({ holds: false, days: 5 });
    expect(switchHolds([], NOW)).toEqual({ holds: false, days: 0 });
  });
});
