import {
  type AgentRecordId,
  MemoryImportView,
  RestatementAnswer,
  RestatementView,
  type RulingId,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { stamp, stampOrNull } from "../../core/db.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { taintCiting } from "../../erasure/taint.ts";
import { removeRecords } from "../../write/writer-records.ts";
import { setRecordWaiting, tryExtractLock } from "../extraction/admin-extraction.ts";

// The owner's reads and clears of restatement marks, run as pi_admin. The list holds ids, names,
// codes and times, and a claim key's first 16 characters: no content.

export type RestatementFilter = { client?: string; answer?: string; limit?: number };

const RESTATEMENTS_LISTED = 200;

// A filter the list takes: an answer of its own list, and a limit of 1 to 200. A client is any
// name; one that is no client lists nothing.
export function validRestatementFilter(filter: RestatementFilter): boolean {
  const { answer, limit } = filter;
  if (answer !== undefined && !RestatementAnswer.safeParse(answer).success) return false;
  return limit === undefined || (Number.isSafeInteger(limit) && limit >= 1 && limit <= RESTATEMENTS_LISTED);
}

const LIST = `
  select r.id::text as id, c.name, r.record_id, left(r.claim_key, 16) as prefix, r.answer, r.reached, r.checked_at, r.cleared_at
  from ledger.restatement_checks r join policy.clients c on c.id = r.client_id
  where ($1::text is null or c.name = $1) and ($2::text is null or r.answer = $2)
  order by r.checked_at desc, r.id desc
  limit $3`;

export async function listRestatements(ctx: AdminContext, filter: RestatementFilter = {}): Promise<RestatementView> {
  if (!validRestatementFilter(filter)) throw new AdminError("invalid_argument");
  return ctx.transaction(async (query) => {
    const rows = await query<{
      id: string;
      name: string;
      record_id: string;
      prefix: string;
      answer: string;
      reached: string | null;
      checked_at: Date;
      cleared_at: Date | null;
    }>(LIST, [filter.client ?? null, filter.answer ?? null, filter.limit ?? 50]);
    return RestatementView.parse(
      rows.map((row) => ({
        id: Number(row.id),
        client: row.name,
        recordId: row.record_id,
        claimKeyPrefix: row.prefix,
        answer: row.answer,
        reached: row.reached,
        checkedAt: stamp(row.checked_at),
        clearedAt: stampOrNull(row.cleared_at),
      })),
    );
  });
}

// One transaction. Throws "not_found" for an id that names no mark or a mark whose record has no body,
// "already_cleared" for one cleared before, and "extract_running" while a run holds the extract lock.
export async function clearRestatement(
  ctx: AdminContext,
  id: number,
  options: { requestId: string },
): Promise<RulingId> {
  if (!Number.isSafeInteger(id) || id < 1) throw new AdminError("not_found");
  return ctx.transaction(async (query) => {
    const tx = { query, keys: ctx.keys };
    await tryExtractLock(tx);
    // The shared taint lock and the record's row lock first, as `pi agent-records release` takes
    // them, so a removal or an erasure of the record is not halfway under the clear.
    const [named] = await query<{ record_id: string }>(
      "select record_id from ledger.restatement_checks where id = $1",
      [id],
    );
    if (named === undefined) throw new AdminError("not_found");
    await lockRows(query, [named.record_id]);
    const [row] = await query<{
      record_id: string;
      cleared: boolean;
      evidence_id: string | null;
      body: boolean;
      compartments: string[];
    }>(
      `select r.record_id, r.cleared_at is not null as cleared, w.evidence_id, w.body_enc is not null as body, w.compartments
       from ledger.restatement_checks r join ledger.agent_writes w on w.id = r.record_id where r.id = $1 for update of r, w`,
      [id],
    );
    if (row === undefined || !row.body || row.evidence_id === null) throw new AdminError("not_found");
    if (row.cleared) throw new AdminError("already_cleared");
    const ruling = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "restatement_clear",
        target: { kind: "agent_record", id: row.record_id as AgentRecordId },
        compartments: row.compartments,
      },
      ctx.now(),
    );
    await query("update ledger.restatement_checks set cleared_at = $2, cleared_by = $3 where id = $1", [
      id,
      stamp(ctx.now()),
      ruling,
    ]);
    // Waiting, with its saved calls and its release kept, and no attempts.
    await setRecordWaiting(tx, row.evidence_id, row.compartments, { attempts: 0 });
    return ruling;
  });
}

// The owner's view of memory coming back: for each client with an import row, its rows counted by mark, and
// its latest import time. No locator, no text. A name that is no client is "not_found", as `pi memory status`
// answers one.
const IMPORTS = `
  select c.id, c.name,
    count(*) filter (where m.mark = 'new')::int as new, count(*) filter (where m.mark = 'echo')::int as echo,
    count(*) filter (where m.mark = 'stale')::int as stale, count(*) filter (where m.mark = 'refused')::int as refused,
    max(m.created_at) as latest_at
  from ledger.memory_imports m join policy.clients c on c.id = m.client_id
  where $1::text is null or c.name = $1
  group by c.id, c.name
  order by c.name`;

export async function memoryImports(ctx: AdminContext, client?: string): Promise<MemoryImportView> {
  return ctx.transaction(async (query) => {
    if (client !== undefined && (await query("select 1 from policy.clients where name = $1", [client])).length === 0)
      throw new AdminError("not_found");
    const rows = await query<{
      id: string;
      name: string;
      new: number;
      echo: number;
      stale: number;
      refused: number;
      latest_at: Date | null;
    }>(IMPORTS, [client ?? null]);
    return MemoryImportView.parse({
      clients: rows.map((row) => ({
        client: row.id,
        name: row.name,
        marks: { new: row.new, echo: row.echo, stale: row.stale, refused: row.refused },
        latestAt: stampOrNull(row.latest_at),
      })),
    });
  });
}

// `pi memory purge NAME`: every memory change of one client that still has a body, removed as
// removeOne removes one, with one taint call for their evidence rows, in one transaction; how
// many. Throws "not_found" for a name that is no
// client. Its import rows stay, as the record of what was sent.
export async function purgeMemory(ctx: AdminContext, name: string): Promise<{ removed: number }> {
  return ctx.transaction(async (query) => {
    const [client] = await query<{ id: string }>("select id from policy.clients where name = $1", [name]);
    if (client === undefined) throw new AdminError("not_found");
    const ids = (
      await query<{ id: string }>(
        "select id from ledger.agent_writes where client_id = $1 and kind = 'memory_change' and body_enc is not null order by id",
        [client.id],
      )
    ).map((row) => row.id);
    const { removed, evidenceIds } = await removeRecords({ query }, ids);
    if (evidenceIds.length > 0) await taintCiting(query, { evidenceIds, refs: [] });
    return { removed };
  });
}
