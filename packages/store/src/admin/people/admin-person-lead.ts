import {
  ClaimRecord,
  type MessageId,
  OWNER_TIE_TYPE,
  type PersonPanelLead,
  TieRelation,
} from "@intelligence/contracts/personal";
import { maskCredentials } from "@intelligence/personal-core";
import { stamp } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { DIRECT_INTERACTION } from "../../core/statements.ts";
import { openedUnder, type Tx } from "../../core/tx.ts";
import { captureTitle } from "../search/admin-items.ts";

// What the person panel leads with beside its tier and commitments, as `get_entity`'s `lead` gives
// an agent: the confirmed tie, and the newest message and meeting, each with what opens it. As
// pi_admin, every statement within the owner's audience ($2), with the reader's filters stated, and
// every one over the group's members ($1).

// Their newest direct message, never a held one, up to now ($3): found in full by the members' rows,
// then cut, so the planner never walks every message in time order.
const LAST_THREAD = `
  with mail as materialized (
    select m.id, m.sent_at, m.subject_enc, m.compartments from knowledge.messages m
    where m.evidence_id in (
      select i.evidence_id from knowledge.interaction_log i
      where i.entity_id = any ($1::text[]) and ${DIRECT_INTERACTION})
      and not m.held and m.compartments <@ $2::text[] and m.sent_at <= $3
  )
  select mail.id, mail.sent_at as at, mail.subject_enc as value_enc, mail.compartments from mail
  order by mail.sent_at desc, mail.id collate "C"
  limit 1`;

// Their newest calendar event that was not cancelled and that the owner accepted or tentatively
// accepted, as the other contact reads count one: an invite left unanswered is no contact.
const LAST_EVENT = `
  select v.id, d.starts_at as at, d.title_enc as value_enc, d.compartments from knowledge.events v
  join knowledge.event_details d on d.event_id = v.id
  where v.id in (select p.event_id from knowledge.event_participants p where p.entity_id = any ($1::text[]) and p.compartments <@ $2::text[])
    and v.compartments <@ $2::text[] and d.compartments <@ $2::text[] and not d.cancelled and coalesce(d.owner_response, 'accepted') in ('accepted', 'tentative') and d.starts_at <= $3
  order by d.starts_at desc, v.id collate "C"
  limit 1`;

// Their newest meeting Lens recorded and linked to no event.
const LAST_CAPTURE = `
  select k.id, k.started_at as at, k.facts_enc as value_enc, k.compartments from knowledge.captures k
  where k.kind = 'meeting' and k.event_id is null and k.compartments <@ $2::text[] and k.started_at <= $3
    and k.evidence_id in (
      select c.evidence_id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
      where c.type = 'capture.person' and n.entity_id = any ($1::text[]) and c.compartments <@ $2::text[])
  order by k.started_at desc, k.id collate "C"
  limit 1`;

const LAST_CHAT = `
  select max(l.occurred_at) as at from knowledge.chat_lines l
  where l.entity_id = any ($1::text[]) and l.compartments <@ $2::text[] and l.occurred_at <= $3`;

// A released owner_tie claim naming a member, whose release is in force, newest by the release's
// ruling, as `get_entity`'s tie reads it.
const TIES = `
  select c.id, c.compartments, c.content_enc as value_enc from knowledge.claims c
  join policy.released_records() r on r.evidence_id = c.evidence_id
  where c.type = $3 and c.released and c.compartments <@ $2::text[]
    and exists (select 1 from knowledge.claim_entities n where n.claim_id = c.id and n.entity_id = any ($1::text[]))
    and not exists (
      select 1 from knowledge.claim_entities n
      where n.claim_id = c.id and not exists (select 1 from knowledge.entities e where e.id = n.entity_id))
  order by r.ruling_id collate "C" desc, c.id`;

type ValueRow = { id: string; at: Date; value_enc: Sealed; compartments: string[] };

// Which of the three is newest; a message before a meeting before a chat line at one time.
export function newestContact(
  thread: string | null,
  meeting: string | null,
  chat: string | null,
): PersonPanelLead["lastContact"] {
  const times = [
    ["message", thread],
    ["meeting", meeting],
    ["chat", chat],
  ] as const;
  let newest: PersonPanelLead["lastContact"] = null;
  let at = "";
  for (const [kind, time] of times)
    if (time !== null && time > at) {
      newest = kind;
      at = time;
    }
  return newest;
}

async function tieOf(tx: Tx, members: readonly string[], audience: readonly string[]) {
  const mine = new Set(members);
  for (const row of await tx.query<Omit<ValueRow, "at">>(TIES, [members, audience, OWNER_TIE_TYPE])) {
    if (!row.compartments.every((one) => tx.keys.compartments.has(one))) continue;
    const record = ClaimRecord.safeParse(
      JSON.parse(
        openedUnder(
          tx.keys,
          row.compartments,
          { table: "knowledge.claims", id: row.id, column: "content_enc" },
          row.value_enc,
        ),
      ),
    );
    if (!record.success || !mine.has(record.data.claim.content.subject)) continue;
    const relation = TieRelation.safeParse(record.data.claim.content.fields.relation);
    if (relation.success) return relation.data;
  }
  return null;
}

export async function personPanelLead(
  tx: Tx,
  members: readonly string[],
  audience: readonly string[],
  now: Date,
): Promise<PersonPanelLead> {
  const { query } = tx;
  const values = [members, audience, now.toISOString()];
  // A row whose words the key file cannot open is still a contact: it has a time and no words, and
  // never costs the panel the rest of the person.
  const open = (table: string, column: string, row: ValueRow): string | null =>
    row.value_enc === null || !row.compartments.every((one) => tx.keys.compartments.has(one))
      ? null
      : openedUnder(tx.keys, row.compartments, { table, id: row.id, column }, row.value_enc);
  const [thread] = await query<ValueRow>(LAST_THREAD, values);
  const [event] = await query<ValueRow>(LAST_EVENT, values);
  const [capture] = await query<ValueRow>(LAST_CAPTURE, values);
  const [chat] = await query<{ at: Date | null }>(LAST_CHAT, values);
  const recorded = capture !== undefined && (event === undefined || capture.at > event.at);
  const met = recorded ? capture : event;
  const titled = (row: ValueRow): string | null => {
    if (!recorded) return open("knowledge.event_details", "title_enc", row);
    try {
      return captureTitle(open("knowledge.captures", "facts_enc", row) ?? "{}");
    } catch {
      return null;
    }
  };
  const subject = thread === undefined ? null : open("knowledge.messages", "subject_enc", thread);
  const lastThread =
    thread === undefined
      ? null
      : {
          message: thread.id as MessageId,
          at: stamp(thread.at),
          subject: subject === null ? null : { untrusted: maskCredentials(subject).text },
        };
  const title = met === undefined ? null : titled(met);
  const lastMeeting =
    met === undefined
      ? null
      : { meeting: met.id, at: stamp(met.at), title: title === null ? null : { untrusted: title } };
  const lastChat = chat?.at == null ? null : stamp(chat.at);
  return {
    tie: await tieOf(tx, members, audience),
    lastContact: newestContact(lastThread?.at ?? null, lastMeeting?.at ?? null, lastChat),
    lastThread,
    lastChat,
    lastMeeting,
  };
}
