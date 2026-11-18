import { type EvidenceId, type RawItem, Timestamp } from "@intelligence/contracts";
import {
  CodedError,
  EntityId,
  MessageCategory,
  type PersonalRef,
  ResearchRequestId,
  RestrictedCategory,
} from "@intelligence/contracts/personal";
import { codePoints, THE_OWNER } from "@intelligence/personal-core";
import {
  CONTACT_CLAIMS_VERSION,
  type ItemContext,
  type ItemFacts,
  isFullName,
  isHeadersMail,
  isOwnerAddress,
  type MessageFacts,
  membersOf,
  ownerSent,
  personalBulk,
} from "@intelligence/personal-core/items";
import { canonicalUrl } from "@intelligence/personal-core/research";
import { keepAlias } from "../core/aliases.ts";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { sealUnder } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { taintCiting } from "../erasure/taint.ts";
import { domainOf, ownerEntity, sameLabel } from "../identity/identity-port.ts";
import { contactAddresses, removeContactRows, writeContact, writeContactClaims } from "./writer-contacts.ts";
import { interactionOf } from "./writer-interactions.ts";
import { namedBy, removeClaims, removeUncited } from "./writer-removal.ts";

// The knowledge rows derived from one item. Every row takes the item's label, its source account's compartment and the restricted ones its screen
// added, and its values are sealed under that whole label.

type Account = { id: string; compartment: string };

const sealedOrNull = (
  tx: Tx,
  label: string[],
  table: string,
  id: string,
  column: string,
  value: string | null | undefined,
) => (value === null || value === undefined ? null : sealUnder(tx.keys, label, { table, id, column }, value));

export const isTimestamp = (value: unknown): boolean => Timestamp.safeParse(value).success;

