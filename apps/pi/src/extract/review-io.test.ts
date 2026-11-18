import { ReviewImport } from "@intelligence/contracts/personal";
import type { Keys } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import { importVerdicts, openSample, type Sample, type SampleState, sealSample } from "./extract-owner.ts";

// The checks of `pi extract review-import` that need no database: the sample id, and each
// verdict against the sample and the items' state now.

const keys = { compartments: new Map(), fingerprintKey: Buffer.alloc(32, 7) } as unknown as Keys;
const other = { compartments: new Map(), fingerprintKey: Buffer.alloc(32, 8) } as unknown as Keys;
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const sample: Sample = {
  generation: 1,
  type: null,
  items: [
    [A, ["a1", "a2"]],
    [B, []],
  ],
};
const state = (): SampleState =>
  new Map([
    [
      A,
      {
        done: true,
        reviewed: false,
        claims: [
          { id: "a1", type: "plan" },
          { id: "a2", type: "commitment" },
        ],
      },
    ],
    [B, { done: true, reviewed: false, claims: [] }],
  ]);
const answer = (verdicts: unknown[]): ReviewImport => ReviewImport.parse({ sample_id: "unused", verdicts });
const full = {
  item_id: A,
  claims: [
    { claim_id: "a1", verdict: "right" },
    { claim_id: "a2", verdict: "wrong_date" },
  ],
  missed: true,
} as const;

const refusedWith = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "none";
};

describe("the sample id", () => {
  it("opens to the sample it was sealed from, under the same key only", () => {
    const id = sealSample(keys, sample);
    expect(openSample(keys, id)).toEqual(sample);
    expect(refusedWith(() => openSample(other, id))).toBe("review_unknown_id");
    // A changed payload, a changed MAC, or no id at all.
    const [prefix, payload, mac] = id.split(".");
    const forged = Buffer.from(JSON.stringify({ ...sample, items: [[C, []]] })).toString("base64url");
    for (const bad of [
      `${prefix}.${forged}.${mac}`,
      `${prefix}.${payload}.${mac?.slice(1)}`,
      "x",
      `${prefix}.${payload}`,
    ]) {
      expect(
        refusedWith(() => openSample(keys, bad)),
        bad,
      ).toBe("review_unknown_id");
    }
  });
});

describe("importVerdicts", () => {
  it("gives exactly what the terminal review stores: each claim's verdict, then missed, or nothing", () => {
    expect(importVerdicts(answer([full, { item_id: B, claims: [], missed: false }]), sample, state(), 1)).toEqual([
      [
        { evidenceId: A, claimId: "a1", type: "plan", verdict: "right" },
        { evidenceId: A, claimId: "a2", type: "commitment", verdict: "wrong_date" },
        { evidenceId: A, type: "any", verdict: "missed" },
      ],
      [{ evidenceId: B, type: "any", verdict: "nothing" }],
    ]);
    // A sample drawn for a type counts a missed fact under it, and `nothing: true` is the same as leaving it out.
    expect(
      importVerdicts(answer([{ item_id: B, claims: [], missed: true }]), { ...sample, type: "plan" }, state(), 1),
    ).toEqual([[{ evidenceId: B, type: "plan", verdict: "missed" }]]);
    expect(
      importVerdicts(answer([{ item_id: B, claims: [], missed: false, nothing: true }]), sample, state(), 1),
    ).toEqual([[{ evidenceId: B, type: "any", verdict: "nothing" }]]);
    // Part of the sample may be answered, as a terminal review may stop part way.
    expect(importVerdicts(answer([]), sample, state(), 1)).toEqual([]);
  });

  it("refuses with a fixed code: an unknown id, a duplicate, a stale sample, an item part judged, or nothing with a claim or a miss", () => {
    const cases: [string, unknown[], SampleState?, number?][] = [
      ["review_unknown_id", [{ ...full, item_id: C }]],
      ["review_unknown_id", [{ ...full, claims: [...full.claims, { claim_id: "zz", verdict: "right" }] }]],
      ["review_duplicate", [full, full]],
      ["review_duplicate", [{ ...full, claims: [full.claims[0], full.claims[0], full.claims[1]] }]],
      ["review_incomplete", [{ ...full, claims: [full.claims[0]] }]],
      ["review_stale", [full], state(), 2],
      ["review_stale", [full], new Map([...state()].map(([id, one]) => [id, { ...one, done: false }]))],
      ["review_stale", [full], new Map([...state()].map(([id, one]) => [id, { ...one, claims: one.claims.slice(1) }]))],
      ["review_stale", [full], new Map()],
      ["review_duplicate", [full], new Map([...state()].map(([id, one]) => [id, { ...one, reviewed: true }]))],
      ["review_invalid", [{ ...full, nothing: true }]],
      ["review_invalid", [{ item_id: B, claims: [], missed: true, nothing: true }]],
    ];
    for (const [code, verdicts, now = state(), generation = 1] of cases) {
      expect(
        refusedWith(() => importVerdicts(answer(verdicts), sample, now, generation)),
        `${code} ${JSON.stringify(verdicts)}`,
      ).toBe(code);
    }
  });
});
