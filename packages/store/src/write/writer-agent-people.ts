import { ClaimRecord, ClientName, KNOWN_PERSON_TYPE, type PersonalEvidenceId } from "@intelligence/contracts/personal";
import type { ConfirmedPerson } from "@intelligence/personal-core/items";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";

// The people the owner confirmed from agents' proposals, read as pi_writer at a sync: each released
// `known_person` claim (the owner's confirm released it to `own`, and the pipeline made the released
// claim), by the agent that proposed it. A lift of the confirm, a removal or an erasure of the
// record removes the released claim, so the person's contact goes at the next sync, as a contact
// dropped from a complete listing does.

export type ConfirmedProposal = { client: ClientName; record: PersonalEvidenceId; person: ConfirmedPerson };

export const AGENT_PEOPLE_PREFIX = "agent-people:";

const RELEASED_PEOPLE = `
  select distinct on (c.evidence_id) c.id, c.evidence_id, c.compartments, c.content_enc, w.client_name
  from knowledge.claims c join ledger.agent_writes w on w.evidence_id = c.evidence_id
  where c.type = $1 and c.released and c.evidence_id in (select r.evidence_id from policy.released_records() r)
  order by c.evidence_id, c.id`;

export async function confirmedPeople(tx: Tx): Promise<ConfirmedProposal[]> {
  const rows = await tx.query<{
    id: string;
    evidence_id: string;
    compartments: string[];
    content_enc: Sealed;
    client_name: string;
  }>(RELEASED_PEOPLE, [KNOWN_PERSON_TYPE]);
  return rows.flatMap((row) => {
    const parsed = ClaimRecord.safeParse(JSON.parse(open(tx.keys, row, "knowledge.claims.content_enc", "throw")));
    const client = ClientName.safeParse(row.client_name);
    if (!parsed.success || !client.success) return [];
    const { name, email, phone, linkedin } = parsed.data.claim.content.fields as Record<string, unknown>;
    if (typeof name !== "string") return [];
    const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
    return [
      {
        client: client.data,
        record: row.evidence_id as PersonalEvidenceId,
        person: { name, email: text(email), phone: text(phone), linkedin: text(linkedin) },
      },
    ];
  });
}
