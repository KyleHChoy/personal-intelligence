import type { DecisionPointDefinition, Sha256 } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { decide } from "./decide.ts";
import { hashOf } from "./hash.ts";
import { definitionHash, loadRegistry } from "./registry.ts";

const go: DecisionPointDefinition = {
  id: "opportunity_go",
  version: 1,
  rungs: [0, 4],
  outputs: { go: "go_internal", no_go: "decline", later: "defer" },
  queue: "opportunity_decision",
  onNoAnswer: "expire",
  expiresAfterDays: 14,
};
const wake: DecisionPointDefinition = {
  id: "wake_worth_run",
  version: 1,
  rungs: [0],
  outputs: { run: "start_run", skip: "record_silence" },
};
const climbed: DecisionPointDefinition = {
  ...go,
  id: "owner_question",
  rungs: [0, 1, 2, 4],
  prompts: [{ id: "p", version: "1" }],
};

const pins = (definitions: DecisionPointDefinition[]): Record<string, Sha256> =>
  Object.fromEntries(
    definitions.map((definition) => [`${definition.id}@${definition.version}`, definitionHash(definition)]),
  );
const registry = loadRegistry([go, wake, climbed], pins([go, wake, climbed]), { "p@1": "b".repeat(64) });

const facts = { kind: "meeting_prep", count: 2, flag: true };

describe("decide", () => {
  it("a rung 0 output carries its effect and class", () => {
    const call = decide(registry, "opportunity_go", facts, () => ({ output: "go", reason: "intent" }));
    expect(call).toEqual({
      point: "opportunity_go",
      version: 1,
      definitionHash: definitionHash(go),
      rung: 0,
      inputHash: hashOf(facts),
      output: "go",
      effect: "go_internal",
      effectClass: "internal_reversible",
      escalated: false,
    });
  });

  it("cannot decide on a point with rung 4 escalates", () => {
    expect(decide(registry, "opportunity_go", facts, () => "cannot_decide")).toMatchObject({
      rung: 4,
      output: null,
      effect: null,
      effectClass: null,
      escalated: true,
    });
  });

  it("cannot decide on a point with no rung 4 throws", () => {
    expect(() => decide(registry, "wake_worth_run", facts, () => "cannot_decide")).toThrow(/cannot decide/);
  });

  it("rungs 1 and 2 with no runner are passed over", () => {
    expect(decide(registry, "owner_question", facts, () => "cannot_decide")).toMatchObject({
      point: "owner_question",
      rung: 4,
      escalated: true,
    });
  });

  it("an output outside the point's outputs throws", () => {
    expect(() => decide(registry, "wake_worth_run", facts, () => ({ output: "go", reason: "x" }))).toThrow(
      /not an output/,
    );
  });

  it("a point the registry lacks throws", () => {
    expect(() => decide(registry, "move_clear", facts, () => "cannot_decide")).toThrow(/not registered/);
  });

  it("the same facts give the same input hash, whatever the key order", () => {
    const one = decide(registry, "opportunity_go", { a: 1, b: { c: [1, 2], d: "x" } }, () => "cannot_decide");
    const two = decide(registry, "opportunity_go", { b: { d: "x", c: [1, 2] }, a: 1 }, () => "cannot_decide");
    expect(one.inputHash).toBe(two.inputHash);
    expect(
      decide(registry, "opportunity_go", { a: 2, b: { c: [1, 2], d: "x" } }, () => "cannot_decide").inputHash,
    ).not.toBe(one.inputHash);
  });
});
