// Messages and events written by hand, the facts a derive returns for each, and the derive.

import {
  type InteractionRecord,
  type LocalEntityId,
  type RawItem,
  RequestId,
  type Resolution,
  type Timestamp,
} from "@intelligence/contracts";
import { messageBodyHash } from "@intelligence/contracts/body-hash";
import { type RestrictedCategory, SourceAccountId } from "@intelligence/contracts/personal";
import { normalizeAddress, THE_OWNER } from "@intelligence/personal-core";
import {
  type Attachment,
  type CalendarEvent,
  type CalendarPerson,
  calendarItem,
  type EventFacts,
  type GmailMessage,
  gmailItem,
  type ItemContext,
  type ItemFacts,
  type ItemMembers,
  type MessageFacts,
} from "@intelligence/personal-core/items";
import type { Writer } from "../write/writer.ts";
import type { IngestAnswer, SourceAccountRow } from "../write/writer-types.ts";
import type { Who } from "./cast.ts";
import { sha256Hex } from "./clients.ts";

// ---------------------------------------------------------------------------------------------
// Messages and events, written by hand, and the facts a derive returns for each
// ---------------------------------------------------------------------------------------------

export type Derive = (ctx: ItemContext) => Promise<ItemFacts>;

// A message as a test writes it. `reads` says what the hand-written facts make of it: no person for
// `bulk`, nothing derived for `unread`, and for `conditional` a person's message exactly when the
// writer says the owner has written to its sender (`ctx.senderWrittenTo`), bulk otherwise. `text`,
// `attachments`, `references`, `held` and `unreadable` are what the facts say of the message
// itself; absent, the message has no text and no attachment, and is neither held nor unreadable.
export type MailFixture = {
  id: string;
  threadId: string;
  messageId?: string;
  references?: string[];
  at: Timestamp;
  from?: Who;
  to?: Who[];
  cc?: Who[];
  bcc?: Who[];
  subject?: string;
  labels: string[];
  reads?: "bulk" | "unread" | "conditional";
  text?: string;
  attachments?: Attachment[];
  held?: boolean;
  unreadable?: boolean;
  // The restricted categories the screen found in it, as deriveItem gives them; absent is none.
  restricted?: RestrictedCategory[];
};

const written = (who: Who): string => (who.name === undefined ? who.address : `"${who.name}" <${who.address}>`);
const rfc5322 = (at: Timestamp): string => new Date(at).toUTCString().replace("GMT", "+0000");

// Gmail's metadata answer for a fixture.
export function gmailMessage(fixture: MailFixture): GmailMessage {
  const list = (name: string, people: Who[] = []): { name: string; value: string }[] =>
    people.length === 0 ? [] : [{ name, value: people.map(written).join(", ") }];
  return {
    id: fixture.id,
    threadId: fixture.threadId,
    internalDate: Date.parse(fixture.at),
    labelIds: fixture.labels,
    headers: [
      ...(fixture.from === undefined ? [] : [{ name: "From", value: written(fixture.from) }]),
      ...list("To", fixture.to),
      ...list("Cc", fixture.cc),
      ...list("Bcc", fixture.bcc),
      { name: "Date", value: rfc5322(fixture.at) },
      ...(fixture.subject === undefined ? [] : [{ name: "Subject", value: fixture.subject }]),
      ...(fixture.messageId === undefined ? [] : [{ name: "Message-ID", value: `<${fixture.messageId}>` }]),
      ...(fixture.references === undefined
        ? []
        : [{ name: "References", value: fixture.references.map((id) => `<${id}>`).join(" ") }]),
    ],
    ...(fixture.text === undefined ? {} : { text: fixture.text }),
    ...(fixture.attachments === undefined ? {} : { attachments: fixture.attachments }),
  };
}

// The item the connector would hand over, from the shared builder.
export const mailItem = (
  fixture: MailFixture,
  account: SourceAccountRow,
  changeKind: RawItem["changeKind"] = "backfill",
): RawItem => gmailItem(gmailMessage(fixture), { sourceAccount: account.id, changeKind });

