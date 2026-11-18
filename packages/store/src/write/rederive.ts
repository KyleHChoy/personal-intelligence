import { EvidenceId, type LocalEntityId, RawItem } from "@intelligence/contracts";
import type { PersonalRef } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { type ItemContext, type ItemFacts, isHeadersMail } from "@intelligence/personal-core/items";
import { CARRY_AT, carryRows } from "../core/claim-columns.ts";
import { CAPTURE_SOURCE_KINDS } from "../core/lanes.ts";
import { BELIEFS_LOCK } from "../core/locks.ts";
import { open, type Sealed } from "../core/seal.ts";
import { sql, sqlWords } from "../core/sql.ts";
import { setTriggerCause } from "../core/stored-forms.ts";
import type { Tx } from "../core/tx.ts";
import { holders } from "../core/vocabulary.ts";
import { DROP_EVERY_DECLASSIFIED } from "../erasure/declassified.ts";
import { taintCiting } from "../erasure/taint.ts";
import { identityPort, type KeptIds, ownerAddresses, ownerEntity, writtenTo } from "../identity/identity-port.ts";
import { ignoreRekeys, nameRekeys, rekeyIgnores, rekeyNames } from "../identity/ignore-rekey.ts";
import { refoldPlan } from "../identity/org-fold.ts";
import { removeWarmth } from "../identity/warmth-build.ts";
import { checkFacts, writeDerived } from "./writer-derived.ts";
import { removeUncited } from "./writer-removal.ts";

// The re-derive: everything in `knowledge` is derived from the vault, so it is derived again from
// the latest revision of every stored item, in the caller's one transaction, keeping the id of
// every row that is still there. The vault's payloads, stored items, hashes, marks and recipient
// rows are never changed. It reads the database and the key file, and nothing else.

// Needed exactly when an owner address is also held by a person, in any compartment. A
// stateless question, so a run killed before or during a re-derive loses nothing.
const NEEDED = `
  select exists (
    select 1
    from knowledge.accounts mine
    join knowledge.entities owner on owner.id = mine.entity_id and owner.kind = 'owner'
    join knowledge.accounts theirs on theirs.value_fp = mine.value_fp
    join knowledge.entities person on person.id = theirs.entity_id and person.kind = 'person') as needed`;

// The latest revision of each stored source item: what the owner sent first, then the rest, each
// group oldest first. The evidence rows alone, and no payload, each with its own label: a
// restricted item is opened, and derived again, under its whole label, which sync's keys hold. An
// agent record's row is left out: it is neither sealed under its account's one compartment nor a
// RawItem, and nothing in `knowledge` is derived from it. Nor is a document's: nothing of a
// document depends on the owner's addresses, so its row and id stay. Nor is an expired item's: it
// keeps no original and derives nothing. Nor is a Lens capture's (a meeting transcript, a moment, a
// block day): it is no RawItem, its row in `knowledge.captures` is the drain's, and none of the
// tables below is derived from it; read as mail, it would fail the parse and roll back the whole
// re-derive. Every capture lane's source kind is left out, a task's included. Nor is a page's: a
// page makes no person, alias or interaction, and its row is derived with its request, which a
// re-derive does not hold.
const NOT_RAW = sqlWords(["agent_record", "document", "web_research", "owner_command", ...CAPTURE_SOURCE_KINDS]);
const LATEST = `
  select e.id, e.revision, e.source_account_id, e.item_enc, e.blob_ref, e.hold_released_at, e.model_hold_at, e.compartments, s.compartments[1] as compartment
  from vault.evidence_items e
  join vault.source_accounts s on s.id = e.source_account_id
  where e.source_kind not in (${NOT_RAW}) and e.payload_state = 'present' and not exists (
    select 1 from vault.evidence_items later
    where later.source_account_id = e.source_account_id and later.source_item_fp = e.source_item_fp and later.revision > e.revision)
  order by (e.sender_member is distinct from $1), e.ingested_at, e.id`;

