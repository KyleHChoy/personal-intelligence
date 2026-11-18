import { EFFECT_CLASS, type EffectName, POINT_THRESHOLDS, PROMPT_PINS } from "@intelligence/contracts/personal";
import {
  DECIDE_RECORD,
  DECIDE_RECOVERY,
  DECIDE_SCREEN,
  EXTRACT_DECISION_POINTS,
  EXTRACT_PROMPTS,
} from "@intelligence/personal-extract";
import { REGISTRY } from "@intelligence/personal-ladder";
import { describe, expect, it } from "vitest";

// The extraction's decision points in the ladder's registry equal the extraction's own data, which
// is the source. pi imports both pieces, which may not import each other. The test compares a
// projection: a deep-equal cannot hold, since the extraction's data carries classes and pins the
// contract's strict definition does not.

describe("the extraction decision points in the registry", () => {
  for (const source of EXTRACT_DECISION_POINTS) {
    describe(source.id, () => {
      const registered = REGISTRY.current(source.id);

      it("the registry's definition equals EXTRACT_DECISION_POINTS in id, version, rungs, outputs and prompts", () => {
        expect(registered).toBeDefined();
        const definition = registered?.definition;
        expect(definition?.id).toBe(source.id);
        expect(definition?.version).toBe(source.version);
        expect(definition?.rungs).toEqual(source.rungs);
        expect(definition?.outputs).toEqual(source.outputs);
        const prompts = (list: readonly { id: string; version: string }[] | undefined) =>
          (list ?? []).map(({ id, version }) => `${id}@${version}`).sort();
        expect(prompts(definition?.prompts)).toEqual(prompts("prompts" in source ? source.prompts : undefined));
      });

      it("each effect's class is the class its source definition gives it, and none is external", () => {
        for (const [effect, effectClass] of Object.entries(source.effectClasses)) {
          expect(EFFECT_CLASS[effect as EffectName], effect).toBe(effectClass);
        }
        for (const effect of Object.values(registered?.definition.outputs ?? {}))
          expect(EFFECT_CLASS[effect], effect).not.toBe("external");
      });

      // The registry's thresholds are the pinned constants beside the source's definition.
      it("the registry's thresholds equal the source's", () => {
        if (!("thresholds" in source)) {
          expect(registered?.thresholds).toBeUndefined();
          return;
        }
        expect(registered?.thresholds).toEqual(source.thresholds);
        expect(POINT_THRESHOLDS[`${source.id}@${source.version}`]).toEqual(source.thresholds);
      });

      it("each pinned prompt hash is the text hash EXTRACT_PROMPTS records", () => {
        for (const prompt of registered?.definition.prompts ?? []) {
          const recorded = [...EXTRACT_PROMPTS, DECIDE_SCREEN, DECIDE_RECOVERY, DECIDE_RECORD].find(
            (one) => one.id === prompt.id && one.version === prompt.version,
          );
          expect(recorded, prompt.id).toBeDefined();
          expect(PROMPT_PINS[`${prompt.id}@${prompt.version}`]).toBe(recorded?.textHash);
        }
        if ("pins" in source)
          for (const pin of source.pins) expect(PROMPT_PINS[`${pin.id}@${pin.version}`]).toBe(pin.textHash);
      });
    });
  }

  it("every pin of an extraction prompt, one a later version replaced included, is the text hash EXTRACT_PROMPTS records", () => {
    const recorded = new Map(
      [...EXTRACT_PROMPTS, DECIDE_SCREEN, DECIDE_RECOVERY, DECIDE_RECORD].map((prompt) => [
        `${prompt.id}@${prompt.version}`,
        prompt.textHash,
      ]),
    );
    const pinned = Object.entries(PROMPT_PINS).filter(([key]) => recorded.has(key));
    expect(pinned.map(([key]) => key)).toContain("personal_correspondence@1");
    for (const [key, hash] of pinned) expect(hash, key).toBe(recorded.get(key));
    // Every extraction prompt is pinned: a recorded prompt with no pin could be edited unseen.
    for (const key of recorded.keys()) expect(Object.keys(PROMPT_PINS), key).toContain(key);
  });

  it("extraction, jev-item-decisions and jev-calibration have the six points the registry holds for them", () => {
    expect(EXTRACT_DECISION_POINTS.map((point) => point.id)).toEqual([
      "extract_triage",
      "extract_claims",
      "extract_injection",
      "extract_sensitivity",
      "extract_recovery",
      "record_injection",
    ]);
  });
});

// The store draws and stores a verdict's band with its own copy of the bands, since it may not
// import the ladder; the ladder's report reads them. The two agree on every edge.
describe("the bands of a verdict", () => {
  it("the store's bandOf equals the ladder's at and around every edge", async () => {
    const { bandOf: storeBand } = await import("@intelligence/personal-store");
    const { bandOf: ladderBand, BANDS } = await import("@intelligence/personal-ladder");
    const probes = [
      0,
      1,
      ...BANDS.flatMap(([low, high]) => [low, high, Math.max(0, low - 1e-9), Math.min(1, high - 1e-9)]),
    ];
    for (const p of probes) expect(storeBand(p), String(p)).toBe(ladderBand(p));
  });
});
