import type { SourceDeletion } from "@intelligence/contracts";
import { CodedError, type PersonalRef } from "@intelligence/contracts/personal";
import { forgetPairCalls } from "../core/decision-calls.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { BELIEFS_LOCK } from "../core/locks.ts";
import { sealUnder } from "../core/seal.ts";
import { DEVICE_OF_ACCOUNT } from "../core/stored-forms.ts";
import type { Tx } from "../core/tx.ts";
import { taintCiting } from "../erasure/taint.ts";
import { eraseFromQuestions } from "../identity/identity-answers-erasure.ts";
import { removeWarmth } from "../identity/warmth-build.ts";
import { storedAccount } from "./writer-accounts.ts";
import { removeContactRows } from "./writer-contacts.ts";
import { removeResting } from "./writer-records.ts";
import { namedBy, removeExtracted, removeForGood, removeRestrictions, removeUncited } from "./writer-removal.ts";
import type { SourceAccountRow } from "./writer-types.ts";

// A source item's removal and its expiry, one sequence of steps: an expiry differs in the latest
// revision it keeps, named `kept` below, and in nothing else.

type Account = { id: string; compartment: string };

// Why a source item is removed. Each reason has one meaning, and every caller gives the one that
// is true of its act.
// `deleted`: the source says the item is no longer there: a listing that no longer holds it, a
//   deletion the source reported. The one reason SCRUB_ON_SOURCE_DELETION acts on.
// `replaced`: the same item is stored again under the id it has, in this transaction or by the
//   next listing or push with no act of the owner's: a contact whose new revision did not read, a
//   moment split another way. Nothing about it is gone.
// `dropped`: the system stops holding an item its source still has, and nothing stores it again
//   unless something else changes: the owner removed or switched off what held it (an import, a
//   folder, a contacts account, a Mac's contacts), it left the owner's scope, or a rule leaves it
//   out (the owner's own contact entry, a contact with no address, one another source's item
//   outranks, one that lists a suppressed address). No deletion at the source, and no erasure.
// `erased`: the owner's erasure, which does its own work around the removal.
// Outside an erasure a removal lifts no split, deletes no report of a wrong merge and takes
// nothing from a ruling; `deleted` does what the switch below says, and the other two never do.
export type RemovalReason = "deleted" | "replaced" | "dropped" | "erased";

// Whether a deletion at the source does what an erasure does to what the owner and agents ruled on
// the item: takes the identifiers a ruling of the owner's holds of it
// (knowledge.scrub_rulings_of_item), lifts the agents' same-person rulings and splits that cite it
// with their answers and reports (eraseFromQuestions), and strips the reports that name a person it
// leaves nothing of (removeForGood). One switch for all of it. The owner has not ruled on it: off,
// and then a deletion at the source removes the item and what was derived from it, and no more. An
// erasure does all of it whatever this says; a replacement, a drop and an expiry never do.
export const SCRUB_ON_SOURCE_DELETION = false;
type Revision = { id: string; blob_ref: string | null; revision: number; compartments: string[] };
type Removed = {
  removed: boolean;
  recordsRemoved: number;
  captures: { key: string; device: string; compartments: string[] }[];
};

const OF_ITEM =
  "evidence_id in (select id from vault.evidence_items where source_account_id = $1 and source_item_fp = $2)";

