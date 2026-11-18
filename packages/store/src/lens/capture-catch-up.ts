import { type BlockItem, CaptureWork, isCoded, type MomentItem, type TaskItem } from "@intelligence/contracts/personal";
import { activityTable, captureWorkOf, sealedTitle, titleFpsOf, withTitles } from "@intelligence/personal-core/lens";
import { fpsMemo, suppressedFps, titleSeal, withoutNamed } from "../core/capture-pages.ts";
import { TAINT_SHARED } from "../core/locks.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import type { DrainContext } from "./capture-drain.ts";
import { openBlobs, sealWork } from "./capture-write.ts";

// Work time's catch-up: older capture rows' work_enc filled, or given their titles, from their
// blobs, under the shared taint lock so an erasure is never undone.

// Work time: each full `pi sync` fills the work_enc of at most `limit`
// older rows that have none, a block day's blocks and a moment's line count from the vault blob
// and a moment's bundle and thread from the row's current facts, so the catch-up restores nothing
// a person's erasure cleared. Each row in a transaction of its own.
// It refills, the same way, a block day's or a moment's work_enc sealed before its titles were
// (work_titles false), so a window title anchor reaches time already stored; such a row keeps its
// work_enc, and its time, until it is refilled. `limit` bounds the rows tried, filled or not, so a
// run's work is bounded however few rows gain anything. A row tried and left unfilled is stamped
// work_tried_at, and the rows never tried come first, oldest first, then the least recently tried,
// so a row that cannot be filled holds back no newer one and is tried again only after every
// other. The stamp is the row's own transaction's, but for a row whose transaction failed, which is
// stamped after it; a stamp that fails is counted with the row and ends nothing but a lost
// connection.
export function catchUpWork(writer: DrainContext, limit: number): Promise<{ filled: number; failed?: number }> {
  return writer.write(async () => {
    let filled = 0;
    let failed = 0;
    const rows = await writer.direct.query<{ id: string }>(CATCH_UP, [limit]);
    // Each row in a transaction of its own; a row that fails is counted and tried again later.
    for (const row of rows) {
      try {
        if (await writer.write(() => writer.transaction((tx) => fillWork(tx, row.id)))) filled += 1;
      } catch (error) {
        if (isCoded(error, "unavailable")) throw error;
        failed += 1;
        try {
          await writer.write(() => writer.direct.query(TRIED, [row.id]));
        } catch (stamp) {
          if (isCoded(stamp, "unavailable")) throw stamp;
        }
      }
    }
    return { filled, ...(failed > 0 ? { failed } : {}) };
  });
}

const TRIED = "update knowledge.captures set work_tried_at = now() where id = $1";

// Those never tried first, oldest first, then the least recently tried.
const UNFILLED = "(c.work_enc is null or (not c.work_titles and c.kind in ('block', 'moment')))";
const CATCH_UP = `
  select c.id from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
  where ${UNFILLED} and c.kind in ('block', 'moment', 'task') and e.blob_ref is not null
  order by c.work_tried_at nulls first, c.first_pushed_at, c.started_at, c.id limit $1`;

// A person's erasure takes it alone before its hooks and holds it until it commits, so a refill
// never reads the suppressions before an erasure's commit and seals after its hook ran: it waits
// for the erasure, or the erasure's hook waits for it and then judges what it sealed. `pi sync`
// holds the sync lock too, which an erasure refuses.

