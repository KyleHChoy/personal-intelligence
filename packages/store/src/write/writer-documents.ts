import type { EvidenceId, RawItem } from "@intelligence/contracts";
import { normalizeAddress } from "@intelligence/personal-core";
import type { DocumentFacts, DrivePerson } from "@intelligence/personal-core/items";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { open, type Sealed, sealRow } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { suppressedFps } from "../identity/identity-port.ts";

// What the writer keeps of a document: one row for each stored document, citing its latest
// revision, the roots the owner set, and the one original kept of each document. Nothing of a
// document makes an entity, an account, an alias or an interaction row, and no name, title, text,
// address or Google id is in clear.

type Account = { id: string; label: string; compartment: string };
type DocumentRoot = { id: string; mode: "extract" | "reference" };

const ROOT_MARKER = "root:";

export async function documentRoot(tx: Tx, account: Account, raw: RawItem): Promise<DocumentRoot | null> {
  const marker = raw.markers.find((one) => one.startsWith(ROOT_MARKER));
  if (marker === undefined) return null;
  const [root] = await tx.query<DocumentRoot>(
    "select id, mode from policy.drive_roots where label = $1 and root_fp = $2",
    [account.label, fingerprint(tx.keys, "source_id", marker.slice(ROOT_MARKER.length))],
  );
  return root ?? null;
}

// A person's keyed address fingerprint and sealed value, or neither when the person has no address
// that parses or the address is suppressed. A name with no address keeps its sealed value and no
// fingerprint.
async function personOf(
  tx: Tx,
  compartment: string,
  id: string,
  column: "owner_enc" | "sharer_enc",
  person: DrivePerson | undefined,
): Promise<{ fp: string | null; enc: unknown }> {
  if (person === undefined) return { fp: null, enc: null };
  const address = person.address === undefined ? null : normalizeAddress(person.address);
  const fp = address === null ? null : fingerprint(tx.keys, "address", address);
  if (fp !== null && (await suppressedFps(tx, [fp])).size > 0) return { fp: null, enc: null };
  const kept = {
    ...(address === null ? {} : { address }),
    ...(person.name === undefined ? {} : { name: person.name }),
  };
  if (Object.keys(kept).length === 0) return { fp: null, enc: null };
  return { fp, enc: sealRow(tx.keys, compartment, { table: "knowledge.documents", id, column }, JSON.stringify(kept)) };
}

// `held` is the facts' hold unless the owner released this revision.
export async function writeDocument(
  tx: Tx,
  account: Account,
  evidenceId: EvidenceId,
  facts: DocumentFacts,
  root: DocumentRoot,
  released: boolean,
): Promise<void> {
  const fileFp = fingerprint(tx.keys, "source_id", facts.fileId);
  const [found] = await tx.query<{ id: string }>(
    "select id from knowledge.documents where source_account_id = $1 and file_fp = $2",
    [account.id, fileFp],
  );
  const id = found?.id ?? newId("doc");
  const { compartment } = account;
  const seal = (column: string, value: string) =>
    sealRow(tx.keys, compartment, { table: "knowledge.documents", id, column }, value);
  const owner = await personOf(tx, compartment, id, "owner_enc", facts.owner);
  const sharer = await personOf(tx, compartment, id, "sharer_enc", facts.sharer);
  const outline = facts.sections.map(({ heading, start, end }) => ({ heading, start, end }));
  const values = [
    id,
    evidenceId,
    account.id,
    [compartment],
    facts.kind,
    facts.modifiedAt,
    facts.createdAt,
    facts.mine,
    facts.editedByMe,
    root.mode === "reference",
    facts.held && !released,
    root.id,
    fileFp,
    facts.parent === undefined ? null : fingerprint(tx.keys, "source_id", facts.parent),
    owner.fp,
    sharer.fp,
    seal("title_enc", facts.title),
    seal("file_id_enc", facts.fileId),
    owner.enc,
    sharer.enc,
    facts.text === null ? null : seal("body_enc", facts.text),
    seal("outline_enc", JSON.stringify(outline)),
    seal(
      "facts_enc",
      JSON.stringify({
        chars: facts.text?.length ?? 0,
        sections: facts.sections.length,
        size: facts.size ?? null,
        unreadable: facts.unreadable,
      }),
    ),
  ];
  await tx.query(
    `insert into knowledge.documents (id, evidence_id, source_account_id, compartments, kind, modified_at, created_at, mine, edited_by_me,
       reference, held, root_id, file_fp, folder_fp, owner_fp, sharer_fp, title_enc, file_id_enc, owner_enc, sharer_enc, body_enc, outline_enc, facts_enc)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     on conflict (id) do update set evidence_id = excluded.evidence_id, kind = excluded.kind, modified_at = excluded.modified_at,
       created_at = excluded.created_at, mine = excluded.mine, edited_by_me = excluded.edited_by_me, reference = excluded.reference,
       held = excluded.held, root_id = excluded.root_id, folder_fp = excluded.folder_fp, owner_fp = excluded.owner_fp,
       sharer_fp = excluded.sharer_fp, title_enc = excluded.title_enc, file_id_enc = excluded.file_id_enc, owner_enc = excluded.owner_enc,
       sharer_enc = excluded.sharer_enc, body_enc = excluded.body_enc, outline_enc = excluded.outline_enc, facts_enc = excluded.facts_enc`,
    values,
  );
}

// Every earlier revision's blob is deleted and its evidence row keeps its record and hash, marked
// expired.
export async function expireEarlier(tx: Tx, account: Account, sourceItemFp: string, latest: EvidenceId): Promise<void> {
  const expired = await tx.query<{ blob_ref: string }>(
    `with earlier as (
       select id, blob_ref from vault.evidence_items
       where source_account_id = $1 and source_item_fp = $2 and id <> $3 and blob_ref is not null)
     update vault.evidence_items e set blob_ref = null, payload_state = 'expired' from earlier
     where e.id = earlier.id returning earlier.blob_ref`,
    [account.id, sourceItemFp, latest],
  );
  if (expired.length > 0)
    await tx.query("delete from vault.evidence_blobs where blob_ref = any($1)", [expired.map((row) => row.blob_ref)]);
}

// A label's roots, for `pi sync`: each root's id, the folder id or word it names, and its mode.
export async function rootsOf(
  tx: Tx,
  label: string,
): Promise<{ id: string; root: string; mode: "extract" | "reference" }[]> {
  const rows = await tx.query<{ id: string; root_enc: Sealed; mode: "extract" | "reference" }>(
    "select id, root_enc, mode from policy.drive_roots where label = $1 order by id",
    [label],
  );
  return rows.map((row) => ({
    id: row.id,
    root: open(
      tx.keys,
      { id: row.id, compartments: ["own"], root_enc: row.root_enc },
      "policy.drive_roots.root_enc",
      "throw",
    ),
    mode: row.mode,
  }));
}
