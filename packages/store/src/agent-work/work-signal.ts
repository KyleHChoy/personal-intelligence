import { markId } from "../core/ids.ts";
import {
  type Args,
  answered,
  type Done,
  isRefused,
  type Result,
  refused,
  sealSummary,
  type WorkCall,
} from "../core/work-refs.ts";
import { openItemsOf } from "../read/read-open-items.ts";
import { triedSources, unpaid } from "./work-questions.ts";

// write_back: what an agent says happened on a signal or an item. Handled clears it for whoever can read
// the mark, drafted and needs_owner hold it. It is the agent's record: a ledger row, sealed under the
// writer's clearance, which never reaches the writer and never becomes a claim. Mail the owner sends
// clears an owed reply by itself, through sync, whatever anyone wrote back.

const FACT_SOURCES: ReadonlySet<string> = new Set(["commitment", "next_step", "plan"]);

export async function writeBack(call: WorkCall, valid: Args<"write_back">): Promise<Done<Result<"write_back">>> {
  const { client, ctx, session, fn } = call;
  // An open item's key names no row the function can look for: it stands if the caller's token serves it.
  let evidence: readonly string[] = [];
  if (FACT_SOURCES.has(valid.source.kind)) {
    const open = await openItemsOf(ctx, client.views, new Date(), "fresh");
    if (!open.items.some((item) => item.source.id === valid.source.id)) return refused("not_found");
    evidence = open.rests.get(valid.source.id as string)?.bound ?? [];
  }
  const id = markId();
  const note =
    valid.note === undefined
      ? null
      : sealSummary(ctx, client.compartments, { table: "ledger.signal_marks", id, column: "note_enc" }, valid.note);
  // a needs_owner is a question to the owner and pays first, checked by the function
  // against the caller's own logs after it answers a source the caller cannot see as not_found.
  const tried = valid.state === "needs_owner" ? valid.tried : undefined;
  const rows = await fn<{ mark: string | null }>(
    "select ledger.write_back($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::text[], $9::text[], $10::text[]) as mark",
    [
      id,
      valid.requestId,
      await session(),
      valid.source.kind,
      valid.source.id,
      valid.state,
      note,
      evidence,
      tried === undefined ? null : tried.searches.map((one) => one.tool),
      tried === undefined ? null : await triedSources(call, tried),
    ],
  );
  if (isRefused(rows)) return refused(rows);
  const mark = rows[0]?.mark;
  if (mark === null || mark === undefined) return refused("not_found");
  if (mark === "unpaid") return unpaid();
  return answered({ state: valid.state });
}
