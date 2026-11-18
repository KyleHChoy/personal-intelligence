import {
  DECISION_POINT_PINS,
  DECISION_POINTS,
  type DecisionPointDefinition,
  EFFECT_CLASS,
  type ModelEntry,
  OWNER_ONLY_EFFECTS,
  POINT_THRESHOLDS,
  PROMPT_PINS as SHIPPED_PROMPT_PINS,
  type Sha256,
  THRESHOLD_PINS,
  ThresholdBounds,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { hashOf } from "./hash.ts";
import {
  checkModelEffects,
  checkNeverClimbs,
  definitionHash,
  loadRegistry,
  REGISTRY,
  RegistryRefused,
  thresholdsHash,
  UNBANDED,
} from "./index.ts";
import { CHANGE, CONSTANTS, LINK, loadFull, SAME, WORTH } from "./test-support/points.ts";

const PROMPT_HASH = "a".repeat(64);
const PROMPT_PINS: Record<string, Sha256> = { "run@1": PROMPT_HASH };

const base: DecisionPointDefinition = {
  id: "move_clear",
  version: 1,
  rungs: [0],
  outputs: { clear: "clear_internal_move", refuse: "hold" },
};

const pinsFor = (definitions: readonly DecisionPointDefinition[]): Record<string, Sha256> =>
  Object.fromEntries(
    definitions.map((definition) => [`${definition.id}@${definition.version}`, definitionHash(definition)]),
  );

// Loads one definition with its own correct pin, so only the rule under test can refuse it.
const load = (definition: DecisionPointDefinition, promptPins: Record<string, Sha256> = PROMPT_PINS) =>
  loadRegistry([definition], pinsFor([definition]), promptPins);

const refusal = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof RegistryRefused) return error.code;
    throw error;
  }
};

describe("L1: every output names a known effect", () => {
  it("a definition with an unknown effect fails to load", () => {
    const bad = { ...base, outputs: { clear: "launch_rocket" } } as unknown as DecisionPointDefinition;
    expect(refusal(() => load(bad))).toBe("unknown_effect");
    expect(refusal(() => load(base))).toBeNull();
  });
});

describe("L2: no model rung reaches an external effect", () => {
  const external: DecisionPointDefinition = {
    id: "send_clear",
    version: 1,
    rungs: [0, 4],
    outputs: { clear: "clear_external_move", refuse: "hold" },
    queue: "draft_waiting",
    onNoAnswer: "expire",
    prompts: [{ id: "run", version: "1" }],
  };

  for (const rung of [1, 2, 3] as const) {
    it(`a definition that maps rung ${rung} to an external effect fails to load`, () => {
      expect(refusal(() => load({ ...external, rungs: [rung, 4] }))).toBe("model_external");
    });
  }

  it("the same definition on rungs 0 and 4 loads", () => {
    expect(refusal(() => load(external))).toBeNull();
  });
});

describe("L3: an owner-only effect is the owner's alone", () => {
  for (const effect of OWNER_ONLY_EFFECTS) {
    it(`a definition that lets rung 0 cause ${effect} fails to load, and rung 4 alone loads`, () => {
      const definition: DecisionPointDefinition = {
        id: "owner_question",
        version: 1,
        rungs: [0, 4],
        outputs: { yes: effect, no: "decline" },
        queue: "owner_question",
        onNoAnswer: "expire",
      };
      expect(refusal(() => load(definition))).toBe("owner_only");
      expect(refusal(() => load({ ...definition, rungs: [4] }))).toBeNull();
    });
  }
});

describe("L4: rungs, queue and no-answer effect", () => {
  it("rungs out of order, repeated or empty fail to load", () => {
    expect(refusal(() => load({ ...base, rungs: [4, 0], queue: "q", onNoAnswer: "expire" }))).toBe("bad_rungs");
    expect(refusal(() => load({ ...base, rungs: [0, 0] }))).toBe("bad_rungs");
    expect(refusal(() => load({ ...base, rungs: [] }))).toBe("bad_rungs");
  });

  it("a rung 4 with no queue fails to load", () => {
    expect(refusal(() => load({ ...base, rungs: [0, 4], onNoAnswer: "expire" }))).toBe("bad_queue");
    expect(refusal(() => load({ ...base, rungs: [0, 4], queue: "opportunity_decision" }))).toBe("bad_queue");
    expect(
      refusal(() => load({ ...base, rungs: [0, 4], queue: "opportunity_decision", onNoAnswer: "expire" })),
    ).toBeNull();
  });

  it("a no-answer effect that is not narrow fails to load", () => {
    expect(EFFECT_CLASS.go_internal).not.toBe("narrow");
    expect(
      refusal(() => load({ ...base, rungs: [0, 4], queue: "opportunity_decision", onNoAnswer: "go_internal" })),
    ).toBe("bad_queue");
  });
});

