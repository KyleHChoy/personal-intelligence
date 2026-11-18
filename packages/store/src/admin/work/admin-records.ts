import type { Timestamp } from "@intelligence/contracts";
import { type AgentRecordId, AgentWriteKind, type ClientName } from "@intelligence/contracts/personal";
import { AdminError } from "../../core/admin-error.ts";
import { stamp } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { openUnder } from "../../core/seal.ts";
import type { Tx } from "../../core/tx.ts";
import { removeOne } from "../../write/writer-records.ts";

// The owner's reads and removal of agent records, run as pi_admin. The list holds ids, names,
// kinds, times, labels, states and flags, and no content; one agent record's body is opened only by
// `recordOf`, for a terminal.

export const RECORD_STATES = ["appended", "taken", "refused", "removed"] as const;
type RecordState = (typeof RECORD_STATES)[number];

export type RecordRow = {
  id: AgentRecordId;
  client: ClientName;
  kind: AgentWriteKind;
  createdAt: Timestamp;
  compartments: string[];
  state: RecordState;
  flagged: boolean;
};

export type RecordView = RecordRow & { body: string | null; cites: string[]; refusedCode: string | null };

export type RecordFilter = { client?: string; kind?: string; state?: string; limit?: number };

const RECORDS_LISTED = 200;

// A row's state from its three columns: with no body it is removed, whatever its code.
const STATE = `case when body_enc is null then 'removed' when refused_code is not null then 'refused' when evidence_id is not null then 'taken' else 'appended' end`;

const LIST = `
  select id, client_name, kind, created_at, compartments, flagged_at is not null as flagged, ${STATE} as state
  from ledger.agent_writes
  where ($1::text is null or client_name = $1) and ($2::text is null or kind = $2) and ($3::text is null or ${STATE} = $3)
  order by created_at desc, id desc
  limit $4`;

type Stored = {
  id: string;
  client_name: string;
  kind: AgentWriteKind;
  created_at: Date;
  compartments: string[];
  flagged: boolean;
  state: RecordState;
};

const rowOf = (row: Stored): RecordRow => ({
  id: row.id as AgentRecordId,
  client: row.client_name,
  kind: row.kind,
  createdAt: stamp(row.created_at),
  compartments: row.compartments,
  state: row.state,
  flagged: row.flagged,
});

// Whether a filter is one the list takes: a kind of every agent-lane write (`proposal` and
// `memory_change` among them) and a state of their own lists, and a limit of 1 to 200. A client is
// any name; one that is no client lists nothing.
export function validFilter(filter: RecordFilter): boolean {
  const { kind, state, limit } = filter;
  if (kind !== undefined && !AgentWriteKind.safeParse(kind).success) return false;
  if (state !== undefined && !(RECORD_STATES as readonly string[]).includes(state)) return false;
  return limit === undefined || (Number.isSafeInteger(limit) && limit >= 1 && limit <= RECORDS_LISTED);
}

export async function listRecords(tx: Tx, filter: RecordFilter = {}): Promise<RecordRow[]> {
  if (!validFilter(filter)) throw new AdminError("invalid_argument");
  const rows = await tx.query<Stored>(LIST, [
    filter.client ?? null,
    filter.kind ?? null,
    filter.state ?? null,
    filter.limit ?? RECORDS_LISTED,
  ]);
  return rows.map(rowOf);
}

// One agent record with its body opened under the admin's keys, or null for an id not there.
export async function recordOf(tx: Tx, id: string): Promise<RecordView | null> {
  const [row] = await tx.query<Stored & { body_enc: Sealed; cites: string[]; refused_code: string | null }>(
    `select id, client_name, kind, created_at, compartments, flagged_at is not null as flagged, ${STATE} as state, body_enc, cites, refused_code
     from ledger.agent_writes where id = $1`,
    [id],
  );
  if (row === undefined) return null;
  const body =
    row.body_enc === null
      ? null
      : openUnder(
          tx.keys,
          row.compartments,
          { table: "ledger.agent_writes", id: row.id, column: "body_enc" },
          row.body_enc,
        );
  return { ...rowOf(row), body, cites: row.cites, refusedCode: row.refused_code };
}

export async function removeRecord(tx: Tx, id: string): Promise<{ removed: number } | null> {
  const [row] = await tx.query<{ id: string }>("select id from ledger.agent_writes where id = $1", [id]);
  if (row === undefined) return null;
  return { removed: (await removeOne(tx, id)) ? 1 : 0 };
}
