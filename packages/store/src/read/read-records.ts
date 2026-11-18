import {
  type AgentWriteKind,
  type ClientName,
  type ClientView,
  EntityId,
  FIND_RECORDS_CHARS,
  FindRecordsArgs,
  ReadRecordArgs,
  type RecordFind,
  type RecordRead,
} from "@intelligence/contracts/personal";
import type { Ctx } from "../core/read-ctx.ts";
import { type Entity, type Found, shownOnly } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { CORRECTED } from "../core/visibility.ts";
import { FACT_RESTS_ON_RECORD, seconds } from "./read-fact-rows.ts";
import { loadGroups } from "./read-groups.ts";
import { type RecordRow, recordItem } from "./read-pack-items.ts";
import { ENTITY_OR_PROJECT, PROJECT } from "./read-tools.ts";

// read_record and find_records: an agent's notes, findings and handoffs read back. Every statement
// runs under the caller's token, so a row its policy does not return changes nothing it is served
// (invariant 6): the filters are terms over returned rows, nothing is counted or ranked, and text is
// matched in the masked text the caller would be served, so a masked value is no oracle.

// `kind` is any kind a record takes: read_record may open one of another kind (ONE).
type Row = Omit<RecordRow, "kind"> & { kind: AgentWriteKind; project_id: string | null };
const COLUMNS = "w.id, w.kind, w.client_name, w.created_at, w.compartments, w.body_enc, w.project_id";

// A note, a finding, a handoff, a lesson or a capability by its id, whatever its writer, as the row
// policy returns it: an id is how a handoff reaches the next holder. A record of another kind (a
// proposal, an answer, a close, a fill, a memory change) only when a fact the caller may see rests
// on it, as find_facts and get_evidence_span name it: one no visible fact rests on is not served
// alone. One statement whatever the rows.
const ONE = `
  select ${COLUMNS} from ledger.agent_writes w
  where w.id = $1
    and (w.kind in ('note', 'finding', 'handoff', 'lesson', 'capability')
      or (w.evidence_id is not null and ${FACT_RESTS_ON_RECORD}))
  order by w.id`;

// Notes and findings of any client the caller may see, and the caller's own handoffs (another's is
// reached by its id), with a body and with no live correction, as the pack's notes leave them out.
const FIND = `
  select ${COLUMNS} from ledger.agent_writes w
  where (w.kind in ('note', 'finding', 'lesson', 'capability') or (w.kind = 'handoff' and w.client_name = $1)) and w.body_enc is not null
    and ($2::text is null or w.project_id = $2)
    and ($3::text is null or w.client_name = $3)
    and ($4::float8 is null or w.created_at >= to_timestamp($4))
    and ($5::float8 is null or w.created_at <= to_timestamp($5))
    and ($6::text[] is null or w.evidence_id in (
      select c.evidence_id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
      where n.entity_id = any($6::text[])))
    and not ${CORRECTED}
  order by w.created_at desc, w.id
  limit $7`;

const VISIBLE_PROJECTS = "select p.id from knowledge.projects p where p.id = any($1) order by p.id";

// How many rows a call with a text filter opens at most, newest first. A call that stops here says
// `more`, so the caller narrows by date, client or project.
const FIND_RECORDS_SCAN = 500;
const FIND_RECORDS_DEFAULT = 20;

const holdsWork = (client: ClientView): boolean => client.views.includes("work");

// Which of the rows' projects this caller may be told: with the work view, those its token returns.
async function shownProjects(ctx: Ctx, rows: readonly Row[], client: ClientView): Promise<ReadonlySet<string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.project_id === null ? [] : [row.project_id])))];
  if (!holdsWork(client) || ids.length === 0) return new Set();
  return new Set((await ctx.run<{ id: string }>(VISIBLE_PROJECTS, [ids])).map((row) => row.id));
}