describe("L5: a definition is pinned beside its version", () => {
  it("a definition edited under the same version fails to load", () => {
    const pins = pinsFor([base]);
    const edited: DecisionPointDefinition = { ...base, outputs: { clear: "clear_internal_move", refuse: "decline" } };
    expect(refusal(() => loadRegistry([edited], pins, PROMPT_PINS))).toBe("changed");
  });

  it("a definition with no pin fails to load", () => {
    expect(refusal(() => loadRegistry([base], {}, PROMPT_PINS))).toBe("changed");
  });

  it("the hash does not depend on the order of keys", () => {
    const reordered = {
      outputs: { refuse: "hold", clear: "clear_internal_move" },
      rungs: [0],
      version: 1,
      id: "move_clear",
    } as DecisionPointDefinition;
    expect(definitionHash(reordered)).toBe(definitionHash(base));
  });
});

describe("L6: a model rung names a pinned prompt", () => {
  const model: DecisionPointDefinition = {
    id: "run_outcome",
    version: 1,
    rungs: [3],
    outputs: { ignore: "record_silence" },
    prompts: [{ id: "run", version: "1" }],
  };

  for (const rung of [1, 2, 3] as const) {
    it(`a rung ${rung} with no prompt fails to load`, () => {
      const { prompts: _prompts, ...bare } = { ...model, rungs: [rung] };
      expect(refusal(() => load(bare))).toBe("no_prompt");
      expect(refusal(() => load({ ...model, rungs: [rung], prompts: [] }))).toBe("no_prompt");
    });
  }

  it("a prompt with no pin fails to load", () => {
    expect(refusal(() => load(model, {}))).toBe("no_prompt");
    expect(refusal(() => load(model))).toBeNull();
  });
});