// Whether facts fit the item, and the context `derive` was handed for it. Checked before
// anything of the item is written, and a refusal rolls the item back:
// - the owner is the only member there is, and a member column holds its value in clear, so
//   facts that name any other member would store whatever a derive put there;
// - the sender member is the owner exactly when core's membersOf says so: for an email, when
//   its labels say the owner sent it (ownerSent: SENT and not SPAM), so facts cannot make a
//   forged From the owner's; for an event, when the owner organizes it, by `self` or by one of
//   the context's owner addresses. An email's record, which gives the interaction rows their
//   direction, is outbound exactly when the owner sent it;
// - the facts are of the item's own kind, and their record is about this revision and of the
//   item's own channel;
// - every time is a timestamp: a time goes to a typed column, and the server's refusal of a
//   value that is none would quote it;
// - every entity the record gives a row has exactly one role, so none is given one by default;
// - an email has its message, filed under one of the five categories, with whole attachment
//   sizes, and, unless it is bulk, at its record's own time, and its restricted list holds
//   categories only, sorted, each once, so a derive can name no other compartment;
// - an email that personalBulk calls bulk, with the context's senderWrittenTo, is bulk, so it
//   writes no interaction row and no entity. Facts may call bulk one personalBulk does not: the
//   shared parse's `automated` rule makes a message bulk too, and is not read here.
export function checkFacts(facts: ItemFacts, raw: RawItem, ctx: ItemContext): void {
  const members = [
    ...facts.members.participantMembers,
    ...(facts.members.senderMember === undefined ? [] : [facts.members.senderMember]),
  ];
  const own =
    raw.sourceKind === "calendar"
      ? "event"
      : raw.sourceKind === "crm"
        ? "contact"
        : raw.sourceKind === "document"
          ? "document"
          : raw.sourceKind === "web_research"
            ? "page"
            : "email";
  let fits = facts.kind === "unread" || facts.kind === own;
  // Nothing else of a page is a fact; page facts on any other source kind are refused above.
  if (facts.kind === "page") {
    const page = facts.page;
    fits &&=
      page.url === raw.sourceItemId &&
      canonicalUrl(page.url) === page.url &&
      (page.title === null || typeof page.title === "string") &&
      ResearchRequestId.safeParse(page.requestId).success &&
      (page.about === null || EntityId.safeParse(page.about).success) &&
      Array.isArray(page.names) &&
      page.names.every((name) => typeof name === "string") &&
      (raw.mediaType === "text/html" || raw.mediaType === "text/plain");
  }
  // A document's facts carry its file's times and a kind of the five.
  if (facts.kind === "document") {
    const document = facts.document;
    fits &&=
      isTimestamp(document.modifiedAt) &&
      isTimestamp(document.createdAt) &&
      ["doc", "sheet", "slides", "pdf", "other"].includes(document.kind);
    fits &&= document.sections.every(
      (one) => Number.isInteger(one.start) && Number.isInteger(one.end) && one.start <= one.end,
    );
  }
  fits &&= (facts.members.senderMember === THE_OWNER) === (membersOf(raw, ctx).senderMember === THE_OWNER);
  if (facts.kind === "event" || (facts.kind === "email" && !facts.bulk)) {
    members.push(...facts.record.teamRecipients, ...(facts.record.sender === undefined ? [] : [facts.record.sender]));
    fits &&=
      facts.record.evidenceId === ctx.evidenceId &&
      facts.record.channel === raw.sourceKind &&
      isTimestamp(facts.record.occurredAt);
  }
  if (facts.kind === "event")
    fits &&= [facts.facts.startsAt, facts.facts.endsAt].every((time) => time === null || isTimestamp(time));
  if (facts.kind === "email" && !facts.bulk) {
    fits &&=
      facts.record.direction === (ownerSent(raw) ? "outbound" : "inbound") && !personalBulk(raw, ctx.senderWrittenTo);
    const roles = facts.roles.map((one) => String(one.entity));
    fits &&=
      new Set(roles).size === roles.length && interactionOf(facts.record).every((pair) => roles.includes(pair.entity));
  }
  // A contact names only identifiers it lists, and only its people; it names a person by a name
  // only when it lists one identifier: one address, or an imported row's one profile key.
  if (facts.kind === "contact") {
    const listed = contactAddresses(raw);
    const people = new Set(facts.people.map((one) => String(one.entity)));
    fits &&=
      isTimestamp(facts.contact.updatedAt) &&
      facts.people.every((one) => listed.includes(one.address)) &&
      facts.names.every((one) => people.has(String(one.entity))) &&
      (facts.names.length === 0 || listed.length === 1);
  }
  if (facts.kind === "unread" && facts.restricted !== undefined)
    fits &&= raw.sourceKind === "email" && restrictedList(facts.restricted);
  if (facts.kind === "email") {
    // There by its type; facts written by hand may still lack it.
    const message = facts.message as MessageFacts | undefined;
    fits &&=
      message !== undefined &&
      isTimestamp(message.at) &&
      MessageCategory.safeParse(message.category).success &&
      message.attachments.every((one) => Number.isInteger(one.size) && one.size >= 0) &&
      (facts.bulk || message.at === facts.record.occurredAt) &&
      restrictedList(message.restricted);
  }
  // Read off any kind, so facts written by hand cannot carry it elsewhere or carry another name.
  const ownNames = (facts as { ownerNames?: unknown }).ownerNames;
  if (ownNames !== undefined) {
    const written = facts.kind === "email" ? facts.message.sender?.name : undefined;
    fits &&=
      facts.kind === "email" &&
      !facts.bulk &&
      ownerSent(raw) &&
      raw.sender !== undefined &&
      isOwnerAddress(raw.sender, ctx.ownerAddresses) &&
      written !== undefined &&
      isFullName(written) &&
      Array.isArray(ownNames) &&
      ownNames.length === 1 &&
      ownNames[0] === written;
  }
  if (!fits || members.some((member) => member !== THE_OWNER)) throw new CodedError("invalid_facts");
}

// A list of restricted categories, sorted, each once.
const restrictedList = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (one, i) => RestrictedCategory.safeParse(one).success && (i === 0 || (value[i - 1] as string) < (one as string)),
  );