// The same Gmail message handed over again under another revision tag (`f:<id>`, with no
// closing colon, which the builder never gives): the next revision of its source item. The
// builder gives `f:<id>:` and the message's deriving labels.
export const mailRevision = (fixture: MailFixture, account: SourceAccountRow): RawItem => ({
  ...mailItem(fixture, account),
  revisionTag: `f:${fixture.id}`,
});

// A stand-in account id, for reading what the builder makes of a fixture before any account exists.
const NO_ACCOUNT = SourceAccountId.parse(`acc_${"0".repeat(26)}`);

// A message's source item id and revision tag, always as the builder gives them, never typed:
// `gmail-id:<id>` and `f:<id>:<deriving labels>`. The Message-ID header is never an item's
// identity.
export const mailSourceId = (fixture: MailFixture): string =>
  gmailItem(gmailMessage(fixture), { sourceAccount: NO_ACCOUNT, changeKind: "backfill" }).sourceItemId;
const mailTag = (fixture: MailFixture): string =>
  gmailItem(gmailMessage(fixture), { sourceAccount: NO_ACCOUNT, changeKind: "backfill" }).revisionTag;

// A stand-in body hash for a sent message with no text: a header item has no body to hash.
export const bodyHashOf = (fixture: MailFixture): string => sha256Hex(`body of ${fixture.id}`);

// The body hash a sent message's record carries: the shared rule's hash of its text, or the
// stand-in when it has none.
export const sentBodyHash = async (fixture: MailFixture): Promise<string> =>
  fixture.text === undefined ? bodyHashOf(fixture) : messageBodyHash(fixture.text);

// An address through the identity port, as a derive resolves one. Null when it is no person.
export async function resolveAddress(
  ctx: ItemContext,
  address: string,
  observedAt: Timestamp,
): Promise<LocalEntityId | null> {
  const resolution = await ask(ctx, "address", address, observedAt);
  return resolution.outcome === "linked" || resolution.outcome === "created" ? resolution.entity : null;
}

// One question to the identity port, with its whole answer.
export const ask = (
  ctx: ItemContext,
  kind: "address" | "source_id" | "name",
  value: string,
  observedAt: Timestamp,
): Promise<Resolution> =>
  ctx.identity.resolve(
    { key: { kind, value }, observedAt },
    "people",
    RequestId.parse(`fixture:${ctx.evidenceId}:${kind}:${value}`),
  );

// What a message's facts say of the message itself, written by hand from its fixture: its subject,
// time, sender and Gmail category, its text and attachment list, whether it is held or unreadable,
// and its own Message-ID and References, each left out when the fixture has none.
export function mailMessage(fixture: MailFixture): MessageFacts {
  const address = fixture.from === undefined ? null : normalizeAddress(fixture.from.address);
  const name = fixture.from?.name;
  return {
    subject: fixture.subject ?? null,
    at: fixture.at,
    ...(address === null ? {} : { sender: { address, ...(name === undefined ? {} : { name }) } }),
    category:
      (["promotions", "social", "forums", "updates"] as const).find((category) =>
        fixture.labels.includes(`CATEGORY_${category.toUpperCase()}`),
      ) ?? "primary",
    text: fixture.text ?? null,
    unreadable: fixture.unreadable ?? false,
    held: fixture.held ?? false,
    restricted: fixture.restricted ?? [],
    attachments: fixture.attachments ?? [],
    ...(fixture.messageId === undefined ? {} : { messageId: fixture.messageId }),
    ...(fixture.references === undefined ? {} : { references: fixture.references }),
  };
}