// Every revision but `keep`'s, and everything derived from each. The locks come in one order: the
// item's message row, by its delete, then every evidence row of the source item `for update`, so a
// commit of the pipeline that holds one `for share` finishes first and its claims are seen here,
// then the beliefs lock, then the taint lock, and last the rows of agent records not taken in that
// the second pass empties. Every caller's transaction is read committed (db.ts's TRANSACTION),
// which that pass relies on.
async function removeRevisions(
  tx: Tx,
  account: Account,
  sourceItemFp: string,
  keep: { choose(revisions: Revision[]): Revision | undefined; end(kept: Revision): Promise<unknown> } | null,
  reason: RemovalReason | "expired",
  scrub: boolean,
): Promise<Removed> {
  const item = [account.id, sourceItemFp];
  const messages = await tx.query<{ id: string; sender_fp: string | null }>(
    `delete from knowledge.messages where ${OF_ITEM} returning id, sender_fp`,
    item,
  );
  // A document's row the same way, before the evidence rows, in the order the owner's release
  // of a held document locks them.
  const documents = await tx.query<{ id: string }>(
    `delete from knowledge.documents where ${OF_ITEM} returning id`,
    item,
  );
  const pages = await tx.query<{ id: string }>(`delete from knowledge.pages where ${OF_ITEM} returning id`, item);
  const goneCaptures = await tx.query<{ id: string; key: string; device: string; compartments: string[] }>(
    `with gone as (
       delete from knowledge.captures where ${OF_ITEM}
       returning id, capture_key, source_account_id, compartments)
     select g.id, g.capture_key as key, ${DEVICE_OF_ACCOUNT} as device, g.compartments from gone g join vault.source_accounts a on a.id = g.source_account_id order by 2`,
    item,
  );
  const captures = goneCaptures.map(({ key, device, compartments }) => ({ key, device, compartments }));
  const revisions = await tx.query<Revision>(
    "select id, blob_ref, revision, compartments from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 order by id for update",
    item,
  );
  if (revisions.length === 0) return { removed: false, recordsRemoved: 0, captures };
  const kept = keep?.choose(revisions);
  const ids = revisions.map((row) => row.id);
  // Before the beliefs lock: the resting agent records' evidence rows, then their rows.
  const records = await removeResting(tx, ids);
  const named = await namedBy(tx, ids);
  // A deletion at the source, switched on: as an erasure of the item.
  const asErasure = scrub && reason === "deleted";
  // Before the claims and the anchors go, which the scrub finds the rulings by; under the beliefs
  // lock, which removeExtracted takes next in any case. And the agents' answers and reports that
  // cite one of these revisions, before its rows go.
  if (asErasure) {
    await tx.query(BELIEFS_LOCK);
    await tx.query("select knowledge.scrub_rulings_of_item($1::text[], $2, $3)", [ids, ...item]);
    await eraseFromQuestions(tx.query, [], ids, []);
  }
  const claimed = await removeExtracted(tx, ids);
  // Under the beliefs lock removeExtracted took: the warmth rows of every
  // audience that could see a mail or meeting row of these revisions, by the rows' own labels.
  const seen = await tx.query<{ compartments: string[] }>(
    `select distinct compartments from knowledge.interaction_log where evidence_id = any($1)
     union select distinct compartments from knowledge.events where evidence_id = any($1)
     union select distinct p.compartments from knowledge.event_participants p join knowledge.events v on v.id = p.event_id where v.evidence_id = any($1)`,
    [ids],
  );
  // A source moment's chat lines, of every revision, before its evidence rows, their labels with
  // the rest. A kept revision keeps its lines and removes no warmth row for them: a line row holds
  // no text, so it outlives the text as a mail's record and hash do.
  const lines = await tx.query<{ compartments: string[] }>(
    `with gone as (delete from knowledge.chat_lines where evidence_id = any($1) and evidence_id is distinct from $2 returning compartments)
     select distinct compartments from gone`,
    [ids, kept?.id ?? null],
  );
  await removeWarmth(
    tx.query,
    [...seen, ...(kept === undefined ? lines : [])].map((row) => row.compartments),
  );

  const addresses = await tx.query<{ fp: string }>(
    `select a.value_fp as fp from knowledge.interaction_log l join knowledge.accounts a on a.entity_id = l.entity_id where l.evidence_id = any($1)
     union select r.address_fp from vault.sent_recipients r where r.evidence_id = any($1)`,
    [ids],
  );
  await forgetPairCalls(tx.query, [
    ...ids,
    ...addresses.map((row) => row.fp),
    ...messages.flatMap((row) => (row.sender_fp === null ? [] : [row.sender_fp])),
  ]);

  await tx.query("delete from knowledge.interaction_log where evidence_id = any($1)", [ids]);
  await tx.query("delete from knowledge.aliases where evidence_id = any($1)", [ids]);
  await removeContactRows(tx, ids);
  const events = (
    await tx.query<{ id: string }>("select id from knowledge.events where evidence_id = any($1)", [ids])
  ).map((row) => row.id);
  await tx.query("delete from knowledge.event_participants where event_id = any($1)", [events]);
  await tx.query("delete from knowledge.event_details where event_id = any($1)", [events]);
  const gone = await tx.query<{ id: string }>("delete from knowledge.events where id = any($1) returning id", [events]);
  await taintCiting(tx.query, {
    evidenceIds: [...ids, ...records.evidenceIds],
    refs: [
      ...messages.map((row) => ({ kind: "message", id: row.id })),
      ...gone.map((row) => ({ kind: "event", id: row.id })),
      ...documents.map((row) => ({ kind: "document", id: row.id })),
      ...pages.map((row) => ({ kind: "page", id: row.id })),
      ...goneCaptures.map((row) => ({ kind: "capture", id: row.id })),
    ] as PersonalRef[],
    // An expiry keeps the latest revision's row: a ruling anchored on it keeps that anchor.
    staying: kept === undefined ? [] : [kept.id],
  });
  // And loses what the owner was shown, whatever revisions the item had: the item's retention
  // covers that sealed copy of its claim.
  if (kept !== undefined) await tx.query("select knowledge.forget_ruling_shown($1::text[])", [[kept.id]]);
  // An append that checked the vault before this deletion committed holds the shared lock until it commits,
  // so one the first pass missed committed before the taint call was granted, and this statement, read
  // committed, sees it. Only agent records not taken in: intake runs under the sync lock every deletion
  // holds, so none was taken in since the first pass. They have no evidence row, so nothing extracted from
  // them is left to taint.
  const late = await removeResting(tx, ids, { untaken: true });
  await tx.query("delete from vault.sent_recipients where evidence_id = any($1)", [ids]);
  await removeRestrictions(tx, ids);
  await tx.query("delete from vault.evidence_items where id = any($1)", [ids.filter((id) => id !== kept?.id)]);
  if (kept !== undefined) await keep?.end(kept);
  await tx.query("delete from vault.evidence_blobs where blob_ref = any($1)", [
    revisions.flatMap((row) => (row.blob_ref === null ? [] : [row.blob_ref])),
  ]);
  await tx.query("delete from vault.listed_items where account_id = $1 and source_item_fp = $2", item);

  // An erasure, and a deletion at the source switched on, strip the agents' reports of a wrong
  // merge of each person left with nothing. Every other removal leaves the reports as they are:
  // the person may be made again under the id it had, and an open report that names one who is
  // gone is closed by the sweep.
  const people = [...new Set([...named, ...claimed])];
  if (reason === "erased" || asErasure) await removeForGood(tx, people);
  else await removeUncited(tx, people);
  return { removed: true, recordsRemoved: records.removed + late.removed, captures };
}

