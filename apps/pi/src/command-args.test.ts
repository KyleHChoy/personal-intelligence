// Covers command-args.ts: what `pi health job` keeps of the counts the night's pass printed.
import { describe, expect, it } from "vitest";
import { dreamRowOf, healthJobOf } from "./command-args.ts";

const STAGES = { recall: 0, fulfils: 4, sweep: 30, sourceCheck: 9, hotCheck: 2 };
const COLUMNS = { recall: 0, fulfils: 4, sweep: 30, source_check: 9, hot_check: 2 };
const job = (positionals: string[], values: Record<string, string | boolean>) =>
  healthJobOf({ positionals, values } as never);

describe("pi health job --counts (imp_01M6ST6JZ4PW9BWNWVN61DHHMR)", () => {
  it("keeps the night's backlog and each stage's spend under its name in the row, and nothing else it printed", () => {
    const printed = JSON.stringify({ sweep: { pairs: 3 }, backlog: 12, stageMicroUsd: STAGES, stopped: "budget" });
    expect(job(["dream", "budget"], { started: "1794555150", counts: printed })).toEqual({
      job: "dream",
      code: "budget",
      startedAt: new Date(1_794_555_150_000),
      backlog: 12,
      stageMicroUsd: COLUMNS,
    });
  });

  it("counts that are not the pass's keep neither, and the run is still recorded", () => {
    expect(dreamRowOf("not json")).toEqual({});
    expect(dreamRowOf("null")).toEqual({});
    expect(dreamRowOf('{"stopped":"unavailable"}')).toEqual({});
    expect(dreamRowOf(JSON.stringify({ backlog: -1, stageMicroUsd: { ...STAGES, sweep: 1.5 } }))).toEqual({});
    // Every stage or none: a missing one keeps no stage, the backlog still.
    const { hotCheck: _, ...missing } = STAGES;
    expect(dreamRowOf(JSON.stringify({ backlog: 0, stageMicroUsd: missing }))).toEqual({ backlog: 0 });
    expect(job(["dream", "ok"], { started: "1794555150", counts: "{" })).toEqual({
      job: "dream",
      code: "ok",
      startedAt: new Date(1_794_555_150_000),
    });
  });

  it("takes counts for the night's pass alone", () => {
    expect(() => job(["extract", "ok"], { started: "1794555150", counts: "{}" })).toThrow();
    expect(() => job(["dream", "ok"], { started: "1794555150", counts: true })).toThrow();
  });
});
