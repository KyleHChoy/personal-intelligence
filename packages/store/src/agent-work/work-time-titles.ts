import type { SortTitles, WorkRow } from "@intelligence/personal-core/lens";
import { titleFpsMemo } from "../core/capture-pages.ts";
import { open, type Sealed } from "../core/seal.ts";
import { isRefused, type WorkCall } from "../core/work-refs.ts";
import { type BlockTitle, blobTitles, titleCovering } from "../lens/time-group-text.ts";

// get_work_time's titles for the title role, as pi_reader. The definer gives, for the block days and
// meetings this read already holds and only within the caller's clearance, the sealed blob and the
// sealed meeting facts; they are opened here under the caller's own keys, which open only its
// compartments. A title naming a person an erasure suppressed is not served, by the daily pass's rule
// (titleSeal). Nothing is stored. A caller without the title role is refused by the definer, and is
// served no title.

const TITLES = "select kind, id, ref, compartments, sealed from ledger.work_time_titles($1, $2::text[], $3::text[])";
const SUPPRESSED = "select ledger.work_time_title_suppressed($1, $2::text[]) as fp";

type Found = { kind: "block" | "meeting"; id: string; ref: string; compartments: string[]; sealed: Sealed };

// A meeting's name: its own title, else its calendar entry's.
function meetingName(opened: string): string | null {
  let facts: { title?: unknown; calendar?: { title?: unknown } | null } | null = null;
  try {
    facts = JSON.parse(opened);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const name = [facts?.title, facts?.calendar?.title].find(
    (one): one is string => typeof one === "string" && one.trim() !== "",
  );
  return name ?? null;
}

export async function sortTitles(call: WorkCall, rows: readonly WorkRow[]): Promise<SortTitles | undefined> {
  const session = await call.session();
  const evidence = [...new Set(rows.filter((row) => row.kind === "block").map((row) => row.evidence))];
  const meetings = rows.filter((row) => row.kind === "meeting").map((row) => row.id);
  const found = await call.fn<Found>(TITLES, [session, evidence, meetings]);
  if (isRefused(found)) return undefined;
  const blocks = new Map<string, BlockTitle[]>();
  const names = new Map<string, string>();
  for (const row of found) {
    const { keys } = call.ctx;
    const opened =
      row.kind === "block"
        ? open(keys, { ...row, id: row.ref, envelope: row.sealed }, "vault.evidence_blobs.envelope", "null")
        : open(keys, { ...row, id: row.ref, facts_enc: row.sealed }, "knowledge.captures.facts_enc", "null");
    if (opened === null) continue;
    if (row.kind === "block") blocks.set(row.id, blobTitles(opened));
    else {
      const name = meetingName(opened);
      if (name !== null) names.set(row.id, name);
    }
  }
  const fpsOf = titleFpsMemo(call.ctx.keys);
  const fps = [...new Set([...[...blocks.values()].flat().map((one) => one.title), ...names.values()].flatMap(fpsOf))];
  const gone = fps.length === 0 ? [] : await call.fn<{ fp: string }>(SUPPRESSED, [session, fps]);
  if (isRefused(gone)) return undefined;
  const suppressed = new Set(gone.map((row) => row.fp));
  const kept = (title: string | null | undefined): string | null =>
    title === null || title === undefined || fpsOf(title).some((fp) => suppressed.has(fp)) ? null : title;
  return {
    window: (stretch) => kept(titleCovering(blocks.get(stretch.evidence) ?? [], stretch)),
    meeting: (row) => kept(names.get(row)),
  };
}
