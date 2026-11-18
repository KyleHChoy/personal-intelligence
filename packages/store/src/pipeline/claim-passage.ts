import type { ClaimRecord } from "@intelligence/contracts/personal";
import { passageOf, recordPassageOf } from "@intelligence/personal-core/items";
import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";

// A claim's passage: from its message's kept text, never a held message's, or from its agent
// record's body. Null when the store keeps none the span names. The same-fact sweep's and the
// relation step's.
export async function claimPassage(
  query: Query,
  keys: Keys,
  record: ClaimRecord,
  evidenceId: string,
): Promise<string | null> {
  const span = record.claim.evidence.find((passage) => passage.evidenceId === evidenceId)?.span;
  if (span === undefined) return null;
  const [message] = await query<{
    id: string;
    compartments: string[];
    held: boolean;
    subject_enc: Sealed | null;
    body_enc: Sealed | null;
  }>(
    "select id, compartments, held, subject_enc, body_enc from knowledge.messages where evidence_id = $1 order by id limit 1",
    [evidenceId],
  );
  if (message !== undefined) {
    if (message.held || span.startsWith("attachment:")) return null;
    const openMessage = (
      column: "knowledge.messages.body_enc" | "knowledge.messages.subject_enc",
      value: Sealed | null,
    ): string | null => (value === null ? null : open(keys, message, column, "throw"));
    const subject = span.startsWith("subject:");
    return passageOf(
      {
        body: subject ? null : openMessage("knowledge.messages.body_enc", message.body_enc),
        subject: subject ? openMessage("knowledge.messages.subject_enc", message.subject_enc) : null,
      },
      span,
    );
  }
  const [item] = await query<{ blob_ref: string; compartments: string[]; source_kind: string }>(
    "select blob_ref, compartments, source_kind from vault.evidence_items where id = $1",
    [evidenceId],
  );
  if (item?.source_kind !== "agent_record") return null;
  const [blob] = await query<{ envelope: Sealed }>("select envelope from vault.evidence_blobs where blob_ref = $1", [
    item.blob_ref,
  ]);
  if (blob === undefined) return null;
  const body = Buffer.from(
    open(
      keys,
      { id: item.blob_ref, compartments: item.compartments, envelope: blob.envelope },
      "vault.evidence_blobs.envelope",
      "throw",
    ),
    "base64",
  ).toString("utf8");
  return recordPassageOf(body, span);
}