// For each item, the earliest first-known time of each value of its claims, by
// carry key, an owner_command item's left out (its claims stay), in one read. An item with a status
// row keeps its carry there, for its next commit; the others' (a contact's) are returned.
const CARRY = `
  with known as materialized (
    select g.evidence_id, jsonb_object_agg(g.key, g.at) as known
    from (
      select k.evidence_id, k.key, ${CARRY_AT} as at
      from (${carryRows("c.evidence_id not in (select id from vault.evidence_items where source_kind = 'owner_command')")}) k
      group by k.evidence_id, k.key) g
    group by g.evidence_id),
  kept as (
    update vault.pipeline_items p set first_known = coalesce(p.first_known, '{}'::jsonb) || known.known
    from known where p.evidence_id = known.evidence_id)
  select known.evidence_id, known.known from known
  where not exists (select 1 from vault.pipeline_items p where p.evidence_id = known.evidence_id)`;

// How many of them one read brings back. The rows are read through a cursor of the caller's
// transaction, and the cursor reads what one statement would: the rows as they were when it
// was declared, whatever the loop has written since. Each payload is read alone when its
// item's turn comes and let go before the next: one can be megabytes, so this process holds one
// at a time, however many are stored and however large they are.
const BATCH = 25;

type Stored = {
  id: string;
  revision: number;
  source_account_id: string;
  item_enc: Sealed;
  blob_ref: string;
  hold_released_at: Date | null;
  model_hold_at: Date | null;
  compartments: string[];
  compartment: string;
};

// The chat lines of moments whose text has expired, which no sync can derive again.
type KeptLine = {
  id: string;
  evidence_id: string;
  line: number;
  entity_id: string;
  direction: string;
  occurred_at: Date;
  others: number;
  thread_fp: string | null;
  compartments: string[];
  handle_fp: string | null;
  created_at: Date;
};
const KEPT_LINES = `
  select c.id, c.evidence_id, c.line, c.entity_id, c.direction, c.occurred_at, c.others, c.thread_fp, c.compartments, c.handle_fp, c.created_at
  from knowledge.chat_lines c join vault.evidence_items e on e.id = c.evidence_id
  where e.payload_state = 'expired'
  order by c.id`;
// The one person holding a handle's account under a line's label, as the step resolves a holder.
const HOLDER = sql`select a.entity_id from ${holders("$1", "$2::text[]")} group by a.entity_id order by a.entity_id collate "C" limit 2`;

// Each kept line back on whoever holds its handle under its label now: one person, never two, the
// owner or no one (then the line is dropped). A row written before handles were kept has none, and
// goes back on its own person only while that person is still here. The row keeps its id, times,
// size, thread and label; only its person can change. Returns how many went back and how many went.
async function restoreKeptLines(tx: Tx, lines: readonly KeptLine[]): Promise<{ restored: number; dropped: number }> {
  const back: (KeptLine & { person: string })[] = [];
  const moved: string[][] = [];
  const holders = new Map<string, string | null>();
  for (const line of lines) {
    let person: string | null = null;
    if (line.handle_fp !== null) {
      const key = `${line.handle_fp}\n${[...line.compartments].sort().join(",")}`;
      if (!holders.has(key)) {
        const rows = await tx.query<{ entity_id: string }>(HOLDER, [line.handle_fp, line.compartments]);
        holders.set(key, rows.length === 1 ? (rows[0] as { entity_id: string }).entity_id : null);
      }
      person = holders.get(key) ?? null;
    } else {
      const [still] = await tx.query<{ id: string }>(
        "select id from knowledge.entities where id = $1 and kind = 'person'",
        [line.entity_id],
      );
      person = still?.id ?? null;
    }
    if (person !== null) back.push({ ...line, person });
    // A line dropped, or moved to another person, stopped counting where it counted: the warmth
    // days of every label containing its label go, as every other path does.
    if (person !== line.entity_id) moved.push(line.compartments);
  }
  if (moved.length > 0) await removeWarmth(tx.query, moved);
  if (back.length > 0) {
    await tx.query(
      `insert into knowledge.chat_lines (id, evidence_id, line, entity_id, direction, occurred_at, others, thread_fp, compartments, handle_fp, created_at)
       select r.id, r.evidence_id, r.line, r.person, r.direction, r.occurred_at, r.others, r.thread_fp, r.compartments, r.handle_fp, r.created_at
       from jsonb_to_recordset($1::jsonb) as r (id text, evidence_id text, line integer, person text, direction text, occurred_at timestamptz,
         others integer, thread_fp text, compartments text[], handle_fp text, created_at timestamptz)
       on conflict (evidence_id, line, entity_id) do nothing`,
      [JSON.stringify(back)],
    );
  }
  return { restored: back.length, dropped: lines.length - back.length };
}

