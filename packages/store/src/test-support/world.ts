// Items written through the writer, and seedWorld, the two-label world on them.

import { type LocalEntityId, type RawItem, RawItem as RawItemShape } from "@intelligence/contracts";
import { EntityId } from "@intelligence/contracts/personal";
import { normalizeAddress } from "@intelligence/personal-core";
import type { CalendarPerson, CalendarTime, ItemContext, ItemFacts, Person } from "@intelligence/personal-core/items";
import type { Admin } from "../admin/admin.ts";
import { googleSecretName } from "../admin/admin-base.ts";
import type { Writer } from "../write/writer.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";
import type { Accounts } from "./cast.ts";
import {
  type Derive,
  type EventFixture,
  eventFacts,
  eventItem,
  type MailFixture,
  mailFacts,
  mailItem,
} from "./items.ts";
import { daysFrom, hoursFrom, iso } from "./values.ts";

// ---------------------------------------------------------------------------------------------
// Hand-written items for seeding a store through the writer, on the builders and facts above
// ---------------------------------------------------------------------------------------------

// One email. `at` is its Date header and the time of its interaction. With `sent`, it carries the
// SENT marker, the only thing that makes it outbound. With `thread: null`, the item has no thread
// id at all (`RawItem.threadId` is optional). With `bulk`, it is filed under Updates and read as
// bulk: a message with no interaction row.
type MailSpec = {
  id: string;
  from: Person;
  to: Person[];
  cc?: Person[];
  bcc?: Person[];
  at: Date;
  subject?: string;
  sent?: boolean;
  thread?: string | null;
  bulk?: boolean;
  text?: string;
};

export type Attendee = Person & { response?: "needsAction" | "declined" | "tentative" | "accepted" };

// One calendar event. A `null` time is one the source gave in a form nobody can read. With
// `allDay`, `start` and `end` are midnights UTC, the end exclusive. `updated` is when the
// source last changed it, which is its time when the start is unknown.
export type EventSpec = {
  id: string;
  title?: string;
  start: Date | null;
  end: Date | null;
  allDay?: boolean;
  cancelled?: boolean;
  organizer: Person;
  attendees?: Attendee[];
  updated?: Date;
};

const mailFixtureOf = (spec: MailSpec): MailFixture => ({
  id: spec.id,
  threadId: spec.thread ?? `thread-${spec.id}`,
  messageId: `${spec.id}@mail.example.com`,
  at: iso(spec.at),
  from: spec.from,
  to: spec.to,
  ...(spec.cc === undefined ? {} : { cc: spec.cc }),
  ...(spec.bcc === undefined ? {} : { bcc: spec.bcc }),
  ...(spec.subject === undefined ? {} : { subject: spec.subject }),
  ...(spec.text === undefined ? {} : { text: spec.text }),
  labels: spec.sent === true ? ["SENT"] : spec.bulk === true ? ["INBOX", "CATEGORY_UPDATES"] : ["INBOX"],
  ...(spec.bulk === true ? { reads: "bulk" as const } : {}),
});

function eventFixtureOf(spec: EventSpec, now: Date): EventFixture {
  const time = (at: Date | null): CalendarTime => {
    if (at === null) return { dateTime: "unreadable" };
    return spec.allDay === true ? { date: at.toISOString().slice(0, 10) } : { dateTime: at.toISOString() };
  };
  const person = (one: Attendee): CalendarPerson => ({
    email: one.address,
    ...(one.name === undefined ? {} : { displayName: one.name }),
    ...(one.response === undefined ? {} : { responseStatus: one.response }),
  });
  return {
    event: {
      id: spec.id,
      status: spec.cancelled === true ? "cancelled" : "confirmed",
      etag: `"etag-${spec.id}"`,
      updated: (spec.updated ?? daysFrom(now, -1)).toISOString(),
      ...(spec.title === undefined ? {} : { summary: spec.title }),
      start: time(spec.start),
      end: time(spec.end),
      organizer: person(spec.organizer),
      attendees: (spec.attendees ?? []).map(person),
    },
    title: spec.title ?? null,
    startsAt: spec.start === null ? null : spec.start.toISOString(),
    endsAt: spec.end === null ? null : spec.end.toISOString(),
    allDay: spec.allDay === true,
  };
}

export type StoreSeeder = {
  mail(account: SourceAccountRow, spec: MailSpec): Promise<void>;
  event(account: SourceAccountRow, spec: EventSpec): Promise<void>;
  // Each seeded item's facts, by raw.sourceItemId, for the writer's rederiveIfNeeded.
  derive(raw: RawItem, ctx: ItemContext): Promise<ItemFacts>;
  // The entity the writer's identity port last gave an address. Ids change at a re-derive.
  entityOf(address: string): EntityId;
  ownerEntity(): EntityId;
};

