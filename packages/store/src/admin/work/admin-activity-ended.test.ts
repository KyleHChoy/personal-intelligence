import type { MoveId, MoveReportBody } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Query } from "../../core/db.ts";
import { endedOf } from "./admin-activity.ts";

const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const move = (n: number): MoveId => `mov_${ulid(n)}` as MoveId;
const record = (n: number): string => `rec_${ulid(n)}`;
const body = (summary: string | undefined, cites: string[] = []): MoveReportBody =>
  ({
    v: 1,
    ...(summary === undefined ? {} : { summary }),
    marks: [],
    ...(cites.length === 0 ? {} : { report: { sources: cites.map((id) => ({ kind: "agent_record", id })) } }),
  }) as unknown as MoveReportBody;

// A query that answers the one statement: the cited records still kept.
const keeping = (kept: string[], asked: string[][] = []): Query =>
  (async (_text: string, params?: unknown[]) => {
    asked.push(params?.[0] as string[]);
    return kept.map((id) => ({ id }));
  }) as unknown as Query;

describe("endedOf", () => {
  it("gives a done move with a summary its headline, found", async () => {
    const rows = [{ move_id: move(1), move_status: "done" as const }];
    const ended = await endedOf(keeping([]), rows, new Map([[move(1), body("Found the venue's owner.\nMore.")]]));
    expect(ended(rows[0] as (typeof rows)[0])).toEqual({
      resultOutcome: "found",
      headline: { untrusted: "Found the venue's owner." },
    });
  });

  it("reads a report's deliverable as what it found when there is no summary", async () => {
    const rows = [{ move_id: move(9), move_status: "done" as const }];
    const delivered = { v: 1, marks: [], report: { deliverable: "Twelve companies fit.\nThe list follows." } };
    const ended = await endedOf(keeping([]), rows, new Map([[move(9), delivered as unknown as MoveReportBody]]));
    expect(ended(rows[0] as (typeof rows)[0])).toEqual({
      resultOutcome: "found",
      headline: { untrusted: "Twelve companies fit." },
    });
  });

  it("is stopped with no headline when there is no summary or no readable report", async () => {
    const rows = [
      { move_id: move(2), move_status: "done" as const },
      { move_id: move(3), move_status: "done" as const },
    ];
    const asked: string[][] = [];
    const ended = await endedOf(keeping([], asked), rows, new Map([[move(2), body(undefined)]]));
    for (const row of rows) expect(ended(row)).toEqual({ resultOutcome: "stopped", headline: null });
    expect(asked).toEqual([]);
  });

  it("has no headline when the report cites a removed agent record, in one statement", async () => {
    const rows = [
      { move_id: move(4), move_status: "done" as const },
      { move_id: move(5), move_status: "done" as const },
    ];
    const asked: string[][] = [];
    const ended = await endedOf(
      keeping([record(7)], asked),
      rows,
      new Map([
        [move(4), body("Kept finding", [record(7)])],
        [move(5), body("Erased finding", [record(7), record(8)])],
      ]),
    );
    expect(ended(rows[0] as (typeof rows)[0])).toEqual({
      resultOutcome: "found",
      headline: { untrusted: "Kept finding" },
    });
    expect(ended(rows[1] as (typeof rows)[0])).toEqual({ resultOutcome: "stopped", headline: null });
    expect(asked).toEqual([[record(7), record(8)]]);
  });
});
