// The named messages and events, MAIL and EVENTS.
import type { CalendarEvent, CalendarPerson } from "@intelligence/personal-core/items";
import {
  CANARIES,
  CANARY_PERSON,
  GUEST,
  LATER_OWNER,
  OWNER,
  OWNER_PERSONAL,
  OWNER_WORK,
  QUENTIN,
  RHEA,
  SOLO,
  type Who,
  WORK_ONLY,
} from "./cast.ts";
import { crowd, type EventFixture, event, type MailFixture, mail } from "./items.ts";

export const MAIL = {
  // Received in `personal`: the canary person writes to the owner, with Quentin on Cc.
  canary: mail({
    id: CANARIES.gmailId,
    threadId: CANARIES.threadId,
    messageId: CANARIES.messageId,
    at: "2026-09-01T09:00:00Z",
    from: CANARY_PERSON,
    to: [OWNER_PERSONAL],
    cc: [QUENTIN],
    subject: CANARIES.subject,
    labels: ["INBOX"],
    text: CANARIES.bodyText,
    attachments: [{ name: CANARIES.attachmentName, type: "application/pdf", size: 48_213 }],
  }),
  // Sent from `personal`: the owner answers, to the canary person, with Quentin and Rhea on Cc.
  reply: mail({
    id: "gm-reply-0002",
    threadId: CANARIES.threadId,
    messageId: "reply-0002@hearth-canary.test",
    at: "2026-09-01T10:30:00Z",
    from: OWNER_PERSONAL,
    to: [CANARY_PERSON],
    cc: [QUENTIN, RHEA],
    subject: "Re: the heron ledger",
    labels: ["SENT"],
  }),
  fromQuentin: mail({
    id: "gm-quentin-0003",
    threadId: "thread-rota-0003",
    messageId: "rota-0003@lighthouse.test",
    at: "2026-09-02T08:15:00Z",
    from: QUENTIN,
    to: [OWNER_PERSONAL],
    subject: "Lamp rota for next week",
    labels: ["INBOX"],
  }),
  // The only item Solo is on, and the only one from Solo's domain. Quentin is on Cc.
  solo: mail({
    id: "gm-solo-0004",
    threadId: "thread-solo-0004",
    messageId: "solo-0004@one-message.test",
    at: "2026-09-03T11:00:00Z",
    from: SOLO,
    to: [OWNER_PERSONAL],
    cc: [QUENTIN],
    subject: "A single hello",
    labels: ["INBOX"],
  }),
  // The same Gmail message as `solo`, read again with Rhea on Cc in Quentin's place: handed over
  // under another revision tag, it is the source item's next revision.
  soloAgain: {
    id: "gm-solo-0004",
    threadId: "thread-solo-0004",
    messageId: "solo-0004@one-message.test",
    at: "2026-09-03T11:00:00Z",
    from: SOLO,
    to: [OWNER_PERSONAL],
    cc: [RHEA],
    subject: "A single hello, read in full",
    labels: ["INBOX"],
  } satisfies MailFixture,
  // Sent from an address that is neither account's own.
  aliasSent: mail({
    id: "gm-alias-0005",
    threadId: "thread-alias-0005",
    messageId: "alias-0005@alias-one.test",
    at: "2026-09-04T07:45:00Z",
    from: { address: OWNER.alias },
    to: [QUENTIN],
    subject: "From the side door",
    labels: ["SENT"],
  }),
  // Received mail addressed to that alias.
  toAlias: mail({
    id: "gm-toalias-0006",
    threadId: "thread-alias-0005",
    messageId: "toalias-0006@lighthouse.test",
    at: "2026-09-04T09:00:00Z",
    from: RHEA,
    to: [{ address: OWNER.alias }],
    subject: "Re: From the side door",
    labels: ["INBOX"],
  }),
  newsletter: mail({
    id: "gm-news-0007",
    threadId: "thread-news-0007",
    messageId: "news-0007@bulletin.test",
    at: "2026-09-05T06:00:00Z",
    from: { address: "bulletin@bulletin.test", name: "The Weekly Bulletin" },
    to: [OWNER_PERSONAL],
    subject: "This week in lamps",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    reads: "bulk",
  }),
  // Bulk, but sent by the owner from a second alias.
  bulkSent: mail({
    id: "gm-bulksent-0008",
    threadId: "thread-bulksent-0008",
    messageId: "bulksent-0008@alias-two.test",
    at: "2026-09-05T12:00:00Z",
    from: { address: OWNER.bulkAlias },
    to: [{ address: "members@announce-list.test" }],
    subject: "Notice to the list",
    labels: ["SENT"],
    reads: "bulk",
  }),
  // No From header: an item the shared parse refuses, so it is unread.
  unread: mail({
    id: "gm-unread-0009",
    threadId: "thread-unread-0009",
    messageId: "unread-0009@nowhere.test",
    at: "2026-09-06T06:00:00Z",
    to: [OWNER_PERSONAL],
    subject: "No sender at all",
    labels: ["INBOX"],
    reads: "unread",
  }),
  // Two Gmail messages that carry one Message-ID header: two source items.
  twinA: mail({
    id: "gm-twin-a-0010",
    threadId: "thread-twin-0010",
    messageId: "twin-0010@lighthouse.test",
    at: "2026-09-07T10:00:00Z",
    from: QUENTIN,
    to: [OWNER_PERSONAL],
    subject: "Twin, first copy",
    labels: ["INBOX"],
  }),
  twinB: mail({
    id: "gm-twin-b-0011",
    threadId: "thread-twin-0010",
    messageId: "twin-0010@lighthouse.test",
    at: "2026-09-07T10:05:00Z",
    from: SOLO,
    to: [OWNER_PERSONAL],
    subject: "Twin, second copy",
    labels: ["INBOX"],
  }),
  // The owner to 500 people: 200 To, 200 Cc and 100 Bcc.
  crowd: mail({
    id: "gm-crowd-0012",
    threadId: "thread-crowd-0012",
    messageId: "crowd-0012@hearth-canary.test",
    at: "2026-08-01T10:00:00Z",
    from: OWNER_PERSONAL,
    to: crowd("to", 200),
    cc: crowd("cc", 200),
    bcc: crowd("bcc", 100),
    subject: "To everyone at once",
    labels: ["SENT"],
  }),
  // Received in `work`: the canary person again, under the employer's compartment.
  workCanary: mail({
    id: "gm-work-0013",
    threadId: "thread-work-0013",
    messageId: "work-0013@harbor-canary.test",
    at: "2026-09-08T09:00:00Z",
    from: CANARY_PERSON,
    to: [OWNER_WORK],
    subject: CANARIES.subject,
    labels: ["INBOX"],
  }),
  workOnly: mail({
    id: "gm-work-0014",
    threadId: "thread-work-0014",
    messageId: "work-0014@partner-example.test",
    at: "2026-09-08T10:00:00Z",
    from: WORK_ONLY,
    to: [OWNER_WORK],
    subject: "Partner notes",
    labels: ["INBOX"],
  }),
  // Sent from `work`: the owner answers the work-only person, so the employer's compartment
  // holds a recipient row too.
  workSent: mail({
    id: "gm-work-0017",
    threadId: "thread-work-0014",
    messageId: "work-0017@employer-example.test",
    at: "2026-09-08T11:00:00Z",
    from: OWNER_WORK,
    to: [WORK_ONLY],
    subject: "Re: Partner notes",
    labels: ["SENT"],
  }),
  // The re-derive tests: the address that becomes the owner's sends one message...
  fromLater: mail({
    id: "gm-later-0015",
    threadId: "thread-later-0015",
    messageId: "later-0015@second-home.test",
    at: "2026-09-09T09:00:00Z",
    from: LATER_OWNER,
    to: [OWNER_PERSONAL, RHEA],
    subject: "From the second home",
    labels: ["INBOX"],
  }),
  // ...and receives another.
  toLater: mail({
    id: "gm-later-0016",
    threadId: "thread-later-0016",
    messageId: "later-0016@hearth-canary.test",
    at: "2026-09-09T10:00:00Z",
    from: OWNER_PERSONAL,
    to: [LATER_OWNER, QUENTIN],
    subject: "To the second home",
    labels: ["SENT"],
  }),
};

