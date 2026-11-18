import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  type BlockItem,
  CaptureItem,
  type CaptureWork,
  type CutReasons,
  type EntityId,
  type EventId,
  type MeetingItem,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { canonicalJson, normalizeAddress, strictAddress, THE_OWNER } from "@intelligence/personal-core";
import {
  activityTable,
  captureBlock,
  captureFacts,
  captureMatchKeys,
  captureWorkOf,
} from "@intelligence/personal-core/lens";
import { titleSeal } from "../core/capture-pages.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId, sha256Hex } from "../core/ids.ts";
import { CAPTURE_LANES } from "../core/lanes.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { taintCiting } from "../erasure/taint.ts";
import { removeExtracted, removeUncited } from "../write/writer-removal.ts";
import { hostOf, type Item } from "./capture-admit.ts";

// Writing one taken part: the meeting's event link and speakers, the earlier revision
// superseded, and the blob, evidence row and capture row, with work_enc sealed beside it.

// One evidence item the drain writes: a meeting, a moment, or one compartment's split of a block day.
// `agent` for a moment an agent-app rule admitted: the named client's
// clearance, as the drain reads it, which joins its label; none for any other item.
// `unfiled`: what no rule could file of a block day, on its first split alone. It
// goes in work_enc and never in the blob.
export type Part = {
  item: Item;
  sourceItemId: string;
  compartment: string;
  agent?: { compartments: string[] };
  unfiled?: { among: string[]; reasons: CutReasons };
};

// The candidate events, by code: not cancelled, not all-day, with a participant
// besides the owner, overlapping the meeting by at least half of the longer span, and sharing a
// participant address (the owner's left out) with the meeting's attendees or speakers. The most
// addresses in common, then the greatest overlap, then the lower id.
// The addresses in common are counted by accounts within the event's own compartments, which
// the meeting's label then covers, so no link rests on an account outside it (invariant 4).
const LINK = `
  with cand as (
    select ev.id, ev.compartments,
      extract(epoch from least(d.ends_at, $2::timestamptz) - greatest(d.starts_at, $1::timestamptz)) as overlap,
      greatest(extract(epoch from d.ends_at - d.starts_at), extract(epoch from $2::timestamptz - $1::timestamptz)) as longer,
      (select count(distinct a.value_fp) from knowledge.event_participants p
       join knowledge.entities en on en.id = p.entity_id and en.kind <> 'owner'
       join knowledge.accounts a on a.entity_id = p.entity_id
       where p.event_id = ev.id and a.value_fp = any($3::text[]) and a.compartments <@ ev.compartments) as common
    from knowledge.events ev join knowledge.event_details d on d.event_id = ev.id
    where not d.cancelled and not d.all_day and d.starts_at is not null and d.ends_at is not null
      and d.starts_at <= $2::timestamptz and d.ends_at >= $1::timestamptz
      and exists (select 1 from knowledge.event_participants p join knowledge.entities en on en.id = p.entity_id
                  where p.event_id = ev.id and en.kind <> 'owner'))
  select id, compartments from cand where common > 0 and overlap >= longer / 2
  order by common desc, overlap desc, id limit 1`;

const OWNER_BACKED = `
  select coalesce(d.owner_response = 'accepted', false) or coalesce(e.sender_member = 'm-owner', false) as backed
  from knowledge.events ev join vault.evidence_items e on e.id = ev.evidence_id
  left join knowledge.event_details d on d.event_id = ev.id where ev.id = $1`;

// The event participant whose account address is exactly the speaker's, by an
// account under the meeting's label ($3), so no participant rests on an account outside it
// (invariant 4).
const PARTICIPANT = `
  select distinct p.entity_id from knowledge.event_participants p join knowledge.accounts a on a.entity_id = p.entity_id
  where p.event_id = $1 and a.value_fp = $2 and a.compartments <@ $3::text[]`;

// The date of the item's own time as written, with the Mac's offset.
const localDay = (item: Item): string =>
  item.kind === "block"
    ? item.day
    : (item.kind === "moment"
        ? item.observedAt
        : item.kind === "task"
          ? (item.events[0]?.at ?? "")
          : item.startedAt
      ).slice(0, 10);

const spanOf = (item: Item): { start: string; end: string } => {
  if (item.kind === "meeting") return { start: item.startedAt, end: item.endedAt };
  if (item.kind === "moment") return { start: item.observedAt, end: item.endedAt };
  // Work time: a task's row spans its created event to its latest.
  if (item.kind === "task") return { start: item.events[0]?.at ?? "", end: item.events.at(-1)?.at ?? "" };
  const starts = item.blocks.map((block) => block.start).sort((left, right) => Date.parse(left) - Date.parse(right));
  const ends = item.blocks.map((block) => block.end).sort((left, right) => Date.parse(left) - Date.parse(right));
  return { start: starts[0] ?? item.day, end: ends[ends.length - 1] ?? item.day };
};