// Seeds a store through the writer's ingestItem, with the hand-written facts above for each item
// (`mailFacts`, `eventFacts`): a message is outbound by its SENT marker alone, the owner is never a
// counterpart and is known by ctx.ownerAddresses, and every other address is resolved through
// ctx.identity. It notes the entity the identity port gives each address, which is how a test
// learns an id the writer made. `now` dates an event's `updated` where its spec gives none. (The
// `seeder` above writes rows in SQL; this one never does.)
export function storeSeeder(writer: Writer, now: Date): StoreSeeder {
  const facts = new Map<string, Derive>();
  const entities = new Map<string, LocalEntityId>();
  let owner: LocalEntityId | undefined;

  // The same context, noting every answer of its identity port.
  const noting = (ctx: ItemContext): ItemContext => {
    owner = ctx.ownerEntity;
    return {
      ...ctx,
      identity: {
        resolve: async (mention, store, requestId, from) => {
          const answer = await ctx.identity.resolve(mention, store, requestId, from);
          if ((answer.outcome === "linked" || answer.outcome === "created") && answer.entity !== ctx.ownerEntity) {
            entities.set(normalizeAddress(mention.key.value) ?? mention.key.value, answer.entity);
          }
          return answer;
        },
      },
    };
  };

  const ingest = async (account: SourceAccountRow, raw: RawItem, make: Derive): Promise<void> => {
    RawItemShape.parse(raw);
    facts.set(raw.sourceItemId, make);
    const outcome = await writer.ingestItem(account, raw, (ctx) => make(noting(ctx)));
    if (outcome !== "stored") throw new Error(`fixture item ${raw.sourceItemId} was ${outcome}, not stored`);
  };

  return {
    mail: (account, spec) => {
      const { threadId, ...threadless } = mailItem(mailFixtureOf(spec), account);
      return ingest(
        account,
        spec.thread === null ? threadless : { ...threadless, ...(threadId === undefined ? {} : { threadId }) },
        mailFacts(mailFixtureOf(spec)),
      );
    },
    event: (account, spec) =>
      ingest(account, eventItem(eventFixtureOf(spec, now), account), eventFacts(eventFixtureOf(spec, now))),
    derive: (raw, ctx) => {
      const make = facts.get(raw.sourceItemId);
      if (make === undefined) throw new Error(`no fixture facts for ${raw.sourceItemId}`);
      return make(noting(ctx));
    },
    entityOf: (address) => {
      const entity = entities.get(normalizeAddress(address) ?? "");
      if (entity === undefined) throw new Error(`the identity port never resolved ${address}`);
      return EntityId.parse(entity);
    },
    ownerEntity: () => EntityId.parse(owner),
  };
}

// ---------------------------------------------------------------------------------------------
// seedWorld: one owner, a `personal` label under `own` and a `work` label under employer:example
// ---------------------------------------------------------------------------------------------

export const WORLD_NOW = new Date("2026-03-10T12:00:00.000Z");

export const WORLD = Object.freeze({
  ownerPersonal: "owner.personal@example.com",
  ownerWork: "owner.work@example.org",
  // Seen under both labels, by one address, under a different display name in each.
  both: { address: "blake.both@example.com", ownName: "Blake Canary-Both", workName: "Blake Canary-Workname" },
  // Seen only in work mail and work meetings.
  workOnly: { address: "wren.workonly@example.org", name: "Wren Canary-Workonly" },
  // Seen only in personal mail.
  ownOnly: { address: "pat.ownonly@example.com", name: "Pat Canary-Ownonly" },
  ownSubjects: {
    first: "canary-own-subject-first",
    second: "canary-own-subject-second",
    sent: "canary-own-subject-sent",
    pat: "canary-own-subject-pat",
  },
  ownMeeting: "canary-own-meeting-next",
  workMeetingNext: "canary-work-meeting-next",
  workMeetingLast: "canary-work-meeting-last",
  // What a result for a client cleared for `own` alone must never hold.
  workNeedles: ["canary-work", "Wren Canary-Workonly", "wren.workonly", "Blake Canary-Workname", "example.org"],
});

export type WorldLabel = "personal" | "work";

