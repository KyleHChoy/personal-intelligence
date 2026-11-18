import { ClaimRecord } from "@intelligence/contracts/personal";
import { normal } from "@intelligence/personal-beliefs";
import { secondDegreeRules } from "@intelligence/personal-core/views";
import { fingerprint } from "../core/fingerprint.ts";
import { newId, orgNameId } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { labelJoined } from "../core/labels.ts";
import { ORGANIZATION_TYPES, orgNameFp } from "../core/org-names.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import { eachInOwnTransaction, type Tx } from "../core/tx.ts";
import { anySuppressed } from "../identity/identity-port.ts";

// An organization known only by name. The commit files a name row beside each `affiliation` or
// `role` claim that names its organization by `organization_name` alone (knowledge.claim_org_names:
// the name's keyed fingerprint, no text). At each sync the writer's binding step, after the named
// people's, gives each such name under a label an organization: the one already named by it under
// exactly that label, else the one the owner named so (`pi org name`, under the label), else a new
// one keyed `orgname:<keyed fingerprint of the name and the label>`, under the named people's daily
// cap. It writes one knowledge.org_names row for each name, label and citing item. A domainless
// organization holds no domain row and no account: its name rows are its key, and the reader sees
// it through them. The claim is never changed (invariant 3): reads resolve its organization through
// the two tables. Code alone binds (invariant 5); every read is of one label (invariant 6). A
// contact claim files its name when the writer stores it (writer-contacts.ts), and a name only
// contacts give is made under its own daily allowance, not the named people's.

const TYPES: ReadonlySet<string> = new Set(ORGANIZATION_TYPES);

// The name a claim knows its organization by alone, as written, or null: an `affiliation` or a
// `role` with a non-empty `organization_name` and no `organization` entity.
function organizationNameOf(record: ClaimRecord): string | null {
  const { type, fields } = record.claim.content;
  if (!TYPES.has(type) || fields.organization !== undefined) return null;
  const name = fields.organization_name;
  return typeof name === "string" && normal(name).text.trim() !== "" ? name.trim() : null;
}

const orgKey = (keys: Keys, nameFp: string, label: readonly string[]): string =>
  `orgname:${fingerprint(keys, "source_id", `named organization\n${nameFp}\n${labelJoined(label)}`)}`;

// The fingerprint an erasure suppresses a key by, as it suppresses a named person's key (an account).
const orgKeyFp = (keys: Keys, nameFp: string, label: readonly string[]): string =>
  fingerprint(keys, "address", orgKey(keys, nameFp, label));

// The commit's row (pipeline-write.ts): its claim's id, name fingerprint and label.
export async function fileOrgName(tx: Tx, claimId: string, record: ClaimRecord): Promise<void> {
  const name = organizationNameOf(record);
  if (name === null) return;
  await tx.query("insert into knowledge.claim_org_names (claim_id, name_fp, compartments) values ($1, $2, $3)", [
    claimId,
    orgNameFp(tx.keys, name),
    record.claim.label.compartments,
  ]);
}

// The contact claims stored before a contact claim filed its name: every role and affiliation of a
// contact's item with no name row.
const UNFILED_CONTACT_CLAIMS = `
  select c.id, c.compartments, c.content_enc
  from knowledge.claims c
  join knowledge.contacts k on k.evidence_id = c.evidence_id
  where c.type = any($1::text[]) and not exists (select 1 from knowledge.claim_org_names x where x.claim_id = c.id)
  order by c.id`;

export type FiledContactNames = { claims: number; filed: number; skipped: number };

// `pi contacts file-org-names`: each stored contact claim's name row, under the claim's own label,
// as its commit would have filed it. With `dryRun` nothing is written. `claims`: those with no row
// (a role with a title alone has none to file); `skipped`: those the key file cannot open, or that
// no longer parse, as settleName treats one.
export async function fileStoredContactNames(tx: Tx, dryRun: boolean): Promise<FiledContactNames> {
  const rows = await tx.query<{ id: string; compartments: string[]; content_enc: Sealed }>(UNFILED_CONTACT_CLAIMS, [
    ORGANIZATION_TYPES,
  ]);
  const counts = { claims: rows.length, filed: 0, skipped: 0 };
  for (const row of rows) {
    if (!row.compartments.every((one) => tx.keys.compartments.has(one))) {
      counts.skipped += 1;
      continue;
    }
    const parsed = ClaimRecord.safeParse(JSON.parse(open(tx.keys, row, "knowledge.claims.content_enc", "throw")));
    if (!parsed.success) {
      counts.skipped += 1;
      continue;
    }
    if (organizationNameOf(parsed.data) === null) continue;
    counts.filed += 1;
    if (!dryRun) await fileOrgName(tx, row.id, parsed.data);
  }
  return counts;
}