// So an owner address in From without SENT is inbound with no sender entity.
export const mailFacts =
  (fixture: MailFixture): Derive =>
  async (ctx) => {
    const outbound = fixture.labels.includes("SENT") && !fixture.labels.includes("SPAM");
    const members: ItemMembers = {
      participantMembers: [THE_OWNER],
      ...(outbound ? { senderMember: THE_OWNER } : {}),
    };
    if (fixture.from === undefined || fixture.reads === "unread") return { kind: "unread", members };
    if (fixture.reads === "bulk" || (fixture.reads === "conditional" && ctx.senderWrittenTo !== true))
      return { kind: "email", members, bulk: true, message: mailMessage(fixture) };

    const roles: { entity: LocalEntityId; role: "sender" | "recipient" }[] = [];
    const names: { entity: LocalEntityId; name: string }[] = [];
    const people = [
      { who: fixture.from, role: "sender" as const },
      ...[...(fixture.to ?? []), ...(fixture.cc ?? []), ...(fixture.bcc ?? [])].map((who) => ({
        who,
        role: "recipient" as const,
      })),
    ];
    for (const { who, role } of people) {
      const entity = await resolveAddress(ctx, who.address, fixture.at);
      const owner = entity === ctx.ownerEntity || ctx.ownerAddresses.includes(normalizeAddress(who.address) ?? "");
      if (entity === null || owner) continue;
      if (!roles.some((one) => one.entity === entity)) roles.push({ entity, role });
      if (who.name !== undefined && !names.some((one) => one.entity === entity)) names.push({ entity, name: who.name });
    }
    const recipients = roles.filter((one) => one.role === "recipient").map((one) => one.entity);
    const record: InteractionRecord = outbound
      ? {
          evidenceId: ctx.evidenceId,
          occurredAt: fixture.at,
          channel: "email",
          direction: "outbound",
          sender: THE_OWNER,
          teamRecipients: [],
          participants: recipients,
          sent: { recipients, bodyHash: await sentBodyHash(fixture) },
        }
      : {
          evidenceId: ctx.evidenceId,
          occurredAt: fixture.at,
          channel: "email",
          direction: "inbound",
          teamRecipients: [THE_OWNER],
          participants: roles.map((one) => one.entity),
        };
    return { kind: "email", members, bulk: false, message: mailMessage(fixture), record, roles, names };
  };

// An event as a test writes it, with the title and times a reader of it returns, written by hand.
export type EventFixture = {
  event: CalendarEvent;
  title: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
};

// The clock handed to `calendarItem`.
export const NOW: Timestamp = "2026-09-15T12:00:00Z";

// The item the connector would hand over for an event that is no bare cancellation.
export function eventItem(
  fixture: EventFixture,
  account: SourceAccountRow,
  changeKind: RawItem["changeKind"] = "backfill",
): RawItem {
  const item = calendarItem(fixture.event, { sourceAccount: account.id, changeKind, now: NOW });
  if (!("payload" in item)) throw new Error("a bare cancellation is a deletion, not an item");
  return item;
}