// The row as served, its body masked and cut, with its project when the caller may be told it. A body
// that does not open is left out with a trace of ids, as a pack leaves it out.
function served(ctx: Ctx, row: Row, projects: ReadonlySet<string>, cut: number | undefined): RecordRead | null {
  // The pack's record shape, whose kind is one of five; the kind served is the row's own.
  const item = recordItem(ctx, row as RecordRow, "notes", false, cut);
  if (item === null || item.kind !== "record") return null;
  return {
    ...(item.record as RecordRead),
    kind: row.kind,
    // An erased record names nothing: its row keeps the id, and its sealed item, with the evidence row,
    // is gone.
    ...(row.body_enc !== null && row.project_id !== null && projects.has(row.project_id)
      ? { project: EntityId.parse(row.project_id) }
      : {}),
  };
}

async function readRecord(ctx: Ctx, args: ReadRecordArgs, client: ClientView): Promise<Found<RecordRead> | null> {
  const [row] = await ctx.run<Row>(ONE, [args.record]);
  if (row === undefined) return null;
  const value = served(ctx, row, await shownProjects(ctx, [row], client), undefined);
  if (value === null) return null;
  return { value, rows: 1, read: shownOnly([row.id]) };
}

// The ids a project or subject filter reads by; null when one names nothing the caller sees. Both
// statements run whichever the answer, so a hidden row and an absent one are alike.
async function filters(
  ctx: Ctx,
  args: FindRecordsArgs,
  client: ClientView,
): Promise<{ project: string | null; members: string[] | null } | null> {
  let project: string | null = null;
  if (args.project !== undefined) {
    const found = await ctx.run(PROJECT, [args.project]);
    if (found.length === 0 || !holdsWork(client)) return null;
    project = args.project;
  }
  if (args.subject === undefined) return { project, members: null };
  const [entity] = await ctx.run<Entity>(ENTITY_OR_PROJECT, [args.subject]);
  // Its own view too, as get_entity asks: which people exist is no answer to a client without people.
  if (entity === undefined || !client.views.includes(entity.kind === "project" ? "work" : "people")) return null;
  const members = entity.kind === "person" ? (await loadGroups(ctx)).membersOf(entity.id) : [entity.id];
  return { project, members };
}

async function findRecords(ctx: Ctx, args: FindRecordsArgs, client: ClientView): Promise<Found<RecordFind> | null> {
  const narrowed = await filters(ctx, args, client);
  if (narrowed === null) return null;
  const limit = args.limit ?? FIND_RECORDS_DEFAULT;
  const words = args.text?.toLowerCase();
  const scan = words === undefined ? limit + 1 : FIND_RECORDS_SCAN + 1;
  const rows = await ctx.run<Row>(FIND, [
    client.name as ClientName,
    narrowed.project,
    args.client ?? null,
    seconds(args.from),
    seconds(args.to),
    narrowed.members,
    scan,
  ]);
  const looked = rows.slice(0, scan - 1);
  const kept =
    words === undefined
      ? looked
      : looked.filter((row) => {
          const whole = recordItem(ctx, row as RecordRow, "notes", false, undefined);
          return whole?.kind === "record" && whole.record.body?.untrusted.toLowerCase().includes(words) === true;
        });
  const page = kept.slice(0, limit);
  const projects = await shownProjects(ctx, page, client);
  const records = page.flatMap((row) => served(ctx, row, projects, FIND_RECORDS_CHARS) ?? []);
  return {
    value: { records, more: kept.length > limit || rows.length > looked.length },
    rows: records.length,
    read: shownOnly(records.map((one) => one.id)),
  };
}

export const READ_RECORD_TOOL: ReadTool<ReadRecordArgs, RecordRead> = {
  tool: "read_record",
  parse: (args) => parsed(ReadRecordArgs.safeParse(args)),
  work: (ctx, valid, client) => readRecord(ctx, valid, client),
};

export const FIND_RECORDS_TOOL: ReadTool<FindRecordsArgs, RecordFind> = {
  tool: "find_records",
  parse: (args) => parsed(FindRecordsArgs.safeParse(args)),
  work: (ctx, valid, client) => findRecords(ctx, valid, client),
};