const OWNER_ORGANIZER: CalendarPerson = { email: OWNER.personal, self: true };
const ownerAttends = (responseStatus: NonNullable<CalendarPerson["responseStatus"]>): CalendarPerson => ({
  email: OWNER.personal,
  displayName: OWNER.name,
  responseStatus,
  self: true,
});
const attends = (
  who: Who,
  responseStatus: NonNullable<CalendarPerson["responseStatus"]> = "accepted",
): CalendarPerson => ({
  email: who.address,
  ...(who.name === undefined ? {} : { displayName: who.name }),
  responseStatus,
});

const CANARY_EVENT: CalendarEvent = {
  id: CANARIES.eventId,
  status: "confirmed",
  etag: '"etag-canary-1"',
  updated: "2026-09-02T08:00:00Z",
  summary: CANARIES.eventTitle,
  start: { dateTime: "2026-09-10T15:00:00Z" },
  end: { dateTime: "2026-09-10T16:00:00Z" },
  organizer: OWNER_ORGANIZER,
  attendees: [ownerAttends("accepted"), attends(CANARY_PERSON), attends(QUENTIN, "tentative")],
};

export const EVENTS = {
  // The owner organizes; the canary person and Quentin attend.
  canary: event({
    event: CANARY_EVENT,
    title: CANARIES.eventTitle,
    startsAt: "2026-09-10T15:00:00.000Z",
    endsAt: "2026-09-10T16:00:00.000Z",
    allDay: false,
  }),
  // The same event, edited: a day later, renamed, with Rhea in Quentin's place.
  canaryMoved: event({
    event: {
      ...CANARY_EVENT,
      etag: '"etag-canary-2"',
      updated: "2026-09-03T08:00:00Z",
      summary: "Heron ledger walkthrough, moved",
      start: { dateTime: "2026-09-11T15:00:00Z" },
      end: { dateTime: "2026-09-11T16:30:00Z" },
      attendees: [ownerAttends("accepted"), attends(CANARY_PERSON), attends(RHEA, "needsAction")],
    },
    title: "Heron ledger walkthrough, moved",
    startsAt: "2026-09-11T15:00:00.000Z",
    endsAt: "2026-09-11T16:30:00.000Z",
    allDay: false,
  }),
  // The same event, cancelled with its fields kept.
  canaryCancelled: event({
    event: { ...CANARY_EVENT, status: "cancelled", etag: '"etag-canary-3"', updated: "2026-09-04T08:00:00Z" },
    title: CANARIES.eventTitle,
    startsAt: "2026-09-10T15:00:00.000Z",
    endsAt: "2026-09-10T16:00:00.000Z",
    allDay: false,
  }),
  // Organized by a guest seen nowhere else; the owner and Quentin attend.
  guest: event({
    event: {
      id: "evguest0002",
      status: "confirmed",
      etag: '"etag-guest-1"',
      updated: "2026-09-02T09:00:00Z",
      summary: "Guest walkabout",
      start: { dateTime: "2026-09-12T09:00:00Z" },
      end: { dateTime: "2026-09-12T10:00:00Z" },
      organizer: { email: GUEST.address, ...(GUEST.name === undefined ? {} : { displayName: GUEST.name }) },
      attendees: [attends(GUEST), ownerAttends("needsAction"), attends(QUENTIN)],
    },
    title: "Guest walkabout",
    startsAt: "2026-09-12T09:00:00.000Z",
    endsAt: "2026-09-12T10:00:00.000Z",
    allDay: false,
  }),
  // In the `work` calendar: the work-only person organizes, the owner attends.
  work: event({
    event: {
      id: "evwork0003",
      status: "confirmed",
      etag: '"etag-work-1"',
      updated: "2026-09-02T10:00:00Z",
      summary: "Partner sync",
      start: { dateTime: "2026-09-14T13:00:00Z" },
      end: { dateTime: "2026-09-14T13:30:00Z" },
      organizer: { email: WORK_ONLY.address },
      attendees: [
        attends(WORK_ONLY),
        { email: OWNER.work, displayName: OWNER.name, responseStatus: "accepted", self: true },
      ],
    },
    title: "Partner sync",
    startsAt: "2026-09-14T13:00:00.000Z",
    endsAt: "2026-09-14T13:30:00.000Z",
    allDay: false,
  }),
  // The re-derive tests: the address that becomes the owner's attends, with no `self` flag.
  withLater: event({
    event: {
      id: "evlater0004",
      status: "confirmed",
      etag: '"etag-later-1"',
      updated: "2026-09-02T11:00:00Z",
      summary: "Second home visit",
      start: { dateTime: "2026-09-16T17:00:00Z" },
      end: { dateTime: "2026-09-16T18:00:00Z" },
      organizer: OWNER_ORGANIZER,
      attendees: [ownerAttends("accepted"), attends(LATER_OWNER, "tentative"), attends(QUENTIN)],
    },
    title: "Second home visit",
    startsAt: "2026-09-16T17:00:00.000Z",
    endsAt: "2026-09-16T18:00:00.000Z",
    allDay: false,
  }),
};