// One row's work_enc, from its blob and, for a moment, its current facts; true when it was filled.
// Nothing for a row filled, changed or removed since it was chosen. A row whose work_enc is sealed
// already gains its titles' fingerprints alone (`titledWork`), and is marked done even when it
// cannot gain them, so the catch-up never chooses it again; but not when its blob does not open or
// parse (a key missing for a while, a schema since tightened), which may pass: such a row stays
// unfilled, stamped tried, and is tried again after every other; so does a row whose work_enc is
// null and whose blob cannot fill it.
async function fillWork(tx: Tx, id: string): Promise<boolean> {
  await tx.query(TAINT_SHARED);
  const [row] = await tx.query<{
    id: string;
    kind: string;
    compartments: string[];
    evidence_id: string;
    facts_enc: Sealed;
    work_enc: Sealed | null;
  }>(
    `select c.id, c.kind, c.compartments, c.evidence_id, c.facts_enc, c.work_enc from knowledge.captures c where c.id = $1 and ${UNFILLED} for update`,
    [id],
  );
  if (row === undefined) return false;
  const untried = async (): Promise<false> => {
    await tx.query(TRIED, [row.id]);
    return false;
  };
  const [item] = await openBlobs(tx, [row.evidence_id]);
  const usable =
    item !== null &&
    item !== undefined &&
    (item.kind === "block" || item.kind === "moment" || item.kind === "task") &&
    item.kind === row.kind;
  if (row.work_enc !== null) {
    if (item === null || item === undefined) return untried();
    const sealed = CaptureWork.parse(JSON.parse(open(tx.keys, row, "knowledge.captures.work_enc", "throw")));
    const work = usable ? await titledWork(tx, sealed, item) : null;
    await tx.query(
      `update knowledge.captures set ${work === null ? "" : "work_enc = $2, "}work_titles = true where id = $1`,
      [row.id, ...(work === null ? [] : [sealWork(tx, row.compartments, row.id, work)])],
    );
    return work !== null;
  }
  if (!usable) return untried();
  let facts: { bundle: string; thread: string | null } | undefined;
  if (item.kind === "moment") {
    const opened = JSON.parse(open(tx.keys, row, "knowledge.captures.facts_enc", "throw")) as {
      app?: { bundle?: unknown };
      thread?: unknown;
    };
    if (typeof opened.app?.bundle !== "string") return untried();
    facts = { bundle: opened.app.bundle, thread: typeof opened.thread === "string" ? opened.thread : null };
  }
  const titles = await titleSeal(
    tx.query,
    tx.keys,
    item.kind === "block" ? item.blocks.map((one) => one.title) : [facts?.thread],
  );
  const { work } = captureWorkOf(item.kind === "block" ? await unsuppressed(tx, item) : item, {
    table: activityTable(),
    titles,
    ...(facts === undefined ? {} : { facts }),
  });
  await tx.query("update knowledge.captures set work_enc = $2, work_titles = true where id = $1", [
    row.id,
    sealWork(tx, row.compartments, row.id, work),
  ]);
  return true;
}

// A sealed block day's or moment's work_enc with its titles'
// fingerprints added from its blob, and nothing else changed (no category, page or count is made
// again); null when there is nothing to add. A block gains those of the blob block with its start,
// end and app (`sameBlocks`), so a sealed day whose blocks are not the blob's in order or in number
// still gains them, with its title's name fingerprints in the day's titles; a moment, its sealed
// thread's, which is its current facts'. None for a title naming an erased person.
// Each blob block's title is fingerprinted alone, no work made of the whole blob.
async function titledWork(
  tx: Tx,
  sealed: CaptureWork,
  item: BlockItem | MomentItem | TaskItem,
): Promise<CaptureWork | null> {
  if (sealed.kind === "moment" && item.kind === "moment") {
    const titles = await titleSeal(tx.query, tx.keys, [sealed.thread]);
    const threadFps = titleFpsOf(titles)(sealed.thread, () => item.app.name);
    return threadFps.length === 0 ? null : { ...sealed, threadFps };
  }
  if (sealed.kind !== "block" || item.kind !== "block") return null;
  const titles = await titleSeal(
    tx.query,
    tx.keys,
    item.blocks.map((one) => one.title),
  );
  const fpsOf = titleFpsOf(titles);
  const fresh = sameBlocks(item.blocks, (one) => one.app.bundle);
  let added = false;
  const work = withTitles(sealed, (block) => {
    const found = fresh(block).map((one) => sealedTitle(fpsOf, titles, one.title, () => one.app.name));
    const [one, ...others] = found;
    // Two blob blocks with one start, end and app whose titles differ: neither is chosen.
    if (one === null || one === undefined || others.some((other) => JSON.stringify(other) !== JSON.stringify(one)))
      return null;
    added = true;
    return one;
  });
  return added ? work : null;
}

// The blocks of a list with a block's start, end and app
// bundle, the one key by which a sealed block is found again in its day's blob.
function sameBlocks<B extends { start: string; end: string }>(
  blocks: readonly B[],
  bundleOf: (one: B) => string,
): (block: { start: string; end: string; bundle: string }) => B[] {
  const keyOf = (one: { start: string; end: string }, bundle: string): string => `${one.start} ${one.end} ${bundle}`;
  const by = new Map<string, B[]>();
  for (const one of blocks) {
    const key = keyOf(one, bundleOf(one));
    by.set(key, [...(by.get(key) ?? []), one]);
  }
  return (block) => by.get(keyOf(block, block.bundle)) ?? [];
}

async function unsuppressed(tx: Tx, item: BlockItem): Promise<BlockItem> {
  const fpsOf = fpsMemo(tx.keys);
  const gone = await suppressedFps(
    tx.query,
    item.blocks.flatMap((block) => (block.pages ?? []).flatMap(fpsOf)),
  );
  if (gone.size === 0) return item;
  return {
    ...item,
    blocks: item.blocks.map((block) => {
      const { pages: _pages, ...rest } = block;
      const { kept } = withoutNamed(block.pages ?? [], fpsOf, gone);
      return kept.length === 0 ? rest : { ...rest, pages: kept };
    }),
  };
}