describe("the registry", () => {
  it("rules are checked in order: an unknown effect is refused before a missing pin", () => {
    const bad = { ...base, outputs: { clear: "launch_rocket" } } as unknown as DecisionPointDefinition;
    expect(refusal(() => loadRegistry([bad], {}, {}))).toBe("unknown_effect");
  });

  it("a point defined twice fails to load", () => {
    expect(refusal(() => loadRegistry([base, base], pinsFor([base]), PROMPT_PINS))).toBe("duplicate");
  });

  it("a loaded point carries its definition and hash", () => {
    const registry = load(base);
    expect(registry.current("move_clear")).toEqual({ definition: base, hash: definitionHash(base) });
  });

  it("the shipped definitions load: durable-work's five, extraction's two, Jev's two holds, send-proxy's three, the two identity points, Jev's three further points, echoes-and-proposals three, restricted-compartments's one and the same-fact point", () => {
    expect([...REGISTRY.ids()].sort()).toEqual(
      [
        "wake_worth_run",
        "run_outcome",
        "opportunity_go",
        "owner_question",
        "move_clear",
        "extract_triage",
        "extract_claims",
        "extract_injection",
        "extract_sensitivity",
        "send_clear",
        "send_first_contact",
        "draft_disclosure",
        "identity_candidate",
        "identity_ruling",
        "extract_recovery",
        "record_injection",
        "identity_rank",
        "record_echo",
        "about_you",
        "client_preference",
        "restrict_category",
        "claims_same_fact",
        // The claim intake's points.
        "claims_standalone",
        "claims_said",
        "task_go",
      ].sort(),
    );
  });

  it("the two screens are on rung 1 alone, and the identity ranking on rungs 0 and 1, each through its own prompt", () => {
    for (const [id, rungs, prompt, outputs] of [
      ["extract_recovery", [1], "jev_recovery", { recovery: "hold_message", none: "record_silence" }],
      ["record_injection", [1], "jev_record", { quarantine: "withhold_item", none: "record_silence" }],
      ["identity_rank", [0, 1], "jev_identity", { rank: "rank_candidate" }],
    ] as const) {
      const definition = REGISTRY.at(id, 1).definition;
      expect(definition?.version, id).toBe(1);
      expect(definition?.rungs, id).toEqual(rungs);
      expect(definition?.prompts, id).toEqual([{ id: prompt, version: "1" }]);
      expect(definition?.outputs, id).toEqual(outputs);
    }
    expect(EFFECT_CLASS.hold_message).toBe("narrow");
    expect(EFFECT_CLASS.rank_candidate).toBe("internal_reversible");
  });

  it("an identity ranking that could merge people fails to load: merge_identity stays the owner's", () => {
    const rank = REGISTRY.current("identity_rank").definition as DecisionPointDefinition;
    // On rungs 0 and 1, L2 refuses it first (merge_identity is external); on rung 0 alone, L3.
    expect(refusal(() => load({ ...rank, outputs: { rank: "merge_identity" } }, SHIPPED_PROMPT_PINS))).toBe(
      "model_external",
    );
    expect(refusal(() => load({ ...rank, rungs: [0], outputs: { rank: "merge_identity" } }, SHIPPED_PROMPT_PINS))).toBe(
      "owner_only",
    );
    expect(refusal(() => load(rank, SHIPPED_PROMPT_PINS))).toBeNull();
  });

  it("extract_triage, at version 5, is on rungs 0 and 1, and the two holds are on rung 1, each through jev_screen@1", () => {
    for (const [id, version, rungs] of [
      ["extract_triage", 5, [0, 1]],
      ["extract_injection", 2, [1]],
      ["extract_sensitivity", 2, [1]],
    ] as const) {
      const definition = REGISTRY.current(id).definition;
      expect(definition?.version, id).toBe(version);
      expect(definition?.rungs, id).toEqual(rungs);
      expect(definition?.prompts, id).toEqual([{ id: "jev_screen", version: "1" }]);
    }
  });

  // W1, read from the registry that ships.
  it("the registry that ships maps no model rung to an external effect and no rung but 4 to an owner-only effect", () => {
    expect(REGISTRY.all().length).toBeGreaterThan(0);
    const ownerOnly = new Set<string>(OWNER_ONLY_EFFECTS);
    for (const { definition } of REGISTRY.all()) {
      const effects = Object.values(definition.outputs);
      if (definition.rungs.some((rung) => rung >= 1 && rung <= 3)) {
        expect(
          effects.map((effect) => EFFECT_CLASS[effect]),
          definition.id,
        ).not.toContain("external");
      }
      if (effects.some((effect) => ownerOnly.has(effect))) expect(definition.rungs, definition.id).toEqual([4]);
    }
  });
});