// The facts for an event, written by hand from its fixture: the owner is whoever carries `self`
// or an owner address, and is never a participant.
export const eventFacts =
  (fixture: EventFixture): Derive =>
  async (ctx) => {
    const { event } = fixture;
    const observedAt = event.updated ?? NOW;
    const everyone = [...(event.organizer === undefined ? [] : [event.organizer]), ...(event.attendees ?? [])];
    const isOwner = (person: CalendarPerson): boolean =>
      person.self === true || ctx.ownerAddresses.includes(normalizeAddress(person.email) ?? "");
    const nameOf = (address: string): string | undefined =>
      everyone.find((person) => normalizeAddress(person.email) === address && person.displayName !== undefined)
        ?.displayName;

    const participants: EventFacts["participants"] = [];
    const add = (person: CalendarPerson, role: "organizer" | "attendee"): void => {
      const address = normalizeAddress(person.email);
      if (address === null || participants.some((one) => one.person.address === address)) return;
      const name = nameOf(address);
      participants.push({ person: { address, ...(name === undefined ? {} : { name }) }, role, owner: isOwner(person) });
    };
    if (event.organizer !== undefined) add(event.organizer, "organizer");
    for (const attendee of event.attendees ?? []) add(attendee, "attendee");

    const ownerResponse = (event.attendees ?? []).find(isOwner)?.responseStatus;
    const facts: EventFacts = {
      sourceId: event.id,
      revision: event.etag ?? event.updated ?? null,
      cancelled: event.status === "cancelled",
      title: fixture.title,
      startsAt: fixture.startsAt,
      endsAt: fixture.endsAt,
      allDay: fixture.allDay,
      ...(ownerResponse === undefined ? {} : { ownerResponse }),
      participants,
      ...(event.callLink === undefined ? {} : { callLink: event.callLink }),
      ...(event.inviteLink === undefined ? {} : { inviteLink: event.inviteLink }),
    };

    const entities: { entity: LocalEntityId; role: "organizer" | "participant" }[] = [];
    const names: { entity: LocalEntityId; name: string }[] = [];
    for (const { person, role, owner } of participants) {
      if (owner) continue;
      const entity = await resolveAddress(ctx, person.address, observedAt);
      if (entity === null || entity === ctx.ownerEntity || entities.some((one) => one.entity === entity)) continue;
      entities.push({ entity, role: role === "organizer" ? "organizer" : "participant" });
      if (person.name !== undefined) names.push({ entity, name: person.name });
    }
    const organizes = participants.some((one) => one.owner && one.role === "organizer");
    const members: ItemMembers = {
      participantMembers: [THE_OWNER],
      ...(organizes ? { senderMember: THE_OWNER } : {}),
    };
    const record: InteractionRecord = {
      evidenceId: ctx.evidenceId,
      occurredAt: fixture.startsAt ?? observedAt,
      channel: "calendar",
      direction: "meeting",
      ...(organizes ? { sender: THE_OWNER } : {}),
      teamRecipients: participants.some((one) => one.owner) ? [THE_OWNER] : [],
      participants: entities.map((one) => one.entity),
    };
    return { kind: "event", members, facts, record, participants: entities, names };
  };

// Every fixture's facts, by the source item id and revision tag the builders give its item.
const REGISTRY = new Map<string, Derive>();
const registryKey = (sourceItemId: string, revisionTag: string): string => `${sourceItemId}\n${revisionTag}`;

// Declares a message fixture, so `derive` finds its facts.
export function mail(fixture: MailFixture): MailFixture {
  REGISTRY.set(registryKey(mailSourceId(fixture), mailTag(fixture)), mailFacts(fixture));
  return fixture;
}

// Declares an event fixture, so `derive` finds its facts.
export function event(fixture: EventFixture): EventFixture {
  const item = calendarItem(fixture.event, { sourceAccount: NO_ACCOUNT, changeKind: "backfill", now: NOW });
  if ("payload" in item) REGISTRY.set(registryKey(item.sourceItemId, item.revisionTag), eventFacts(fixture));
  return fixture;
}

// The one derive for `rederiveIfNeeded`, and for any ingest of a declared fixture: it picks the
// item's hand-written facts by `raw.sourceItemId` (and, where a source item has several
// revisions, its revision tag).
export async function derive(raw: RawItem, ctx: ItemContext): Promise<ItemFacts> {
  const facts = REGISTRY.get(registryKey(raw.sourceItemId, raw.revisionTag));
  if (facts === undefined) throw new Error("no fixture is declared for this item");
  return facts(ctx);
}

export const ingestMail = (writer: Writer, account: SourceAccountRow, fixture: MailFixture): Promise<IngestAnswer> =>
  writer.ingestItem(account, mailItem(fixture, account), mailFacts(fixture));

export const ingestEvent = (writer: Writer, account: SourceAccountRow, fixture: EventFixture): Promise<IngestAnswer> =>
  writer.ingestItem(account, eventItem(fixture, account), eventFacts(fixture));

export const crowd = (prefix: string, count: number): Who[] =>
  Array.from({ length: count }, (_, index) => ({
    address: `${prefix}-${String(index + 1).padStart(3, "0")}@crowd.test`,
  }));