type Derive = (raw: RawItem, ctx: ItemContext) => Promise<ItemFacts>;

// The refold: what it would do and, unless a dry run, a re-derive that does it. Nothing to fold
// re-derives nothing, and the rulings are re-keyed here.
export async function refoldOrganizations(tx: Tx, derive: Derive, dryRun: boolean) {
  const { plan } = await refoldPlan(tx);
  // The domain ignore rulings a new fold re-keys, written by the re-derive,
  // or here when nothing is left to fold.
  const rekey = await ignoreRekeys(tx);
  const ignores = { rekeyed: rekey.rulings.length, unmatched: rekey.unmatched, coarser: rekey.coarser };
  // The owner's organization names, the same way.
  const named = await nameRekeys(tx);
  const names = { rekeyed: named.names.length, unmatched: named.unmatched, coarser: named.coarser };
  if (dryRun) return { plan, ignores, names, rederived: false, items: 0 };
  if (plan.moved === 0 && plan.dropped.length === 0) {
    await rekeyIgnores(tx, rekey);
    await rekeyNames(tx, named);
    return { plan, ignores, names, rederived: false, items: 0 };
  }
  const { rederived, items } = await rederive(tx, derive, { force: true });
  return { plan, ignores, names, rederived, items };
}

// The re-derive, when NEEDED holds; `force` re-derives whether or not it does: the refold's
// (org-fold.ts).
export async function rederive(
  tx: Tx,
  derive: Derive,
  options: { force?: boolean } = {},
): Promise<{ rederived: boolean; items: number; coarser: number }> {
  if (options.force !== true) {
    const [state] = await tx.query<{ needed: boolean }>(NEEDED);
    if (state?.needed !== true) return { rederived: false, items: 0, coarser: 0 };
  }

  const owner = await ownerEntity(tx);
  // One row back, however many are locked: the process holds no list of them all.
  await tx.query("select count(*) from (select 1 from knowledge.messages for update) as locked");
  await tx.query("select count(*) from (select 1 from vault.evidence_items order by id for no key update) as locked");
  await tx.query(BELIEFS_LOCK);
  await tx.query("select count(*) from (select 1 from knowledge.events for update) as locked");
  await tx.query("select count(*) from (select 1 from knowledge.entities where id <> $1 for update) as locked", [
    owner,
  ]);
  const { noteLinks, firstKnown } = await clearExtracted(tx);
  const { kept, folding, ignores, names } = await keptIdentities(tx);
  const keptLines = await clearPeople(tx, owner);

  // 2. Each item again, as an ingest derives it.
  const { items, resolved } = await deriveEach(tx, derive, { owner, kept, firstKnown });
  await restoreNoteLinks(tx, noteLinks);
  await removeUncited(tx, [...resolved]);
  await restoreKeptLines(tx, keptLines);

  // A message or an event that no longer derives a row was tainted where it was deleted. Every
  // organization that had a domain row, a folded one among them.
  const known = [...kept.people.values(), ...folding.organizations];
  const gone = await tx.query<{ id: string }>(
    "select k.id from unnest($1::text[]) as k (id) where not exists (select 1 from knowledge.entities e where e.id = k.id)",
    [[...new Set(known)]],
  );
  await taintCiting(tx.query, {
    evidenceIds: [],
    refs: gone.map((row) => ({ kind: "entity", id: row.id }) as PersonalRef),
  });
  await rekeyIgnores(tx, ignores);
  await rekeyNames(tx, names);
  // The names a coarser new fold would have widened, left on their old keys, and the domain
  // ignores narrowed to their addresses instead.
  return { rederived: true, items, coarser: ignores.coarser + names.coarser };
}