// Seeds through the writer and the admin. With both labels (the default):
//
// personal (own):  Blake wrote at -5d and -2d, the owner wrote to Blake at -4d, Pat wrote at -3d;
//                  a meeting with Blake at +3d.
// work (employer): Blake wrote at -20d and -1d, Wren wrote six times (-7d to -12d), the owner
//                  wrote to both at -6d; a meeting with both at -50h and another at +1d.
//
// So a count that crosses compartments puts Wren first and moves Blake's first and last times,
// and the work items are ingested first, so Blake's entity is made by a work item. With
// `labels: ["personal"]` it seeds the same store as if the work account had never been connected.
export async function seedWorld(
  writer: Writer,
  admin: Admin,
  options?: { labels?: WorldLabel[] },
): Promise<{
  derive: StoreSeeder["derive"];
  entityOf: StoreSeeder["entityOf"];
  ownerEntity: StoreSeeder["ownerEntity"];
  now: Date;
  accounts: Partial<Accounts>;
}> {
  const labels = options?.labels ?? ["personal", "work"];
  const seed = storeSeeder(writer, WORLD_NOW);
  const at = (days: number): Date => daysFrom(WORLD_NOW, days);
  const hour = (start: Date): Date => hoursFrom(start, 1);
  const accounts: Partial<Accounts> = {};

  // What `pi google add` leaves before the first sync: each label's sealed client secret and
  // refresh token.
  const compartments: Record<WorldLabel, string> = { personal: "own", work: "employer:example" };
  for (const label of labels) {
    await admin.secrets.setSecret(
      googleSecretName(label, "client"),
      JSON.stringify({ compartment: compartments[label], secret: `canary-client-secret-${label}` }),
    );
    await admin.secrets.setSecret(googleSecretName(label, "refresh_token"), `canary-refresh-token-${label}`);
  }

  if (labels.includes("work")) {
    const owner: Person = { address: WORLD.ownerWork };
    const blake: Person = { address: WORLD.both.address, name: WORLD.both.workName };
    const wren: Person = { address: WORLD.workOnly.address, name: WORLD.workOnly.name };
    const mailbox = await writer.ensureSourceAccount("work", "google_mail", "employer:example", WORLD.ownerWork);
    const calendar = await writer.ensureSourceAccount("work", "google_calendar", "employer:example", WORLD.ownerWork);
    accounts.workMail = mailbox;
    accounts.workCalendar = calendar;

    await seed.mail(mailbox, {
      id: "work-blake-old",
      from: blake,
      to: [owner],
      at: at(-20),
      subject: "canary-work-subject-old",
    });
    await seed.mail(mailbox, {
      id: "work-blake-new",
      from: blake,
      to: [owner],
      at: at(-1),
      subject: "canary-work-subject-new",
    });
    await seed.mail(mailbox, {
      id: "work-sent",
      from: owner,
      to: [blake, wren],
      at: at(-6),
      subject: "canary-work-subject-sent",
      sent: true,
    });
    for (let n = 0; n < 6; n += 1) {
      await seed.mail(mailbox, {
        id: `work-wren-${n}`,
        from: wren,
        to: [owner],
        at: at(-7 - n),
        subject: `canary-work-subject-wren-${n}`,
      });
    }
    const last = hoursFrom(WORLD_NOW, -50);
    await seed.event(calendar, {
      id: "work-meeting-last",
      title: WORLD.workMeetingLast,
      start: last,
      end: hour(last),
      organizer: owner,
      attendees: [blake, wren],
    });
    await seed.event(calendar, {
      id: "work-meeting-next",
      title: WORLD.workMeetingNext,
      start: at(1),
      end: hour(at(1)),
      organizer: owner,
      attendees: [blake, wren],
    });
  }

  if (labels.includes("personal")) {
    const owner: Person = { address: WORLD.ownerPersonal };
    const blake: Person = { address: WORLD.both.address, name: WORLD.both.ownName };
    const pat: Person = { address: WORLD.ownOnly.address, name: WORLD.ownOnly.name };
    const mailbox = await writer.ensureSourceAccount("personal", "google_mail", "own", WORLD.ownerPersonal);
    const calendar = await writer.ensureSourceAccount("personal", "google_calendar", "own", WORLD.ownerPersonal);
    accounts.personalMail = mailbox;
    accounts.personalCalendar = calendar;

    await seed.mail(mailbox, { id: "own-pat", from: pat, to: [owner], at: at(-3), subject: WORLD.ownSubjects.pat });
    await seed.mail(mailbox, {
      id: "own-blake-first",
      from: blake,
      to: [owner],
      at: at(-5),
      subject: WORLD.ownSubjects.first,
    });
    await seed.mail(mailbox, {
      id: "own-sent",
      from: owner,
      to: [blake],
      at: at(-4),
      subject: WORLD.ownSubjects.sent,
      sent: true,
    });
    await seed.mail(mailbox, {
      id: "own-blake-second",
      from: blake,
      to: [owner],
      at: at(-2),
      subject: WORLD.ownSubjects.second,
    });
    // The own meeting gives Blake no display name, so Blake's latest name under `own` is the own
    // one (mail at -2d) and the latest of all is the work one (the work meeting at +1d).
    await seed.event(calendar, {
      id: "own-meeting-next",
      title: WORLD.ownMeeting,
      start: at(3),
      end: hour(at(3)),
      organizer: owner,
      attendees: [{ address: WORLD.both.address }],
    });
  }

  return { derive: seed.derive, entityOf: seed.entityOf, ownerEntity: seed.ownerEntity, now: WORLD_NOW, accounts };
}
