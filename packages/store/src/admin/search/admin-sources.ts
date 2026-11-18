import type { UntrustedString, Who } from "@intelligence/contracts/personal";
import { maskCredentials } from "@intelligence/personal-core";
import { ownerAudience } from "../../core/audience.ts";
import { stamp } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import type { Tx } from "../../core/tx.ts";
import { ownerWho, ownerWithheld } from "../admin-owner.ts";

// The messages a piece of work cites, as the owner's page names them: each by its subject, masked
// as find_messages masks it, and its sender by name, both within the owner's audience; a held
// message, one outside the owner's audience or a withheld sender is left unnamed. Nothing here
// writes or logs.

export type NamedMessage = { id: string; at: string; subject: UntrustedString | null; from: Who | null };

const MESSAGES = `
  select m.id, m.sent_at, m.subject_enc, m.compartments,
    (select i.entity_id from knowledge.interaction_log i where i.evidence_id = m.evidence_id and i.entity_role = 'sender' and i.compartments <@ $2::text[] order by i.id limit 1) as sender
  from knowledge.messages m
  where m.id = any ($1::text[]) and not m.held and m.compartments <@ $2::text[]
  order by m.sent_at desc, m.id collate "C"`;

export async function namedMessages(tx: Tx, ids: readonly string[]): Promise<NamedMessage[]> {
  if (ids.length === 0) return [];
  const audience = await ownerAudience(tx.query);
  if (audience.length === 0) return [];
  const rows = await tx.query<{
    id: string;
    sent_at: Date;
    subject_enc: Sealed;
    compartments: string[];
    sender: string | null;
  }>(MESSAGES, [[...new Set(ids)], audience]);
  const withheld = await ownerWithheld(tx.query);
  const senders = await ownerWho(tx, [
    ...new Set(rows.flatMap((row) => (row.sender === null || withheld.has(row.sender) ? [] : [row.sender]))),
  ]);
  const opens = (compartments: string[]): boolean => compartments.every((one) => tx.keys.compartments.has(one));
  return rows.map((row) => ({
    id: row.id,
    at: stamp(row.sent_at),
    subject:
      row.subject_enc === null || !opens(row.compartments)
        ? null
        : {
            untrusted: maskCredentials(open(tx.keys, row, "knowledge.messages.subject_enc", "throw")).text,
          },
    from: row.sender === null ? null : (senders.get(row.sender) ?? null),
  }));
}
