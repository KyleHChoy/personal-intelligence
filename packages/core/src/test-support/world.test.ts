import {
  EvidenceId,
  type IdentityResolver,
  InterpreterOutput,
  LocalEntityId,
  PublicIdentifier,
  type RawItem,
  Timestamp,
} from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  FactList,
  KEY_FIELDS,
  type OwnerSideKind,
  PageUrl,
  REJECTED_LENGTH,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { addressParser } from "postal-mime";
import { describe, expect, it } from "vitest";
import { parse, segmentAt } from "../claim-pipeline/parse.ts";
import { CONSUMER_DOMAINS, organizationDomain, PERSONAL_LIMITS } from "../index.ts";
import type { CalendarEvent, GmailMessage, ItemContext } from "../items/index.ts";
import {
  contactItem,
  contactKept,
  deriveItem,
  driveItem,
  gmailItem,
  headersOnly,
  isBareCancellation,
  pipelineItemOf,
  RECOVERY_MARKERS,
  RESTRICTED_TERMS,
  readEvent,
  recoveryHold,
  restrictedCategories,
  whitelistedContact,
} from "../items/index.ts";
import {
  canonicalUrl,
  idShaped,
  isPrivateUrl,
  pageItem,
  pagePayloadForParse,
  robotsAllows,
  robotsDisallow,
} from "../research/index.ts";
import {
  fakeSources,
  fakeWeb,
  type World,
  type WorldAccount,
  type WorldFact,
  world,
  worldModelOutputs,
} from "../testing.ts";

const [MINUTE, HOUR, DAY] = [60_000, 3_600_000, 86_400_000];
const NOW = new Date("2026-03-10T12:00:00.000Z");
// Other times of day, for the rules that depend on one: late evening, just after midnight,
// the last second before the all-day event moves a day, and, as a real clock gives, a time
// with milliseconds.
const NOWS = [
  NOW,
  new Date("2026-03-10T23:30:00.000Z"),
  new Date("2026-03-11T00:20:00.000Z"),
  new Date("2026-03-10T22:59:59.000Z"),
  new Date("2026-03-10T12:00:00.789Z"),
];

const account = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const at = { sourceAccount: account, changeKind: "backfill" } as const;
const bytes = (raw: RawItem): Uint8Array => new Uint8Array(Buffer.from(raw.payload, "base64"));

// Google's calendar system domains: the one exception to reserved domains in the world.
const CALENDAR_DOMAINS = ["group.calendar.google.com", "import.calendar.google.com", "resource.calendar.google.com"];

const values = (message: GmailMessage, ...names: string[]): string[] =>
  message.headers.filter((header) => names.includes(header.name.toLowerCase())).map((header) => header.value);
const value = (message: GmailMessage, name: string): string | undefined => values(message, name)[0];
const addressesOf = (message: GmailMessage, ...names: string[]): string[] =>
  values(message, ...names)
    .flatMap((text) => addressParser(text))
    .flatMap((one) => one.group ?? [one])
    .map((one) => one.address.toLowerCase());
const sender = (message: GmailMessage): string => addressesOf(message, "from")[0] ?? "";
const age = (message: GmailMessage, now: Date): number => now.getTime() - message.internalDate;
const recent = (message: GmailMessage, now: Date): boolean => age(message, now) > 0 && age(message, now) < 30 * DAY;
const from = (box: WorldAccount, address: string): GmailMessage[] =>
  box.messages.filter((message) => sender(message) === address);
const byId = (box: WorldAccount, id: string): GmailMessage => {
  const found = box.messages.find((message) => message.id === id);
  if (found === undefined) throw new Error(`no message ${id}`);
  return found;
};
const eventById = (box: WorldAccount, id: string): CalendarEvent => {
  const found = box.events.find((event) => event.id === id);
  if (found === undefined) throw new Error(`no event ${id}`);
  return found;
};
// How many of the world's items, messages and events, hold a text.
const itemsHolding = (w: World, text: string): number =>
  w.accounts
    .flatMap((box) => [...box.messages, ...box.events])
    .filter((item) => JSON.stringify(item).toLowerCase().includes(text.toLowerCase())).length;
const count = (text: string, part: string): number => text.split(part).length - 1;
const startOf = (event: CalendarEvent): number => Date.parse(event.start?.dateTime ?? `${event.start?.date}T00:00:00Z`);

// Every address the world holds: anything shaped like one in any header of any message, and
// every organizer and attendee.
function worldAddresses(w: World): string[] {
  const found: string[] = [];
  for (const box of w.accounts) {
    found.push(box.address);
    for (const message of box.messages)
      for (const header of message.headers) found.push(...(header.value.match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) ?? []));
    for (const event of box.events)
      found.push(
        ...[event.organizer, ...(event.attendees ?? [])].flatMap((one) => (one === undefined ? [] : [one.email])),
      );
  }
  return [...found, ...w.owner.addresses].map((address) => address.toLowerCase());
}
const domainOf = (address: string): string => address.split("@")[1] ?? "";
const reserved = (domain: string): boolean =>
  ["example.com", "example.org"].some((name) => domain === name || domain.endsWith(`.${name}`)) ||
  domain.endsWith(".test");
const unreserved = (w: World): string[] =>
  worldAddresses(w).filter((address) => !reserved(domainOf(address)) && !CALENDAR_DOMAINS.includes(domainOf(address)));

// A local identity port: one entity per exact address, and every owner address the owner.
const ownerEntity = LocalEntityId.parse("ent-owner");
const entityOf = (address: string): LocalEntityId => LocalEntityId.parse(`ent:${address}`);
const identityFor = (owners: string[]): IdentityResolver => ({
  resolve: async (mention) => ({
    outcome: "linked",
    entity: owners.includes(mention.key.value) ? ownerEntity : entityOf(mention.key.value),
    epoch: 0,
  }),
});
const contextFor = (w: World, box: WorldAccount, n: number): ItemContext => ({
  evidenceId: EvidenceId.parse(`ev-world-${box.label}-${n}`),
  revision: 0,
  compartment: box.compartment,
  ownerAddresses: w.owner.addresses,
  ownerEntity,
  identity: identityFor(w.owner.addresses),
});

// One account's mail as the reader would count it, under the shared header rules: an entity's
// direct messages in the last 30 days, and the latest message each entity is on in any role.
async function counted(w: World, box: WorldAccount, now: Date) {
  const direct = new Map<string, number>();
  const latest = new Map<string, { sourceId: string; at: string }>();
  const names = new Map<string, Set<string>>();
  for (const [n, message] of box.messages.entries()) {
    if (message.labelIds.includes("DRAFT")) continue;
    const raw = gmailItem(message, at);
    const facts = await deriveItem(raw, contextFor(w, box, n), PERSONAL_LIMITS);
    if (facts.kind !== "email" || facts.bulk) continue;
    const { record } = facts;
    const outbound = record.direction === "outbound";
    const directly = outbound
      ? (record.sent?.recipients ?? [])
      : facts.roles.filter((one) => one.role === "sender").map((one) => one.entity);
    const since = now.getTime() - Date.parse(record.occurredAt);
    if (since >= 0 && since <= 30 * DAY)
      for (const entity of new Set(directly)) direct.set(entity, (direct.get(entity) ?? 0) + 1);
    for (const entity of new Set([...record.participants, ...(record.sent?.recipients ?? [])])) {
      const known = latest.get(entity);
      if (known === undefined || known.at < record.occurredAt)
        latest.set(entity, { sourceId: `gmail-id:${message.id}`, at: record.occurredAt });
    }
    for (const { entity, name } of facts.names) names.set(entity, (names.get(entity) ?? new Set()).add(name));
  }
  const ranked = [...direct].sort(([, a], [, b]) => b - a);
  return { direct, latest, names, ranked };
}

const NOW_FOR_CONTACTS = new Date("2026-03-10T12:00:00.000Z");

