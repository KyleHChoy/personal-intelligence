import {
  type AgentRecordId,
  type ClientName,
  RECORD_READS_LISTED,
  type RecordReads,
  RecordReadsArgs,
  type RecordReadsEntry,
} from "@intelligence/contracts/personal";
import { stamp } from "../core/db.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { type Found, shownOnly } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";

// record_reads: the caller's own records
// and the other clients the read log says were shown each. policy.record_reads is the one
// definition of which records are the caller's and of who read them: it answers no row for
// another client's record, as for an absent one, and returns ids, names, kinds, times and counts,
// never a body or a label. One row per record and reader, a null reader for a record no other
// client was shown, newest record first; asked for one record more than are shown, to say whether
// more matched.
const RECORD_READS =
  "select record_id, kind, created_at, superseded_by, erased, reader, first_at, last_at, reads from policy.record_reads($1, $2)";

// A row's receipt fields are all null exactly when no other client was shown the record.
type Row = {
  record_id: AgentRecordId;
  kind: RecordReadsEntry["kind"];
  created_at: Date;
  superseded_by: AgentRecordId | null;
  erased: boolean;
} & (
  | { reader: ClientName; first_at: Date; last_at: Date; reads: number }
  | { reader: null; first_at: null; last_at: null; reads: null }
);

// A named record that is not the caller's answers not_found. The call shows the caller nothing
// that is not its own, so its read log row names nothing.
export async function recordReads(ctx: Ctx, args: RecordReadsArgs): Promise<Found<RecordReads> | null> {
  const rows = await ctx.run<Row>(RECORD_READS, [args.record ?? null, RECORD_READS_LISTED + 1]);
  const records: RecordReadsEntry[] = [];
  for (const row of rows) {
    let entry = records.at(-1);
    if (entry?.record !== row.record_id) {
      entry = {
        record: row.record_id,
        kind: row.kind,
        recordedAt: stamp(row.created_at),
        supersededBy: row.superseded_by,
        erased: row.erased,
        readers: [],
      };
      records.push(entry);
    }
    if (row.reader !== null)
      entry.readers.push({
        client: row.reader,
        firstAt: stamp(row.first_at),
        lastAt: stamp(row.last_at),
        count: row.reads,
      });
  }
  if (args.record !== undefined && records.length === 0) return null;
  const shown = records.slice(0, RECORD_READS_LISTED);
  // Its rows are the records shown and their readers, as get_self counts its lines and people.
  return {
    value: { records: shown, more: records.length > RECORD_READS_LISTED },
    rows: shown.reduce((sum, entry) => sum + 1 + entry.readers.length, 0),
    read: shownOnly([]),
  };
}

// The caller's own records and the other clients shown each, view `self`: a list tool.
// policy.record_reads answers only for the caller's own records.
export const RECORD_READS_TOOL: ReadTool<RecordReadsArgs, RecordReads> = {
  tool: "record_reads",
  parse: (args) => parsed(RecordReadsArgs.safeParse(args)),
  work: (ctx, valid) => recordReads(ctx, valid),
};