// The name rows no org_names row covers yet for their claim's item, with what opens the claim.
const PENDING = `
  select n.claim_id, n.name_fp, n.compartments, c.evidence_id, c.content_enc, c.released or c.closes or c.researched as own_label, e.compartments as item_compartments,
    e.source_kind = 'crm' as from_contact
  from knowledge.claim_org_names n
  join knowledge.claims c on c.id = n.claim_id
  join vault.evidence_items e on e.id = c.evidence_id
  where not exists (
    select 1 from knowledge.org_names o
    where o.name_fp = n.name_fp and o.compartments @> n.compartments and o.compartments <@ n.compartments and o.evidence_id = c.evidence_id)
  order by n.name_fp, n.claim_id`;

type Pending = {
  claim_id: string;
  name_fp: string;
  compartments: string[];
  evidence_id: string;
  content_enc: Sealed;
  own_label: boolean;
  item_compartments: string[];
  from_contact: boolean;
};

// The organization a name already names under exactly the label.
const BY_NAME = `
  select o.entity_id from knowledge.org_names o
  where o.name_fp = $1 and o.compartments @> $2::text[] and o.compartments <@ $2::text[]
  order by o.id limit 1`;

// The organizations the owner named, each live name and its label within the label, on a domain
// the label holds.
const OWNER_NAMED = `
  select n.id, n.name_enc, n.compartments, min(d.entity_id) as entity_id
  from knowledge.organization_names n
  join knowledge.domains d on d.domain_fp = n.domain_fp and d.compartments <@ $1::text[]
  join knowledge.entities e on e.id = d.entity_id and e.kind = 'organization'
  where n.lifted_at is null and n.compartments <@ $1::text[]
  group by n.id, n.name_enc, n.compartments
  order by n.id`;

const NOT_FROM_CONTACT =
  "not exists (select 1 from vault.evidence_items i where i.id = o.evidence_id and i.source_kind = 'crm')";
const MADE_SINCE_MIDNIGHT =
  "e.named and e.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'";
export const MADE_TODAY = `
  select count(distinct e.id)::int as n from knowledge.entities e
  where ${MADE_SINCE_MIDNIGHT}
    and (exists (select 1 from knowledge.accounts a where a.entity_id = e.id and a.compartments @> $1::text[] and a.compartments <@ $1::text[])
      or exists (select 1 from knowledge.org_names o where o.entity_id = e.id and o.compartments @> $1::text[] and o.compartments <@ $1::text[] and ${NOT_FROM_CONTACT}))`;
const CONTACT_ORGS_MADE_TODAY = `
  select count(distinct e.id)::int as n from knowledge.entities e
  join knowledge.org_names n on n.entity_id = e.id and n.compartments @> $1::text[] and n.compartments <@ $1::text[]
  where ${MADE_SINCE_MIDNIGHT}
    and not exists (select 1 from knowledge.org_names o where o.entity_id = e.id and ${NOT_FROM_CONTACT})`;

// The name rows of an item whose claims no longer name the organization so (a re-extraction that
// dropped the claim, or one under another label): the item's and the entity's deletes take the rest.
// An owner_command item holds no claim: its row stands on the owner's word on a goal's target.
const STALE = `
  delete from knowledge.org_names o
  where not exists (
    select 1 from knowledge.claim_org_names x join knowledge.claims c on c.id = x.claim_id
    where x.name_fp = o.name_fp and x.compartments @> o.compartments and x.compartments <@ o.compartments and c.evidence_id = o.evidence_id)
    and not exists (select 1 from vault.evidence_items i where i.id = o.evidence_id and i.source_kind = 'owner_command')
  returning o.id`;

export type OrgCounts = {
  orgBound: number;
  orgMade: number;
  orgCapped: number;
  orgSuppressed: number;
  orgFailed: number;
  orgRemoved: number;
};

// The organization a name already names under exactly the label, else the one the owner named so.
async function namedAlready(tx: Tx, nameFp: string, label: string[]): Promise<string | undefined> {
  const entity = (await tx.query<{ entity_id: string }>(BY_NAME, [nameFp, label]))[0]?.entity_id;
  if (entity !== undefined) return entity;
  for (const row of await tx.query<{ id: string; name_enc: Sealed; compartments: string[]; entity_id: string }>(
    OWNER_NAMED,
    [label],
  )) {
    const named = open(tx.keys, row, "knowledge.organization_names.name_enc", "throw");
    if (orgNameFp(tx.keys, named) === nameFp) return row.entity_id;
  }
  return undefined;
}

