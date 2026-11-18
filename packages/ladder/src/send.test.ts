import { GateCheckKind } from "@intelligence/contracts";
import {
  currentDefinition,
  DECISION_POINT_PINS,
  type DecisionPointDefinition,
  type DecisionPointId,
  type GateOutcome,
  PROMPT_PINS,
  type Sha256,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { definitionHash, loadRegistry, REGISTRY, RegistryRefused, sendClearRung0 } from "./index.ts";

// The three send decision points in the registry, and sendClearRung0.

const point = (id: DecisionPointId): DecisionPointDefinition => currentDefinition(id);

// One definition with its own correct pin, so only the rule under test can refuse it.
const refusal = (
  definition: DecisionPointDefinition,
  promptPins: Record<string, Sha256> = PROMPT_PINS,
): string | null => {
  try {
    loadRegistry([definition], { [`${definition.id}@${definition.version}`]: definitionHash(definition) }, promptPins);
    return null;
  } catch (error) {
    if (error instanceof RegistryRefused) return error.code;
    throw error;
  }
};

// A model rung needs a pinned prompt (L6); this one is pinned, so L2 alone can refuse.
const PROMPT = { id: "personal_run", version: "1" } as const;

describe("send-proxy's decision points", () => {
  it("the registry loads with the three points", () => {
    for (const id of ["send_clear", "send_first_contact", "draft_disclosure"] as const) {
      expect(REGISTRY.current(id).definition, id).toEqual(point(id));
      expect(REGISTRY.current(id).hash, id).toBe(DECISION_POINT_PINS[`${id}@1`]);
    }
    // The three are refused by none of the rules as they ship.
    for (const id of ["send_clear", "send_first_contact", "draft_disclosure"] as const)
      expect(refusal(point(id)), id).toBeNull();
  });

  for (const rung of [1, 2, 3] as const) {
    it(`send_clear with rung ${rung} fails to load`, () => {
      expect(refusal({ ...point("send_clear"), rungs: [0, rung, 4], prompts: [PROMPT] })).toBe("model_external");
    });
  }

  it("send_first_contact with rung 0 fails to load", () => {
    expect(refusal({ ...point("send_first_contact"), rungs: [0, 4] })).toBe("owner_only");
  });

  it("draft_disclosure with an external output fails to load", () => {
    // With model rungs 1 and 2, an external output is refused.
    const widened = { ...point("draft_disclosure"), rungs: [0, 1, 2, 4], prompts: [PROMPT] } as DecisionPointDefinition;
    expect(refusal(widened)).toBeNull();
    expect(refusal({ ...widened, outputs: { ...widened.outputs, hold: "clear_external_move" } })).toBe(
      "model_external",
    );
  });
});

const outcome = (failing: GateCheckKind | null): GateOutcome => ({
  cleared: failing === null,
  checks: Object.fromEntries(GateCheckKind.options.map((kind) => [kind, kind !== failing])) as GateOutcome["checks"],
  causes: failing === null ? [] : ["cannot_answer"],
});

describe("sendClearRung0", () => {
  it("sendClearRung0 never answers clear", () => {
    expect(sendClearRung0(outcome(null))).toBe("cannot_decide");
    for (const kind of GateCheckKind.options) expect(sendClearRung0(outcome(kind)), kind).toBe("refuse");
    // An outcome that says cleared while a check is false is not cleared.
    expect(sendClearRung0({ ...outcome("disclosure"), cleared: true })).toBe("refuse");
  });
});