// What `facts_enc` holds of a message: nothing a query needs, so all of it sealed. The two
// header values are a sender's own, kept for the stage that sends, each left out when the
// facts have none.
const sealedFacts = (message: MessageFacts): string =>
  JSON.stringify({
    chars: message.text === null ? 0 : codePoints(message.text),
    unreadable: message.unreadable,
    attachments: message.attachments.map(({ name, type, size }) => ({ name, type, size })),
    ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
    ...(message.references === undefined ? {} : { references: message.references }),
  });

// Whether a calendar source id names one occurrence of a recurring series: Google gives an
// occurrence its series' id, an underscore and its start, as 20270915T090000Z or, for an
// all-day one, 20270915. Code reads only the id's form, never the event.
export const isOccurrenceId = (sourceItemId: string): boolean => /_\d{8}(?:T\d{6}Z)?$/.test(sourceItemId);

// Writes what an item's facts derive, citing `evidenceId`, every row under `label`. For a later revision, `previous` is
// the revision it supersedes: the rows derived from that one are replaced, a message and an event keeping their ids, and
// whoever only the earlier revision named is removed. A message whose label changed gets a new row: its old one is removed
// as one the revision no longer derives, so nothing that cited it under the old label sees it again. So is whoever the
// identity port resolved for this item (`resolved`) and no row names. Every email that was read has its one message row,
// and a bulk one nothing else; an unread item derives nothing. `released` says the item's evidence row carries the owner's
// release of its hold, and `modelHeld` that it carries the decide model's hold: a message is held exactly when its facts
// say so or the decide model held it, and the owner has not released it.
export async function writeDerived(
  tx: Tx,
  account: Account,
  label: string[],
  raw: RawItem,
  evidenceId: EvidenceId,
  facts: ItemFacts,
  previous: string | null,
  resolved: ReadonlySet<string>,
  released: boolean,
  modelHeld = false,
  // A re-derive's alone: when each value of the claims it deleted was first known, by value
  // fingerprint, which the code-made claims it writes again carry.
  firstKnown?: ReadonlyMap<string, string>,
): Promise<void> {
  const earlier = previous === null ? undefined : await clearPrevious(tx, previous, label);
  let message = earlier?.message;
  let event = earlier?.event;

  const headersMail = isHeadersMail(raw);
  if (facts.kind === "email" && !headersMail) {
    const id = earlier?.changedLabel === true ? newId("msg") : (message ?? newId("msg"));
    if (earlier?.changedLabel !== true) message = undefined;
    await writeMessage(tx, label, raw, evidenceId, facts, { id, held: (facts.message.held || modelHeld) && !released });
  }

  if (facts.kind === "email" && !facts.bulk) {
    // One row per entity on the message, with its role from the facts. A sent message's body hash
    // is stored only as its keyed fingerprint.
    const pairs = interactionOf(facts.record);
    const roleOf = new Map(facts.roles.map((one) => [String(one.entity), one.role]));
    await tx.query(
      `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, body_hash, entity_role, compartments, readers)
       select pair.id, $1, pair.member, pair.entity, $2, $3, $4, pair.body_hash, pair.role, $5, $6
       from unnest($7::text[], $8::text[], $9::text[], $10::text[], $11::text[]) as pair (id, member, entity, body_hash, role)`,
      [
        evidenceId,
        facts.record.direction,
        headersMail ? "mail_headers" : facts.record.channel,
        facts.record.occurredAt,
        label,
        [THE_OWNER],
        pairs.map((pair) => pair.id),
        pairs.map((pair) => pair.member),
        pairs.map((pair) => pair.entity),
        pairs.map((pair) =>
          pair.bodyHash === null || headersMail ? null : fingerprint(tx.keys, "body_hash", pair.bodyHash),
        ),
        // checkFacts has shown that each has one.
        pairs.map((pair) => roleOf.get(pair.entity)),
      ],
    );
  }

  if (facts.kind === "event") {
    await writeEvent(tx, account, label, raw, evidenceId, facts, event ?? newId("evt"));
    event = undefined;
  }

  if (facts.kind === "contact") {
    if (previous !== null)
      await removeClaims(
        tx.query,
        (await tx.query<{ id: string }>("select id from knowledge.claims where evidence_id = $1", [previous])).map(
          (row) => row.id,
        ),
      );
    await writeContact(tx, account, raw, evidenceId, facts, earlier?.contact);
    await writeContactClaims(tx, evidenceId, facts, contactAddresses(raw), CONTACT_CLAIMS_VERSION, firstKnown);
  }

  // What the earlier revision was and this one is not, and what cited it.
  if (message !== undefined) {
    await tx.query("delete from knowledge.messages where id = $1", [message]);
    await taintCiting(tx.query, { evidenceIds: [], refs: [{ kind: "message", id: message } as PersonalRef] });
  }
  if (event !== undefined) {
    await tx.query("delete from knowledge.event_details where event_id = $1", [event]);
    await tx.query("delete from knowledge.events where id = $1", [event]);
    await taintCiting(tx.query, { evidenceIds: [], refs: [{ kind: "event", id: event } as PersonalRef] });
  }

  if (facts.kind === "event" || facts.kind === "contact" || (facts.kind === "email" && !facts.bulk))
    await writeAliases(tx, label, evidenceId, facts);
  await removeUncited(tx, [...new Set([...(earlier?.before ?? []), ...resolved])]);
}

