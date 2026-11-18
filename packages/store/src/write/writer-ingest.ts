// One item of a source in one transaction: the erasure, root and suppression checks, the
// revision, the label, the identity rows, the sealed evidence, the sent tag and the derived rows.

import { createHash } from "node:crypto";
import { RawItem } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import { CodedError, isRestricted, RESTRICTED_LOCKED, RESTRICTED_PREFIX } from "@intelligence/contracts/personal";
import { normalizeAddress, THE_OWNER } from "@intelligence/personal-core";
import { type ItemContext, type ItemFacts, isHeadersMail, ownerSent } from "@intelligence/personal-core/items";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { sealUnder } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import {
  addOwnerAddress,
  identityPort,
  ownerAddresses,
  ownerEntity,
  suppressedAddress,
  suppressedFps,
  writtenTo,
} from "../identity/identity-port.ts";
import { storedAccount } from "./writer-accounts.ts";
import { contactSuppressed, withoutRefused } from "./writer-contacts.ts";
import { checkFacts, writeDerived } from "./writer-derived.ts";
import { documentRoot, expireEarlier, writeDocument } from "./writer-documents.ts";
import { removeSourceItem } from "./writer-item-removal.ts";
import { writePage } from "./writer-pages.ts";
import { removeExtracted, removeUncited } from "./writer-removal.ts";
import type { IngestAnswer, SourceAccountRow } from "./writer-types.ts";

// Thrown inside an item's transaction to roll it back whole: its sender is suppressed.
export const SUPPRESSED = Symbol("suppressed");

// An item as the writer takes it. What is stored is read again by a re-derive, which parses it, so
// nothing is stored that does not parse; the refusal carries nothing of the item. An item whose
// sender is suppressed answers `suppressed`.
export async function ingestParsed(
  ingest: (
    given: SourceAccountRow,
    raw: RawItem,
    derive: (ctx: ItemContext) => Promise<ItemFacts>,
  ) => Promise<IngestAnswer>,
  given: SourceAccountRow,
  item: RawItem,
  derive: (ctx: ItemContext) => Promise<ItemFacts>,
): Promise<IngestAnswer> {
  const parsed = RawItem.safeParse(item);
  if (!parsed.success) throw new CodedError("invalid_item");
  return ingest(given, parsed.data, derive).catch((error: unknown) => {
    if (error === SUPPRESSED) return "suppressed" as const;
    throw error;
  });
}

// Everything it is handed is in hand, none of it opened from a sealed value: the fingerprints of
// the item's source id, thread and body hash, and of its addressees exactly as step 4 writes them
// to vault.sent_recipients. A calendar item makes no call.
async function sentTag(
  tx: Tx,
  account: SourceAccountRow,
  raw: RawItem,
  facts: ItemFacts,
): Promise<{ systemOriginated: boolean; answersSystem: boolean; sentId: string | null }> {
  if (raw.sourceKind !== "email") return { systemOriginated: false, answersSystem: false, sentId: null };
  const bodyHash = facts.kind === "email" && !facts.bulk ? facts.record.sent?.bodyHash : undefined;
  // The suppressed addressees are left out first, by a statement of their own, so the one that
  // decides the tag reads evidence columns alone.
  const addressees = addresseeFps(tx.keys, raw);
  const suppressed = await suppressedFps(tx, addressees);
  const [row] = await tx.query<{ system_originated: boolean; answers_system: boolean; sent_id: string | null }>(
    "select t.system_originated, t.answers_system, t.sent_id from ledger.sent_tag($1, $2, $3, $4, $5, $6, $7) as t",
    [
      account.id,
      fingerprint(tx.keys, "source_id", raw.sourceItemId),
      raw.threadId === undefined ? null : fingerprint(tx.keys, "thread", raw.threadId),
      bodyHash === undefined ? null : fingerprint(tx.keys, "body_hash", bodyHash),
      addressees.filter((fp) => !suppressed.has(fp)),
      ownerSent(raw),
      raw.observedAt,
    ],
  );
  return {
    systemOriginated: row?.system_originated === true,
    answersSystem: row?.answers_system === true,
    sentId: row?.sent_id ?? null,
  };
}