// The address fingerprints of the meeting's attendees and speakers, each a strict addr-spec.
function addressFp(tx: Tx, address: string | undefined): string | null {
  if (address === undefined || !strictAddress(address)) return null;
  const normal = normalizeAddress(address);
  return normal === null ? null : fingerprint(tx.keys, "address", normal);
}

type Linked = { id: EventId; compartments: string[]; ownerBacked: boolean };

// The meeting's event, with its compartments and its owner-backing. The parts of one
// series link to the event its first part links to.
export async function linkOf(tx: Tx, item: MeetingItem, accountId: string): Promise<Linked | null> {
  let event: { id: string; compartments: string[] } | undefined;
  const first =
    item.series !== undefined && item.series !== item.key
      ? (
          await tx.query<{ event_id: string | null }>(
            "select event_id from knowledge.captures where source_account_id = $1 and capture_key = $2 order by revision desc limit 1",
            [accountId, item.series],
          )
        )[0]
      : undefined;
  if (first !== undefined) {
    if (first.event_id === null) return null;
    [event] = await tx.query<{ id: string; compartments: string[] }>(
      "select id, compartments from knowledge.events where id = $1",
      [first.event_id],
    );
  } else {
    const fps = [
      ...new Set(
        [
          ...(item.calendar?.attendees ?? []).map((one) => one.address),
          ...item.speakers.map((one) => one.mention?.address),
        ]
          .map((one) => addressFp(tx, one))
          .filter((one): one is string => one !== null),
      ),
    ];
    if (fps.length === 0) return null;
    [event] = await tx.query<{ id: string; compartments: string[] }>(LINK, [item.startedAt, item.endedAt, fps]);
  }
  if (event === undefined) return null;
  const [backed] = await tx.query<{ backed: boolean }>(OWNER_BACKED, [event.id]);
  return { id: event.id as EventId, compartments: event.compartments, ownerBacked: backed?.backed === true };
}

// The participant of the linked event each speaker resolved to, under the meeting's
// label.
async function speakersOf(
  tx: Tx,
  item: MeetingItem,
  event: EventId,
  label: string[],
): Promise<Record<string, EntityId>> {
  const speakers: Record<string, EntityId> = {};
  for (const speaker of item.speakers) {
    const fp = addressFp(tx, speaker.mention?.address);
    if (fp === null) continue;
    const found = await tx.query<{ entity_id: string }>(PARTICIPANT, [event, fp, label]);
    if (found.length === 1 && found[0] !== undefined) speakers[speaker.label] = found[0].entity_id as EntityId;
  }
  return speakers;
}

type BlockRevision = { grown: boolean; tainted: number };