describe("thresholds are pinned per point version", () => {
  const rung1: DecisionPointDefinition = {
    id: "extract_recovery",
    version: 1,
    rungs: [1],
    outputs: { recovery: "hold_message", none: "record_silence" },
    prompts: [{ id: "run", version: "1" }],
  };
  const constants = { "extract_recovery@1": { hold: { default: 0.7, floor: 0.3, ceiling: 0.95 } } };
  const loadWith = (
    definition: DecisionPointDefinition,
    given: Record<string, unknown>,
    pins: Record<string, Sha256>,
  ) => loadRegistry([definition], pinsFor([definition]), PROMPT_PINS, { constants: given as never, pins });

  it("a rung 1 definition with no THRESHOLD_PINS entry fails to load, and loads with its pin", () => {
    expect(refusal(() => loadWith(rung1, constants, {}))).toBe("no_threshold_pin");
    expect(
      refusal(() =>
        loadWith(rung1, constants, { "extract_recovery@1": thresholdsHash(constants["extract_recovery@1"]) }),
      ),
    ).toBeNull();
  });

  it("a constant changed in code without its pin fails to load", () => {
    const pins = { "extract_recovery@1": thresholdsHash(constants["extract_recovery@1"]) };
    const moved = { "extract_recovery@1": { hold: { default: 0.6, floor: 0.3, ceiling: 0.95 } } };
    expect(refusal(() => loadWith(rung1, moved, pins))).toBe("threshold_changed");
    expect(refusal(() => loadWith(rung1, {}, pins))).toBe("threshold_changed");
  });

  it("a loaded rung 1 point carries its thresholds; a point with no model rung needs no pin", () => {
    const registry = loadWith(rung1, constants, {
      "extract_recovery@1": thresholdsHash(constants["extract_recovery@1"]),
    });
    expect(registry.current("extract_recovery").thresholds).toEqual(constants["extract_recovery@1"]);
    expect(refusal(() => loadWith(base, {}, {}))).toBeNull();
  });

  it("each pin is the hash of the constants POINT_THRESHOLDS holds, and each bound is floor <= default <= ceiling", () => {
    expect(Object.keys(THRESHOLD_PINS).sort()).toEqual(Object.keys(POINT_THRESHOLDS).sort());
    for (const [key, thresholds] of Object.entries(POINT_THRESHOLDS)) {
      expect(THRESHOLD_PINS[key], key).toBe(hashOf(thresholds));
      expect(thresholdsHash(thresholds), key).toBe(hashOf(thresholds));
      for (const bounds of Object.values(thresholds)) expect(ThresholdBounds.safeParse(bounds).success, key).toBe(true);
    }
  });

  it("every rung 1 point that ships has its thresholds in the registry, triage's and the two holds' at their versions", () => {
    for (const { definition, thresholds } of REGISTRY.all()) {
      if (!definition.rungs.includes(1)) continue;
      expect(thresholds, definition.id).toEqual(POINT_THRESHOLDS[`${definition.id}@${definition.version}`]);
    }
    expect(REGISTRY.current("extract_triage").thresholds).toEqual({ lane: { default: 0.5, floor: 0.2, ceiling: 0.8 } });
    // The hold points' current versions at 0.7; version 1 keeps its 0.9.
    expect(REGISTRY.at("extract_injection", 1).thresholds).toEqual({
      hold: { default: 0.9, floor: 0.5, ceiling: 0.99 },
    });
    expect(REGISTRY.current("extract_injection").thresholds).toEqual({
      hold: { default: 0.7, floor: 0.5, ceiling: 0.99 },
    });
    expect(REGISTRY.current("extract_sensitivity").thresholds).toEqual({
      hold: { default: 0.7, floor: 0.5, ceiling: 0.99 },
    });
    expect(REGISTRY.current("extract_recovery").thresholds).toEqual({
      hold: { default: 0.7, floor: 0.3, ceiling: 0.95 },
    });
    expect(REGISTRY.current("record_injection").thresholds).toEqual({
      hold: { default: 0.7, floor: 0.5, ceiling: 0.99 },
    });
    expect(REGISTRY.current("identity_rank").thresholds).toEqual({});
  });

  it("the triage and hold definitions' hashes are unchanged by the threshold pins", () => {
    expect(DECISION_POINT_PINS["extract_triage@2"]).toBe(
      "1e68a0bd0d9c3577ddae853f7ced0d4ba389170a44f1d7a9a2119b094b658cf5",
    );
    expect(DECISION_POINT_PINS["extract_injection@1"]).toBe(
      "6c09783b522b6d645e0c2710daef058e805397de097dc4a07a1a947bc7c261f6",
    );
    expect(DECISION_POINT_PINS["extract_sensitivity@1"]).toBe(
      "ee57a07a7948cc9029107307dc896165e65ba8010d7841d593639abd6b6b1e3a",
    );
    for (const definition of DECISION_POINTS)
      expect(REGISTRY.at(definition.id, definition.version).hash, definition.id).toBe(
        DECISION_POINT_PINS[`${definition.id}@${definition.version}`],
      );
  });

  // Each such threshold is listed here, and the step that registers its version waits for the
  // owner. None today.
  it("lists every hold or clear threshold whose carried value could be raised by a later version's floor", () => {
    const raised: string[] = [];
    for (const [key, thresholds] of Object.entries(POINT_THRESHOLDS)) {
      const [point, version] = key.split("@") as [string, string];
      for (const [earlierKey, earlier] of Object.entries(POINT_THRESHOLDS)) {
        const [earlierPoint, earlierVersion] = earlierKey.split("@") as [string, string];
        if (earlierPoint !== point || Number(earlierVersion) >= Number(version)) continue;
        for (const name of ["hold", "clear"] as const) {
          const now = thresholds[name];
          const before = earlier[name];
          if (now !== undefined && before !== undefined && before.floor < now.floor) raised.push(`${key} ${name}`);
        }
      }
    }
    expect(raised).toEqual([]);
  });
});

