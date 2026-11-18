import { describe, expect, it } from "vitest";
import { assessOutcomes, matchOutcomes, WATCH_SENDS, watchSends } from "./dispatch-learning.ts";

// The tick's two outcome steps are one function call each, with the tick's clock.

describe("the outcome steps", () => {
  it("each makes one call and returns its count", async () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    for (const [step, fn, written] of [
      [matchOutcomes, "ledger.match_outcomes", 3],
      [assessOutcomes, "ledger.assess_outcomes", 0],
    ] as const) {
      const calls: { text: string; values: unknown[] | undefined }[] = [];
      const query = async <Row>(text: string, values?: unknown[]): Promise<Row[]> => {
        calls.push({ text, values });
        return [{ written }] as Row[];
      };
      expect(await step(query, now)).toBe(written);
      expect(calls).toEqual([{ text: `select ${fn}($1) as written`, values: [now.toISOString()] }]);
    }
  });
});

// A send's thread is watched by one insert, which reads
// nothing back from the table pi_work cannot read.
describe("the send watch step", () => {
  it("makes one insert of the sent sends' threads, once a send", async () => {
    const calls: string[] = [];
    await watchSends(async <Row>(text: string): Promise<Row[]> => {
      calls.push(text);
      return [];
    });
    expect(calls).toEqual([WATCH_SENDS]);
    expect(WATCH_SENDS).toMatch(/on conflict do nothing\s*$/);
    expect(WATCH_SENDS).not.toMatch(/returning/i);
  });
});