// What was extracted: every claim entity, claim and unmapped claim. Status rows stay,
// each at generation 0 so every item is due again, with the owner's lane and release; saved
// calls, usage, runs and reviews stay. The foreign keys are `on delete no action`, so the
// entity delete in `clearPeople` depends on this having run. Returns the note links set aside and
// the first-known times of the claims a code-made claim written again carries.
async function clearExtracted(tx: Tx) {
  // The beliefs lock is rederive's, taken in its order there; held already, taking it again here
  // returns at once and keeps the drop of the declassified copies below it in this function.
  await tx.query(BELIEFS_LOCK);
  // A re-derive is backfill, so its rechecks raise nothing.
  await setTriggerCause(tx.query, "backfill");
  // Every project binding, before the claims; a project and its anchors are the owner's
  // and stay, and the replay binds the claims again.
  await tx.query("delete from knowledge.project_bindings");
  const noteLinks = await setAsideNoteLinks(tx);
  await tx.query(DROP_EVERY_DECLASSIFIED);
  // An extracted item's carry goes on its status row, which its next commit reads; a code-made
  // claim written again below (a contact's, whose item has no status row) carries it from
  // `firstKnown`.
  const coded = await tx.query<{ evidence_id: string; known: Record<string, string> }>(CARRY);
  const firstKnown = new Map(coded.map((row) => [row.evidence_id, new Map(Object.entries(row.known))]));
  // Every claim but an owner_command item's, with its entity rows: those are the owner's own
  // command's, made by code and never extracted, so a re-derive keeps them (and with them each
  // goal's mapping row, knowledge.goal_ids, which a claim's delete would take). Through the
  // definer, since the admin runs a re-derive too and holds no delete on claims.
  await tx.query("select knowledge.remove_extracted_claims()");
  await tx.query("delete from vault.unmapped_claims");
  await tx.query("update vault.pipeline_items set extractor_generation = 0");
  return { noteLinks, firstKnown };
}

// The ids a person and an organization keep, read before anything of theirs is deleted: a person's
// by address fingerprint, and nothing sealed; an organization's by its registrable domain's
// fingerprint, each domain row opened to fold it. One entry for each address and each organization
// domain.
async function keptIdentities(tx: Tx) {
  const people = await tx.query<{ value_fp: string; entity_id: string }>(
    `select distinct on (a.value_fp) a.value_fp, a.entity_id from knowledge.accounts a
     join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' order by a.value_fp, a.id`,
  );
  const folding = await refoldPlan(tx);
  // The domain ignore rulings, keyed again by the fold the rows are about to take,
  // read while the accounts are here and written after the taint lock, in `rederive`.
  const ignores = await ignoreRekeys(tx);
  // And the owner's organization names, the same way.
  const names = await nameRekeys(tx);
  const kept: KeptIds = {
    people: new Map(people.map((row) => [row.value_fp, row.entity_id])),
    organizations: folding.kept,
  };
  return { kept, folding, ignores, names };
}

// Every chat line with the interactions, before the entities, and every capture's lines_fp
// nulled, so the participant step derives them again over the following syncs; then every
// account and entity but the owner's and the projects. A line whose moment's text has expired
// cannot be derived again, so it is set aside and returned, to be put back after the people are,
// on whoever then holds its handle (`handle_fp`).
async function clearPeople(tx: Tx, owner: string): Promise<KeptLine[]> {
  const keptLines = await tx.query<KeptLine>(KEPT_LINES);
  for (const table of [
    "chat_lines",
    "interaction_log",
    "aliases",
    "event_participants",
    "contact_addresses",
    "contacts",
    "domains",
  ]) {
    await tx.query(`delete from knowledge.${table}`);
  }
  await tx.query("update knowledge.captures set lines_fp = null where lines_fp is not null");
  await tx.query("delete from knowledge.accounts where entity_id <> $1", [owner]);
  await tx.query("delete from knowledge.entities where id <> $1 and kind <> 'project'", [owner]);
  return keptLines;
}

