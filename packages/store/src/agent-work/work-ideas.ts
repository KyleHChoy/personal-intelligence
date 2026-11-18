import type { HypothesisId, ListIdeasArgs, ListIdeasResult } from "@intelligence/contracts/personal";
import { stamp } from "../core/db.ts";
import { servedOrNull } from "../core/read-ctx.ts";
import { type Done, isRefused, refused, type WorkCall } from "../core/work-refs.ts";
import { evidenceOf, type IdeaRow } from "../core/work-views.ts";

// list_ideas, as pi_reader: the ideas the caller can see, newest evidence first, from the one
// definer that checks the caller and reads only rows within its clearance. Each idea's text is
// opened under its label, untrusted; the evidence is kinds and times, never ids.

const LIST = `select id, filed_by, created_at, latest_at, status, compartments, body_enc, cited, evidence_kinds, evidence_at
  from ledger.list_ideas($1::integer)`;
const DEFAULT_LIMIT = 20;

export async function listIdeas(call: WorkCall, valid: ListIdeasArgs): Promise<Done<ListIdeasResult>> {
  const rows = await call.fn<IdeaRow>(LIST, [valid.limit ?? DEFAULT_LIMIT]);
  if (isRefused(rows)) return refused(rows);
  const ideas = rows.map((row) => ({
    id: row.id as HypothesisId,
    idea: servedOrNull(
      call.ctx.keys,
      row.compartments,
      { table: "ledger.hypotheses", id: row.id, column: "body_enc" },
      row.body_enc,
    ),
    filedBy: row.filed_by,
    filedAt: stamp(row.created_at),
    latestAt: stamp(row.latest_at),
    status: row.status,
    evidence: evidenceOf(row),
    cited: row.cited,
  }));
  return { outcome: { ok: true, value: { ideas } as ListIdeasResult }, rows: ideas.length };
}
