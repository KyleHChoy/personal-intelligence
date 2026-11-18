import {
  type ReportWrongRelationArgs,
  type ReportWrongRelationResult,
  WrongRelationRefusal,
  WrongRelationState,
} from "@intelligence/contracts/personal";
import { relationReportId } from "../core/ids.ts";
import { answered, type Done, isRefused, refused, type WorkCall } from "../core/work-refs.ts";

// report_wrong_relation, as pi_reader. The one definer reads the relation and the cites within the
// caller's clearance, checks the report and writes it. It lifts no relation and writes no ruling:
// the switch job counts it against its kind when a second agent agrees or the second model's later
// check does not hold.

const SQL =
  "select code, report, state from ledger.report_wrong_relation($1::text, $2::text, $3::text, $4::bigint, $5::text, $6::text[])";

export async function reportWrongRelation(
  call: WorkCall,
  valid: ReportWrongRelationArgs,
): Promise<Done<ReportWrongRelationResult>> {
  const rows = await call.fn<{ code: string; report: string | null; state: string | null }>(SQL, [
    relationReportId(),
    valid.requestId,
    await call.session(),
    valid.relation,
    valid.because,
    valid.cites,
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  if (row === undefined || row.code === "not_found") return refused("not_found");
  // The definer answers `ok` with its report and `filed` or `agreed`, and nothing else.
  if (row.code === "ok" && row.report !== null)
    return answered({ report: row.report, state: WrongRelationState.parse(row.state) });
  const code = WrongRelationRefusal.safeParse(row.code);
  if (!code.success) return refused("not_found");
  // A refusal that names its cause: nothing was written.
  return { outcome: { ok: true, value: { refused: code.data } }, rows: 0 };
}