export async function writePart(
  tx: Tx,
  part: Part & { label: string[] },
  accountId: string,
  linked: Linked | null,
  pushed: { first: Date; revision: Date; vouched?: boolean },
  earlier: { id: string; revision: number }[],
): Promise<{ evidenceId: string; refused: WorkRefused; blockRevision?: BlockRevision }> {
  const { item, label, sourceItemId } = part;
  const itemFp = fingerprint(tx.keys, "source_id", sourceItemId);
  const last = [...earlier].sort((left, right) => right.revision - left.revision)[0];
  // The item keeps its cap_ id across revisions, so its handles, basis refs, mirror entries and
  // `pi erase item cap_` still name it.
  let kept: string | undefined;
  let blockRevision: BlockRevision | undefined;
  if (earlier.length > 0) {
    const ids = earlier.map((one) => one.id);
    // A block day's revision that holds every block of the last one, its tail
    // perhaps grown, taints nothing that cited it: what was read is still there. Only the last has
    // a blob; a revision before it lost its own when the last replaced it.
    const grown = item.kind === "block" && last !== undefined && (await grew(tx, last.id, item));
    [kept] = (
      await tx.query<{ id: string }>("delete from knowledge.captures where evidence_id = any($1) returning id", [ids])
    ).map((row) => row.id);
    // The superseded revisions' chat lines go with their capture row,
    // with no warmth removal: a revision deletes nothing the owner asked to delete. The new row's
    // lines_fp is null, so the participant step derives its lines at this sync, and the warmth
    // build's cadence absorbs the change.
    await tx.query("delete from knowledge.chat_lines where evidence_id = any($1)", [ids]);
    const claimed = await removeExtracted(tx, ids);
    const expired = await tx.query<{ blob_ref: string }>(
      `with gone as (select id, blob_ref from vault.evidence_items where id = any($1) and blob_ref is not null)
       update vault.evidence_items e set blob_ref = null, payload_state = 'expired' from gone where e.id = gone.id returning gone.blob_ref`,
      [ids],
    );
    if (expired.length > 0)
      await tx.query("delete from vault.evidence_blobs where blob_ref = any($1)", [expired.map((one) => one.blob_ref)]);
    // After the beliefs lock removeExtracted took, as removeSourceItem orders them. No ref: the
    // item keeps its cap_ id, and the next pass serves its entries again under their ids.
    // The superseded revisions' evidence rows stay, so a ruling keeps its anchors on them.
    const tainted = grown ? 0 : await taintCiting(tx.query, { evidenceIds: ids, refs: [], staying: ids });
    if (item.kind === "block") blockRevision = { grown, tainted };
    await removeUncited(tx, claimed);
  }

  const linkedEvent =
    item.kind === "meeting" && linked !== null
      ? { id: linked.id, ownerBacked: linked.ownerBacked, speakers: await speakersOf(tx, item, linked.id, label) }
      : null;
  const opened = captureFacts(item, {
    linkedEvent,
    ...(item.kind === "meeting" || item.kind === "moment" ? { pushedAt: pushed.revision.toISOString() } : {}),
    ...(pushed.vouched === true ? { vouched: true } : {}),
  });
  const facts = JSON.stringify(opened);
  // The item's own fields work time reads, sealed beside it; a meeting has none.
  // Its titles' fingerprints too, but of none that names an erased person.
  const titles = await titleSeal(
    tx.query,
    tx.keys,
    item.kind === "block" ? item.blocks.map((one) => one.title) : opened.kind === "moment" ? [opened.thread] : [],
  );
  const work =
    item.kind === "meeting"
      ? null
      : captureWorkOf(item, {
          table: activityTable(),
          titles,
          ...(opened.kind === "moment" ? { facts: { bundle: opened.app.bundle, thread: opened.thread } } : {}),
          ...(part.unfiled === undefined ? {} : { unfiled: part.unfiled }),
        });
  const blob = captureBlock(item);
  const source = { vault: "personal" as const, sourceAccount: SourceAccountId.parse(accountId), sourceItemId };
  const evidenceId = evidenceIdFor({ ...source, revision: item.revision });
  const blobRef = newId("blb");
  const { start, end } = spanOf(item);
  await tx.query("insert into vault.evidence_blobs (blob_ref, envelope, compartments) values ($1, $2, $3)", [
    blobRef,
    sealUnder(
      tx.keys,
      label,
      { table: "vault.evidence_blobs", id: blobRef, column: "envelope" },
      Buffer.from(blob).toString("base64"),
    ),
    label,
  ]);
  await tx.query(
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, supersedes, next_revision_id,
       thread_fp, content_hash, media_type, observed_at, change_kind, participant_members, sender_member, system_originated, answers_system,
       hold_released_at, blob_ref, payload_state, compartments, readers, item_enc)
     values ($1, $2, $3, $4, $5, $6, $7, $8, null, $9, 'application/json', $10, 'live', $11, null, false, false, null, $12, 'present', $13, $14, $15)`,
    [
      evidenceId,
      accountId,
      CAPTURE_LANES[item.kind].source,
      itemFp,
      fingerprint(tx.keys, "revision_tag", `${sourceItemId}@${item.revision}`),
      item.revision,
      last?.id ?? null,
      evidenceIdFor({ ...source, revision: item.revision + 1 }),
      fingerprint(tx.keys, "content_hash", sha256Hex(blob)),
      start,
      [THE_OWNER],
      blobRef,
      label,
      [THE_OWNER],
      sealUnder(tx.keys, label, { table: "vault.evidence_items", id: evidenceId, column: "item_enc" }, facts),
    ],
  );

  const scoped = (value: string | undefined): string | null =>
    value === undefined ? null : fingerprint(tx.keys, "capture_scope", value);
  const captureId = kept ?? newId("cap");
  await tx.query(
    `insert into knowledge.captures (id, evidence_id, source_account_id, capture_key, revision, kind, started_at, ended_at, event_id, first_pushed_at, local_day,
       minutes, bundle_fp, host_fp, account_fp, thread_fp, match_fps, facts_enc, compartments, agent_app, work_enc, work_titles, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
    [
      captureId,
      evidenceId,
      accountId,
      item.key,
      item.revision,
      item.kind,
      start,
      end,
      item.kind === "meeting" ? (linked?.id ?? null) : null,
      pushed.first,
      localDay(item),
      item.kind === "block"
        ? Math.round(item.blocks.reduce((total, block) => total + block.minutes, 0) * 10) / 10
        : null,
      item.kind === "block" || item.kind === "task" ? null : scoped(item.app.bundle),
      item.kind === "moment" ? scoped(hostOf(item)) : item.kind === "meeting" ? scoped(item.host) : null,
      item.kind === "block" || item.kind === "task" ? null : scoped(item.account),
      item.kind === "moment" && item.threadKey !== undefined
        ? fingerprint(tx.keys, "thread", item.threadKey)
        : item.kind === "moment" && item.thread !== undefined
          ? fingerprint(tx.keys, "thread", item.thread)
          : null,
      item.kind === "task" ? [] : captureMatchKeys(item).map((key) => fingerprint(tx.keys, "anchor", key)),
      sealUnder(tx.keys, label, { table: "knowledge.captures", id: captureId, column: "facts_enc" }, facts),
      label,
      part.agent !== undefined,
      work === null ? null : sealWork(tx, label, captureId, work.work),
      work !== null,
      item.kind === "moment" ? (item.source ?? null) : null,
    ],
  );
  return { evidenceId, refused: work?.refused ?? {}, ...(blockRevision === undefined ? {} : { blockRevision }) };
}

