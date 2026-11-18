import {
  type CaptureId,
  DraftStatus,
  type EventId,
  type MessageId,
  MessageView,
  OWNER_MEETING_FACTS_MOST,
  OwnerDraft,
  OwnerMeeting,
  type OwnerMeetingFact,
  SendPayload,
  type Who,
} from "@intelligence/contracts/personal";
import { maskCredentials, maskedField, maskedIn, maskedSpans } from "@intelligence/personal-core";
import { gmailLink } from "@intelligence/personal-core/items";
import type { AdminContext } from "../../core/admin-context.ts";
import { ownerAudience } from "../../core/audience.ts";
import { stamp, stampOrNull } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { latestEvent } from "../../core/statements.ts";
import { openedUnder } from "../../core/tx.ts";
import { RELEASE_IN_FORCE } from "../../core/visibility.ts";
import { daysOf, MEETING_COLUMNS, type MeetingRow } from "../../read/read-who.ts";
import { claimRecordUnder, ownerWho, ownerWithheld } from "../admin-owner.ts";
import { EVENT_LINK_COLUMNS, type EventLinkRow, eventLinks } from "../time/admin-week.ts";
import { claimWords } from "./admin-search-items.ts";

// The items a row of the owner's page opens to: one message, as read_message serves it to an agent, one
// draft an agent made, and one meeting. Each runs as pi_admin. A message or a meeting is read within the
// owner's one audience, as the timeline that lists it; a draft under its own label, as `pi send show`
// reads it. A row outside that, or that the key file cannot open, is answered as one that is not there
// (null, a 404). The reader's filter kept: a held message is never read, as the reader's row policy and
// statement leave it out. No reader statement runs here, which a structure test checks. Nothing is
// logged.

// read_message's window: the first 50,000 code points, the reader's most.
const TEXT_MOST = 50_000;

const MESSAGE = `
  select m.id, m.sent_at, m.direction, m.bulk, m.category, m.compartments,
    m.subject_enc, m.sender_enc, m.sender_name_enc, m.facts_enc, m.thread_id_enc, m.body_enc
  from knowledge.messages m
  where m.id = $1 and not m.held and m.compartments <@ $2::text[]
  order by m.id`;

type MessageRow = {
  id: string;
  sent_at: Date;
  direction: "inbound" | "outbound";
  bulk: boolean;
  category: MessageView["category"];
  compartments: string[];
  subject_enc: Sealed;
  sender_enc: Sealed;
  sender_name_enc: Sealed;
  facts_enc: Sealed;
  thread_id_enc: Sealed;
  body_enc: Sealed;
};
type Facts = { chars: number; unreadable: boolean; attachments: { name: string; type: string; size: number }[] };

const held = (context: AdminContext, compartments: string[]): boolean =>
  compartments.length > 0 && compartments.every((one) => context.keys.compartments.has(one));

// R-P6: the message, its text masked whole before the window is cut, as read_message serves it;
// `masked` counts the subject's values and the text's.
export function ownerMessage(context: AdminContext, id: MessageId): Promise<MessageView | null> {
  return context.transaction(async (query) => {
    const audience = await ownerAudience(query);
    const [row] = await query<MessageRow>(MESSAGE, [id, audience]);
    if (row === undefined || !held(context, row.compartments)) return null;
    const open = (column: keyof MessageRow): string | null => {
      const value = row[column];
      return value === null || value === undefined
        ? null
        : openedUnder(context.keys, row.compartments, { table: "knowledge.messages", id: row.id, column }, value);
    };
    const facts = JSON.parse(open("facts_enc") ?? "{}") as Partial<Facts>;
    const attachments = facts.attachments ?? [];
    const subject = open("subject_enc");
    const masked = subject === null ? null : maskCredentials(subject);
    const address = open("sender_enc");
    const thread = open("thread_id_enc");
    const body = open("body_enc");
    const spans = body === null ? null : maskedSpans(body);
    const points = spans === null ? null : Array.from(spans.text);
    const text = points?.slice(0, TEXT_MOST) ?? null;
    const count = (masked?.masked ?? 0) + (spans === null ? 0 : maskedIn(spans.spans, 0, TEXT_MOST));
    return MessageView.parse({
      id: row.id,
      at: stamp(row.sent_at),
      direction: row.direction,
      bulk: row.bulk,
      category: row.category,
      subject: masked === null ? null : { untrusted: masked.text },
      sender:
        address === null
          ? null
          : {
              address: { untrusted: address },
              name: ((name) => (name === null ? null : { untrusted: name }))(open("sender_name_enc")),
            },
      chars: facts.chars ?? points?.length ?? 0,
      attachments: attachments.length,
      ...maskedField(count),
      thread: { untrusted: thread ?? row.id },
      text: text === null ? null : { untrusted: text.join("") },
      offset: 0,
      more: points !== null && points.length > TEXT_MOST,
      unreadable: facts.unreadable ?? false,
      attachmentList: attachments
        .slice(0, 50)
        .map(({ name, type, size }) => ({ name: { untrusted: name }, type: { untrusted: type }, size })),
      link: gmailLink(thread ?? undefined),
    });
  });
}

