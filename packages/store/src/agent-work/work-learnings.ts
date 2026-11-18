import type { FileLearningArgs, FileLearningResult } from "@intelligence/contracts/personal";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { answered, type Done, isRefused, refused, sealSummary, type WorkCall } from "../core/work-refs.ts";
import { Unavailable } from "../read/read-ctx.ts";

// file_learning, as pi_reader: what an agent learned about the tools and ways of working, for every
// agent of its scope. The statement, rule and evidence are sealed here under the caller's clearance,
// bound to the new row; the definer decides the rest from the caller's token: its roles for the
// scope, what it can see for supersedes and a merge, and its day's count. It answers a code and the
// learning's id.

const SQL = "select learning_id, code from ledger.file_learning($1, $2, $3, $4, $5, $6, $7, $8, $9)";

export async function fileLearning(call: WorkCall, valid: FileLearningArgs): Promise<Done<FileLearningResult>> {
  const id = newId("lrn");
  const at = (column: string) => ({ table: "ledger.agent_learnings", id, column });
  const sealed = (column: string, text: string) => sealSummary(call.ctx, call.client.compartments, at(column), text);
  const rows = await call.fn<{ learning_id: string | null; code: string }>(SQL, [
    id,
    valid.requestId,
    await call.session(),
    valid.scope,
    valid.supersedes ?? null,
    fingerprint(call.ctx.keys, "learning_statement", valid.statement),
    sealed("statement_enc", valid.statement),
    sealed("rule_enc", valid.rule),
    sealed("evidence_enc", valid.evidence),
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  if (row === undefined) throw new Unavailable();
  if (row.code === "rate_limited") return { outcome: { ok: false, code: "rate_limited" }, rows: 0 };
  if (row.code === "not_found" || row.learning_id === null) return refused("not_found");
  const learning = row.learning_id as FileLearningResult["learning"];
  if (row.code === "merged") return answered({ learning, merged: true } as FileLearningResult);
  if (row.code === "vetoed") return answered({ learning, vetoed: true } as FileLearningResult);
  if (row.code === "ok") return answered({ learning } as FileLearningResult);
  throw new Unavailable();
}
