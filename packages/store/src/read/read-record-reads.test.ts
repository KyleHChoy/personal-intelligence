import { type PersonalLogger, RECORD_READS_LISTED, RecordReads } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Keys } from "../core/keys.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { orderFault } from "../test-support/order.ts";
import { NOTES_LEFT_OUT } from "./read-pack-items.ts";
import { recordReads } from "./read-record-reads.ts";

// Made-up values only.

const rec = (n: number): string => `rec_${String(n).padStart(26, "0")}`;
const at = (minute: number): Date => new Date(Date.UTC(2026, 2, 4, 10, minute));
const log: PersonalLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

type Row = Record<string, unknown>;
const row = (record: string, over: Row = {}): Row => ({
  record_id: record,
  kind: "note",
  created_at: at(0),
  superseded_by: null,
  erased: false,
  reader: null,
  first_at: null,
  last_at: null,
  reads: null,
  ...over,
});
const read = (record: string, reader: string, reads: number, over: Row = {}): Row =>
  row(record, { reader, first_at: at(1), last_at: at(2), reads, ...over });

function ctxOf(rows: Row[]): { ctx: Ctx; sent: { text: string; values: unknown[] }[] } {
  const sent: { text: string; values: unknown[] }[] = [];
  const run = async <T>(text: string, values: unknown[]): Promise<T[]> => {
    sent.push({ text, values });
    return rows as T[];
  };
  return {
    ctx: { run: run as Ctx["run"], keys: {} as Keys, session: () => Promise.reject(new Error("no session")), log },
    sent,
  };
}

describe("record_reads", () => {
  it("one entry per record, newest first as the function gave them, each with its readers and nothing of a body or a label", async () => {
    const { ctx, sent } = ctxOf([
      read(rec(2), "scout", 3, { created_at: at(5), superseded_by: rec(3) }),
      read(rec(2), "scribe", 1, { created_at: at(5), superseded_by: rec(3) }),
      row(rec(1), { kind: "handoff", erased: true }),
    ]);
    const found = await recordReads(ctx, {});
    expect(sent).toEqual([
      {
        text: expect.stringMatching(/from policy\.record_reads\(\$1, \$2\)$/),
        values: [null, RECORD_READS_LISTED + 1],
      },
    ]);
    expect(found).not.toBeNull();
    const value = RecordReads.parse(found?.value);
    expect(value).toEqual({
      records: [
        {
          record: rec(2),
          kind: "note",
          recordedAt: at(5).toISOString(),
          supersededBy: rec(3),
          erased: false,
          readers: [
            { client: "scout", firstAt: at(1).toISOString(), lastAt: at(2).toISOString(), count: 3 },
            { client: "scribe", firstAt: at(1).toISOString(), lastAt: at(2).toISOString(), count: 1 },
          ],
        },
        {
          record: rec(1),
          kind: "handoff",
          recordedAt: at(0).toISOString(),
          supersededBy: null,
          erased: true,
          readers: [],
        },
      ],
      more: false,
    });
    // The call shows the caller nothing that is not its own: its read log row names nothing.
    expect(found?.read).toEqual({ bound: [], shown: [], factKeyFps: [] });
    // Its rows count the records shown and their readers: two records, two readers.
    expect(found?.rows).toBe(4);
  });

  it("a named record is passed to the function; no row for it answers not_found", async () => {
    const { ctx, sent } = ctxOf([]);
    expect(await recordReads(ctx, { record: rec(9) as never })).toBeNull();
    expect(sent[0]?.values).toEqual([rec(9), RECORD_READS_LISTED + 1]);
    // With no record named, no row is an empty list, not not_found.
    expect((await recordReads(ctxOf([]).ctx, {}))?.value).toEqual({ records: [], more: false });
  });

  it("the function's one record more says more, and is not shown", async () => {
    const rows = Array.from({ length: RECORD_READS_LISTED + 1 }, (_, n) => row(rec(100 - n)));
    const found = await recordReads(ctxOf(rows).ctx, {});
    expect(found?.value.records).toHaveLength(RECORD_READS_LISTED);
    expect(found?.value.more).toBe(true);
    expect(found?.value.records.map((entry) => entry.record)).not.toContain(rec(100 - RECORD_READS_LISTED));
  });
});

describe("the notes statement (agent_bootstrap@9)", () => {
  it("leaves out a record with a live correction anywhere down its chain, before its limit, and keeps R19's order", () => {
    // The chain is followed through every link the row policy returns, an erased one included;
    // only a correction with a body leaves a record out.
    // policy.live_corrections is the one definition, asked of each row as the scan reaches it,
    // and only of one that a readable record supersedes: `case` asks the probe first.
    expect(NOTES_LEFT_OUT).toMatch(
      /and not case when exists \(select 1 from ledger\.agent_writes c where c\.supersedes = w\.id\)\s+then exists \(select 1 from policy\.live_corrections\(array\[w\.id\]\)\) else false end/,
    );
    expect(NOTES_LEFT_OUT).not.toContain("recursive");
    expect(NOTES_LEFT_OUT.indexOf("not case")).toBeLessThan(NOTES_LEFT_OUT.indexOf("limit $1"));
    expect(orderFault(NOTES_LEFT_OUT)).toBeNull();
    expect(orderFault(NOTES_LEFT_OUT.replace(/\n\s*order by w\.created_at[^\n]*/, ""))).not.toBeNull();
  });

  it("takes one parameter", () => {
    expect(NOTES_LEFT_OUT).not.toContain("$2");
  });
});
