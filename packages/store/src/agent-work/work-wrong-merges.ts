import {
  type ReportWrongMergeArgs,
  type ReportWrongMergeResult,
  WrongMergeRefusal,
  WrongMergeState,
} from "@intelligence/contracts/personal";
import { normalizeAddress } from "@intelligence/personal-core";
import { fingerprint } from "../core/fingerprint.ts";
import { wrongMergeReportId } from "../core/ids.ts";
import { answered, type Done, isRefused, refused, type WorkCall } from "../core/work-refs.ts";

// report_wrong_merge, as pi_reader. An agent names each person's addresses as get_entity serves
// them; here each is fingerprinted, as find_messages fingerprints one, and the one definer resolves
// them within the caller's clearance, checks the report and writes it. It writes no ruling: the
// sweep makes the split when a second agent agrees.

const SQL =
  "select code, report, state from ledger.report_wrong_merge($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text, $7::text[])";

export async function reportWrongMerge(
  call: WorkCall,
  valid: ReportWrongMergeArgs,
): Promise<Done<ReportWrongMergeResult>> {
  // An address that reads as none is one get_entity never served: absent, as any other.
  const parts: string[][] = [];
  for (const part of valid.parts) {
    const fps: string[] = [];
    for (const address of part) {
      const read = normalizeAddress(address);
      if (read === null) return refused("not_found");
      fps.push(fingerprint(call.ctx.keys, "address", read));
    }
    parts.push(fps);
  }
  // One address in two lists, or twice in one, is a malformed report, said before the database is asked.
  const all = parts.flat();
  if (new Set(all).size !== all.length) return refused("invalid_request");
  const rows = await call.fn<{ code: string; report: string | null; state: string | null }>(SQL, [
    wrongMergeReportId(),
    valid.requestId,
    await call.session(),
    valid.entity,
    JSON.stringify(parts),
    valid.because,
    valid.cites,
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  if (row === undefined || row.code === "not_found") return refused("not_found");
  if (row.code === "ok" && row.report !== null) {
    const state = WrongMergeState.safeParse(row.state);
    return answered({ report: row.report, state: state.success ? state.data : "filed" });
  }
  const code = WrongMergeRefusal.safeParse(row.code);
  if (!code.success) return refused("not_found");
  // A refusal that names its cause: nothing was written.
  return { outcome: { ok: true, value: { refused: code.data } }, rows: 0 };
}