// What the revision `previous` derived and this one replaces: whoever it named, its contact row,
// its message and event ids, its interaction, alias and participant rows removed. Its message is
// kept only under the same label (`changedLabel` otherwise), to be removed after, and a new row
// made.
async function clearPrevious(tx: Tx, previous: string, label: string[]) {
  const before = await namedBy(tx, [previous]);
  const contact = await removeContactRows(tx, [previous]);
  const [kept] = await tx.query<{ id: string; compartments: string[] }>(
    "select id, compartments from knowledge.messages where evidence_id = $1",
    [previous],
  );
  const changedLabel = kept !== undefined && !sameLabel(kept.compartments, label);
  const event = (
    await tx.query<{ id: string }>("select id from knowledge.events where evidence_id = $1", [previous])
  )[0]?.id;
  await tx.query("delete from knowledge.interaction_log where evidence_id = $1", [previous]);
  await tx.query("delete from knowledge.aliases where evidence_id = $1", [previous]);
  if (event !== undefined) await tx.query("delete from knowledge.event_participants where event_id = $1", [event]);
  return { before, contact, message: kept?.id, event, changedLabel };
}

// In clear, only what a query filters or orders by; everything the message says, and who sent it,
// sealed under this row.
async function writeMessage(
  tx: Tx,
  label: string[],
  raw: RawItem,
  evidenceId: EvidenceId,
  facts: Extract<ItemFacts, { kind: "email" }>,
  row: { id: string; held: boolean },
): Promise<void> {
  const { id } = row;
  const said = facts.message;
  const sender = said.sender?.address;
  const sealed = (column: string, value: string | null | undefined) =>
    sealedOrNull(tx, label, "knowledge.messages", id, column, value);
  await tx.query(
    `insert into knowledge.messages (id, evidence_id, sent_at, direction, bulk, category, held, thread_fp, sender_fp, sender_domain_fp,
         subject_enc, thread_id_enc, sender_enc, sender_name_enc, body_enc, facts_enc, compartments, auth)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       on conflict (id) do update set evidence_id = excluded.evidence_id, sent_at = excluded.sent_at, direction = excluded.direction,
         bulk = excluded.bulk, category = excluded.category, held = excluded.held, thread_fp = excluded.thread_fp,
         sender_fp = excluded.sender_fp, sender_domain_fp = excluded.sender_domain_fp, subject_enc = excluded.subject_enc,
         thread_id_enc = excluded.thread_id_enc, sender_enc = excluded.sender_enc, sender_name_enc = excluded.sender_name_enc,
         body_enc = excluded.body_enc, facts_enc = excluded.facts_enc, auth = excluded.auth`,
    [
      id,
      evidenceId,
      said.at,
      ownerSent(raw) ? "outbound" : "inbound",
      facts.bulk,
      said.category,
      row.held,
      raw.threadId === undefined ? null : fingerprint(tx.keys, "thread", raw.threadId),
      sender === undefined ? null : fingerprint(tx.keys, "address", sender),
      sender === undefined ? null : fingerprint(tx.keys, "domain", domainOf(sender)),
      sealed("subject_enc", said.subject),
      sealed("thread_id_enc", raw.threadId),
      sealed("sender_enc", sender),
      sealed("sender_name_enc", said.sender?.name),
      sealed("body_enc", said.text),
      sealed("facts_enc", sealedFacts(said)),
      label,
      // Clear, as the evidence order reads it.
      said.auth ?? "unknown",
    ],
  );
}