// A timed event by one organizer with the owner attending, for the listing tests: `ends` null is
// an event whose end is unknown.
export const plainEvent = (id: string, ends: string | null): EventFixture =>
  event({
    event: {
      id,
      status: "confirmed",
      etag: `"etag-${id}"`,
      updated: "2026-08-20T08:00:00Z",
      summary: `Rota ${id}`,
      start: { dateTime: "2026-08-25T09:00:00Z" },
      ...(ends === null ? {} : { end: { dateTime: ends } }),
      organizer: { email: QUENTIN.address },
      attendees: [attends(QUENTIN), ownerAttends("accepted")],
    },
    title: `Rota ${id}`,
    startsAt: "2026-08-25T09:00:00.000Z",
    endsAt: ends === null ? null : new Date(ends).toISOString(),
    allDay: false,
  });

// The same, all day: `starts` and `ends` are dates, the end exclusive, and each is stored as
// midnight UTC of its date, whatever zone the calendar keeps.
export const allDayEvent = (id: string, starts: string, ends: string): EventFixture =>
  event({
    event: {
      id,
      status: "confirmed",
      etag: `"etag-${id}"`,
      updated: "2026-08-20T08:00:00Z",
      summary: `Rota ${id}`,
      start: { date: starts },
      end: { date: ends },
      organizer: { email: QUENTIN.address },
      attendees: [attends(QUENTIN), ownerAttends("accepted")],
    },
    title: `Rota ${id}`,
    startsAt: `${starts}T00:00:00.000Z`,
    endsAt: `${ends}T00:00:00.000Z`,
    allDay: true,
  });
