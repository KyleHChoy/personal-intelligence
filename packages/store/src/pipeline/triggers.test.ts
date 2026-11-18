import type { BeliefRecord } from "@intelligence/contracts/personal";
import type { BeliefInputs } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import type { Keys } from "../core/keys.ts";
import { labelKey } from "../core/labels.ts";
import { labelsWithin, raiseForChange, raiseOf, stateOf } from "./triggers.ts";

// The trigger diff's pure parts.

const row = (over: { changeKind?: string; provenance?: BeliefRecord["provenance"] } = {}): BeliefRecord =>
  ({
    factKeyFp: "f".repeat(64),
    compartments: ["own"],
    provenance: over.provenance ?? "source",
    belief: { changeKind: over.changeKind ?? "live" },
  }) as unknown as BeliefRecord;

describe("the clearance keys", () => {
  it("a clearance's key is policy.label_key's: each compartment once, sorted bytewise, joined by a bar", () => {
    expect(labelKey(["own", "employer:example", "own"])).toBe("employer:example|own");
    expect(labelKey(["own"])).toBe("own");
  });

  it("the labels in use within a clearance, and its own key, with no cap: a clearance of fourteen works", () => {
    const inUse = ["own", "employer:example", "employer:example|own", "agent:alpha", "", "agent:alpha|own"];
    expect(labelsWithin(inUse, ["own", "employer:example"]).sort()).toEqual([
      "employer:example",
      "employer:example|own",
      "own",
    ]);
    const wide = ["own", ...Array.from({ length: 13 }, (_, n) => `agent:a${String(n).padStart(2, "0")}`)];
    expect(labelsWithin(["own", "agent:a00|own"], wide)).toEqual(["own", "agent:a00|own", labelKey(wide)]);
  });
});

describe("whether a change raises", () => {
  it("a live change raises; a backfill one, one decided by a backfill claim, and a fact no longer built do not", () => {
    expect(raiseOf(row(), "claim")).toBe("changed");
    expect(raiseOf(row(), "ruling")).toBe("changed");
    expect(raiseOf(row(), "backfill")).toBe("none");
    expect(raiseOf(row({ changeKind: "backfill" }), "claim")).toBe("none");
    expect(raiseOf(undefined, "claim")).toBe("none");
  });

  it("a backfill change raises nothing whatever the provenance; a re-derived one raises only on the owner's word", () => {
    expect(raiseOf(row({ changeKind: "backfill", provenance: "owner" }), "claim")).toBe("none");
    expect(raiseOf(row({ provenance: "owner" }), "backfill")).toBe("none");
    expect(raiseOf(row({ changeKind: "reprocess", provenance: "agent_reported" }), "claim")).toBe("changed");
    expect(raiseOf(row({ changeKind: "reprocess" }), "claim")).toBe("none");
  });
});

describe("what a change raises", () => {
  const keys: Keys = { compartments: new Map(), fingerprintKey: Buffer.alloc(32, 7) };
  const inputs: BeliefInputs = { groups: [], decisions: [], retirements: [], reclassifications: [], goAt: null };
  type Change = Parameters<typeof raiseForChange>[4][number];
  const change = (over: Partial<Change> = {}): Change => ({
    ...{ id: "r1", fact_key_fp: "f", clearance_key: null, cause: "claim", exact: false, failures: 0 },
    ...{ added_claims: [], removed_claims: [], removed_items: [], added_rulings: [], removed_rulings: [] },
    ...{ decisions: [], confirmed_claims: [], window_from: null, window_to: null, compartments: ["own"] },
    ...over,
  });
  const belief = (value: string): BeliefRecord =>
    ({
      ...{ factKeyFp: "f", compartments: ["own"], provenance: "source" },
      belief: { kind: "stated_fact", subject: "ent_1", values: { value }, status: "active", disputed: false },
      ...{ changeKind: "live", support: [] },
    }) as unknown as BeliefRecord;
  const now = belief("b");
  now.belief.changeKind = "live";
  const old = belief("a");
  const before = (row: BeliefRecord | undefined) => ({ keys, clearance: ["own"], compute: () => row });
  const exact = [change({ exact: true })];

  it.each([
    ["an exact change whose state before differs raises", before(old), now, undefined, exact, "changed"],
    ["an exact change whose state before is the same raises nothing", before(now), now, undefined, exact, undefined],
    ["an exact change already recorded raises nothing", before(old), now, stateOf(keys, now), exact, undefined],
    [
      "an inexact change with no last state records the baseline",
      before(undefined),
      now,
      undefined,
      [change()],
      "none",
    ],
    [
      "an inexact change of a fact no longer built, with no last state, writes nothing",
      before(undefined),
      undefined,
      undefined,
      [change()],
      undefined,
    ],
    [
      "an inexact change equal to the last state raises nothing",
      before(undefined),
      now,
      stateOf(keys, now),
      [change()],
      undefined,
    ],
    [
      "a status-only difference that no change named is time's: backfill",
      before(undefined),
      now,
      stateOf(keys, now, "stale"),
      [change()],
      "none",
    ],
    [
      "a named change to a new value raises",
      before(undefined),
      now,
      stateOf(keys, old),
      [change({ added_claims: ["c1"] })],
      "changed",
    ],
  ] as const)("%s", (_title, rules, after, last, changes, expected) => {
    expect(raiseForChange(rules, inputs, after, last, changes)).toBe(expected);
  });
});