// The label of an email: its source compartment, each category the screen found that the owner has
// not lifted for this source item, and every restricted compartment its earlier revisions carry,
// sorted, each once. A screen never removes a category: only the owner's lift keeps one off, and
// only one the screen would add.
async function emailLabel(
  tx: Tx,
  account: SourceAccountRow,
  itemFp: string,
  facts: ItemFacts,
  revisions: { compartments: string[] }[],
): Promise<string[]> {
  const found =
    facts.kind === "email" ? facts.message.restricted : facts.kind === "unread" ? (facts.restricted ?? []) : [];
  const lifted =
    found.length === 0
      ? []
      : (
          await tx.query<{ category: string }>(
            "select category from vault.restriction_lifts where account_id = $1 and source_item_fp = $2",
            [account.id, itemFp],
          )
        ).map((row) => row.category);
  const screened = found
    .filter((category) => !lifted.includes(category))
    .map((category) => `${RESTRICTED_PREFIX}${category}`);
  const kept = revisions.flatMap((row) => row.compartments).filter(isRestricted);
  return [...new Set([account.compartment, ...screened, ...kept])].sort();
}

// Whether any address the item lists, past RawItem's limit on addressees too, is suppressed.
async function namesSuppressed(tx: Tx, raw: RawItem): Promise<boolean> {
  const listed = raw.permissions.scope === "listed" ? raw.permissions.identifiers : [];
  const fps = [...listed, ...(raw.sender === undefined ? [] : [raw.sender])].flatMap((one) => {
    const address = normalizeAddress(one);
    return address === null ? [] : [fingerprint(tx.keys, "address", address)];
  });
  return (await suppressedFps(tx, fps)).size > 0;
}

// The address fingerprints of the addressees normalizeAddress accepts, sorted, each once.
function addresseeFps(keys: Keys, raw: RawItem): string[] {
  const fps = new Set<string>();
  for (const addressee of raw.addressees ?? []) {
    const address = normalizeAddress(addressee);
    if (address !== null) fps.add(fingerprint(keys, "address", address));
  }
  return [...fps].sort();
}

async function lockedRevisions(tx: Tx, account: SourceAccountRow, raw: RawItem, itemFp: string) {
  await tx.query(
    `select 1 from knowledge.messages where evidence_id = (
         select id from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 order by revision desc limit 1)
       for update`,
    [account.id, itemFp],
  );
  // A document's row the same way, as the owner's release of a held document locks it first.
  if (raw.sourceKind === "document") {
    await tx.query(
      `select 1 from knowledge.documents where evidence_id = (
           select id from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 order by revision desc limit 1)
         for update`,
      [account.id, itemFp],
    );
  }
  // Then every stored revision's evidence row, `for update`: a commit of the pipeline that holds
  // one `for share` finishes first, and one that comes after finds its revision superseded.
  const revisions = await tx.query<{ id: string; compartments: string[] }>(
    "select id, compartments from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 order by id for update",
    [account.id, itemFp],
  );
  const [last] = await tx.query<{
    id: string;
    revision: number;
    revision_tag_fp: string;
    content_hash: string;
    released: boolean;
    model_held: boolean;
  }>(
    `select id, revision, revision_tag_fp, content_hash, hold_released_at is not null as released, model_hold_at is not null as model_held from vault.evidence_items
       where source_account_id = $1 and source_item_fp = $2 order by revision desc limit 1`,
    [account.id, itemFp],
  );
  return { revisions, last };
}

// A new revision of an item, as its evidence row records it.
type NewRevision = {
  evidenceId: string;
  revision: number;
  supersedes: string | null;
  itemFp: string;
  tagFp: string;
  contentHash: string;
  compartments: string[];
  headersMail: boolean;
  sent: boolean;
};

