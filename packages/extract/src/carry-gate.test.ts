import { describe, expect, it } from "vitest";
import { EXTRACT_GENERATION } from "./config.ts";
import { runExtraction } from "./run.ts";
import { type Setup, setup } from "./test-support/support.ts";

const RAISED = EXTRACT_GENERATION + 1;
const generations = (s: Setup): number[] => [...new Set(s.store.claims().map((one) => one.claim.extractorGeneration))];
const events = (s: Setup): string[] => s.log.lines.map((line) => line.event.event);
const gated = (s: Setup, gate: { refused: boolean; max: number; unanchored: number; detached: number } | "fails") => ({
  ...s.deps,
  generation: RAISED,
  store: {
    ...s.store,
    carryGate: async () => {
      if (gate === "fails") throw new Error("down");
      return gate;
    },
  },
});

describe("the carry-over gate in a run", () => {
  it("a refused generation leaves every item due again by it untouched, and says so by counts", async () => {
    const s = await setup();
    expect(await runExtraction(s.deps)).toMatchObject({ code: "ok" });
    expect(generations(s)).toEqual([EXTRACT_GENERATION]);
    const claims = s.store.claims().length;

    const held = await runExtraction(gated(s, { refused: true, max: 0, unanchored: 0, detached: 2 }));
    expect(held).toMatchObject({ code: "ok" });
    expect(generations(s)).toEqual([EXTRACT_GENERATION]);
    expect(s.store.claims()).toHaveLength(claims);
    const refused = s.log.lines.find((line) => line.event.event === "carry_gate_refused");
    expect(refused?.level).toBe("warn");
    expect(refused?.event.counts).toEqual({ generation: RAISED, unanchored: 0, detached: 2, max: 0 });
    const left = s.log.lines.find((line) => line.event.event === "carry_gate_items_held");
    expect(left?.event.counts?.held).toBeGreaterThan(0);
  });

  it("the control: with the gate open the same run raises the items", async () => {
    const s = await setup();
    await runExtraction(s.deps);
    await runExtraction(gated(s, { refused: false, max: 0, unanchored: 0, detached: 0 }));
    expect(generations(s)).toEqual([RAISED]);
    expect(events(s)).not.toContain("carry_gate_refused");
    expect(events(s)).not.toContain("carry_gate_items_held");
  });

  it("a gate that cannot be read holds, the safer state", async () => {
    const s = await setup();
    await runExtraction(s.deps);
    await runExtraction(gated(s, "fails"));
    expect(generations(s)).toEqual([EXTRACT_GENERATION]);
    expect(events(s)).toContain("carry_gate_failed");
  });

  it("a refused gate holds nothing of a first run: a new item is no change of generation", async () => {
    const s = await setup();
    await runExtraction(gated(s, { refused: true, max: 0, unanchored: 3, detached: 0 }));
    expect(generations(s)).toEqual([RAISED]);
    expect(events(s)).not.toContain("carry_gate_items_held");
  });
});