type WorkRefused = Partial<Record<string, number>>;

// A CaptureWork sealed in knowledge.captures.work_enc under the row's label,
// bound to the row.
export const sealWork = (tx: Tx, label: string[], captureId: string, work: CaptureWork) =>
  sealUnder(tx.keys, label, { table: "knowledge.captures", id: captureId, column: "work_enc" }, canonicalJson(work));

// Whether a block day split holds every block of its last revision, by start,
// end, minutes, title, app, host, account and attributes (the title too, since labels and screens
// read it; of an attribute its value and method, since its moment's key can come later). Blocks not
// held are still there if they are the revision's tail, grown: one block now spans them all, has at
// least their minutes, keeps their account and the first one's app and host, and reaches the end
// of the revision, which is where more frames fold in. A revision whose blob cannot be read is not
// held.
async function grew(tx: Tx, evidenceId: string, item: BlockItem): Promise<boolean> {
  type One = BlockItem["blocks"][number];
  const attribute = (one: One["repository"]) => (one === undefined ? null : { value: one.value, method: one.method });
  const keyOf = (one: One): string =>
    canonicalJson({
      start: Date.parse(one.start),
      end: Date.parse(one.end),
      minutes: one.minutes,
      title: one.title ?? null,
      app: one.app.bundle,
      host: one.host ?? null,
      account: one.account ?? null,
      repository: attribute(one.repository),
      document: attribute(one.document),
      folder: attribute(one.folder),
    });
  const [earlier] = await openBlobs(tx, [evidenceId]);
  if (earlier === null || earlier === undefined || earlier.kind !== "block") return false;
  const now = new Set(item.blocks.map(keyOf));
  const moved = earlier.blocks.filter((one) => !now.has(keyOf(one)));
  const first = moved.reduce<One | undefined>(
    (soonest, one) => (soonest === undefined || Date.parse(one.start) < Date.parse(soonest.start) ? one : soonest),
    undefined,
  );
  if (first === undefined) return true;
  const reached = Math.max(...earlier.blocks.map((one) => Date.parse(one.end)));
  const tail = item.blocks.find(
    (one) => Date.parse(one.start) <= Date.parse(first.start) && Date.parse(one.end) >= reached,
  );
  if (tail === undefined) return false;
  return (
    tail.app.bundle === first.app.bundle &&
    (tail.host ?? null) === (first.host ?? null) &&
    tail.minutes >= moved.reduce((total, one) => total + one.minutes, 0) &&
    moved.every((one) => (one.account ?? null) === (tail.account ?? null))
  );
}

// The stored items of these evidence rows, opened from their blobs; null for one with no blob.
export async function openBlobs(tx: Tx, evidenceIds: readonly string[]): Promise<(CaptureItem | null)[]> {
  const rows = await tx.query<{ blob_ref: string | null; envelope: Sealed | null; compartments: string[] | null }>(
    `select e.blob_ref, b.envelope, b.compartments from vault.evidence_items e left join vault.evidence_blobs b on b.blob_ref = e.blob_ref where e.id = any($1) order by e.id`,
    [evidenceIds],
  );
  return rows.map((row) => {
    if (row.blob_ref === null || row.envelope === null || row.compartments === null) return null;
    try {
      const base64 = open(
        tx.keys,
        { id: row.blob_ref, compartments: row.compartments, envelope: row.envelope },
        "vault.evidence_blobs.envelope",
        "throw",
      );
      const parsed = CaptureItem.safeParse(JSON.parse(Buffer.from(base64, "base64").toString("utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  });
}