// One knowledge.org_names row, under its name's fingerprint and label, for one citing item.
async function writeOrgName(
  tx: Tx,
  row: { entity: string; nameFp: string; name: string; evidence: string; label: string[] },
): Promise<boolean> {
  const id = orgNameId();
  const [written] = await tx.query<{ id: string }>(
    `insert into knowledge.org_names (id, entity_id, name_fp, name_enc, evidence_id, compartments) values ($1, $2, $3, $4, $5, $6)
     on conflict (name_fp, compartments, evidence_id) do nothing returning id`,
    [
      id,
      row.entity,
      row.nameFp,
      sealUnder(tx.keys, row.label, { table: "knowledge.org_names", id, column: "name_enc" }, row.name),
      row.evidence,
      row.label,
    ],
  );
  return written !== undefined;
}

// Found or made as a claim's name is, but outside the daily cap, as the owner's named people are:
// they name few, each by hand. An erased key makes nobody again. The goal's target follows the row.
export async function settleCommandedOrg(
  tx: Tx,
  row: { nameFp: string; name: string; evidence: string; label: string[] },
  counts: OrgCounts,
): Promise<void> {
  const { nameFp, name, evidence, label } = row;
  let entity = await namedAlready(tx, nameFp, label);
  if (entity === undefined) {
    if (await anySuppressed(tx.query, [orgKeyFp(tx.keys, nameFp, label)])) {
      counts.orgSuppressed += 1;
      return;
    }
    entity = newId("ent");
    await tx.query("insert into knowledge.entities (id, kind, named) values ($1, 'organization', true)", [entity]);
    counts.orgMade += 1;
  }
  if (await writeOrgName(tx, { entity, nameFp, name, evidence, label })) counts.orgBound += 1;
}

// One name under one label, in one transaction: its organization found or made, and a row for each
// citing item. Counts into `counts`.
async function settleName(tx: Tx, rows: Pending[], counts: OrgCounts): Promise<void> {
  const first = rows[0] as Pending;
  const label = first.compartments;
  // Each citing item's name as it wrote it, opened from its claim; a claim whose name does not open
  // to its row's fingerprint names nothing.
  const named = new Map<string, string>();
  for (const row of rows) {
    if (named.has(row.evidence_id)) continue;
    const sealedUnder = row.own_label ? row.compartments : row.item_compartments;
    const parsed = ClaimRecord.safeParse(
      JSON.parse(
        open(
          tx.keys,
          { id: row.claim_id, compartments: sealedUnder, content_enc: row.content_enc },
          "knowledge.claims.content_enc",
          "throw",
        ),
      ),
    );
    const name = parsed.success ? organizationNameOf(parsed.data) : null;
    if (name !== null && orgNameFp(tx.keys, name) === row.name_fp) named.set(row.evidence_id, name);
  }
  if (named.size === 0) return;
  let entity = await namedAlready(tx, first.name_fp, label);
  if (entity === undefined) {
    if (await anySuppressed(tx.query, [orgKeyFp(tx.keys, first.name_fp, label)])) {
      counts.orgSuppressed += rows.length;
      return;
    }
    const rules = secondDegreeRules();
    const contactsAlone = rows.every((row) => row.from_contact);
    const made =
      (await tx.query<{ n: number }>(contactsAlone ? CONTACT_ORGS_MADE_TODAY : MADE_TODAY, [label]))[0]?.n ?? 0;
    if (made >= (contactsAlone ? rules.contactOrgsPerLabelPerDay : rules.namedPerLabelPerDay)) {
      counts.orgCapped += rows.length;
      return;
    }
    entity = newId("ent");
    await tx.query("insert into knowledge.entities (id, kind, named) values ($1, 'organization', true)", [entity]);
    counts.orgMade += 1;
  }
  for (const [evidence, name] of named) {
    if (await writeOrgName(tx, { entity, nameFp: first.name_fp, name, evidence, label })) counts.orgBound += 1;
  }
}

// The step, after the named people's (named-binding.ts): one transaction for each name and label,
// then the name rows no claim of their item holds any more removed, after, so an item's new revision
// keeps its organization. A name that fails is counted and left for the next sync, as the named
// people's items are.
export async function bindNamedOrgs(
  direct: Tx,
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  counts: OrgCounts,
): Promise<void> {
  const groups = new Map<string, Pending[]>();
  for (const row of await direct.query<Pending>(PENDING)) {
    const key = `${row.name_fp}\n${labelJoined(row.compartments)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const failed = await eachInOwnTransaction(groups.values(), (rows) =>
    transaction((tx) => settleName(tx, rows, counts)),
  );
  counts.orgFailed += failed;
  counts.orgRemoved += (await transaction((tx) => tx.query<{ id: string }>(STALE))).length;
}