describe("versions", () => {
  const second: DecisionPointDefinition = {
    ...base,
    version: 2,
    outputs: { clear: "clear_internal_move", refuse: "decline" },
  };

  it("two versions of one point load; a duplicate id@version does not; current is the highest", () => {
    const registry = loadRegistry([second, base], pinsFor([base, second]), PROMPT_PINS);
    expect(registry.current("move_clear").definition).toEqual(second);
    expect(registry.at("move_clear", 1)).toEqual({ definition: base, hash: definitionHash(base) });
    expect(registry.at("move_clear", 2).hash).toBe(definitionHash(second));
    expect(registry.all().map(({ definition }) => `${definition.id}@${definition.version}`)).toEqual([
      "move_clear@2",
      "move_clear@1",
    ]);
    expect(registry.ids()).toEqual(["move_clear"]);
    expect(refusal(() => loadRegistry([base, second, base], pinsFor([base, second]), PROMPT_PINS))).toBe("duplicate");
  });

  it("every version passes every rule: an earlier version that breaks one stops the load", () => {
    const bad: DecisionPointDefinition = {
      ...base,
      rungs: [1],
      prompts: [{ id: "run", version: "1" }],
      outputs: { clear: "clear_external_move" },
    };
    expect(refusal(() => loadRegistry([bad, second], pinsFor([bad, second]), PROMPT_PINS))).toBe("model_external");
  });

  it("a point or a version the registry lacks throws", () => {
    const registry = load(base);
    expect(() => registry.current("wake_worth_run")).toThrow(/not registered/);
    expect(() => registry.at("move_clear", 2)).toThrow(/not registered/);
  });

  it("the registry has no lookup by id alone", () => {
    const registry = load(base);
    // @ts-expect-error: a Registry answers current(id) and at(id, version) only.
    expect(() => registry.get("move_clear")).toThrow(TypeError);
    expect(Object.keys(registry).sort()).toEqual(["all", "at", "current", "ids"]);
    expect(registry instanceof Map).toBe(false);
  });
});

