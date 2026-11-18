import { type ImportMemoryAck, ImportMemoryArgs, type ReadOutcome } from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { RECORD_LABEL } from "../agent-writes/record.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { sealUnder } from "../core/seal.ts";
import { marksOf } from "./memory-marks.ts";

// Reader.importMemory's work, run inside the call's one read committed transaction under the
// client's token, after the shared taint lock. For each change the store finds the stamps and the
// line fingerprints its body carries and the locator's fingerprint; addresses wait for intake.
// policy.import_memory marks each change against the calling client's own projections and answers
// the number of changes, whatever happened to each.

const IMPORT = "select outcome, received from policy.import_memory($1, $2::jsonb, $3)";
// The arguments, and no request id twice: the function refuses a batch that repeats one.
export const parseImportArgs = (args: unknown): ImportMemoryArgs | null => {
  const parsed = ImportMemoryArgs.safeParse(args);
  if (!parsed.success) return null;
  return new Set(parsed.data.changes.map((change) => change.requestId)).size === parsed.data.changes.length
    ? parsed.data
    : null;
};

export async function importMemory(
  ctx: Ctx,
  args: ImportMemoryArgs,
): Promise<{ outcome: ReadOutcome<ImportMemoryAck>; rows: number }> {
  const session = await ctx.session();
  const [row] = await ctx.run<{ label: string[] }>(RECORD_LABEL, []);
  const label = row?.label ?? [];
  const changes = args.changes.map((change) => {
    const common = {
      request_id: change.requestId,
      locator_fp: fingerprint(ctx.keys, "memory_locator", change.locator),
      change: change.change,
      entry_time: change.entryTime ?? null,
    };
    if (change.body === undefined) return { ...common, stamps: [], line_fps: [] };
    const { stamps, lineFps } = marksOf(ctx.keys, change.body);
    const recordId = newId("rec");
    let bodyEnc: unknown;
    try {
      // Under exactly the label's compartments, with only the calling client's keys in hand.
      bodyEnc = sealUnder(
        ctx.keys,
        label,
        { table: "ledger.agent_writes", id: recordId, column: "body_enc" },
        change.body,
      );
    } catch {
      throw new Unavailable();
    }
    return {
      ...common,
      stamps,
      line_fps: lineFps,
      record_id: recordId,
      content_fp: fingerprint(ctx.keys, "content_hash", sha256(change.body)),
      // A memory change cites nothing.
      cites_fp: fingerprint(ctx.keys, "cites", ""),
      body_enc: bodyEnc,
    };
  });
  const [answer] = await ctx.run<{ outcome: string; received: number | null }>(IMPORT, [
    session,
    JSON.stringify(changes),
    label,
  ]);
  switch (answer?.outcome) {
    case "ok":
      return { outcome: { ok: true, value: { received: answer.received ?? 0 } }, rows: args.changes.length };
    case "rate_limited":
      return { outcome: { ok: false, code: "rate_limited" }, rows: 0 };
    // label_mismatch and body_refused: what this code never sends.
    default:
      throw new Unavailable();
  }
}