// A draft with its latest status event and its account's label.
const DRAFT = `
  select d.id, d.created_at, d.compartments, d.body_enc, a.label,
    (${latestEvent("draft", "d.id")}) as status
  from ledger.drafts d
  left join vault.source_accounts a on a.id = d.source_account_id
  where d.id = $1
  order by d.id`;

type DraftRow = {
  id: string;
  created_at: Date;
  compartments: string[];
  body_enc: Sealed;
  label: string | null;
  status: string | null;
};

// Whether a draft goes to an address its account never wrote to, as ledger.first_contacts() finds
// one for `pi send show` (`--first-contact`).
const FIRST_CONTACT = `
  select exists (
    select 1 from ledger.drafts d cross join lateral unnest(d.recipient_fps) as r (fp)
    where d.id = $1 and not exists (select 1 from vault.sent_recipients s where s.account_id = d.source_account_id and s.address_fp = r.fp)) as first`;
// The people the owner's audience knows at the draft's addresses.
const AT_ADDRESSES = `
  select a.value_fp, a.entity_id from knowledge.accounts a
  where a.value_fp = any ($1::text[]) and a.compartments <@ $2::text[]
  order by a.value_fp, a.entity_id`;

// Each recipient the owner knows is named within their audience (one withheld is not), and a first
// contact is said, so the page gives the exact send command.
export function ownerDraft(context: AdminContext, id: string): Promise<OwnerDraft | null> {
  return context.transaction(async (query) => {
    const [row] = await query<DraftRow>(DRAFT, [id]);
    if (row === undefined || !held(context, row.compartments)) return null;
    const status = DraftStatus.safeParse(row.status);
    // A tainted draft's body is cleared (null). One that does not open or parse is a failure, never
    // shown as cleared: the read fails, as `pi send show` refuses it.
    const payload =
      row.body_enc === null
        ? null
        : SendPayload.parse(JSON.parse(open(context.keys, row, "ledger.drafts.body_enc", "throw")));
    const words = (value: string) => ({ untrusted: value });
    const addresses = [...new Set([...(payload?.to ?? []), ...(payload?.cc ?? [])])];
    const fps = new Map(addresses.map((address) => [fingerprint(context.keys, "address", address), address]));
    const audience = addresses.length === 0 ? [] : await ownerAudience(query);
    const withheld = addresses.length === 0 ? new Set<string>() : await ownerWithheld(query);
    const known =
      addresses.length === 0
        ? []
        : (await query<{ value_fp: string; entity_id: string }>(AT_ADDRESSES, [[...fps.keys()], audience])).filter(
            (one) => !withheld.has(one.entity_id),
          );
    const who = await ownerWho({ query, keys: context.keys }, [...new Set(known.map((one) => one.entity_id))]);
    const names = new Map<string, string>();
    for (const one of known) {
      const name = who.get(one.entity_id)?.name?.untrusted;
      const address = fps.get(one.value_fp);
      if (name !== undefined && address !== undefined && !names.has(address)) names.set(address, name);
    }
    const [first] = await query<{ first: boolean }>(FIRST_CONTACT, [row.id]);
    return OwnerDraft.parse({
      id: row.id,
      status: status.success ? status.data : "made",
      at: stamp(row.created_at),
      account: row.label !== null && /^[a-z][a-z0-9-]{1,39}$/.test(row.label) ? row.label : null,
      to: (payload?.to ?? []).map(words),
      cc: (payload?.cc ?? []).map(words),
      subject: payload === null ? null : words(payload.subject),
      text: payload === null ? null : words(payload.body),
      newThread: payload === null ? true : payload.thread === null,
      names: [...names].map(([address, name]) => ({ address: words(address), name: words(name) })),
      firstContact: first?.first ?? false,
    });
  });
}

// A calendar event in the owner's audience, its details' label within it too, as the timeline lists it,
// with its call and calendar links as weekEvents reads them.
const EVENT = `
  select ${MEETING_COLUMNS}, ${EVENT_LINK_COLUMNS}
  from knowledge.events v
  join knowledge.event_details d on d.event_id = v.id
  where v.id = $1 and v.compartments <@ $2::text[] and d.compartments <@ $2::text[]
  order by v.id`;

// Its participants within the same audience, the organizer first, as weekEvents lists them.
const EVENT_PARTICIPANTS = `
  select p.entity_id from knowledge.event_participants p
  where p.event_id = $1 and p.compartments <@ $2::text[]
  order by p.participant_role = 'organizer' desc, p.entity_id`;

// A meeting Lens recorded and linked to no event, and the people its participant claims name, as
// the timeline's captured entry finds it.
const CAPTURE = `
  select k.id, k.started_at, k.ended_at, k.evidence_id, k.compartments, k.facts_enc from knowledge.captures k
  where k.id = $1 and k.kind = 'meeting' and k.event_id is null and k.compartments <@ $2::text[]
  order by k.id`;
