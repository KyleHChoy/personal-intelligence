import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { claimDates, insertClaimValues, valueFpOf } from "../../core/claim-columns.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId, sha256Hex } from "../../core/ids.ts";
import { sealUnder } from "../../core/seal.ts";
import type { Tx } from "../../core/tx.ts";

// The owner's own words as evidence, an item of source kind `owner_command`: the blob and the item
// row with what it holds sealed, in the caller's transaction. A column added to the evidence table is
// added here. `item`: what the sealed item says of the command.
type CommandSource = Omit<Parameters<typeof evidenceIdFor>[0], "revision">;
export async function writeCommandEvidence(
  { query, keys }: Tx,
  input: {
    source: CommandSource;
    evidenceId: string;
    accountId: string;
    ruling: string;
    words: string;
    at: unknown;
    item: Record<string, unknown>;
    compartments: string[];
  },
): Promise<void> {
  const { source, evidenceId, accountId, compartments } = input;
  const blobRef = newId("blb");
  await query("insert into vault.evidence_blobs (blob_ref, envelope, compartments) values ($1, $2, $3)", [
    blobRef,
    sealUnder(
      keys,
      compartments,
      { table: "vault.evidence_blobs", id: blobRef, column: "envelope" },
      Buffer.from(input.words, "utf8").toString("base64"),
    ),
    compartments,
  ]);
  await query(
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, supersedes, next_revision_id,
       thread_fp, content_hash, media_type, observed_at, change_kind, participant_members, sender_member, system_originated, answers_system,
       hold_released_at, blob_ref, payload_state, compartments, readers, item_enc)
     values ($1, $2, 'owner_command', $3, $4, 0, null, $5, null, $6, 'text/plain', $7, 'live', '{}', null, false, false, null, $8, 'present', $9, $10, $11)`,
    [
      evidenceId,
      accountId,
      fingerprint(keys, "source_id", source.sourceItemId),
      fingerprint(keys, "revision_tag", input.ruling),
      evidenceIdFor({ ...source, revision: 1 }),
      fingerprint(keys, "content_hash", sha256Hex(input.words)),
      input.at,
      blobRef,
      compartments,
      [THE_OWNER],
      sealUnder(
        keys,
        compartments,
        { table: "vault.evidence_items", id: evidenceId, column: "item_enc" },
        JSON.stringify(input.item),
      ),
    ],
  );
}

// The one claim those words make, and its value rows, in the caller's transaction.
export async function writeCommandClaim(
  { query, keys }: Tx,
  input: { claimId: string; evidenceId: string; record: ClaimRecord; factKeyFp: string; compartments: string[] },
): Promise<void> {
  const { claimId, evidenceId, record, factKeyFp, compartments } = input;
  const dates = claimDates(record);
  await query(
    `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments, valid_to, due_at, review_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      claimId,
      evidenceId,
      record.claim.content.type,
      record.claim.validFrom,
      factKeyFp,
      record.claim.extractorGeneration,
      [THE_OWNER],
      sealUnder(
        keys,
        compartments,
        { table: "knowledge.claims", id: claimId, column: "content_enc" },
        JSON.stringify(record),
      ),
      compartments,
      dates.validTo,
      dates.dueAt,
      dates.reviewAt,
    ],
  );
  await insertClaimValues(
    { query, keys },
    { id: claimId, evidenceId, factKeyFps: [factKeyFp], compartments, valueFp: valueFpOf(keys, record) },
  );
}