// An event's row, kept by id across revisions, its details and its participants.
async function writeEvent(
  tx: Tx,
  account: Account,
  label: string[],
  raw: RawItem,
  evidenceId: EvidenceId,
  facts: Extract<ItemFacts, { kind: "event" }>,
  id: string,
): Promise<void> {
  await tx.query(
    `insert into knowledge.events (id, event_kind, occurred_at, evidence_id, compartments, readers) values ($1, 'meeting', $2, $3, $4, $5)
       on conflict (id) do update set occurred_at = excluded.occurred_at, evidence_id = excluded.evidence_id`,
    [id, facts.record.occurredAt, evidenceId, label, [THE_OWNER]],
  );
  await tx.query(
    `insert into knowledge.event_details (event_id, account_id, source_event_fp, starts_at, ends_at, all_day, cancelled, owner_response, title_enc, compartments, recurring, call_link_enc, invite_link_enc)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (event_id) do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at, all_day = excluded.all_day,
         cancelled = excluded.cancelled, owner_response = excluded.owner_response, title_enc = excluded.title_enc, recurring = excluded.recurring,
         call_link_enc = excluded.call_link_enc, invite_link_enc = excluded.invite_link_enc`,
    [
      id,
      account.id,
      fingerprint(tx.keys, "source_id", raw.sourceItemId),
      facts.facts.startsAt,
      facts.facts.endsAt,
      facts.facts.allDay,
      facts.facts.cancelled,
      facts.facts.ownerResponse ?? null,
      sealedOrNull(tx, label, "knowledge.event_details", id, "title_enc", facts.facts.title),
      label,
      isOccurrenceId(raw.sourceItemId),
      sealedOrNull(tx, label, "knowledge.event_details", id, "call_link_enc", facts.facts.callLink),
      sealedOrNull(tx, label, "knowledge.event_details", id, "invite_link_enc", facts.facts.inviteLink),
    ],
  );
  await tx.query(
    `insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments)
       select $1, one.entity, one.role, $2 from unnest($3::text[], $4::text[]) as one (entity, role)
       on conflict (event_id, entity_id) do nothing`,
    [id, label, facts.participants.map((one) => one.entity), facts.participants.map((one) => one.role)],
  );
}

// A name is kept once per item that showed it; the owner's own too, as the owner's entity's alias,
// citing the item under its label like any other.
async function writeAliases(
  tx: Tx,
  label: string[],
  evidenceId: EvidenceId,
  facts: Exclude<Extract<ItemFacts, { kind: "event" | "contact" | "email" }>, { bulk: true }>,
): Promise<void> {
  const own = facts.kind === "email" ? (facts.ownerNames ?? []) : [];
  const names = [
    ...facts.names,
    ...(own.length === 0 ? [] : [{ entity: await ownerEntity(tx), name: own[0] as string }]),
  ];
  for (const { entity, name } of names) {
    await keepAlias(tx, { entity, nameFp: fingerprint(tx.keys, "name", name), evidenceId, name, label });
  }
}

// The released claims of a record, removed with every belief resting on them (a
// lift of the owner's release, and its replay).
export async function removeReleased(query: Query, evidenceId: string): Promise<void> {
  const claims = (
    await query<{ id: string }>("select id from knowledge.claims where evidence_id = $1 and released", [evidenceId])
  ).map((row) => row.id);
  await removeClaims(query, claims);
}