describe("the world", () => {
  it("every world address is on a reserved domain", () => {
    const w = world({ now: NOW });
    expect(worldAddresses(w).length).toBeGreaterThan(500);
    expect(unreserved(w)).toEqual([]);
    for (const address of worldAddresses(w)) expect(CONSUMER_DOMAINS, address).not.toContain(domainOf(address));
    // It skips exactly the three calendar system domains, and the world holds one such address.
    expect(
      worldAddresses(w)
        .filter((address) => CALENDAR_DOMAINS.includes(domainOf(address)))
        .map(domainOf),
    ).toEqual(["group.calendar.google.com"]);
    // The control: a consumer address planted in a header, and one on an event, are found.
    const planted = `planted@${CONSUMER_DOMAINS[0]}`;
    const [personal] = w.accounts as [WorldAccount, WorldAccount];
    const first = personal.messages[0] as GmailMessage;
    const inHeader = {
      ...w,
      accounts: [
        {
          ...personal,
          messages: [{ ...first, headers: [...first.headers, { name: "Cc", value: `Someone <${planted}>` }] }],
        },
      ],
    };
    expect(unreserved(inHeader)).toEqual([planted]);
    const onEvent = {
      ...w,
      accounts: [
        { ...personal, events: [{ id: "evt-planted", status: "confirmed" as const, attendees: [{ email: planted }] }] },
      ],
    };
    expect(unreserved(onEvent)).toEqual([planted]);
  });

  it("the world holds every listed item", () => {
    const w = world({ now: NOW });
    const { handles, canaries } = w;
    expect(w.now).toBe(NOW.toISOString());
    expect(w.accounts.map((box) => [box.label, box.compartment])).toEqual([
      ["personal", "own"],
      ["work", "employer:example"],
    ]);
    const [personal, work] = w.accounts as [WorldAccount, WorldAccount];

    // The owner: both profile addresses, and an alias seen only as the From of a SENT message.
    expect(w.owner.addresses).toEqual([personal.address, work.address, handles.ownerAliasAddress]);
    expect(new Set(w.owner.addresses).size).toBe(3);
    const aliased = w.accounts
      .flatMap((box) => box.messages)
      .filter((message) => JSON.stringify(message).includes(handles.ownerAliasAddress));
    expect(aliased.length).toBeGreaterThan(0);
    for (const message of aliased) {
      expect(sender(message)).toBe(handles.ownerAliasAddress);
      expect(message.labelIds).toContain("SENT");
      expect(count(JSON.stringify(message), handles.ownerAliasAddress)).toBe(1);
    }
    expect(
      w.accounts
        .flatMap((box) => box.events)
        .filter((event) => JSON.stringify(event).includes(handles.ownerAliasAddress)),
    ).toEqual([]);

    const all = w.accounts.flatMap((box) => box.messages);
    expect(new Set(all.map((message) => message.id)).size).toBe(all.length);
    for (const message of all) {
      const date = value(message, "date") ?? "";
      expect(date, message.id).toMatch(
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} \+0000$/,
      );
      const lag = message.internalDate - Date.parse(date);
      expect(lag, message.id).toBeGreaterThanOrEqual(MINUTE);
      expect(lag, message.id).toBeLessThanOrEqual(10 * MINUTE);
    }
    const unnamed = all.filter((message) => value(message, "message-id") === undefined);
    expect(unnamed.map((message) => message.id)).toEqual([handles.noMessageIdMessageId]);
    expect(personal.messages.map((message) => message.id)).toContain(handles.noMessageIdMessageId);
    const ids = all.flatMap((message) => values(message, "message-id"));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^<[^<>\s]+@[^<>\s]+>$/);

    // Two addresses with one display name.
    const named = new Map<string, Set<string>>();
    for (const one of personal.messages
      .flatMap((message) => values(message, "from", "to", "cc", "bcc"))
      .flatMap((text) => addressParser(text))) {
      if (one.name !== "" && one.address !== undefined)
        named.set(one.name, (named.get(one.name) ?? new Set()).add(one.address.toLowerCase()));
    }
    expect([...named.values()].some((addresses) => addresses.size === 2)).toBe(true);

    // Each canary once in each account, in place.
    for (const box of w.accounts) {
      const text = JSON.stringify(box);
      for (const canary of Object.values(canaries)) expect(count(text, canary), `${box.label} ${canary}`).toBe(1);
      const [carrier] = from(box, canaries.address);
      expect(value(carrier as GmailMessage, "from")).toContain(canaries.name);
      expect((carrier as GmailMessage).labelIds).not.toContain("SENT");
      expect(
        box.messages.filter(
          (message) => value(message, "subject") === canaries.subject && sender(message) !== canaries.address,
        ),
      ).toHaveLength(1);
      expect(box.events.filter((event) => event.summary === canaries.eventTitle)).toHaveLength(1);
    }

    // The instruction and its twin: the same headers and time, another sender and a neutral subject.
    const [instruction, twin] = [byId(personal, handles.instructionMessageId), byId(personal, handles.twinMessageId)];
    const rest = (message: GmailMessage) =>
      message.headers.filter((header) => !["from", "subject", "message-id"].includes(header.name.toLowerCase()));
    expect(rest(instruction)).toEqual(rest(twin));
    expect(instruction.internalDate).toBe(twin.internalDate);
    expect(instruction.labelIds).toEqual(twin.labelIds);
    expect(sender(instruction)).not.toBe(sender(twin));
    expect(value(instruction, "subject")).toMatch(/ignore/i);
    expect(value(twin, "subject")).not.toMatch(/ignore|instruction/i);
    for (const message of [instruction, twin]) expect(itemsHolding(w, sender(message))).toBe(1);

    // The 500-recipient sent message, 45 days old.
    const [crowd, ...others] = personal.messages.filter(
      (message) => addressesOf(message, "to", "cc", "bcc").length >= 500,
    );
    expect(others).toEqual([]);
    const wide = crowd as GmailMessage;
    expect(wide.labelIds).toContain("SENT");
    expect([addressesOf(wide, "to").length, addressesOf(wide, "cc").length, addressesOf(wide, "bcc").length]).toEqual([
      200, 200, 100,
    ]);
    expect(new Set(addressesOf(wide, "to", "cc", "bcc")).size).toBe(500);
    expect(Math.floor(age(wide, NOW) / DAY)).toBe(45);

    // The newsletter: a List-Id, and the sender with the most mail in the last 30 days.
    const perSender = new Map<string, number>();
    for (const message of personal.messages.filter((one) => recent(one, NOW)))
      perSender.set(sender(message), (perSender.get(sender(message)) ?? 0) + 1);
    const [[busiest, most] = ["", 0], [, next] = ["", 0]] = [...perSender].sort(([, a], [, b]) => b - a);
    expect([busiest, most]).toEqual([handles.newsletterSender, 15]);
    expect(next).toBeLessThan(15);
    for (const message of from(personal, handles.newsletterSender)) expect(value(message, "list-id")).toBeDefined();

    // The role sender: `team` on an organization domain, 8 recent messages, no list headers.
    expect(handles.roleSender.split("@")[0]).toBe("team");
    expect(organizationDomain(handles.roleSender)).not.toBeNull();
    expect(from(personal, handles.roleSender).filter((message) => recent(message, NOW))).toHaveLength(8);
    for (const message of from(personal, handles.roleSender))
      expect(values(message, "list-id", "list-unsubscribe", "precedence", "auto-submitted")).toEqual([]);

    // An encoded-word name.
    expect(personal.messages.some((message) => (value(message, "from") ?? "").includes("=?"))).toBe(true);

    // The draft, to a person who appears in no other item.
    const draft = byId(personal, handles.draftMessageId);
    expect(draft.labelIds).toContain("DRAFT");
    expect(personal.messages.filter((message) => message.labelIds.includes("DRAFT"))).toHaveLength(1);
    for (const address of addressesOf(draft, "to", "cc", "bcc")) expect(itemsHolding(w, address)).toBe(1);

    // A message 31 days old, a trashed and a spam message, and five older than 90 days.
    expect(personal.messages.some((message) => Math.floor(age(message, NOW) / DAY) === 31)).toBe(true);
    expect(personal.messages.some((message) => message.labelIds.includes("TRASH"))).toBe(true);
    expect(personal.messages.some((message) => message.labelIds.includes("SPAM"))).toBe(true);
    expect(personal.messages.filter((message) => age(message, NOW) > 90 * DAY).length).toBeGreaterThanOrEqual(5);

    // The last 30 days: the top contact, the runner-up, and what the owner sent.
    const owners = w.owner.addresses;
    const withPerson = (address: string) => {
      const inbound = from(personal, address);
      const outbound = personal.messages.filter(
        (message) =>
          owners.includes(sender(message)) &&
          message.labelIds.includes("SENT") &&
          addressesOf(message, "to", "cc", "bcc").includes(address),
      );
      return { inbound, outbound };
    };
    const top = withPerson(handles.topContactAddress);
    expect([
      top.inbound.filter((one) => recent(one, NOW)).length,
      top.outbound.filter((one) => recent(one, NOW)).length,
    ]).toEqual([5, 2]);
    expect(top.outbound.filter((message) => sender(message) === handles.ownerAliasAddress)).toHaveLength(1);
    const runner = withPerson(handles.runnerUpAddress);
    expect([
      runner.inbound.filter((one) => recent(one, NOW)).length,
      runner.outbound.filter((one) => recent(one, NOW)).length,
    ]).toEqual([4, 2]);
    // The runner-up's Social message is apart from these.
    const older = [...runner.inbound, ...runner.outbound]
      .filter((message) => message.id !== handles.socialKeptMessageId)
      .map((message) => age(message, NOW) / DAY)
      .filter((days) => days > 30);
    expect(older.filter((days) => Math.floor(days) === 31)).toHaveLength(1);
    expect(older.filter((days) => days > 40 && days < 80)).toHaveLength(3);
    expect(older).toHaveLength(4);
    expect(
      personal.messages.filter((message) => recent(message, NOW) && owners.includes(sender(message))).length,
    ).toBeLessThan(15);
    // Every message the owner sent carries SENT: no other counts as outbound. The draft is not
    // sent. The one exception is the forged message: inbound, with an owner address in From.
    const fromOwner = all.filter(
      (message) =>
        owners.includes(sender(message)) &&
        !message.labelIds.includes("DRAFT") &&
        message.id !== handles.forgedOwnerMessageId,
    );
    expect(fromOwner.length).toBeGreaterThan(5);
    for (const message of fromOwner) expect(message.labelIds, message.id).toContain("SENT");

    // The last-interaction person: one message of their own about 20 days ago, and on Cc of the
    // top contact's five inbound messages and the runner-up's four.
    const own = from(personal, handles.lastInteractionAddress);
    expect(own).toHaveLength(1);
    expect(Math.round(age(own[0] as GmailMessage, NOW) / DAY)).toBe(20);
    const copied = personal.messages.filter((message) =>
      addressesOf(message, "cc").includes(handles.lastInteractionAddress),
    );
    expect(copied).toHaveLength(9);
    expect(copied.filter((message) => sender(message) === handles.topContactAddress)).toHaveLength(5);
    expect(copied.filter((message) => sender(message) === handles.runnerUpAddress)).toHaveLength(4);
    for (const message of copied) expect(recent(message, NOW)).toBe(true);
    const latest = copied.reduce((a, b) => (a.internalDate > b.internalDate ? a : b));
    // An item is known by its Gmail id, never by its Message-ID header.
    expect(`gmail-id:${latest.id}`).toBe(w.expected.lastInteraction.sourceId);
    expect(new Date(value(latest, "date") ?? "").toISOString()).toBe(w.expected.lastInteraction.at);
    expect(w.expected.lastInteraction.address).toBe(handles.lastInteractionAddress);
    expect(value(own[0] as GmailMessage, "from")).toContain(w.expected.lastInteraction.name);
    // The top contact and the runner-up are co-recipients nowhere: only the owner writes to them.
    for (const address of [handles.topContactAddress, handles.runnerUpAddress]) {
      for (const message of personal.messages.filter((one) => addressesOf(one, "to", "cc", "bcc").includes(address)))
        expect(owners, message.id).toContain(sender(message));
    }

    // The message to delete later, from a person seen in that one message only.
    expect(personal.deleteLater).toHaveLength(1);
    const doomed = byId(personal, personal.deleteLater[0] as string);
    expect(sender(doomed)).toBe(handles.oneMessageSenderAddress);
    expect(itemsHolding(w, handles.oneMessageSenderAddress)).toBe(1);
    expect(work.deleteLater).toEqual([]);

    // The personal events, placed relative to now.
    const offsets = (id: string): number[] => {
      const event = eventById(personal, id);
      return [
        (Date.parse(event.start?.dateTime ?? "") - NOW.getTime()) / HOUR,
        (Date.parse(event.end?.dateTime ?? "") - NOW.getTime()) / HOUR,
      ];
    };
    const allDay = personal.events.filter((event) => event.start?.date !== undefined);
    expect(allDay.map((event) => [event.start, event.end])).toEqual([[{ date: "2026-03-11" }, { date: "2026-03-12" }]]);
    expect(
      personal.events
        .filter(
          (event) => !isBareCancellation(event) && Date.parse(event.start?.dateTime ?? "") === NOW.getTime() - 2 * HOUR,
        )
        .map((event) => offsets(event.id)),
    ).toEqual([[-2, 2]]);
    const starts = personal.events
      .filter((event) => event.start?.dateTime !== undefined)
      .map((event) => (startOf(event) - NOW.getTime()) / HOUR);
    for (const weekly of [-138, 30, 198]) expect(starts, String(weekly)).toContain(weekly);
    const cancelled = eventById(personal, handles.cancelledEventId);
    expect([
      cancelled.status,
      offsets(cancelled.id)[0],
      cancelled.summary !== undefined,
      (cancelled.attendees ?? []).length > 0,
    ]).toEqual(["cancelled", 48, true, true]);
    const invited = personal.events.filter((event) => offsets(event.id)[0] === 72);
    expect(invited).toHaveLength(1);
    expect(
      readEvent(invited[0] as CalendarEvent, owners)
        .participants.filter((one) => one.owner)
        .map((one) => one.role),
    ).toEqual(["attendee"]);
    const roomed = personal.events.filter((event) => offsets(event.id)[0] === 96);
    expect(roomed).toHaveLength(1);
    expect((roomed[0] as CalendarEvent).attendees?.some((one) => one.resource === true)).toBe(true);
    expect(
      (roomed[0] as CalendarEvent).attendees?.some((one) => domainOf(one.email) === "group.calendar.google.com"),
    ).toBe(true);
    expect(offsets(personal.events.find((event) => event.summary === canaries.eventTitle)?.id ?? "")[0]).toBe(120);
    const eightDay = eventById(personal, handles.eightDayEventId);
    expect(offsets(eightDay.id)[0]).toBe(192);
    expect(readEvent(eightDay, owners).participants.map((one) => [one.person.address, one.role, one.owner])).toEqual([
      [personal.address, "organizer", true],
      [handles.runnerUpAddress, "attendee", false],
    ]);
    expect(personal.events.filter(isBareCancellation)).toHaveLength(1);
    // Every event but the bare cancellation has a fixed etag and an updated before now.
    for (const event of w.accounts.flatMap((box) => box.events)) {
      if (isBareCancellation(event)) {
        expect(Object.keys(event).sort()).toEqual(["id", "status"]);
        continue;
      }
      expect(event.etag, event.id).toMatch(/\S/);
      expect(Date.parse(event.updated ?? ""), event.id).toBeLessThan(NOW.getTime());
    }
    const eventIds = w.accounts.flatMap((box) => box.events).map((event) => event.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);

    // The work account: its own mail and events, one person shared with personal, one not.
    expect(work.messages.length).toBeGreaterThan(0);
    expect(work.events.length).toBeGreaterThan(0);
    // The message that names the work-only address in its body is left out: no header of
    // the personal account holds that address, so no personal person is made from it.
    const inPersonal = (address: string): boolean =>
      JSON.stringify({
        ...personal,
        messages: personal.messages.filter((message) => message.id !== handles.namesWorkOnlyMessageId),
      })
        .toLowerCase()
        .includes(address);
    const workPeople = [
      ...new Set(work.messages.flatMap((message) => addressesOf(message, "from", "to", "cc", "bcc"))),
    ].filter((address) => !owners.includes(address) && address !== canaries.address);
    expect(workPeople.some(inPersonal)).toBe(true);
    expect(inPersonal(handles.workOnlyAddress)).toBe(false);
    expect(workPeople).toContain(handles.workOnlyAddress);

    // A body for every message but the draft: plain text unless said otherwise.
    for (const message of all)
      expect(message.text !== undefined || message.html !== undefined, message.id).toBe(
        !message.labelIds.includes("DRAFT"),
      );
    const withHtml = all.filter((message) => message.html !== undefined).map((message) => message.id);
    expect(withHtml.sort()).toEqual(
      [
        handles.receiptMessageId,
        handles.htmlOnlyMessageId,
        handles.deepHtmlMessageId,
        ...work.messages.filter((message) => message.attachments !== undefined).map((message) => message.id),
      ].sort(),
    );
    // The receipt, in each account: Updates, an organization's sender, both text forms, the
    // body canary in its text and the attachment canary its one attachment.
    for (const carrier of w.accounts.map(
      (one) => one.messages.find((message) => message.attachments !== undefined) as GmailMessage,
    )) {
      expect(carrier.labelIds).toContain("CATEGORY_UPDATES");
      expect(organizationDomain(sender(carrier))).not.toBeNull();
      expect([
        carrier.text?.includes(canaries.body),
        carrier.html?.includes(canaries.body),
        carrier.attachments?.map((one) => one.name),
      ]).toEqual([true, false, [canaries.attachmentName]]);
    }
    const receipt = byId(personal, handles.receiptMessageId);
    expect(sender(receipt)).toBe(handles.receiptSender);
    expect(itemsHolding(w, handles.receiptSender)).toBe(1);
    // HTML with no plain part, and HTML deeper than the shared htmlDepth with none.
    const htmlOnly = byId(personal, handles.htmlOnlyMessageId);
    expect([htmlOnly.text, htmlOnly.html !== undefined]).toEqual([undefined, true]);
    const deep = byId(personal, handles.deepHtmlMessageId);
    expect([deep.text, count(deep.html ?? "", "<div>") > PERSONAL_LIMITS.htmlDepth]).toEqual([undefined, true]);
    // A body that holds an instruction, and its twin.
    const [bodyInstruction, bodyTwin] = [
      byId(personal, handles.bodyInstructionMessageId),
      byId(personal, handles.bodyTwinMessageId),
    ];
    expect(rest(bodyInstruction)).toEqual(rest(bodyTwin));
    expect(value(bodyInstruction, "subject")).toBe(value(bodyTwin, "subject"));
    expect([bodyInstruction.internalDate, bodyInstruction.labelIds]).toEqual([
      bodyTwin.internalDate,
      bodyTwin.labelIds,
    ]);
    expect(bodyInstruction.text).toMatch(/ignore all previous instructions/i);
    expect(bodyTwin.text).not.toMatch(/ignore|instruction/i);
    for (const message of [bodyInstruction, bodyTwin]) expect(itemsHolding(w, sender(message))).toBe(1);
    // Who the owner has written to, from the personal account, and the threads the owner posted in.
    const sentMail = personal.messages.filter(
      (message) => message.labelIds.includes("SENT") && !message.labelIds.includes("SPAM"),
    );
    const writtenTo = new Set(sentMail.flatMap((message) => addressesOf(message, "to", "cc", "bcc")));
    const postedIn = new Set(sentMail.map((message) => message.threadId));
    // A promotion and a spam message received, and a promotion the owner sent.
    expect(
      personal.messages.filter(
        (message) => message.labelIds.includes("CATEGORY_PROMOTIONS") && !message.labelIds.includes("SENT"),
      ),
    ).toHaveLength(1);
    expect(
      personal.messages.filter((message) => message.labelIds.includes("SPAM") && !message.labelIds.includes("SENT")),
    ).toHaveLength(1);
    const sentPromotion = byId(personal, handles.sentPromotionMessageId);
    expect([sentPromotion.labelIds, owners.includes(sender(sentPromotion))]).toEqual([
      ["SENT", "CATEGORY_PROMOTIONS"],
      true,
    ]);
    // Social: the runner-up's, written to, between 30 and 90 days old; a stranger's.
    const socialKept = byId(personal, handles.socialKeptMessageId);
    expect([
      socialKept.labelIds.includes("CATEGORY_SOCIAL"),
      sender(socialKept),
      writtenTo.has(sender(socialKept)),
    ]).toEqual([true, handles.runnerUpAddress, true]);
    expect(age(socialKept, NOW) > 30 * DAY && age(socialKept, NOW) < 90 * DAY).toBe(true);
    const socialLeftOut = byId(personal, handles.socialLeftOutMessageId);
    expect([
      socialLeftOut.labelIds.includes("CATEGORY_SOCIAL"),
      writtenTo.has(sender(socialLeftOut)),
      postedIn.has(socialLeftOut.threadId),
    ]).toEqual([true, false, false]);
    // Forums: one in a thread the owner posted in, from a sender never written to, with a
    // List-Id; one in another thread.
    const forumsKept = byId(personal, handles.forumsKeptMessageId);
    expect([
      forumsKept.labelIds.includes("CATEGORY_FORUMS"),
      writtenTo.has(sender(forumsKept)),
      postedIn.has(forumsKept.threadId),
      value(forumsKept, "list-id") !== undefined,
    ]).toEqual([true, false, true, true]);
    const forumsLeftOut = byId(personal, handles.forumsLeftOutMessageId);
    expect([
      forumsLeftOut.labelIds.includes("CATEGORY_FORUMS"),
      writtenTo.has(sender(forumsLeftOut)),
      postedIn.has(forumsLeftOut.threadId),
    ]).toEqual([true, false, false]);
    // Under SENT and SPAM: From the owner, to one person who appears nowhere else.
    const sentSpam = byId(personal, handles.sentSpamMessageId);
    expect([sentSpam.labelIds, sender(sentSpam)]).toEqual([["SENT", "SPAM"], personal.address]);
    expect(addressesOf(sentSpam, "to", "cc", "bcc")).toHaveLength(1);
    expect(itemsHolding(w, addressesOf(sentSpam, "to")[0] as string)).toBe(1);
    // For a test to mark too large: a person seen in this message only, older than 30 days.
    const tooLarge = byId(personal, handles.tooLargeMessageId);
    expect([itemsHolding(w, sender(tooLarge)), age(tooLarge, NOW) > 30 * DAY, tooLarge.text !== undefined]).toEqual([
      1,
      true,
      true,
    ]);
    // The held message: Updates, older than 30 days, from a no-reply address on an organization
    // domain seen nowhere else, a recovery term in its subject and a six-digit code in its text.
    const held = byId(personal, handles.heldMessageId);
    expect([
      held.labelIds.includes("CATEGORY_UPDATES"),
      age(held, NOW) > 30 * DAY,
      sender(held).split("@")[0],
      organizationDomain(sender(held)) !== null,
      itemsHolding(w, sender(held)),
    ]).toEqual([true, true, "no-reply", true, 1]);
    expect(value(held, "subject")).toMatch(/verification code/i);
    expect(held.text).toMatch(/\b\d{6}\b/);
    // No other message has a sender whose local part is on the hold's list.
    const onList = all.filter((message) =>
      (RECOVERY_MARKERS.senders as readonly string[]).includes(sender(message).split("@")[0]?.split("+")[0] ?? ""),
    );
    expect(onList.map((message) => message.id)).toEqual([handles.heldMessageId]);
  });

  it("exactly one world message is held", async () => {
    const w = world({ now: NOW });
    const held: string[] = [];
    for (const box of w.accounts) {
      for (const [n, message] of box.messages.entries()) {
        if (message.labelIds.includes("DRAFT")) continue;
        const facts = await deriveItem(gmailItem(message, at), contextFor(w, box, n), PERSONAL_LIMITS);
        if (facts.kind === "email" && facts.message.held) held.push(message.id);
      }
    }
    expect(held).toEqual([w.handles.heldMessageId]);
    // Held, and bulk: it changes no expected answer.
    const [personal] = w.accounts as [WorldAccount];
    const facts = await deriveItem(
      gmailItem(byId(personal, w.handles.heldMessageId), at),
      contextFor(w, personal, 0),
      PERSONAL_LIMITS,
    );
    expect(facts.kind === "email" && facts.bulk).toBe(true);
  });

  it("the world's bodies and attachment names are on reserved domains and hold no real name", () => {
    const w = world({ now: NOW });
    const texts = (box: WorldAccount): string[] =>
      box.messages.flatMap((message) => [
        message.text ?? "",
        message.html ?? "",
        ...(message.attachments ?? []).map((one) => one.name),
      ]);
    const hosts = (text: string): string[] => [
      ...(text.match(/[^\s<>"(),;:]+@[^\s<>"(),;:]+/g) ?? []).map((one) => domainOf(one.replace(/[.]$/, ""))),
      ...[...text.matchAll(/https?:\/\/([^/\s"<>]+)/g)].map((one) => one[1] as string),
    ];
    // Every display name the world's headers give: the only names a body may hold.
    const names = new Set(
      w.accounts.flatMap((box) =>
        box.messages.flatMap((message) =>
          values(message, "from", "to", "cc", "bcc")
            .flatMap((text) => addressParser(text))
            .map((one) => one.name),
        ),
      ),
    );
    const people = (text: string): string[] =>
      (text.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) ?? []).filter((one) => !names.has(one));
    const all = w.accounts.flatMap(texts);
    expect(all.flatMap(hosts).length).toBeGreaterThan(2);
    for (const host of all.flatMap(hosts)) expect(reserved(host), host).toBe(true);
    expect(all.flatMap(people)).toEqual([]);
    // The controls: a consumer address, a real-looking host and a name, each planted in a body, are found.
    const planted = `Write to someone@${CONSUMER_DOMAINS[0]} or see https://www.${CONSUMER_DOMAINS[1]}/x, from Jane Doe`;
    expect(hosts(planted).filter((host) => !reserved(host))).toHaveLength(2);
    expect(people(planted)).toEqual(["Jane Doe"]);
  });

  it("every world message parses with the shared parse", async () => {
    const w = world({ now: NOW });
    for (const box of w.accounts) {
      for (const [n, message] of box.messages.entries()) {
        const raw = gmailItem(message, at);
        const item = pipelineItemOf(raw, contextFor(w, box, n));
        // The one message whose HTML the shared parse refuses parses by its headers.
        const deep = message.id === w.handles.deepHtmlMessageId;
        if (deep)
          await expect(parse(item, bytes(raw), PERSONAL_LIMITS)).rejects.toMatchObject({ code: "parse_failed" });
        const parsed = await parse(item, deep ? headersOnly(bytes(raw)) : bytes(raw), PERSONAL_LIMITS);
        expect(parsed.headers.from, message.id).toEqual([sender(message)]);
        expect(parsed.headers.date, message.id).toEqual([new Date(value(message, "date") ?? "").toISOString()]);
        // Only the newsletter, the role sender, the Forums list message and the held message's
        // no-reply sender are automated by the shared rule.
        const forums = sender(byId(w.accounts[0] as WorldAccount, w.handles.forumsKeptMessageId));
        const held = sender(byId(w.accounts[0] as WorldAccount, w.handles.heldMessageId));
        const automated = [w.handles.newsletterSender, w.handles.roleSender, forums, held].includes(sender(message));
        expect(parsed.automated, message.id).toBe(automated);
      }
    }
  });

  it("the expected answers match a count over the items under the shared rules, and the runner-up is strictly behind", async () => {
    for (const now of NOWS) {
      const w = world({ now });
      const { handles, expected } = w;
      const [personal, work] = w.accounts as [WorldAccount, WorldAccount];
      const own = await counted(w, personal, now);

      // The top contact, with the runner-up strictly behind and everyone else behind both.
      const [[first, most] = ["", 0], [second, next] = ["", 0], [, third] = ["", 0]] = own.ranked;
      expect([first, most], now.toISOString()).toEqual([entityOf(expected.topContact30d), 7]);
      expect([second, next]).toEqual([entityOf(handles.runnerUpAddress), 6]);
      expect(third).toBeLessThan(6);
      expect(expected.topContact30d).toBe(handles.topContactAddress);
      // Bulk senders count for nothing, and a Cc row is not direct.
      expect(own.direct.has(entityOf(handles.newsletterSender))).toBe(false);
      expect(own.direct.has(entityOf(handles.roleSender))).toBe(false);
      expect(own.direct.get(entityOf(handles.lastInteractionAddress))).toBe(1);
      // A count that crosses compartments gives another answer.
      expect((await counted(w, work, now)).direct.get(entityOf(handles.workOnlyAddress))).toBe(9);
      expect(own.direct.has(entityOf(handles.workOnlyAddress))).toBe(false);

      // The last interaction: the latest message the person is on, in any role.
      expect(own.latest.get(entityOf(expected.lastInteraction.address))).toEqual({
        sourceId: expected.lastInteraction.sourceId,
        at: expected.lastInteraction.at,
      });
      expect([...(own.names.get(entityOf(expected.lastInteraction.address)) ?? [])]).toEqual([
        expected.lastInteraction.name,
      ]);

      // Upcoming: events that end after now and start within seven days, cancelled ones left out.
      const upcoming = personal.events
        .filter((event) => !isBareCancellation(event))
        .map((event) => readEvent(event, w.owner.addresses))
        .filter((facts) => !facts.cancelled && facts.startsAt !== null && facts.endsAt !== null)
        .filter(
          (facts) =>
            Date.parse(facts.endsAt as string) > now.getTime() &&
            Date.parse(facts.startsAt as string) < now.getTime() + 7 * DAY,
        )
        .sort(
          (a, b) => (a.startsAt as string).localeCompare(b.startsAt as string) || a.sourceId.localeCompare(b.sourceId),
        );
      expect(
        upcoming.map((facts) => facts.sourceId),
        now.toISOString(),
      ).toEqual(expected.upcoming);
      // And who each is with: its participants besides the owner, the organizer included.
      expect(
        upcoming.map((facts) => facts.participants.filter((one) => !one.owner).map((one) => one.person.address)),
      ).toEqual(expected.upcomingWith);
      expect(expected.upcomingWith).toHaveLength(expected.upcoming.length);
      expect(expected.upcomingWith.flat()).toHaveLength(5);
      expect(expected.upcoming).toHaveLength(6);
      expect(expected.upcoming).not.toContain(handles.cancelledEventId);
      expect(expected.upcoming).not.toContain(handles.eightDayEventId);
    }
  });

  it("no time is within an hour of a window edge", () => {
    for (const now of NOWS) {
      const w = world({ now });
      const edges = [0, -30 * DAY, -90 * DAY, 7 * DAY].map((offset) => now.getTime() + offset);
      const times: [string, number][] = [];
      for (const box of w.accounts) {
        for (const message of box.messages)
          times.push([message.id, message.internalDate], [message.id, Date.parse(value(message, "date") ?? "")]);
        for (const event of box.events) {
          for (const time of [event.start, event.end]) {
            if (time?.dateTime !== undefined) times.push([event.id, Date.parse(time.dateTime)]);
            if (time?.date !== undefined) times.push([event.id, Date.parse(`${time.date}T00:00:00Z`)]);
          }
          if (event.updated !== undefined) times.push([event.id, Date.parse(event.updated)]);
        }
      }
      expect(times.length).toBeGreaterThan(100);
      for (const [id, time] of times) {
        expect(Number.isNaN(time), id).toBe(false);
        for (const edge of edges) expect(Math.abs(time - edge), `${id} at ${now.toISOString()}`).toBeGreaterThan(HOUR);
      }
    }
    // The all-day event is tomorrow, or a day later when now is at or after 23:00 UTC.
    const allDayStart = (now: string): string | undefined =>
      world({ now: new Date(now) }).accounts[0]?.events.find((event) => event.start?.date !== undefined)?.start?.date;
    expect(allDayStart("2026-03-10T22:59:59.000Z")).toBe("2026-03-11");
    expect(allDayStart("2026-03-10T23:00:00.000Z")).toBe("2026-03-12");
  });

  it("every message time and the expected last interaction are on a whole second", () => {
    for (const now of NOWS) {
      const w = world({ now });
      // The world's own now keeps its milliseconds.
      expect(w.now).toBe(now.toISOString());
      const messages = w.accounts.flatMap((box) => box.messages);
      for (const message of messages) expect(message.internalDate % 1000, message.id).toBe(0);
      // A Date header holds no milliseconds, so the expected time must hold none either.
      expect(w.expected.lastInteraction.at, now.toISOString()).toMatch(/\.000Z$/);
      const named = messages.find((message) => `gmail-id:${message.id}` === w.expected.lastInteraction.sourceId);
      expect(new Date(value(named as GmailMessage, "date") ?? "").toISOString(), now.toISOString()).toBe(
        w.expected.lastInteraction.at,
      );
    }
  });

  // Extraction's planted facts and recorded model outputs.

  it("every recorded output's span is a segment of its message", async () => {
    const w = world({ now: NOW });
    let checked = 0;
    for (const box of w.accounts) {
      for (const [n, message] of box.messages.entries()) {
        const output = w.modelOutputs[message.id];
        if (typeof output !== "object" || output === null) continue;
        const raw = gmailItem(message, at);
        const parsed = await parse(pipelineItemOf(raw, contextFor(w, box, n)), bytes(raw), PERSONAL_LIMITS);
        for (const claim of (output as { claims: { span: string }[] }).claims) {
          expect(segmentAt(parsed, claim.span), `${message.id} ${claim.span}`).toBeDefined();
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

  it("every expected text value is in its message's own words", () => {
    const w = world({ now: NOW });
    const messages = w.accounts.flatMap((box) => box.messages);
    const facts = [...w.expected.facts.own, ...w.expected.facts.both];
    expect(facts.length).toBeGreaterThan(8);
    for (const fact of facts) {
      const message = messages.find((one) => one.id === fact.gmailId) as GmailMessage;
      const words = `${value(message, "subject") ?? ""}\n${message.text ?? ""}`;
      for (const name of ["merchant", "order_ref", "what"]) {
        const text = fact.fields[name];
        if (text !== undefined) expect(words, `${fact.gmailId} ${name}`).toContain(String(text));
      }
    }
  });

  it("every recorded output but the two the schema refuses and the cut-off string passes the shared InterpreterOutput", () => {
    const w = world({ now: NOW });
    const { handles } = w;
    const refused = [handles.reservedKeyMessageId, handles.unknownKeyMessageId];
    expect(w.modelOutputs[handles.cutOffMessageId]).toBe(REJECTED_LENGTH);
    for (const [id, output] of Object.entries(w.modelOutputs)) {
      if (id === handles.cutOffMessageId) continue;
      expect(InterpreterOutput.safeParse(output).success, id).toBe(!refused.includes(id));
    }
  });

  it("every recorded output's mentions carry their message's date as observedAt", () => {
    const w = world({ now: NOW });
    const messages = w.accounts.flatMap((box) => box.messages);
    let mentions = 0;
    for (const [id, output] of Object.entries(w.modelOutputs)) {
      if (typeof output !== "object" || output === null) continue;
      const message = messages.find((one) => one.id === id) as GmailMessage;
      const date = new Date(value(message, "date") ?? "").toISOString();
      for (const claim of (output as { claims: { subject: { observedAt: string }; fields: Record<string, unknown> }[] })
        .claims) {
        const found = [
          claim.subject,
          ...Object.values(claim.fields).filter(
            (field): field is { observedAt: string } =>
              typeof field === "object" && field !== null && "observedAt" in field,
          ),
        ];
        for (const mention of found) expect(mention.observedAt, id).toBe(date);
        mentions += found.length;
      }
    }
    expect(mentions).toBeGreaterThan(20);
  });

  it("no planted message holds a recovery term, and no planted sender's local part is on the recovery list", () => {
    const w = world({ now: NOW });
    const planted = Object.keys(w.expected.items);
    expect(planted.length).toBeGreaterThan(20);
    const messages = w.accounts.flatMap((box) => box.messages);
    for (const id of planted) {
      const message = messages.find((one) => one.id === id) as GmailMessage;
      expect(
        recoveryHold({
          subject: value(message, "subject") ?? null,
          sender: sender(message),
          text: message.text ?? null,
        }),
        id,
      ).toBe(false);
      expect(RECOVERY_MARKERS.senders as readonly string[], id).not.toContain(sender(message).split("@")[0]);
    }
    // The control: the held message holds one.
    const held = messages.find((one) => one.id === w.handles.heldMessageId) as GmailMessage;
    expect(
      recoveryHold({ subject: value(held, "subject") ?? null, sender: sender(held), text: held.text ?? null }),
    ).toBe(true);
  });

  it("the held message has no recorded output and no expected fact", () => {
    const w = world({ now: NOW });
    const held = w.handles.heldMessageId;
    expect(Object.hasOwn(w.modelOutputs, held)).toBe(false);
    expect(Object.hasOwn(w.expected.items, held)).toBe(false);
    expect([...w.expected.facts.own, ...w.expected.facts.both].some((fact) => fact.gmailId === held)).toBe(false);
    // The control: the message beside it has an output.
    expect(Object.hasOwn(w.modelOutputs, w.handles.receiptMessageId)).toBe(true);
  });

  it("the forged message is inbound and not bulk", async () => {
    const w = world({ now: NOW });
    const [personal] = w.accounts as [WorldAccount];
    const forged = byId(personal, w.handles.forgedOwnerMessageId);
    expect(w.owner.addresses).toContain(sender(forged));
    expect(forged.labelIds).not.toContain("SENT");
    const facts = await deriveItem(gmailItem(forged, at), contextFor(w, personal, 0), PERSONAL_LIMITS);
    if (facts.kind !== "email" || facts.bulk) throw new Error("not a person's email");
    expect(facts.record.direction).toBe("inbound");
  });

  it("the world's expected facts, given ids, parse as a FactList", () => {
    const w = world({ now: NOW });
    const ENTITY = "ent_01JABCDEFGHJKMNPQRSTVWXYZ0";
    const who = (address: string) => ({
      id: ENTITY,
      kind: w.owner.addresses.includes(address) ? "owner" : "person",
      name: null,
      address: { untrusted: address },
    });
    const ENTITIES = ["counterparty", "organization"];
    const TEXTS = ["merchant", "order_ref", "what", "title", "organization_name"];
    // An organization is written as its domain.
    const entity = (name: string, value: string) =>
      name === "organization"
        ? { id: ENTITY, kind: "organization", name: null, address: { untrusted: value } }
        : who(value);
    // An owner-side kind's key phrase is served as its `what` (the world's are version 4's).
    const served = (fact: WorldFact, name: string) =>
      Object.hasOwn(KEY_FIELDS, fact.type) && KEY_FIELDS[fact.type as OwnerSideKind].phrase === name ? "what" : name;
    const view = (fact: WorldFact, n: number) => ({
      id: n.toString(16).padStart(64, "0"),
      type: fact.type,
      subject: who(fact.subject),
      statedBy: fact.statedBy === null ? null : who(fact.statedBy),
      basis: fact.basis,
      statementKind: fact.statementKind,
      at: w.now,
      message: "msg_01JABCDEFGHJKMNPQRSTVWXYZ0",
      document: null,
      passage: null,
      page: null,
      capture: null,
      segment: null,
      thirdParty: fact.thirdParty,
      agentReported: false,
      provenance: "source",
      ...(fact.status === undefined ? {} : { status: fact.status }),
      fields: Object.fromEntries(
        Object.entries(fact.fields).map(([name, field]) => [
          served(fact, name),
          ENTITIES.includes(name)
            ? entity(name, String(field))
            : TEXTS.includes(served(fact, name))
              ? { untrusted: String(field) }
              : field,
        ]),
      ),
    });
    for (const list of [w.expected.facts.own, w.expected.facts.both]) {
      const parsed = FactList.safeParse({ facts: list.map(view), more: false });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    // Newest first, and the client cleared for both sees every fact the own client sees.
    const messages = w.accounts.flatMap((box) => box.messages);
    const sentAt = (fact: WorldFact): number =>
      (messages.find((one) => one.id === fact.gmailId) as GmailMessage).internalDate;
    for (const list of [w.expected.facts.own, w.expected.facts.both]) {
      for (let n = 1; n < list.length; n += 1)
        expect(sentAt(list[n - 1] as WorldFact)).toBeGreaterThanOrEqual(sentAt(list[n] as WorldFact));
    }
    for (const fact of w.expected.facts.own) expect(w.expected.facts.both).toContainEqual(fact);
    expect(w.expected.facts.both.length).toBeGreaterThan(w.expected.facts.own.length);
  });

  it("worldModelOutputs gives each output under the evidence id of its message, for each revision asked", () => {
    const w = world({ now: NOW });
    const accounts = {
      personal: SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ1"),
      work: SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ2"),
    };
    const once = worldModelOutputs(w, accounts);
    expect(Object.keys(once)).toHaveLength(Object.keys(w.modelOutputs).length);
    const twice = worldModelOutputs(w, accounts, [0, 3]);
    expect(Object.keys(twice)).toHaveLength(2 * Object.keys(w.modelOutputs).length);
    for (const box of w.accounts) {
      for (const message of box.messages) {
        if (!Object.hasOwn(w.modelOutputs, message.id)) continue;
        for (const revision of [0, 3]) {
          const id = evidenceIdFor({
            vault: "personal",
            sourceAccount: accounts[box.label as "personal" | "work"],
            sourceItemId: `gmail-id:${message.id}`,
            revision,
          });
          expect(twice[id], `${message.id} ${revision}`).toEqual(w.modelOutputs[message.id]);
          if (revision === 0) expect(once[id]).toEqual(w.modelOutputs[message.id]);
        }
      }
    }
  });

  it("each expected fact names a planted message with a recorded output, and the world plants a role, affiliation, relationship, need, capability, contact rule, goal and preference", () => {
    const w = world({ now: NOW });
    for (const fact of w.expected.facts.both)
      expect(Object.hasOwn(w.modelOutputs, fact.gmailId), fact.gmailId).toBe(true);
    const types = new Set(w.expected.facts.both.map((fact) => fact.type));
    for (const type of [
      "role",
      "affiliation",
      "relationship",
      "need",
      "capability",
      "contact_rule",
      "goal",
      "preference",
    ])
      expect(types.has(type as never), type).toBe(true);
    // A role's key holds its title, so the two titles are two active beliefs and none is disputed;
    // the third party's relationship has no status.
    expect(w.expected.facts.both.some((fact) => fact.disputed === true || fact.sharesBeliefWith !== undefined)).toBe(
      false,
    );
    const titles = w.expected.facts.both.filter(
      (fact) => fact.gmailId === w.handles.firstTitleMessageId || fact.gmailId === w.handles.secondTitleMessageId,
    );
    expect(titles.map((fact) => fact.status)).toEqual(["active", "active"]);
    expect(
      w.expected.facts.both.find((fact) => fact.gmailId === w.handles.reportedRelationshipMessageId)?.status,
    ).toBeUndefined();
    // The owner's own goal and preference each build a belief.
    expect(
      w.expected.facts.both
        .filter((fact) => fact.type === "goal" || fact.type === "preference")
        .map((fact) => fact.status),
    ).toEqual(["active", "active"]);
    // The candidate with a domain its passage does not name is planted with no expected fact.
    expect(w.expected.facts.both.some((fact) => fact.gmailId === w.handles.unnamedDomainMessageId)).toBe(false);
    expect(w.expected.items[w.handles.unnamedDomainMessageId]).toEqual({ status: "done" });
  });

  it("two worlds built at one now are deep-equal", () => {
    const [a, b] = [world({ now: NOW }), world({ now: new Date(NOW.getTime()) })];
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Each is a fresh copy: changing one changes no other.
    a.accounts[0]?.messages.pop();
    expect(world({ now: NOW })).toEqual(b);
    // Every time moves with now.
    const later = world({ now: new Date(NOW.getTime() + 3 * DAY) });
    expect(later.accounts[0]?.messages[0]?.internalDate).toBe(
      (b.accounts[0]?.messages[0]?.internalDate ?? 0) + 3 * DAY,
    );
    expect(later.expected.upcoming).toEqual(b.expected.upcoming);
  });

  // Contacts and identity, n1.4.
  it("the world's contacts parse with whitelistedContact", () => {
    const w = world({ now: NOW_FOR_CONTACTS });
    const [personal, work] = w.accounts as [WorldAccount, WorldAccount];
    const sourceAccount = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
    const kept = (box: WorldAccount) =>
      box.contacts.map((person) => {
        const read = whitelistedContact(person);
        expect(read, JSON.stringify(person).slice(0, 40)).not.toBeNull();
        return contactKept(
          contactItem(read!, { sourceAccount, changeKind: "backfill", now: w.now }),
          w.owner.addresses,
        );
      });
    // The contact with no address, and the owner's own, are the two never stored.
    expect(
      kept(personal)
        .filter((one) => one !== "keep")
        .sort(),
    ).toEqual(["no_address", "own_contact"]);
    expect(kept(work).every((one) => one === "keep")).toBe(true);
    const text = JSON.stringify(w.accounts.map((box) => box.contacts));
    for (const [, domain] of text.matchAll(/@([a-z0-9.-]+)"/g))
      expect(domain, domain).toMatch(/(\.test|example\.(com|org|net))$/);
    for (const [phone] of text.matchAll(/"value":"[^"@]*\d{3}[^"@]*"/g)) expect(phone).toMatch(/555.?01\d\d/);
    // The canary contact's fields are in no message or event, and in one contact.
    for (const canary of Object.values(w.contactCanaries)) {
      expect(count(JSON.stringify(w.accounts.map((box) => [box.messages, box.events])), canary), canary).toBe(0);
      expect(count(text, canary), canary).toBe(1);
    }
  });
});

// The world's documents.
describe("the world's restricted messages", () => {
  const ALL = ["health", "money", "legal", "intimate"] as const;
  const screened = (message: GmailMessage) =>
    restrictedCategories({ subject: value(message, "subject") ?? null, text: message.text ?? null }, ALL);

  it("each term message matches exactly its category's terms", async () => {
    const w = world({ now: NOW });
    const [personal] = w.accounts as [WorldAccount];
    const cases = [
      [w.handles.healthTermMessageId, "health"],
      [w.handles.moneyTermMessageId, "money"],
      [w.handles.legalTermMessageId, "legal"],
    ] as const;
    for (const [id, category] of cases) {
      const message = byId(personal, id);
      expect(screened(message), id).toEqual([category]);
      // Through deriveItem too, with every category on, and nothing with none on.
      const index = personal.messages.indexOf(message);
      const on = await deriveItem(
        gmailItem(message, at),
        { ...contextFor(w, personal, index), restrictedOn: ALL },
        PERSONAL_LIMITS,
      );
      const off = await deriveItem(gmailItem(message, at), contextFor(w, personal, index), PERSONAL_LIMITS);
      if (on.kind !== "email" || off.kind !== "email") throw new Error("not an email");
      expect([on.message.restricted, off.message.restricted], id).toEqual([[category], []]);
      // Each from a sender seen in this message only, older than 30 days, and not bulk.
      expect([itemsHolding(w, sender(message)), age(message, NOW) > 30 * DAY, on.bulk], id).toEqual([1, true, false]);
    }
  });

  it("the two Jev messages match no term, and Jev's recorded outputs mark health at 0.85 and 0.75", () => {
    const w = world({ now: NOW });
    const [personal] = w.accounts as [WorldAccount];
    for (const id of [w.handles.decideHealthMessageId, w.handles.decideBelowMessageId]) {
      const message = byId(personal, id);
      expect(screened(message), id).toEqual([]);
      expect([itemsHolding(w, sender(message)), age(message, NOW) > 30 * DAY], id).toEqual([1, true]);
    }
    expect(w.decideOutputs[w.handles.decideHealthMessageId]).toEqual({
      human_written: 0.9,
      special_category: 0,
      quarantine: 0,
      health: 0.85,
      money: 0,
      legal: 0,
      intimate: 0,
    });
    expect(w.decideOutputs[w.handles.decideBelowMessageId]).toEqual({
      human_written: 0.9,
      special_category: 0,
      quarantine: 0,
      health: 0.75,
      money: 0,
      legal: 0,
      intimate: 0,
    });
  });

  it("every world message has a Jev output of seven numbers, all zero but human_written for the rest", () => {
    const w = world({ now: NOW });
    const ids = w.accounts.flatMap((box) => box.messages.map((message) => message.id));
    expect(Object.keys(w.decideOutputs).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      if (id === w.handles.decideHealthMessageId || id === w.handles.decideBelowMessageId) continue;
      expect(w.decideOutputs[id], id).toEqual({
        human_written: 0.9,
        special_category: 0,
        quarantine: 0,
        health: 0,
        money: 0,
        legal: 0,
        intimate: 0,
      });
    }
  });

  it("no other world message matches any category's terms", () => {
    const w = world({ now: NOW });
    const terms = [w.handles.healthTermMessageId, w.handles.moneyTermMessageId, w.handles.legalTermMessageId];
    const matched = w.accounts.flatMap((box) => box.messages).filter((message) => screened(message).length > 0);
    expect(matched.map((message) => message.id).sort()).toEqual([...terms].sort());
    expect(RESTRICTED_TERMS.version).toBe(1);
  });

  it("the term and Jev messages hold no recovery term, have a recorded output and no expected fact", () => {
    const w = world({ now: NOW });
    const [personal] = w.accounts as [WorldAccount];
    const ids = [
      w.handles.healthTermMessageId,
      w.handles.moneyTermMessageId,
      w.handles.legalTermMessageId,
      w.handles.decideHealthMessageId,
      w.handles.decideBelowMessageId,
    ];
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) {
      const message = byId(personal, id);
      expect(
        recoveryHold({
          subject: value(message, "subject") ?? null,
          sender: sender(message),
          text: message.text ?? null,
        }),
        id,
      ).toBe(false);
      expect(Object.hasOwn(w.modelOutputs, id), id).toBe(true);
      expect(Object.hasOwn(w.expected.items, id), id).toBe(false);
    }
  });
});

describe("the world's documents", () => {
  const sourceAccount = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
  const docCtx = (evidence: string): ItemContext => ({
    evidenceId: EvidenceId.parse(evidence),
    revision: 0,
    compartment: "own",
    ownerAddresses: [],
    ownerEntity: LocalEntityId.parse("ent_01JABCDEFGHJKMNPQRSTVWXYZ0"),
    identity: { resolve: async () => ({ outcome: "not_a_person" }) },
  });
  // Every file of every account, with the label it is under.
  const filesOf = (w: World) =>
    w.accounts.flatMap((box) => (box.drive?.files ?? []).map((one) => ({ ...one, label: box.label, box })));

  it("every world document parses with the shared parse", async () => {
    const w = world({ now: NOW });
    const docs = filesOf(w).filter((one) => one.body !== null);
    expect(docs.length).toBe(8);
    for (const [i, { file, body, box }] of docs.entries()) {
      const item = driveItem({ ...file, root: "my-drive" }, body, null, {
        sourceAccount,
        changeKind: "backfill",
        ownerAddress: box.address,
      });
      const facts = await deriveItem(
        item,
        docCtx(`evi_01JABCDEFGHJKMNPQRSTVW${String(i).padStart(4, "0")}`),
        PERSONAL_LIMITS,
      );
      expect(facts.kind, file.id).toBe("document");
      if (facts.kind === "document")
        expect([facts.document.unreadable, facts.document.text === null], file.id).toEqual([null, false]);
    }
  });

  it("the world's expected documents are what a hand count gives", async () => {
    const w = world({ now: NOW });
    const sources = fakeSources(w);
    const counted: { fileId: string; label: string; root: string | null }[] = [];
    for (const source of sources) {
      const box = w.accounts.find((one) => one.label === source.label) as WorldAccount;
      if (source.drive === undefined) continue;
      const roots = (box.drive?.roots ?? []).map((one) => one.root);
      const connector = source.connector("google_docs", sourceAccount, { roots });
      const page = await connector.listChanges({ id: sourceAccount, connector: "google_docs" } as never, null, 100);
      expect(page.listing?.ended).toBe("complete");
      const stored = new Map(
        page.items.map((item) => [
          item.sourceItemId.slice("drive-file:".length),
          item.markers[1]?.slice("root:".length) ?? null,
        ]),
      );
      for (const { file } of box.drive?.files ?? [])
        counted.push({ fileId: file.id, label: box.label, root: stored.get(file.id) ?? null });
    }
    expect(counted).toEqual(w.expected.documents.map(({ fileId, label, root }) => ({ fileId, label, root })));
    for (const one of w.expected.documents) expect(one.stored, one.fileId).toBe(one.root !== null);
    // The reference mark is the reference root's, and nothing else's.
    const reference = new Set(
      w.accounts.flatMap((box) =>
        (box.drive?.roots ?? []).filter((one) => one.mode === "reference").map((one) => one.root),
      ),
    );
    for (const one of w.expected.documents)
      expect(one.reference, one.fileId).toBe(one.root !== null && reference.has(one.root));
    // Every kind is there.
    expect([...new Set(w.expected.documents.map((one) => one.kind))].sort()).toEqual([
      "doc",
      "other",
      "pdf",
      "sheet",
      "slides",
    ]);
  });

  it("exactly one world document is held", () => {
    const w = world({ now: NOW });
    const text = (body: { blocks: { kind: string; text?: string; cells?: string[] }[] } | null): string | null =>
      body === null ? null : body.blocks.map((block) => block.text ?? (block.cells ?? []).join(" | ")).join("\n\n");
    const held = filesOf(w).filter(({ file, body }) => recoveryHold({ subject: file.name, text: text(body) }));
    expect(held.map((one) => one.file.id)).toEqual([w.handles.heldDocumentId]);
    expect(w.expected.documents.filter((one) => one.held).map((one) => one.fileId)).toEqual([w.handles.heldDocumentId]);
  });

  it("no world value is a real name or domain", () => {
    const w = world({ now: NOW });
    const json = JSON.stringify(w.accounts.map((box) => box.drive));
    const addresses = [...json.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g)].map((found) => found[0]);
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses)
      expect(/\.(test|example\.com|example\.org)$|@example\.(com|org)$/.test(address), address).toBe(true);
    for (const address of addresses) expect(CONSUMER_DOMAINS, address).not.toContain(address.split("@")[1]);
    // Each document canary is in the personal account once and in no other.
    const [personal, work] = w.accounts.map((box) => JSON.stringify(box.drive));
    for (const canary of Object.values(w.documentCanaries)) {
      expect(personal?.split(canary).length, canary).toBeGreaterThan(1);
      expect(work?.includes(canary), canary).toBe(false);
      // And in no mail or event.
      expect(JSON.stringify(w.accounts.map((box) => [box.messages, box.events])).includes(canary), canary).toBe(false);
    }
  });
});

describe("the world's research", () => {
  const w = world({ now: NOW });
  const { research } = w;
  const texts = [...research.messages.personal, ...research.messages.work].map((message) => message.text ?? "");

  it("every host in the world is a reserved domain", () => {
    const { web } = research;
    const urls = [
      ...(web.search ?? []).flatMap((one) => one.urls),
      ...web.pages.map((one) => one.url),
      ...web.robots.map((one) => one.origin),
      ...Object.values(research.links),
      ...Object.values(research.pages),
    ];
    const written = [...web.pages.flatMap((one) => ("body" in one ? [one.body] : [])), ...texts].flatMap(
      (text) => text.match(/https?:\/\/[^\s<>"']+/g) ?? [],
    );
    const hosts = [...urls, ...written].map((url) => new URL(url).hostname);
    expect(hosts.length).toBeGreaterThan(30);
    for (const host of hosts) expect(host.endsWith(".example"), host).toBe(true);
    const addresses = [...research.messages.personal, ...research.messages.work].flatMap((message) =>
      addressesOf(message, "from", "to"),
    );
    // Split at white space and markup first: a pattern run over the 1 MiB page would backtrack.
    const inPages = web.pages.flatMap((one) =>
      "body" in one ? one.body.split(/[\s<>]+/).filter((word) => word.includes("@")) : [],
    );
    for (const address of [...addresses, ...inPages])
      expect(domainOf(address).endsWith(".example") || w.owner.addresses.includes(address), address).toBe(true);
  });

  it("the subjects are known from their account's mail, and their identifiers are public identifiers and no id", async () => {
    const { own, employer } = research.subjects;
    expect([own.compartment, employer.compartment]).toEqual(["own", "employer:example"]);
    const [personal, work] = w.accounts as [WorldAccount, WorldAccount];
    for (const [subject, messages, box] of [
      [own, research.messages.personal, personal],
      [employer, research.messages.work, work],
    ] as const) {
      expect(box.compartment).toBe(subject.compartment);
      expect(
        messages.some((message) => value(message, "from") === `${subject.person.name} <${subject.person.address}>`),
      ).toBe(true);
      expect(domainOf(subject.person.address)).toBe(subject.organization.domain);
      const identifiers = [
        ...subject.person.aliases.map((name) => ({ kind: "person_name", value: name })),
        ...subject.organization.aliases.map((name) => ({ kind: "organization_name", value: name })),
        { kind: "domain", value: subject.organization.domain },
      ];
      for (const one of identifiers) {
        const parsed = PublicIdentifier.parse(one);
        expect(idShaped(parsed), one.value).toBe(false);
      }
      // None of them is anywhere in the world's other mail.
      for (const one of [subject.person.address, subject.person.name, subject.organization.name])
        expect(itemsHolding(w, one), one).toBe(0);
    }
    // Every research message derives as mail, none held and none bulk.
    for (const [box, messages] of [
      [personal, research.messages.personal],
      [work, research.messages.work],
    ] as const) {
      for (const [n, message] of messages.entries()) {
        const facts = await deriveItem(gmailItem(message, at), contextFor(w, box, 900 + n), PERSONAL_LIMITS);
        expect(facts.kind === "email" && !facts.bulk && !facts.message.held, message.id).toBe(true);
      }
    }
  });

  it("the own message holds a clean link and a tokened one, and the owner answered its thread", () => {
    const [link, answer] = research.messages.personal as [GmailMessage, GmailMessage];
    expect([link.id, answer.id]).toEqual([research.linkMessageId, research.answerMessageId]);
    expect(answer.threadId).toBe(link.threadId);
    expect(answer.labelIds).toContain("SENT");
    expect(link.text).toContain(research.links.clean);
    expect(link.text).toContain(research.links.tokened);
    expect([canonicalUrl(research.links.clean), isPrivateUrl(research.links.clean)]).toEqual([
      research.links.clean,
      false,
    ]);
    expect([canonicalUrl(research.links.tokened), isPrivateUrl(research.links.tokened)]).toEqual([
      research.links.tokened,
      true,
    ]);
    expect(research.messages.work.find((message) => message.id === research.employerLinkMessageId)?.text).toContain(
      research.links.employer,
    );
    // No id collides with the accounts' own.
    const ids = [
      ...w.accounts.flatMap((box) => box.messages),
      ...research.messages.personal,
      ...research.messages.work,
    ].map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the fake web answers each planted page as the world says", async () => {
    const web = fakeWeb(research.web);
    const outcome = async (url: string) => {
      const answer = await web.ask({ kind: "page", url });
      return answer.kind === "page" ? answer.outcome : "no page";
    };
    const { pages } = research;
    for (const url of [pages.profile, pages.board, pages.namesake, pages.instructions, pages.filings, pages.disallowed])
      expect(await outcome(url), url).toBeNull();
    expect(await outcome(pages.redirect)).toBe("redirect");
    expect(await outcome(pages.notText)).toBe("not_text");
    expect(await outcome(pages.tooLarge)).toBe("too_large");
    expect(await outcome(pages.gone)).toBe("gone");
    expect(await outcome(pages.timeout)).toBe("timeout");
    expect(await outcome(pages.serverError)).toBe("http_5xx");
    const boards = await web.ask({ kind: "robots", url: "https://boards.example/robots.txt" });
    expect(
      boards.kind === "robots" &&
        boards.body !== null &&
        robotsAllows(robotsDisallow(boards.body), new URL(pages.disallowed).pathname),
    ).toBe(false);
    const profiles = await web.ask({ kind: "robots", url: "https://profiles.example/robots.txt" });
    expect(
      profiles.kind === "robots" &&
        profiles.body !== null &&
        robotsAllows(robotsDisallow(profiles.body), new URL(pages.profile).pathname),
    ).toBe(true);
    // Every search URL is a page of the world.
    const known = new Set(research.web.pages.map((one) => one.url));
    for (const url of (research.web.search ?? []).flatMap((one) => one.urls)) expect(known.has(url), url).toBe(true);
  });

  it("every page with a body to read has its expected claims, each standing in the page's own text", async () => {
    const web = fakeWeb(research.web);
    const read: string[] = [];
    for (const one of research.web.pages) {
      const answer = await web.ask({ kind: "page", url: one.url });
      if (answer.kind !== "page" || answer.body === null) continue;
      read.push(one.url);
      const item = pageItem(account, PageUrl.parse(one.url), answer, Timestamp.parse(w.now));
      const { mediaType, payload } = pagePayloadForParse(item);
      const parsed = await parse(
        { ...pipelineItemOf(item, contextFor(w, w.accounts[0] as WorldAccount, 950)), mediaType },
        payload,
        PERSONAL_LIMITS,
      );
      const text = parsed.texts[""] ?? "";
      for (const claim of research.expected[one.url] ?? []) {
        expect(text, one.url).toContain(claim.quote);
        for (const field of Object.values(claim.fields).filter((field) => !["board", "employee"].includes(field)))
          expect(claim.quote.toLowerCase(), field).toContain(field.toLowerCase());
      }
    }
    expect(Object.keys(research.expected).sort()).toEqual(read.sort());
  });
});
