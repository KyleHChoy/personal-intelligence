import type { Envelope, EvidenceId, RawItem } from "@intelligence/contracts";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { e164Of, phoneRegionOf } from "@intelligence/personal-core";
import {
  CONTACT_CLAIMS_VERSION,
  type ContactClaimsVersion,
  contactClaims,
  type ItemFacts,
  importClaims,
  REFUSED_MARKER,
} from "@intelligence/personal-core/items";
import {
  carryKey,
  claimDates,
  type FirstKnown,
  firstKnownOf,
  insertClaimValues,
  legacyFactKeyFps,
  valueFpOf,
} from "../core/claim-columns.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { open, openRow, type Sealed, sealRow, sealUnder } from "../core/seal.ts";
import { setTriggerCause } from "../core/stored-forms.ts";
import type { Tx } from "../core/tx.ts";
import { ownerZoneOf } from "../core/zone.ts";
import { suppressedFps } from "../identity/identity-port.ts";
import { fileOrgName } from "./named-orgs.ts";
import { removeClaims } from "./writer-removal.ts";

// The versions a contact's claims may be made at.
export type { ContactClaimsVersion };

// A stored contact's derived rows: one knowledge.contacts row with its sealed facts and its
// fingerprint lists, and a knowledge.contact_addresses row for each address that resolved to a
// person. Every row takes the account's compartment. And the role and affiliation claims code makes
// from its organizations, under its evidence row's label, in the same transaction, so a new
// revision replaces them and a deletion removes them with everything else of the item.

type Account = { id: string; compartment: string };
type ContactFacts = Extract<ItemFacts, { kind: "contact" }>;

// Every address the contact lists, uncut: the raw item's listed identifiers.
export const contactAddresses = (raw: Pick<RawItem, "permissions">): string[] =>
  raw.permissions.scope === "listed" ? raw.permissions.identifiers : [];

const refusedForms = (raw: RawItem): string[] =>
  raw.markers.filter((one) => one.startsWith(REFUSED_MARKER)).map((one) => one.slice(REFUSED_MARKER.length));

// The raw item as it is sealed beside its payload: without the refused forms, so none is in any
// row.
export const withoutRefused = (raw: RawItem): RawItem => ({
  ...raw,
  markers: raw.markers.filter((one) => !one.startsWith(REFUSED_MARKER)),
});

export async function contactSuppressed(tx: Tx, raw: RawItem): Promise<boolean> {
  const fps = [...contactAddresses(raw), ...refusedForms(raw)].map((address) =>
    fingerprint(tx.keys, "address", address),
  );
  return (await suppressedFps(tx, fps)).size > 0;
}

// The contact rows that cite any of these revisions, children first. The contact's id, when one
// was removed, is returned so a later revision keeps it.
export async function removeContactRows(tx: Tx, evidenceIds: string[]): Promise<string | undefined> {
  const contacts = await tx.query<{ id: string }>("select id from knowledge.contacts where evidence_id = any($1)", [
    evidenceIds,
  ]);
  const ids = contacts.map((row) => row.id);
  if (ids.length === 0) return undefined;
  await tx.query("delete from knowledge.contact_addresses where contact_id = any($1)", [ids]);
  await tx.query("delete from knowledge.contacts where id = any($1)", [ids]);
  return ids[0];
}

// The `phone` fingerprints of a contact's phones in E.164 form, sorted, by which the participant
// step finds the contact of a source moment's phone handle without opening every contact. A
// national number is read in `region`, the owner's (phoneRegion).
const phoneFps = (
  keys: Tx["keys"],
  phones: readonly { value: string; canonical?: string | null }[],
  region: string | null,
): string[] =>
  [
    ...new Set(
      phones
        .map((one) => e164Of(one, region))
        .filter((one): one is string => one !== null)
        .map((one) => fingerprint(keys, "phone", one)),
    ),
  ].sort();

// The calling code the owner's time zone gives a national number (phoneRegionOf), read in the
// transaction, null while the zone is unset or outside the plan.
const phoneRegion = async (tx: Tx): Promise<string | null> => phoneRegionOf(await ownerZoneOf(tx.query));