async function writeEvidence(
  tx: Tx,
  account: SourceAccountRow,
  raw: RawItem,
  facts: ItemFacts,
  next: NewRevision,
): Promise<void> {
  const { evidenceId, compartments } = next;
  const tag = await sentTag(tx, account, raw, facts);
  const { payload, ...rest } = raw.sourceKind === "crm" ? withoutRefused(raw) : raw;
  const blobRef = newId("blb");
  await tx.query("insert into vault.evidence_blobs (blob_ref, envelope, compartments) values ($1, $2, $3)", [
    blobRef,
    sealUnder(tx.keys, compartments, { table: "vault.evidence_blobs", id: blobRef, column: "envelope" }, payload),
    compartments,
  ]);
  const source = { vault: "personal" as const, sourceAccount: account.id, sourceItemId: raw.sourceItemId };
  await tx.query(
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, supersedes, next_revision_id,
         thread_fp, content_hash, media_type, observed_at, change_kind, participant_members, sender_member, system_originated, answers_system,
         sent_id, hold_released_at, model_hold_at, payload_state, compartments, readers, blob_ref, item_enc, headers_only)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $22,
         case when $3 = 'document' then null else (select hold_released_at from vault.evidence_items where id = $7) end, (select model_hold_at from vault.evidence_items where id = $7),
         'present', $18, $19, $20, $21, $23)`,
    [
      evidenceId,
      account.id,
      raw.sourceKind,
      next.itemFp,
      next.tagFp,
      next.revision,
      next.supersedes,
      evidenceIdFor({ ...source, revision: next.revision + 1 }),
      raw.threadId === undefined ? null : fingerprint(tx.keys, "thread", raw.threadId),
      next.contentHash,
      raw.mediaType,
      raw.observedAt,
      raw.changeKind,
      facts.members.participantMembers,
      facts.members.senderMember ?? null,
      tag.systemOriginated,
      tag.answersSystem,
      compartments,
      [THE_OWNER],
      blobRef,
      sealUnder(
        tx.keys,
        compartments,
        { table: "vault.evidence_items", id: evidenceId, column: "item_enc" },
        JSON.stringify(rest),
      ),
      tag.sentId,
      next.headersMail,
    ],
  );
  // The item's listed row, when a listing named it before it was stored under another label, is
  // replaced by one under the evidence row's: no runtime role updates a label.
  const relisted = await tx.query(
    "delete from vault.listed_items where account_id = $1 and source_item_fp = $2 and compartments <> $3 returning source_item_fp",
    [account.id, next.itemFp, compartments],
  );
  if (relisted.length > 0)
    await tx.query(
      "insert into vault.listed_items (account_id, source_item_fp, compartments) select source_account_id, source_item_fp, compartments from vault.evidence_items where id = $1",
      [evidenceId],
    );

  // Whom the owner wrote to, for a message the owner sent: one row for each addressee, in place of
  // the rows the earlier revision had.
  if (next.supersedes !== null)
    await tx.query("delete from vault.sent_recipients where evidence_id = $1", [next.supersedes]);
  if (next.sent) {
    const recipients = addresseeFps(tx.keys, raw);
    await tx.query(
      `insert into vault.sent_recipients (evidence_id, address_fp, account_id, compartments)
         select $1, one.fp, $2, $3 from unnest($4::text[]) as one (fp)
         where not exists (select 1 from knowledge.suppressions s where s.kind = 'address' and s.value_fp = one.fp)`,
      [evidenceId, account.id, compartments, recipients],
    );
  }
}

// One item, in one transaction.
export const ingestOne = (
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  keys: Keys,
  given: SourceAccountRow,
  raw: RawItem,
  derive: (ctx: ItemContext) => Promise<ItemFacts>,
): Promise<IngestAnswer> =>
  transaction(async (tx): Promise<IngestAnswer> => {
    const account = await storedAccount(tx, given);
    if (raw.sourceAccount !== account.id || raw.sourceKind !== account.sourceKind)
      throw new CodedError("account_mismatch");
    const itemFp = fingerprint(keys, "source_id", raw.sourceItemId);
    const tagFp = fingerprint(keys, "revision_tag", raw.revisionTag);

    const [erased] = await tx.query<{ erased: boolean }>(
      "select exists (select 1 from knowledge.removed_evidence where source_account_id = $1 and source_item_fp = $2) as erased",
      [account.id, itemFp],
    );
    if (erased?.erased === true) return "removed";
    const root = raw.sourceKind === "document" ? await documentRoot(tx, account, raw) : null;
    if (raw.sourceKind === "document" && root === null) return "left";

    // A later revision that lists none is stored as a new item.
    if (raw.sourceKind === "crm" && (await contactSuppressed(tx, raw))) {
      await removeSourceItem(tx, account, itemFp, "dropped");
      return "suppressed";
    }

    const headersMail = isHeadersMail(raw);
    if (headersMail) {
      const [held] = await tx.query<{ stored: boolean }>(
        "select exists (select 1 from vault.evidence_items where source_account_id = $1 and source_item_fp = $2) as stored",
        [account.id, itemFp],
      );
      if (held?.stored === true) return "repeat";
      if (await namesSuppressed(tx, raw)) throw SUPPRESSED;
    }

    const { revisions, last } = await lockedRevisions(tx, account, raw, itemFp);
    const contentHash = fingerprint(
      keys,
      "content_hash",
      createHash("sha256").update(Buffer.from(raw.payload, "base64")).digest("hex"),
    );
    // Mail keeps the tag alone.
    if (last?.revision_tag_fp === tagFp && (raw.sourceKind !== "document" || last.content_hash === contentHash))
      return "repeat";
    // What was extracted from the earlier revisions goes with them, under the beliefs lock.
    const claimed =
      revisions.length === 0
        ? []
        : await removeExtracted(
            tx,
            revisions.map((row) => row.id),
          );

    // 2. Whoever sent mail the owner sent is the owner, also when the message is bulk. The
    // owner sent it only when it carries SENT and not SPAM: tested here, whatever sync left out.
    // The owner's own address is the owner's identity, not the item's: it stays under the
    // account's compartment, so every item of the account resolves it, restricted or not.
    const sent = raw.sourceKind === "email" && ownerSent(raw);
    if (sent && raw.sender !== undefined) {
      const sender = normalizeAddress(raw.sender);
      if (sender !== null) await addOwnerAddress(tx, sender, [account.compartment]);
    }

    const revision = last === undefined ? 0 : last.revision + 1;
    const source = { vault: "personal" as const, sourceAccount: account.id, sourceItemId: raw.sourceItemId };
    const evidenceId = evidenceIdFor({ ...source, revision });
    const identity = identityPort(tx);
    const ctx: ItemContext = {
      evidenceId,
      revision,
      compartment: account.compartment,
      ownerAddresses: await ownerAddresses(tx),
      ownerEntity: await ownerEntity(tx),
      identity: identity.resolver,
      senderWrittenTo: raw.sourceKind === "email" && (await writtenTo(tx, account.id, raw.sender, headersMail)),
    };
    // The derive is handed a copy, so nothing it changes loosens the checks below.
    const facts = await derive({ ...ctx, ownerAddresses: [...ctx.ownerAddresses] });
    checkFacts(facts, raw, ctx);
    // Only a sent message's own address was written so far, which sync learns from a bulk message
    // too.
    if (headersMail && (facts.kind !== "email" || facts.bulk)) return "no_tie";
    const sender = facts.kind === "email" ? facts.message.sender?.address : undefined;
    if (sender !== undefined && (await suppressedAddress(tx, sender))) throw SUPPRESSED;

    // The item's label, decided before any row of it is written: every row below takes it,
    // and every value is sealed under it. Only email is screened for restricted categories, so
    // no other kind ever carries a restricted compartment.
    const compartments =
      raw.sourceKind === "email" ? await emailLabel(tx, account, itemFp, facts, revisions) : [account.compartment];
    // A label whose key the key file lacks is refused before anything is sealed. One whose restricted key
    // is wrapped and not open is `restricted_locked`: sync, which runs unattended, never holds an unlock,
    // so nothing of the item is stored and sync counts it as waiting.
    if (compartments.some((one) => keys.locked?.has(one) === true)) throw new CodedError(RESTRICTED_LOCKED);
    if (!compartments.every((one) => keys.compartments.has(one))) throw new CodedError("invalid_facts");
    await identity.write(compartments);
    const supersedes = last?.id ?? null;
    await writeEvidence(tx, account, raw, facts, {
      evidenceId,
      revision,
      supersedes,
      itemFp,
      tagFp,
      contentHash,
      compartments,
      headersMail,
      sent,
    });

    if (facts.kind === "document" && root !== null) {
      await expireEarlier(tx, account, itemFp, evidenceId);
      await writeDocument(tx, account, evidenceId, facts.document, root, false);
    } else if (facts.kind === "page") await writePage(tx, account, raw, evidenceId, facts.page, supersedes);
    else
      await writeDerived(
        tx,
        account,
        compartments,
        raw,
        evidenceId,
        facts,
        supersedes,
        identity.resolved,
        last?.released === true,
        last?.model_held === true,
      );
    await removeUncited(tx, claimed);
    return facts.kind === "unread" ? "unread" : "stored";
  });