// Each refusal has a control that passes: the same definition, loaded whole.
describe("L7: model entries", () => {
  const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
    const { [key]: _gone, ...rest } = value;
    return rest;
  };

  it("the definitions with model entries load, and carry them", () => {
    const registry = loadFull([LINK, SAME, CHANGE, WORTH]);
    expect(registry.current("project_link").definition.models).toEqual(LINK.models);
    expect(registry.current("project_link").thresholds).toEqual(CONSTANTS["project_link@1"]);
  });

  it("a definition with models whose rung 1 has no entry fails to load (L7)", () => {
    expect(refusal(() => loadFull([{ ...LINK, models: LINK.models?.filter((entry) => entry.rung !== 1) }]))).toBe(
      "bad_models",
    );
    expect(refusal(() => loadFull([LINK]))).toBeNull();
  });

  it("an entry for a rung not in rungs, or two for one rung, fails to load (L7)", () => {
    const extra: ModelEntry = {
      rung: 2,
      prompt: { id: "jev_change_worth", version: "1" },
      question: "worth_attention",
      onAccept: ["offer"],
      onReject: [],
    };
    expect(refusal(() => loadFull([{ ...WORTH, models: [...(WORTH.models ?? []), extra] }]))).toBe("bad_models");
    expect(refusal(() => loadFull([{ ...WORTH, models: [...(WORTH.models ?? []), ...(WORTH.models ?? [])] }]))).toBe(
      "bad_models",
    );
    expect(refusal(() => loadFull([WORTH]))).toBeNull();
  });

  it("an entry whose prompt the definition does not name, or whose output is not the point's, fails to load (L7)", () => {
    const [entry] = WORTH.models ?? [];
    if (entry?.rung !== 1) throw new Error("WORTH has one rung 1 entry");
    expect(
      refusal(() => loadFull([{ ...WORTH, models: [{ ...entry, prompt: { id: "jev_project", version: "1" } }] }])),
    ).toBe("bad_models");
    expect(refusal(() => loadFull([{ ...WORTH, models: [{ ...entry, onAccept: ["launch"] }] }]))).toBe("bad_models");
    expect(refusal(() => loadFull([{ ...WORTH, models: [{ ...entry, onReject: ["launch"] }] }]))).toBe("bad_models");
  });

  it("a definition with a rung 1 and no models that is not in UNBANDED fails to load (L7)", () => {
    expect(refusal(() => loadFull([without(WORTH, "models")]))).toBe("bad_models");
    expect(refusal(() => loadFull([{ ...without(SAME, "models"), rungs: [0, 2, 4] }]))).toBe("bad_models");
    expect(refusal(() => loadFull([WORTH]))).toBeNull();
  });

  it("UNBANDED is exactly its twenty-two versions", () => {
    expect([...UNBANDED].sort()).toEqual(
      [
        "extract_claims@4",
        "extract_triage@3",
        "extract_injection@1",
        "extract_sensitivity@1",
        "extract_recovery@1",
        "record_injection@1",
        "identity_rank@1",
        "draft_disclosure@2",
        "extract_injection@2",
        "extract_sensitivity@2",
        "record_injection@2",
        "record_injection@3",
        "restrict_category@1",
        "extract_claims@5",
        "extract_triage@4",
        "extract_claims@6",
        "extract_triage@5",
        "extract_claims@7",
        "extract_claims@8",
        "extract_claims@10",
        "extract_claims@11",
        "extract_claims@12",
        "extract_claims@13",
        "extract_claims@14",
        "extract_claims@15",
        "extract_claims@16",
        "extract_claims@17",
        "extract_claims@18",
        "extract_claims@19",
        "extract_claims@20",
        "extract_claims@22",
        "extract_claims@23",
        "extract_claims@24",
        "extract_claims@25",
        "extract_claims@26",
      ].sort(),
    );
    expect(Object.isFrozen(UNBANDED)).toBe(true);
  });

  it("a rung 1 entry whose threshold name has no THRESHOLD_PINS entry fails to load", () => {
    const acceptOnly = { ...CONSTANTS, "project_link@1": { accept: { default: 0.8, floor: 0.6, ceiling: 0.95 } } };
    expect(refusal(() => loadFull([LINK], acceptOnly))).toBe("bad_models");
    // A version with no pin at all is the threshold-pin refusal, before L7.
    const { "project_link@1": _gone, ...none } = CONSTANTS;
    expect(refusal(() => loadFull([LINK], none))).toBe("no_threshold_pin");
  });

  it("a reject default not below its accept fails to load (L7)", () => {
    const level = {
      ...CONSTANTS,
      "project_link@1": {
        accept: { default: 0.5, floor: 0.4, ceiling: 0.95 },
        reject: { default: 0.5, floor: 0.05, ceiling: 0.5 },
      },
    };
    expect(refusal(() => loadFull([LINK], level))).toBe("bad_models");
  });
});

describe("L8: fallback and whileWaiting", () => {
  it("a point with models, rung 1, no rung 4 and no fallback fails to load (L8)", () => {
    const { fallback: _gone, ...bare } = WORTH;
    expect(refusal(() => loadFull([bare]))).toBe("bad_fallback");
    expect(refusal(() => loadFull([WORTH]))).toBeNull();
  });

  it("a fallback mapped to internal_reversible fails to load (L8)", () => {
    expect(refusal(() => loadFull([{ ...WORTH, fallback: "offer" }]))).toBe("bad_fallback");
  });

  it("a fallback that is not an output, or a fallback on a point with rung 4, fails to load (L8)", () => {
    expect(refusal(() => loadFull([{ ...WORTH, fallback: "never" }]))).toBe("bad_fallback");
    expect(refusal(() => loadFull([{ ...CHANGE, fallback: "conflict" }]))).toBe("bad_fallback");
    expect(refusal(() => loadFull([CHANGE]))).toBeNull();
  });

  it("a whileWaiting that is not narrow fails to load (L8)", () => {
    expect(refusal(() => loadFull([{ ...CHANGE, whileWaiting: "change" }]))).toBe("bad_fallback");
  });
});