// `id` is the contact's id when an earlier revision had one.
export async function writeContact(
  tx: Tx,
  account: Account,
  raw: RawItem,
  evidenceId: EvidenceId,
  facts: ContactFacts,
  id: string = newId("con"),
): Promise<void> {
  const compartments = [account.compartment];
  const { sourceId: _sourceId, updatedAt: _updatedAt, ...sealed } = facts.contact;
  const region = await phoneRegion(tx);
  await tx.query(
    `insert into knowledge.contacts (id, evidence_id, account_id, source_contact_fp, updated_at, address_fps, name_fps, facts_enc, compartments, phone_fps, phone_region)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      evidenceId,
      account.id,
      fingerprint(tx.keys, "source_id", raw.sourceItemId),
      facts.contact.updatedAt,
      [...new Set(contactAddresses(raw).map((address) => fingerprint(tx.keys, "address", address)))],
      [...new Set(facts.contact.names.map((name) => fingerprint(tx.keys, "name", name)))],
      sealRow(
        tx.keys,
        account.compartment,
        { table: "knowledge.contacts", id, column: "facts_enc" },
        JSON.stringify(sealed),
      ),
      compartments,
      phoneFps(tx.keys, facts.contact.phones, region),
      region,
    ],
  );
  await tx.query(
    `insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments)
     select $1, one.fp, one.entity, $2 from unnest($3::text[], $4::text[]) as one (fp, entity)
     on conflict (contact_id, value_fp) do nothing`,
    [
      id,
      compartments,
      facts.people.map((one) => fingerprint(tx.keys, "address", one.address)),
      facts.people.map((one) => one.entity),
    ],
  );
}

// The contact's organizations as role and affiliation claims, by code, about each person its
// addresses resolved to. Each claim carries its evidence row's label, as the database holds it to.
// The ids are fixed by the revision, so writing them again is a no-op. `addresses` are every
// identifier the contact lists (contactAddresses), which the contact quality rules read.
export async function writeContactClaims(
  tx: Tx,
  evidenceId: EvidenceId,
  facts: ContactFacts,
  addresses: readonly string[],
  version: ContactClaimsVersion = CONTACT_CLAIMS_VERSION,
  firstKnown?: ReadonlyMap<string, string>,
): Promise<number> {
  const records = await contactRecords(tx, evidenceId, facts, addresses, version);
  if (records === undefined) return 0;
  await insertContactClaims(tx, evidenceId, records, firstKnown);
  return records.records.length;
}

type ContactRecords = { records: ClaimRecord[]; compartments: string[]; readers: string[] };

async function contactRecords(
  tx: Tx,
  evidenceId: EvidenceId,
  facts: {
    people: readonly { entity: string }[];
    contact: Pick<ContactFacts["contact"], "updatedAt" | "organizations" | "imported" | "links">;
  },
  addresses: readonly string[],
  version: ContactClaimsVersion,
): Promise<ContactRecords | undefined> {
  const [item] = await tx.query<{ compartments: string[]; readers: string[] }>(
    "select compartments, readers from vault.evidence_items where id = $1",
    [evidenceId],
  );
  if (item === undefined) return undefined;
  const { links } = facts.contact;
  const input = {
    evidenceId,
    compartments: item.compartments,
    readers: item.readers,
    observedAt: facts.contact.updatedAt,
    organizations: facts.contact.organizations,
    ...(links === undefined ? {} : { links }),
    people: facts.people,
    addresses,
  };
  // Contact import: an imported contact's claims, at the same fact key version.
  const { imported } = facts.contact;
  const records =
    imported === undefined ? contactClaims(input, version) : importClaims({ ...input, imported }, version);
  return { records, compartments: item.compartments, readers: item.readers };
}

// `known`: when each value of the claims these replace was first known.
async function insertContactClaims(
  tx: Tx,
  evidenceId: EvidenceId,
  { records, compartments, readers }: ContactRecords,
  known?: FirstKnown,
): Promise<void> {
  const item = { compartments, readers };
  for (const record of records) {
    const id = fingerprint(tx.keys, "claim", record.claim.id);
    const factKeyFp = fingerprint(tx.keys, "fact", record.factKey);
    const legacy = legacyFactKeyFps(tx, record);
    const dates = claimDates(record);
    const valueFp = valueFpOf(tx.keys, record);
    const inserted = await tx.query<{ id: string }>(
      `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments, legacy_fact_key_fp, legacy_alt_fact_key_fp,
         valid_to, due_at, review_at, first_known_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, coalesce($15::timestamptz, now())) on conflict (id) do nothing returning id`,
      [
        id,
        evidenceId,
        record.claim.content.type,
        record.claim.validFrom,
        factKeyFp,
        record.claim.extractorGeneration,
        item.readers,
        sealUnder(
          tx.keys,
          item.compartments,
          { table: "knowledge.claims", id, column: "content_enc" },
          JSON.stringify(record),
        ),
        item.compartments,
        ...legacy,
        dates.validTo,
        dates.dueAt,
        dates.reviewAt,
        known?.get(carryKey(valueFp, item.compartments)) ?? null,
      ],
    );
    if (inserted.length > 0) {
      await insertClaimValues(tx, {
        id,
        evidenceId,
        factKeyFps: [factKeyFp, ...legacy],
        compartments: item.compartments,
        valueFp,
      });
      await fileOrgName(tx, id, record);
    }
    await tx.query(
      `insert into knowledge.claim_entities (claim_id, entity_id, compartments)
       select $1, one.entity, $2 from unnest($3::text[]) as one (entity) on conflict do nothing`,
      [id, item.compartments, record.entities],
    );
  }
}

// Every stored contact's claims made again at `version`, counted: the contacts, those that
// changed, and the claims removed and written.
export async function reclaimContacts(
  tx: Tx,
  { dryRun, version }: { dryRun: boolean; version?: ContactClaimsVersion },
): Promise<{ contacts: number; changed: number; removed: number; written: number }> {
  const contacts = await tx.query<{ id: string }>("select id from knowledge.contacts order by id");
  const counts = { contacts: contacts.length, changed: 0, removed: 0, written: 0 };
  // A reclaim makes claims again under a raised version, as a generation raise does, so the
  // contact triggers write its rechecks as backfill and raise no change to agents.
  if (!dryRun) await setTriggerCause(tx.query, "backfill");
  for (const { id } of contacts) {
    const done = await reclaimContact(tx, id, { dryRun, ...(version === undefined ? {} : { version }) });
    if (done.removed + done.written > 0) counts.changed += 1;
    counts.removed += done.removed;
    counts.written += done.written;
  }
  return counts;
}

// One stored contact's claims made again at `version`, from its stored rows: its sealed
// organizations, its revision time and the people its addresses resolved to, and the identifiers
// its evidence row lists. The claims of its item not made at `version` are removed, with the
// beliefs they support, and the new ones written, under pi_writer's own grants. With `dryRun`
// nothing is written. `removed` counts the claims removed, or that would be; `written` those not
// yet stored.
export async function reclaimContact(
  tx: Tx,
  contactId: string,
  options: { dryRun: boolean; version?: ContactClaimsVersion },
): Promise<{ removed: number; written: number }> {
  const [contact] = await tx.query<{
    evidence_id: EvidenceId;
    updated_at: Date;
    facts_enc: Envelope;
    compartments: string[];
  }>("select evidence_id, updated_at, facts_enc, compartments from knowledge.contacts where id = $1", [contactId]);
  if (contact === undefined) return { removed: 0, written: 0 };
  const [compartment] = contact.compartments;
  if (compartment === undefined) return { removed: 0, written: 0 };
  const sealed = JSON.parse(
    openRow(
      tx.keys,
      compartment,
      { table: "knowledge.contacts", id: contactId, column: "facts_enc" },
      contact.facts_enc,
    ),
  ) as Pick<ContactFacts["contact"], "organizations" | "imported" | "links">;
  const people = await tx.query<{ entity: string }>(
    "select distinct entity_id as entity from knowledge.contact_addresses where contact_id = $1 order by 1",
    [contactId],
  );
  // An imported contact's claims are made again from its sealed fields, and its links too.
  const facts = {
    updatedAt: contact.updated_at.toISOString(),
    organizations: sealed.organizations,
    ...(sealed.links === undefined ? {} : { links: sealed.links }),
    ...(sealed.imported === undefined ? {} : { imported: sealed.imported }),
  };
  const made = await contactRecords(
    tx,
    contact.evidence_id,
    { people, contact: facts },
    await listedAddresses(tx, contact.evidence_id),
    options.version ?? CONTACT_CLAIMS_VERSION,
  );
  if (made === undefined) return { removed: 0, written: 0 };
  const keep = made.records.map((record) => fingerprint(tx.keys, "claim", record.claim.id));
  const stored = (
    await tx.query<{ id: string }>("select id from knowledge.claims where evidence_id = $1 order by id", [
      contact.evidence_id,
    ])
  ).map((row) => row.id);
  const gone = stored.filter((id) => !keep.includes(id));
  const missing = keep.filter((id) => !stored.includes(id)).length;
  // A claim made again of the same value keeps its time.
  const known = options.dryRun ? new Map<string, string>() : await firstKnownOf(tx, gone);
  // The next rebuild builds the beliefs again from the new claims.
  if (!options.dryRun) await removeClaims(tx.query, gone);
  if (!options.dryRun && missing > 0) await insertContactClaims(tx, contact.evidence_id, made, known);
  return { removed: gone.length, written: missing };
}

// Every identifier a stored contact's evidence row lists, as contactAddresses reads
// them from its raw item: its sealed item, opened under its own label. None when the row keeps no
// sealed item.
async function listedAddresses(tx: Tx, evidenceId: EvidenceId): Promise<string[]> {
  const [row] = await tx.query<{ compartments: string[]; item_enc: Sealed | null }>(
    "select compartments, item_enc from vault.evidence_items where id = $1",
    [evidenceId],
  );
  if (row === undefined || row.item_enc === null) return [];
  return contactAddresses(
    JSON.parse(
      open(
        tx.keys,
        { id: evidenceId, compartments: row.compartments, item_enc: row.item_enc },
        "vault.evidence_items.item_enc",
        "throw",
      ),
    ) as Pick<RawItem, "permissions">,
  );
}

// The contacts stored before phone_fps was, each filled from its sealed phones, at most `limit` a
// sync, so no sync opens every contact. Returns the rows filled. Each row filled in another region
// than the owner's now (`phone_region`) is filled too, so rows read with no region, which read no
// national number, are filled again once, and again only when the owner's region changes.
export async function fillPhoneFps(tx: Tx, limit: number): Promise<number> {
  const region = await phoneRegion(tx);
  const rows = await tx.query<{ id: string; compartments: string[]; facts_enc: Envelope }>(
    "select id, compartments, facts_enc from knowledge.contacts where phone_fps is null or phone_region is distinct from $2 order by id limit $1 for update skip locked",
    [limit, region],
  );
  let filled = 0;
  for (const row of rows) {
    const [compartment] = row.compartments;
    // A row that does not open (a key the file lacks) is left for a later sync. One filled
    // already is marked with the region, its fingerprints kept, so it does not hold a place in
    // every later sync's window.
    let sealed: { phones?: unknown } | null;
    try {
      sealed =
        compartment === undefined
          ? null
          : (JSON.parse(
              open(
                tx.keys,
                { id: row.id, compartments: [compartment], facts_enc: row.facts_enc },
                "knowledge.contacts.facts_enc",
                "throw",
              ),
            ) as { phones?: unknown });
    } catch {
      await tx.query("update knowledge.contacts set phone_region = $2 where id = $1 and phone_fps is not null", [
        row.id,
        region,
      ]);
      continue;
    }
    const phones = Array.isArray(sealed?.phones)
      ? sealed.phones.filter(
          (one): one is { value: string; canonical?: string | null } =>
            typeof one === "object" && one !== null && typeof (one as { value?: unknown }).value === "string",
        )
      : [];
    await tx.query("update knowledge.contacts set phone_fps = $2, phone_region = $3 where id = $1", [
      row.id,
      phoneFps(tx.keys, phones, region),
      region,
    ]);
    filled += 1;
  }
  return filled;
}
