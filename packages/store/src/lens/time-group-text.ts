import { BlockItem, CaptureWork } from "@intelligence/contracts/personal";
import { titleSeal } from "../core/capture-pages.ts";
import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";

// What a person would call a group of time, read from its evidence each time it is needed and never
// stored: a block's title lives only in the vault's blob, which a person's erasure leaves as it
// was, and a thread stays in work_enc, so each is judged again by the words an erasure suppressed.
// So an erased name is never read back, and no ruling holds a word.

const parsedOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

export type BlockTitle = { start: number; end: number; bundle: string; title: string };

// The titles of one block day's current revision, those an erasure suppressed left out; none when
// its blob is gone or does not parse.
export async function blockTitles(query: Query, keys: Keys, evidenceId: string): Promise<BlockTitle[]> {
  const [row] = await query<{ blob_ref: string | null; compartments: string[] }>(
    "select blob_ref, compartments from vault.evidence_items where id = $1",
    [evidenceId],
  );
  if (row === undefined || row.blob_ref === null) return [];
  const [blob] = await query<{ envelope: Sealed }>("select envelope from vault.evidence_blobs where blob_ref = $1", [
    row.blob_ref,
  ]);
  if (blob === undefined) return [];
  const titles = blobTitles(
    open(
      keys,
      { id: row.blob_ref, compartments: row.compartments, envelope: blob.envelope },
      "vault.evidence_blobs.envelope",
      "throw",
    ),
  );
  const seal = await titleSeal(
    query,
    keys,
    titles.map((one) => one.title),
  );
  return titles.filter((one) => seal.kept(one.title));
}

// The non-empty titles of a block day's blob, opened (base64 of the item's JSON); none when it does
// not parse. Whether an erasure suppressed one is the caller's to judge.
export function blobTitles(opened: string): BlockTitle[] {
  const item = BlockItem.safeParse(parsedOrNull(Buffer.from(opened, "base64").toString("utf8")));
  if (!item.success) return [];
  return item.data.blocks.flatMap((one) =>
    one.title === undefined || one.title.trim() === ""
      ? []
      : [{ start: Date.parse(one.start), end: Date.parse(one.end), bundle: one.app.bundle, title: one.title }],
  );
}

// A title among a day's that covers the stretch in the same app.
export const titleCovering = (
  titles: readonly BlockTitle[],
  stretch: { from: number; to: number; bundle: string },
): string | null =>
  titles.find((one) => one.bundle === stretch.bundle && one.start <= stretch.from && one.end >= stretch.to)?.title ??
  null;

// The ids cited and every later revision of them. A ruling keeps the revision the pass read, and only an
// item's last revision has a capture row and a blob, so a day that Lens revised is read through its chain.
async function withLaterRevisions(query: Query, evidenceIds: readonly string[]): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `with recursive chain as (
       select id from vault.evidence_items where id = any ($1::text[])
       union select e.id from vault.evidence_items e join chain on e.supersedes = chain.id)
     select id from chain`,
    [[...evidenceIds]],
  );
  return rows.map((row) => row.id);
}

// The words of a proposal: the thread of a moment it cites, else the title of the block its stretch
// lies in, else that block's most specific place, else null when no block is there any more.
export async function proposalText(
  query: Query,
  keys: Keys,
  evidenceIds: readonly string[],
  from: number,
): Promise<string | null> {
  if (evidenceIds.length === 0) return null;
  const rows = await query<{
    id: string;
    evidence_id: string;
    kind: string;
    compartments: string[];
    work_enc: Sealed;
  }>(
    `select id, evidence_id, kind, compartments, work_enc from knowledge.captures
     where evidence_id = any ($1::text[]) and kind in ('moment', 'block') and work_enc is not null order by id`,
    [await withLaterRevisions(query, evidenceIds)],
  );
  const opened = rows.flatMap((row) => {
    const work = CaptureWork.safeParse(parsedOrNull(open(keys, row, "knowledge.captures.work_enc", "throw")));
    return work.success ? [{ row, work: work.data }] : [];
  });
  const threads = opened.flatMap(({ work }) => (work.kind === "moment" && work.thread !== null ? [work.thread] : []));
  const seal = await titleSeal(query, keys, threads);
  const thread = threads.find((one) => seal.kept(one));
  if (thread !== undefined) return thread;
  for (const { row, work } of opened) {
    if (work.kind !== "block") continue;
    const block = work.blocks.find((one) => Date.parse(one.start) <= from && Date.parse(one.end) > from);
    if (block === undefined) continue;
    const title = titleCovering(await blockTitles(query, keys, row.evidence_id), {
      from,
      to: from,
      bundle: block.bundle,
    });
    if (title !== null) return title;
    const places = [block.document?.value, block.folder?.value, block.repository?.value].filter(
      (one): one is string => one !== undefined,
    );
    const placeSeal = await titleSeal(query, keys, places);
    return places.find((one) => placeSeal.kept(one)) ?? block.host ?? block.bundle;
  }
  return null;
}