// L9 and L10 are second checks of L2 and L3: on a full load L2 or L3 refuses first, so each test
// asserts that code, and calls the second check alone.
describe("L9 and L10: what a model may never give", () => {
  it("a models entry whose onAccept names an output mapped to clear_external_move is refused at L2 (model_external) on a full load, and by L9's check called alone", () => {
    const external: DecisionPointDefinition = {
      ...LINK,
      outputs: { propose: "clear_external_move", none: "record_silence" },
    };
    expect(refusal(() => loadFull([external]))).toBe("model_external");
    expect(refusal(() => checkModelEffects(external))).toBe("model_effect");
    expect(refusal(() => checkModelEffects(LINK))).toBeNull();
  });

  it("a whileWaiting or fallback naming merge_identity is refused at L3 (owner_only) on a full load, and by L10's check called alone", () => {
    // On rungs 0 and 4, with no model rung, L3 refuses it.
    const waiting: DecisionPointDefinition = {
      ...base,
      rungs: [0, 4],
      queue: "q",
      onNoAnswer: "expire",
      outputs: { merge: "merge_identity", keep: "hold" },
      whileWaiting: "merge",
    };
    expect(refusal(() => loadFull([waiting]))).toBe("owner_only");
    expect(refusal(() => checkNeverClimbs(waiting))).toBe("never_climbs");
    // With a model rung, merge_identity is external, so L2 refuses it before L3.
    const fallback: DecisionPointDefinition = {
      ...WORTH,
      outputs: { offer: "offer_wake", skip: "record_silence", merge: "merge_identity" },
      fallback: "merge",
    };
    expect(refusal(() => loadFull([fallback]))).toBe("model_external");
    expect(refusal(() => checkNeverClimbs(fallback))).toBe("never_climbs");
    expect(refusal(() => checkModelEffects(fallback))).toBe("model_effect");
    expect(refusal(() => checkNeverClimbs(WORTH))).toBeNull();
    expect(refusal(() => checkNeverClimbs(CHANGE))).toBeNull();
  });

  it("an entry naming an owner-only output is refused by L10's check called alone", () => {
    const [entry] = WORTH.models ?? [];
    if (entry?.rung !== 1) throw new Error("WORTH has one rung 1 entry");
    const named: DecisionPointDefinition = {
      ...WORTH,
      outputs: { ...WORTH.outputs, pay: "pay" },
      models: [{ ...entry, onAccept: ["pay"] }],
    };
    expect(refusal(() => checkNeverClimbs(named))).toBe("never_climbs");
    expect(refusal(() => loadFull([named]))).toBe("model_external");
  });
});

describe("the shipped registry", () => {
  it("the shipped registry loads, every version of every point, and no definition hash changed", () => {
    const shipped = REGISTRY.all().map(({ definition }) => `${definition.id}@${definition.version}`);
    expect(shipped.sort()).toEqual(
      DECISION_POINTS.map((definition) => `${definition.id}@${definition.version}`).sort(),
    );
    for (const { definition, hash } of REGISTRY.all())
      expect(hash, definition.id).toBe(DECISION_POINT_PINS[`${definition.id}@${definition.version}`]);
    // Every shipped definition with a model rung 1 or 2 and no models is on the frozen list.
    for (const { definition } of REGISTRY.all()) {
      if (definition.models === undefined && definition.rungs.some((rung) => rung === 1 || rung === 2))
        expect(UNBANDED, definition.id).toContain(`${definition.id}@${definition.version}`);
    }
  });

  // W1, over every version of every point: no model output reaches beyond narrow and
  // internal_reversible, and no owner-only effect is reached by anything but rung 4.
  it("no definition in the shipped registry lets a model rung give an effect outside narrow and internal_reversible", () => {
    for (const { definition } of REGISTRY.all()) {
      expect(
        refusal(() => checkModelEffects(definition)),
        definition.id,
      ).toBeNull();
      expect(
        refusal(() => checkNeverClimbs(definition)),
        definition.id,
      ).toBeNull();
    }
  });
});
