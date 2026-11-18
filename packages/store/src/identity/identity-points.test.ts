import { createHash } from "node:crypto";
import {
  currentDefinition,
  DECISION_POINTS,
  DecideIdentityOutput,
  POINT_THRESHOLDS,
  PROMPT_PINS,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  DECIDE_IDENTITY,
  IDENTITY_DECIDE_ON,
  IDENTITY_POINTS,
  pairSubject,
  rankWithinTiers,
} from "./identity-points.ts";

// The identity ranking, the parts that do not wait for the contacts sweep: the prompt, the point's
// data, the pair's subject and the order within a tier.

const QUESTIONS = {
  same_person: {
    type: "noul",
    instructions: "Are these two email identities the same human being?",
    criteria: {
      true: "The names, addresses and domains fit one person who uses two addresses, such as a personal and a work address, or an old and a new one.",
      false:
        "They fit two different people, such as two people who share a common name, a person and their assistant, or a person and a shared or role address.",
    },
  },
};

describe("DECIDE_IDENTITY", () => {
  it("is jev_identity@1, one pair slot, no tools, the expected question word for word", () => {
    expect(`${DECIDE_IDENTITY.id}@${DECIDE_IDENTITY.version}`).toBe("jev_identity@1");
    expect(DECIDE_IDENTITY.slots).toEqual(["pair"]);
    expect(DECIDE_IDENTITY.tools).toBe("none");
    expect(DECIDE_IDENTITY.outputSchemaId).toBe("JevIdentityOutput");
    expect(DECIDE_IDENTITY.outputSchema).toBe(DecideIdentityOutput);
    expect(JSON.parse(DECIDE_IDENTITY.instructions)).toEqual(QUESTIONS);
    expect(Object.isFrozen(DECIDE_IDENTITY)).toBe(true);
  });

  // The shared promptTextHash's form, computed here: the store takes no model client.
  it("its text matches its recorded hash, which is the contracts' pin", () => {
    const { id, version, slots, outputSchemaId, tools, instructions, textHash } = DECIDE_IDENTITY;
    const text = JSON.stringify([id, version, slots, outputSchemaId, tools, instructions]);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(textHash);
    expect(PROMPT_PINS["jev_identity@1"]).toBe(textHash);
  });
});

describe("identity_rank@1", () => {
  it("equals the contracts' copy, and has no threshold", () => {
    const point = IDENTITY_POINTS[0];
    if (point === undefined) throw new Error("no identity point");
    const { thresholds, ...definition } = point;
    expect(DECISION_POINTS.find((one) => one.id === "identity_rank" && one.version === 1)).toEqual(definition);
    // The sweep and the card answer use this copy's id and version: it must be the version that
    // runs, so a later version registered without it fails here.
    expect(currentDefinition("identity_rank")).toEqual(definition);
    expect(thresholds).toEqual({});
    expect(POINT_THRESHOLDS["identity_rank@1"]).toEqual(thresholds);
  });

  it("is switched off until the sweep's calls are recorded", () => {
    expect(IDENTITY_DECIDE_ON).toBe(false);
  });
});

describe("pairSubject", () => {
  it("is pair:<a>:<b> with the two address fingerprints sorted", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(pairSubject(b, a)).toBe(`pair:${a}:${b}`);
    expect(pairSubject(a, b)).toBe(`pair:${a}:${b}`);
  });
});

describe("rankWithinTiers", () => {
  type C = { id: string; tier: number };
  const order = (candidates: C[], p: Record<string, number>) =>
    rankWithinTiers(candidates, {
      tierOf: (c) => c.tier,
      subjectOf: (c) => c.id,
      probability: (subject) => p[subject],
    }).map((c) => c.id);

  it("orders candidates within a tier by descending probability", () => {
    expect(
      order(
        [
          { id: "x", tier: 1 },
          { id: "y", tier: 1 },
          { id: "z", tier: 1 },
        ],
        { x: 0.2, y: 0.9, z: 0.5 },
      ),
    ).toEqual(["y", "z", "x"]);
  });

  it("never raises a candidate of a lower tier before one of a higher tier", () => {
    expect(
      order(
        [
          { id: "low", tier: 2 },
          { id: "high", tier: 1 },
        ],
        { low: 0.99, high: 0.01 },
      ),
    ).toEqual(["high", "low"]);
  });

  it("a candidate with no answer comes after those with one, in the order it was given (the fingerprint order)", () => {
    expect(
      order(
        [
          { id: "a", tier: 1 },
          { id: "b", tier: 1 },
          { id: "c", tier: 1 },
          { id: "d", tier: 1 },
        ],
        { c: 0.1 },
      ),
    ).toEqual(["c", "a", "b", "d"]);
  });

  it("ties keep the order they were given", () => {
    expect(
      order(
        [
          { id: "a", tier: 1 },
          { id: "b", tier: 1 },
        ],
        { a: 0.5, b: 0.5 },
      ),
    ).toEqual(["a", "b"]);
  });

  it("drops no candidate, and with no probability at all keeps the order", () => {
    const given = [
      { id: "a", tier: 3 },
      { id: "b", tier: 1 },
      { id: "c", tier: 2 },
    ];
    expect(order(given, {})).toEqual(["b", "c", "a"]);
    expect(order(given, { a: 0.9 })).toHaveLength(3);
  });
});
