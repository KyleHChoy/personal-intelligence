import { OUTCOME_CASES, type OutcomeEvalCase, outcomeCaseCounts } from "@intelligence/personal-core/testing";
import { describe, expect, it } from "vitest";
import type { AskOutcome } from "../outcome-judge.ts";
import { evaluateOutcomes, OUTCOME_KINDS, outcomeEvalLines } from "../test-support/eval-outcomes.ts";
import { R11_POSITIVES } from "../test-support/eval-relations.ts";

// The outcome judge scored per link kind on the outcome set, precision
// and recall, with false links counted, over
// stub model calls (no model is called, and nothing is spent). An oracle stub, which answers what a
// careful reader would, shows what code's rules and bounds make of right answers and what the set
// can certify per kind at best; a careless stub shows false links counted; an injection that is
// flagged never yields a link. The report's lines are printed so a reader can see the numbers.

const byId = new Map(OUTCOME_CASES.map((one) => [`facts:${one.id}`, one]));
// A strong cite: the passage's first six words, as written.
const citeOf = (one: OutcomeEvalCase): string => one.passage.split(/\s+/).slice(0, 6).join(" ");
const stub =
  (answer: (one: OutcomeEvalCase, expectedFirst: boolean) => OutcomeEvalCase["reading"]): AskOutcome =>
  async ({ subject, slot }) => {
    const one = byId.get(subject);
    if (one === undefined) return "unavailable";
    const expectedFirst = Object.keys(JSON.parse(slot) as object)[0] === "expected";
    return { output: { outcome: answer(one, expectedFirst), cites: [{ text: citeOf(one) }] } };
  };

describe("the outcome set", () => {
  it("covers every source, both paths, every scenario the plan names, and each kind with positives; each case is its own passage", () => {
    expect(new Set(OUTCOME_CASES.map((one) => one.source))).toEqual(
      new Set(["mail", "calendar", "document", "contacts", "lens_meeting", "lens_moment", "chat", "agent_finding"]),
    );
    expect(new Set(OUTCOME_CASES.map((one) => one.path))).toEqual(new Set(["watched", "open"]));
    for (const scenario of [
      "unexpected_source",
      "polite_decline",
      "partial_progress",
      "coincidence",
      "injection",
      "third_party",
    ])
      expect(
        OUTCOME_CASES.some((one) => one.scenario === scenario),
        scenario,
      ).toBe(true);
    // Coincidences that are observed, not caused.
    expect(OUTCOME_CASES.some((one) => one.scenario === "coincidence" && one.attribution === "observed")).toBe(true);
    expect(new Set(OUTCOME_CASES.map((one) => one.passage)).size).toBe(OUTCOME_CASES.length);
    const counts = outcomeCaseCounts();
    for (const kind of OUTCOME_KINDS) expect(counts[kind], kind).toBeGreaterThan(10);
  });
});

describe("the outcome judge scored per kind", () => {
  it("an oracle's answers are written right: every link correct, injections flagged count as nothing, the bound and the rule applied", async () => {
    const report = await evaluateOutcomes(
      OUTCOME_CASES,
      stub((one) => one.reading),
    );
    for (const line of outcomeEvalLines(report)) console.log(line);
    for (const kind of report.kinds) {
      expect(kind.falseLinks, kind.kind).toBe(0);
      expect(kind.recall, kind.kind).toBe(1);
      // What even a perfect score on this many positives certifies, below the 100 a kind needs.
      expect(kind.short, kind.kind).toBe(Math.max(0, R11_POSITIVES - kind.positives));
    }
    expect(report.unrelated.falseLinks).toBe(0);
    expect(report.flagged.links).toBe(0);
    expect(report.attribution.correct).toBe(report.attribution.links);
    // Every third-party met that waits on a named person became advances.
    expect(report.bounded).toBe(OUTCOME_CASES.filter((one) => one.scenario === "third_party").length);
    // The declines on the work's thread by the person, after its move, are code's.
    expect(report.ruled).toBe(
      OUTCOME_CASES.filter(
        (one) =>
          one.item.decline && one.item.reply && one.item.fromPerson && one.item.afterMove && one.path === "watched",
      ).length,
    );
  });

  it("a careless judge's links are counted false, and still none comes from a flagged item", async () => {
    const report = await evaluateOutcomes(
      OUTCOME_CASES,
      stub(() => "met"),
    );
    const met = report.kinds.find((one) => one.kind === "met");
    expect(met?.falseLinks).toBeGreaterThan(0);
    expect(met?.precision).toBeLessThan(0.5);
    expect(report.unrelated.falseLinks).toBeGreaterThan(0);
    expect(report.flagged.links).toBe(0);
  });

  it("a judge whose answer turns on the order writes nothing it disagrees on", async () => {
    const report = await evaluateOutcomes(
      OUTCOME_CASES,
      stub((one, expectedFirst) => (expectedFirst ? one.reading : one.reading === "met" ? "partial" : "met")),
    );
    expect(report.disagreed).toBeGreaterThan(0);
    for (const kind of report.kinds) expect(kind.falseLinks, kind.kind).toBe(0);
  });
});
