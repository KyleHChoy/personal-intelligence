import { ACTIVITY_TYPES, type CaptureMention, CaptureWork, type EntityId } from "@intelligence/contracts/personal";
import { canonicalJson, normalizeAddress, phoneKey } from "@intelligence/personal-core";
import { type CaptureFacts, withTitles } from "@intelligence/personal-core/lens";
import { fpsMemo, titleFpsMemo, withoutNamed } from "../core/capture-pages.ts";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { waitToReplay } from "../core/replay.ts";
import { openUnder, type Sealed, sealUnder } from "../core/seal.ts";
import { type ErasureHook, peopleOf } from "../erasure/erasure-hook.ts";
import { removeClaims } from "../write/writer-removal.ts";
import { rewriteCaptureItem } from "./capture-item.ts";

// The `captures` row of ERASURE_HOOKS: a person's erasure removes, from
// each CaptureFacts, the mentions of the erased addresses and the speaker-to-participant entries
// of the erased entities or of a speaker whose mention went, and counts the rows changed; a dry
// run counts the rows it would change. The facts are sealed twice, in the row's `facts_enc` and
// in its evidence row's `item_enc`, and both are cleaned. An item's own knowledge.captures row is
// removeSourceItem's, and the vault's blob, evidence kept unchanged, still names the
// person.

const at = (id: string) => ({ table: "knowledge.captures", id, column: "facts_enc" });
const itemAt = (id: string) => ({ table: "vault.evidence_items", id, column: "item_enc" });

// CaptureFacts without the erased mentions, or null when nothing in it is erased.
function cleaned(
  keys: Keys,
  facts: CaptureFacts,
  addressFps: Set<string>,
  entities: Set<string>,
  nameFps: Set<string>,
): CaptureFacts | null {
  const erased = (mention: CaptureMention | null | undefined): boolean => {
    const address = mention?.address === undefined ? null : normalizeAddress(mention.address);
    if (address !== null && addressFps.has(fingerprint(keys, "address", address))) return true;
    const key =
      facts.kind !== "moment" || facts.source === undefined || mention?.handle === undefined
        ? null
        : phoneKey(mention.handle);
    return (
      key !== null &&
      mention?.handle !== undefined &&
      (addressFps.has(fingerprint(keys, "address", key)) || nameFps.has(fingerprint(keys, "name", mention.handle)))
    );
  };
  let changed = false;
  const keep = (mentions: CaptureMention[]): CaptureMention[] => {
    const kept = mentions.filter((mention) => !erased(mention));
    if (kept.length !== mentions.length) changed = true;
    return kept;
  };
  if (facts.kind === "moment") {
    const participants = keep(facts.participants);
    // An erased handle's slot in `lines` is set null and its turns dropped, so every other index
    // stays valid.
    const lines = facts.lines;
    if (lines !== undefined) {
      const gone = new Set(
        lines.handles.flatMap((handle, index) =>
          handle !== null && erased(phoneKey(handle) === null ? { address: handle } : { handle }) ? [index] : [],
        ),
      );
      if (gone.size > 0) {
        changed = true;
        return {
          ...facts,
          participants,
          lines: {
            handles: lines.handles.map((handle, index) => (gone.has(index) ? null : handle)),
            turns: lines.turns.filter(([who]) => !gone.has(who)),
          },
        };
      }
    }
    return changed ? { ...facts, participants } : null;
  }
  if (facts.kind !== "meeting") return null;
  const gone = new Set<string>();
  const speakers = facts.speakers.map((speaker) => {
    if (!erased(speaker.mention)) return speaker;
    changed = true;
    gone.add(speaker.label);
    return { ...speaker, mention: null };
  });
  let calendar = facts.calendar;
  if (calendar !== null) {
    const organizer = erased(calendar.organizer) ? null : calendar.organizer;
    if (organizer !== calendar.organizer) changed = true;
    calendar = { ...calendar, organizer, attendees: keep(calendar.attendees) };
  }
  let linked = facts.linked;
  if (linked !== null) {
    const entries = Object.entries(linked.speakers).filter(
      ([label, entity]) => !gone.has(label) && !entities.has(entity),
    );
    if (entries.length !== Object.keys(linked.speakers).length) {
      changed = true;
      linked = { ...linked, speakers: Object.fromEntries(entries) as Record<string, EntityId> };
    }
  }
  const attendees = facts.attendees === undefined ? undefined : keep(facts.attendees);
  return changed ? { ...facts, speakers, calendar, linked, ...(attendees === undefined ? {} : { attendees }) } : null;
}

const workAt = (id: string) => ({ table: "knowledge.captures", id, column: "work_enc" });