// `removed` is false when the item is not stored, and then nothing is touched. A capture item's
// knowledge.captures row goes before its evidence rows, as a message's does, and `captures` names
// each removed row's capture key and device, for an owner erasure to send back. `reason` says why
// (RemovalReason); `scrub` is SCRUB_ON_SOURCE_DELETION everywhere but in its own tests.
export const removeSourceItem = (
  tx: Tx,
  account: Account,
  sourceItemFp: string,
  reason: RemovalReason,
  scrub: boolean = SCRUB_ON_SOURCE_DELETION,
): Promise<Removed> => removeRevisions(tx, account, sourceItemFp, null, reason, scrub);

// A source's deletion of one item of this stored account, which the deletion must name; returns
// the agent records removed with it.
export async function applyDeletion(
  tx: Tx,
  given: SourceAccountRow,
  deletion: SourceDeletion,
): Promise<{ recordsRemoved: number }> {
  const account = await storedAccount(tx, given);
  if (deletion.sourceAccount !== account.id) throw new CodedError("account_mismatch");
  const { recordsRemoved } = await removeSourceItem(
    tx,
    account,
    fingerprint(tx.keys, "source_id", deletion.sourceItemId),
    "deleted",
  );
  return { recordsRemoved };
}

export const expireSourceItem = (tx: Tx, account: Account, sourceItemFp: string, at: Date): Promise<Removed> =>
  removeRevisions(
    tx,
    account,
    sourceItemFp,
    {
      choose: (revisions) => [...revisions].sort((left, right) => right.revision - left.revision)[0],
      end: (latest) =>
        tx.query(
          "update vault.evidence_items set blob_ref = null, payload_state = 'expired', expired_at = $3, item_enc = $2 where id = $1",
          [
            latest.id,
            sealUnder(
              tx.keys,
              latest.compartments,
              { table: "vault.evidence_items", id: latest.id, column: "item_enc" },
              "{}",
            ),
            at.toISOString(),
          ],
        ),
    },
    "expired",
    false,
  );
