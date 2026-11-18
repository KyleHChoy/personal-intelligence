import {
  currentDefinition,
  DECISION_POINT_PINS,
  type DecisionPointDefinition,
  EFFECT_CLASS,
  PROMPT_PINS,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { definitionHash, loadRegistry, REGISTRY, RegistryRefused } from "./index.ts";

// The two identity decision points. No code calls decide for either: the sweep's cards are rung 0's
// output and the owner's decision rung 4's.

// The version that runs.
const point = (id: "identity_candidate" | "identity_ruling"): DecisionPointDefinition => currentDefinition(id);

const refusal = (definition: DecisionPointDefinition): string | null => {
  try {
    loadRegistry([definition], { [`${definition.id}@${definition.version}`]: definitionHash(definition) }, PROMPT_PINS);
    return null;
  } catch (error) {
    if (error instanceof RegistryRefused) return error.code;
    throw error;
  }
};

const PROMPT = { id: "personal_run", version: "1" } as const;

describe("the identity decision points", () => {
  it("the registry loads both points", () => {
    for (const id of ["identity_candidate", "identity_ruling"] as const) {
      expect(REGISTRY.current(id).definition, id).toEqual(point(id));
      expect(REGISTRY.current(id).hash, id).toBe(DECISION_POINT_PINS[`${id}@1`]);
      expect(refusal(point(id)), id).toBeNull();
    }
    expect(point("identity_candidate")).toEqual({
      id: "identity_candidate",
      version: 1,
      rungs: [0],
      outputs: { raise: "raise_identity_card" },
    });
    expect(point("identity_ruling")).toEqual({
      id: "identity_ruling",
      version: 1,
      rungs: [4],
      outputs: { same: "merge_identity", different: "record_answer" },
      queue: "same_person",
      onNoAnswer: "defer",
    });
    expect(EFFECT_CLASS.raise_identity_card).toBe("internal_reversible");
  });

  it("identity_ruling with rung 0 added fails to load as owner_only", () => {
    expect(refusal({ ...point("identity_ruling"), rungs: [0, 4] })).toBe("owner_only");
  });

  // A model rung meets L2 first: merge_identity is external, so it is refused before L3 asks.
  for (const rung of [1, 2, 3] as const) {
    it(`identity_ruling with rung ${rung} added fails to load`, () => {
      expect(refusal({ ...point("identity_ruling"), rungs: [rung, 4], prompts: [PROMPT] })).toBe("model_external");
    });
  }

  it("identity_candidate with a model rung fails to load without a prompt", () => {
    expect(refusal({ ...point("identity_candidate"), rungs: [0, 1] })).not.toBeNull();
  });
});
