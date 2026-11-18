import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { percentiles, readMeasureOf } from "../read/read-measure.ts";
import type { Query } from "./db.ts";
import { statementId, statementTimer } from "./statement-timer.ts";

// Read performance, step 1 (`pia extract measure-reads`): the wrapper that times every statement
// of a read path by its statement id, and the work between statements as `other`.

// A clock the test moves: each statement takes `ms` of it, and the work around them `gap`.
const fakeClock = (): { clock: () => number; advance: (ms: number) => void } => {
  let now = 0;
  return { clock: () => now, advance: (ms) => (now += ms) };
};

describe("statementId", () => {
  it("is the first 8 hex characters of sha256 of the text with its whitespace collapsed, and its first 6 words", () => {
    const text = "\n  select a.id, a.value_fp\n  from knowledge.accounts a\n  where a.entity_id = any($1)";
    const collapsed = "select a.id, a.value_fp from knowledge.accounts a where a.entity_id = any($1)";
    expect(statementId(text)).toEqual({
      id: createHash("sha256").update(collapsed).digest("hex").slice(0, 8),
      words: "select a.id, a.value_fp from knowledge.accounts a",
    });
    // The same statement indented otherwise is the same id.
    expect(statementId(collapsed)).toEqual(statementId(text));
    expect(statementId("select 1").id).not.toBe(statementId("select 2").id);
  });
});

describe("statementTimer", () => {
  it("times each statement by its id, each call whole, and the rest of a call as other", async () => {
    const { clock, advance } = fakeClock();
    const ran: unknown[][] = [];
    const query: Query = async <Row>(text: string, values?: unknown[]): Promise<Row[]> => {
      ran.push([text, values]);
      advance(text === "select slow" ? 30 : 10);
      return [{ text } as Row];
    };
    const timer = statementTimer(query, clock);
    const one = await timer.call(async () => {
      advance(5);
      const rows = await timer.run<{ text: string }>("select slow", [1]);
      await timer.run("select   fast");
      advance(7);
      return rows;
    });
    await timer.call(async () => {
      await timer.run("select fast", ["x"]);
      advance(2);
    });
    expect(one).toEqual([{ text: "select slow" }]);
    expect(ran).toEqual([
      ["select slow", [1]],
      ["select   fast", undefined],
      ["select fast", ["x"]],
    ]);
    expect(timer.calls).toEqual([52, 12]);
    expect(timer.other).toEqual([12, 2]);
    expect([...timer.statements.entries()]).toEqual([
      [statementId("select slow").id, { words: "select slow", ms: [30] }],
      [statementId("select fast").id, { words: "select fast", ms: [10, 10] }],
    ]);
  });

  it("counts a failed statement and a failed call, and rethrows", async () => {
    const { clock, advance } = fakeClock();
    const failing: Query = async () => {
      advance(4);
      throw new Error("refused");
    };
    const timer = statementTimer(failing, clock);
    await expect(timer.call(() => timer.run("select 1"))).rejects.toThrow("refused");
    expect(timer.calls).toEqual([4]);
    expect(timer.other).toEqual([0]);
    expect(timer.statements.get(statementId("select 1").id)?.ms).toEqual([4]);
  });
});

describe("percentiles", () => {
  it("is the nearest rank, in milliseconds to two places", () => {
    const samples = Array.from({ length: 100 }, (_, n) => 100 - n + 0.004);
    expect(percentiles(samples)).toEqual({ count: 100, p50: 50, p95: 95, p99: 99 });
    expect(percentiles([7])).toEqual({ count: 1, p50: 7, p95: 7, p99: 7 });
    expect(percentiles([])).toEqual({ count: 0, p50: 0, p95: 0, p99: 0 });
  });
});

describe("readMeasureOf", () => {
  it("gives n, p50, p95 and max of the calls, the top 10 statements by total time, and other's total", async () => {
    const { clock, advance } = fakeClock();
    const query: Query = async <Row>(text: string): Promise<Row[]> => {
      advance(Number(text.split(" ")[1]));
      return [];
    };
    const timer = statementTimer(query, clock);
    // Twelve statements, the n-th taking n ms; the 12th runs twice in the second call.
    await timer.call(async () => {
      for (let n = 1; n <= 12; n += 1) await timer.run(`select ${n}`);
      advance(1.5);
    });
    await timer.call(async () => {
      await timer.run("select 12");
      await timer.run("select 12");
    });
    const measure = readMeasureOf(timer);
    expect(measure).toMatchObject({ n: 2, p50: 24, p95: 79.5, max: 79.5, otherMs: 1.5 });
    expect(measure.statements).toHaveLength(10);
    expect(measure.statements[0]).toEqual({
      id: statementId("select 12").id,
      words: "select 12",
      calls: 3,
      totalMs: 36,
      p95Ms: 12,
    });
    expect(measure.statements.map((one) => one.words)).toEqual([
      "select 12",
      ...[11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `select ${n}`),
    ]);
  });

  it("is all zeros for a tool that was never called", () => {
    expect(readMeasureOf(statementTimer(async () => []))).toEqual({
      n: 0,
      p50: 0,
      p95: 0,
      max: 0,
      statements: [],
      otherMs: 0,
    });
  });
});