// Each item again, as an ingest derives it: its own id and revision, its account's compartment,
// and the identity port on this transaction. Every row takes the item's label as its evidence row
// has it: a re-derive never changes a label. Returns how many items it derived and whoever the
// port resolved.
async function deriveEach(
  tx: Tx,
  derive: Derive,
  given: { owner: LocalEntityId; kept: KeptIds; firstKnown: Map<string, Map<string, string>> },
): Promise<{ items: number; resolved: Set<string> }> {
  const addresses = await ownerAddresses(tx);
  await tx.query(`declare latest no scroll cursor for ${LATEST}`, [THE_OWNER]);
  let items = 0;
  const resolved = new Set<string>();
  for (;;) {
    const batch = await tx.query<Stored>(`fetch ${BATCH} from latest`);
    for (const item of batch) {
      const { compartment, compartments: label } = item;
      const [blob] = await tx.query<{ envelope: Sealed }>(
        "select envelope from vault.evidence_blobs where blob_ref = $1",
        [item.blob_ref],
      );
      const raw = RawItem.parse({
        ...(JSON.parse(open(tx.keys, item, "vault.evidence_items.item_enc", "throw")) as object),
        payload: open(
          tx.keys,
          { id: item.blob_ref, compartments: label, envelope: blob?.envelope },
          "vault.evidence_blobs.envelope",
          "throw",
        ),
      });
      const evidenceId = EvidenceId.parse(item.id);
      const identity = identityPort(tx, given.kept);
      // Asked again, over all the sent mail stored now: the recipient rows are not derived, so
      // the answer does not depend on the order the items were stored in.
      const ctx: ItemContext = {
        evidenceId,
        revision: item.revision,
        compartment,
        ownerAddresses: addresses,
        ownerEntity: given.owner,
        identity: identity.resolver,
        senderWrittenTo:
          raw.sourceKind === "email" && (await writtenTo(tx, item.source_account_id, raw.sender, isHeadersMail(raw))),
      };
      // The derive is handed a copy, so nothing it changes loosens the checks below, or the
      // addresses every later item is checked against.
      const facts = await derive(raw, { ...ctx, ownerAddresses: [...addresses] });
      checkFacts(facts, raw, ctx);
      await identity.write(label);
      // Whoever the port resolved and no row names is removed once, after the last item: a
      // person removed here and resolved again by a later item would be removed, tainted and
      // made again under its kept id.
      for (const entity of identity.resolved) resolved.add(entity);
      await writeDerived(
        tx,
        { id: item.source_account_id, compartment },
        label,
        raw,
        evidenceId,
        facts,
        item.id,
        new Set(),
        item.hold_released_at !== null,
        item.model_hold_at !== null,
        given.firstKnown.get(evidenceId),
      );
      // 3. Who of the owner was on it is derived too. Nothing else of the evidence row changes.
      await tx.query("update vault.evidence_items set participant_members = $2, sender_member = $3 where id = $1", [
        item.id,
        facts.members.participantMembers,
        facts.members.senderMember ?? null,
      ]);
    }
    items += batch.length;
    if (batch.length < BATCH) break;
  }
  await tx.query("close latest");
  return { items, resolved };
}

// A person keeps its id by address fingerprint across a re-derive, so the link goes back to the
// same id; failing that, to the person who holds one of its addresses now. A person with no address
// left is made again by no item, and its notes keep no link. The same holds for any owner_command
// claim about a person, a correction's too.
type NoteLink = { claim_id: string; entity_id: string; compartments: string[]; fps: string[] };

async function setAsideNoteLinks(tx: Tx): Promise<NoteLink[]> {
  const links = await tx.query<NoteLink>(
    `select n.claim_id, n.entity_id, n.compartments, array(select a.value_fp from knowledge.accounts a where a.entity_id = n.entity_id order by 1) as fps
     from knowledge.claim_entities n join knowledge.claims c on c.id = n.claim_id join knowledge.entities e on e.id = n.entity_id
       join vault.evidence_items v on v.id = c.evidence_id
     where v.source_kind = 'owner_command' and e.kind = 'person' order by n.claim_id, n.entity_id`,
  );
  // Only the person links it puts back, through the definer the admin and the writer execute.
  await tx.query("select knowledge.remove_person_links($1)", [links.map((one) => one.claim_id)]);
  return links;
}

async function restoreNoteLinks(tx: Tx, links: NoteLink[]): Promise<void> {
  for (const link of links) {
    const [person] = await tx.query<{ id: string }>(
      `select e.id from knowledge.entities e where e.kind = 'person' and (e.id = $1 or e.id in (select a.entity_id from knowledge.accounts a where a.value_fp = any($2)))
       order by (e.id = $1) desc, e.id limit 1`,
      [link.entity_id, link.fps],
    );
    if (person !== undefined)
      await tx.query(
        "insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, $3) on conflict do nothing",
        [link.claim_id, person.id, link.compartments],
      );
  }
}