// And each block's `titleFps` whose title names the person, and each moment's `threadFps` whose
// sealed thread names them; nothing rests on either, and the catch-up and the drain never
// fingerprint such a title again (capture-pages' titleSeal). A block's title is judged by its name
// fingerprints, sealed beside its title's in the day's `titles`, so no blob is read and work_enc
// alone decides; a block whose title fingerprints have none there (none is sealed so) loses them,
// since they cannot be checked (invariant 10).
async function blockDays(query: Query, keys: Keys, fps: ReadonlySet<string>, dryRun: boolean): Promise<Set<string>> {
  if (fps.size === 0) return new Set();
  const fpsOf = fpsMemo(keys);
  const titleFps = titleFpsMemo(keys);
  const named = (title: string | null | undefined): boolean =>
    title !== null && title !== undefined && titleFps(title).some((fp) => fps.has(fp));
  type Row = { id: string; compartments: string[]; evidence_id: string; work_enc: Sealed };
  // A row's work_enc without the erased pages and titles, or null when it holds none; `paged`
  // when a page went.
  const cleanedWork = (row: Row): { work: CaptureWork; paged: boolean } | null => {
    const work = CaptureWork.parse(JSON.parse(openUnder(keys, row.compartments, workAt(row.id), row.work_enc)));
    if (work.kind === "moment") {
      if (work.threadFps === undefined || !named(work.thread)) return null;
      const { threadFps: _fps, ...rest } = work;
      return { work: rest, paged: false };
    }
    if (
      work.kind !== "block" ||
      !work.blocks.some((block) => block.pages !== undefined || block.titleFps !== undefined)
    )
      return null;
    let dropped = 0;
    let untitled = 0;
    const blocks = work.blocks.map((block) => {
      if (block.pages === undefined) return block;
      const { kept, dropped: gone } = withoutNamed(block.pages, fpsOf, fps);
      dropped += gone;
      const { pages: _pages, ...rest } = block;
      return kept.length === 0 ? rest : { ...rest, pages: kept };
    });
    const titled = withTitles({ ...work, blocks }, (block) => {
      if (block.titleFps === undefined) return null;
      const names = block.titleAt === undefined ? undefined : work.titles?.[block.titleAt];
      if (names === undefined || names.some((fp) => fps.has(fp))) {
        untitled += 1;
        return null;
      }
      return { fps: block.titleFps, names };
    });
    return dropped === 0 && untitled === 0 ? null : { work: titled, paged: dropped > 0 };
  };
  // Read unlocked, then lock and read again only the rows that change, so the drain waits on
  // those alone.
  const read = (where: string, values: unknown[], lock = "") =>
    query<Row>(
      `select id, compartments, evidence_id, work_enc from knowledge.captures where kind in ('block', 'moment') and work_enc is not null and ${where} order by id${lock}`,
      values,
    );
  const found = new Map<string, { as: string; cleaned: { work: CaptureWork; paged: boolean } }>();
  const as = (row: Row): string => JSON.stringify([row.evidence_id, row.compartments, row.work_enc]);
  for (const row of await read("true", [])) {
    const cleaned = cleanedWork(row);
    if (cleaned !== null) found.set(row.id, { as: as(row), cleaned });
  }
  if (dryRun || found.size === 0) return new Set(found.keys());
  const paged: string[] = [];
  const changed = new Set<string>();
  for (const row of await read("id = any($1)", [[...found.keys()]], " for update")) {
    const seen = found.get(row.id);
    const cleaned = seen !== undefined && seen.as === as(row) ? seen.cleaned : cleanedWork(row);
    if (cleaned === null) continue;
    changed.add(row.id);
    if (cleaned.paged) paged.push(row.evidence_id);
    await query("update knowledge.captures set work_enc = $2 where id = $1", [
      row.id,
      sealUnder(keys, row.compartments, workAt(row.id), canonicalJson(cleaned.work)),
    ]);
  }
  if (paged.length > 0) {
    const claims = (
      await query<{ id: string }>(
        "select id from knowledge.claims where evidence_id = any($1) and type = $2 order by id",
        [paged, ACTIVITY_TYPES.researched],
      )
    ).map((row) => row.id);
    await removeClaims(query, claims);
    await waitToReplay({ query, keys }, paged);
  }
  return changed;
}

async function runCaptures(...[query, erased, { dryRun, keys }]: Parameters<ErasureHook["run"]>): Promise<number> {
  const entities = new Set(peopleOf(erased));
  if (erased.addressFps.length === 0 && erased.nameFps.length === 0 && entities.size === 0) return 0;
  // A moment both passes change is counted once.
  const changed = await blockDays(query, keys, new Set([...erased.addressFps, ...erased.nameFps]), dryRun);
  const addressFps = new Set(erased.addressFps);
  const nameFps = new Set(erased.nameFps);
  const rows = await query<{
    id: string;
    compartments: string[];
    facts_enc: Sealed;
    evidence_id: string;
    item_compartments: string[];
    item_enc: Sealed;
  }>(
    `select c.id, c.compartments, c.facts_enc, c.evidence_id, e.compartments as item_compartments, e.item_enc
       from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
       where c.kind in ('meeting', 'moment') order by c.id${dryRun ? "" : " for update of c, e"}`,
  );
  for (const row of rows) {
    const facts = JSON.parse(openUnder(keys, row.compartments, at(row.id), row.facts_enc)) as CaptureFacts;
    const next = cleaned(keys, facts, addressFps, entities, nameFps);
    const item = JSON.parse(
      openUnder(keys, row.item_compartments, itemAt(row.evidence_id), row.item_enc),
    ) as CaptureFacts;
    const nextItem = cleaned(keys, item, addressFps, entities, nameFps);
    if (next === null && nextItem === null) continue;
    changed.add(row.id);
    if (dryRun) continue;
    // Its lines_fp nulled with it, so the participant step derives the other people's chat lines
    // again from what is left.
    if (next !== null)
      await query("update knowledge.captures set facts_enc = $2, lines_fp = null where id = $1", [
        row.id,
        sealUnder(keys, row.compartments, at(row.id), JSON.stringify(next)),
      ]);
    if (nextItem !== null) {
      await rewriteCaptureItem(
        query,
        keys,
        { evidenceId: row.evidence_id, compartments: row.item_compartments },
        nextItem,
      );
    }
  }
  return changed.size;
}

export const capturesErasure: ErasureHook = {
  name: "captures",
  after: {
    hooks: ["pages"],
    why: "a page's sealed body goes by its fetch rows before the captures hook opens what names the person",
  },
  run: runCaptures,
};