const CAPTURE_PEOPLE = `
  select distinct n.entity_id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
  join knowledge.entities e on e.id = n.entity_id and e.kind = 'person'
  where c.evidence_id = $1 and c.type = 'capture.person' and c.compartments <@ $2::text[]
  order by n.entity_id`;

// The facts drawn from the recording, oldest first: the claims citing its evidence within the owner's
// audience, not its `capture.*` claims (its people, project, anchor and place, which the sheet shows
// otherwise or are no statement), with the reader's filters stated: a release in force, and no claim
// naming a withheld ($3) or gone entity. A held message or a flagged agent write cannot be a
// recording's evidence.
const CAPTURE_FACTS = `
  select c.id, c.content_enc, c.compartments from knowledge.claims c
  where c.evidence_id = $1 and c.type not like 'capture.%' and c.compartments <@ $2::text[] and ${RELEASE_IN_FORCE}
    and not exists (
      select 1 from knowledge.claim_entities n
      where n.claim_id = c.id and (n.entity_id = any ($3::text[]) or not exists (select 1 from knowledge.entities e where e.id = n.entity_id)))
  order by c.valid_from, c.id collate "C"
  limit ${OWNER_MEETING_FACTS_MOST}`;

// A recording's title from its sealed facts: the app's, else its calendar entry's, masked as a
// subject is; null for none. The timeline's row and the opened meeting say the same.
export function captureTitle(facts: string): string | null {
  const sealed = JSON.parse(facts) as { title?: string | null; calendar?: { title?: string | null } | null };
  const title = sealed.title || sealed.calendar?.title || null;
  return title === null ? null : maskCredentials(title).text;
}

type CaptureRow = {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  evidence_id: string;
  compartments: string[];
  facts_enc: Sealed;
};

// A participant the reader would hide (withheld) is left out. Null for one outside the owner's
// audience, unknown, or a recording linked to an event (the event's row stands for it).
export function ownerMeeting(context: AdminContext, id: EventId | CaptureId): Promise<OwnerMeeting | null> {
  return context.transaction(async (query) => {
    const audience = await ownerAudience(query);
    const withheld = await ownerWithheld(query);
    const people = async (statement: string, key: string): Promise<Who[]> => {
      const ids = (await query<{ entity_id: string }>(statement, [key, audience]))
        .map((row) => row.entity_id)
        .filter((one) => !withheld.has(one));
      const who = await ownerWho({ query, keys: context.keys }, ids);
      return ids.flatMap((one) => who.get(one) ?? []);
    };
    if (id.startsWith("cap_")) {
      const [row] = await query<CaptureRow>(CAPTURE, [id, audience]);
      if (row === undefined || !held(context, row.compartments)) return null;
      const title = captureTitle(open(context.keys, row, "knowledge.captures.facts_enc", "throw"));
      const facts: OwnerMeetingFact[] = [];
      for (const claim of await query<{ id: string; content_enc: Sealed; compartments: string[] }>(CAPTURE_FACTS, [
        row.evidence_id,
        audience,
        [...withheld],
      ])) {
        let words = "";
        try {
          words = claimWords(claimRecordUnder(context.keys, claim));
        } catch {
          // A claim whose record does not parse says nothing here; its fact is still on the owner's timeline.
        }
        if (words !== "") facts.push({ id: claim.id, words: { untrusted: maskCredentials(words).text } });
      }
      return OwnerMeeting.parse({
        kind: "captured_meeting",
        id: row.id,
        title: title === null ? null : { untrusted: title },
        startsAt: stamp(row.started_at),
        endsAt: stampOrNull(row.ended_at),
        participants: await people(CAPTURE_PEOPLE, row.evidence_id),
        facts,
      });
    }
    const [row] = await query<MeetingRow & EventLinkRow>(EVENT, [id, audience]);
    if (row === undefined || !held(context, row.compartments)) return null;
    const days = row.all_day ? daysOf(row.starts_at, row.ends_at) : null;
    return OwnerMeeting.parse({
      kind: "meeting",
      meeting: {
        id: row.id,
        title:
          row.title_enc === null
            ? null
            : {
                untrusted: openedUnder(
                  context.keys,
                  row.compartments,
                  { table: "knowledge.event_details", id: row.id, column: "title_enc" },
                  row.title_enc,
                ),
              },
        startsAt: days === null ? stampOrNull(row.starts_at) : null,
        endsAt: days === null ? stampOrNull(row.ends_at) : null,
        allDay: row.all_day,
        ...(days ?? {}),
        cancelled: row.cancelled,
        participants: await people(EVENT_PARTICIPANTS, row.id),
        ...(row.owner_response === null ? {} : { response: row.owner_response }),
        ...eventLinks(context.keys, row),
      },
    });
  });
}
