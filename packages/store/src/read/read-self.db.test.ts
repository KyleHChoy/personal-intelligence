import { type EntityId, EntityView, type MeetingView, SelfView } from "@intelligence/contracts/personal";
import type { Person } from "@intelligence/personal-core/items";
import { afterAll, describe, expect, it } from "vitest";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { recordingPool } from "../test-support/recording.ts";
import { callLog, openStore, type TestStore } from "../test-support/store.ts";
import { daysFrom, hoursFrom, instant, outcomeValue, registration } from "../test-support/values.ts";
import { type Attendee, type EventSpec, type StoreSeeder, storeSeeder } from "../test-support/world.ts";
import { Reader } from "./read.ts";
import { WROTE_TO_MAX_RECIPIENTS } from "./read-fragments.ts";

// The stores are seeded through the writer, with hand-written people on reserved domains.

const NOW = new Date("2026-03-10T12:00:00.000Z");
const OWNER = "owner.self@example.com";
const ALIAS = "owner.alias@example.com";

describe("get_self: upcoming", { timeout: 180_000 }, () => {
  const pia = { address: "pia@guests.example.org", name: "Pia Guest" };
  const quill = { address: "quill@guests.example.org", name: "Quill Guest" };
  const orla = { address: "orla@hosts.example.org", name: "Orla Organizer" };

  let store: TestStore | undefined;
  let seed: StoreSeeder;
  let self: SelfView;

  const titled = (title: string): MeetingView => {
    const meeting = self.upcoming.find((one) => one.title?.untrusted === title);
    if (meeting === undefined) throw new Error(`no upcoming meeting titled ${title}`);
    return meeting;
  };

  // The store is seeded once, by the first test that asks, and only read after that. Every test
  // awaits it, so a failure to seed fails each test and skips none.
  let seeded: Promise<void> | undefined;
  const ready = (): Promise<void> => (seeded ??= prepare());
  const prepare = async (): Promise<void> => {
    store = await openStore({ compartments: ["own"], now: NOW });
    seed = storeSeeder(store.writer, NOW);
    await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
    const calendar = await store.writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER);
    // A second owner address, which no account has: an alias the owner added.
    await store.admin.accounts.addOwnerAddress(ALIAS, "own");
    const owner: Person = { address: OWNER };
    const event = (spec: Omit<EventSpec, "end" | "organizer"> & { end?: Date | null; organizer?: Person }) =>
      seed.event(calendar, {
        ...spec,
        end: spec.end ?? (spec.start === null ? null : hoursFrom(spec.start, 1)),
        organizer: spec.organizer ?? owner,
      });
    const ownerAs = (response: NonNullable<Attendee["response"]>): Attendee => ({ address: OWNER, response });

    // In upcoming, by start:
    await event({
      id: "u-long",
      title: "canary-began-two-days-ago",
      start: daysFrom(NOW, -2),
      end: daysFrom(NOW, 1),
      attendees: [pia],
    });
    await event({
      id: "u-allday",
      title: "canary-all-day-today",
      start: new Date("2026-03-10T00:00:00.000Z"),
      end: new Date("2026-03-11T00:00:00.000Z"),
      allDay: true,
    });
    await event({
      id: "u-progress",
      title: "canary-in-progress",
      start: hoursFrom(NOW, -1),
      end: hoursFrom(NOW, 1),
      attendees: [{ ...pia, response: "accepted" }, ownerAs("tentative"), { ...quill, response: "declined" }],
    });
    await event({ id: "u-tied-one", title: "canary-tied-one", start: daysFrom(NOW, 1), attendees: [pia] });
    await event({ id: "u-tied-two", title: "canary-tied-two", start: daysFrom(NOW, 1), attendees: [quill] });
    // The owner is only an attendee, under the alias: someone else organizes.
    await event({
      id: "u-guest",
      title: "canary-owner-is-a-guest",
      start: daysFrom(NOW, 3),
      organizer: orla,
      attendees: [pia, { address: ALIAS, response: "accepted" }],
    });
    await event({
      id: "u-edge",
      title: "canary-inside-seven-days",
      start: hoursFrom(NOW, 7 * 24 - 1),
      attendees: [{ ...quill, response: "accepted" }],
    });
    // The edges: one that ends a second after now, and one that starts a second inside seven days.
    await event({
      id: "u-ending",
      title: "canary-ends-in-a-second",
      start: hoursFrom(NOW, -2),
      end: new Date(NOW.getTime() + 1000),
      attendees: [pia],
    });
    await event({
      id: "u-last",
      title: "canary-last-second-of-seven-days",
      start: new Date(daysFrom(NOW, 7).getTime() - 1000),
      attendees: [pia],
    });

    // Not in upcoming:
    await event({
      id: "x-cancelled",
      title: "canary-cancelled",
      start: daysFrom(NOW, 2),
      cancelled: true,
      attendees: [pia],
    });
    await event({
      id: "x-ended",
      title: "canary-ended",
      start: hoursFrom(NOW, -3),
      end: hoursFrom(NOW, -2),
      attendees: [pia],
    });
    await event({ id: "x-far", title: "canary-after-seven-days", start: daysFrom(NOW, 8), attendees: [pia] });
    await event({ id: "x-timeless", title: "canary-no-readable-time", start: null, attendees: [pia] });
    // The edges: one that ends at now exactly, and one that starts at seven days exactly.
    await event({ id: "x-ending", title: "canary-ended-now", start: hoursFrom(NOW, -2), end: NOW, attendees: [pia] });
    await event({ id: "x-seventh", title: "canary-starts-at-seven-days", start: daysFrom(NOW, 7), attendees: [pia] });

    const { token } = await store.admin.clients.addClient(registration("self-client", ["own"]));
    self = SelfView.parse(outcomeValue(await store.reader.getSelf(token)));
  };

  afterAll(async () => {
    await store?.close();
  });

  it("upcoming holds an all-day event today and a meeting in progress, and not a cancelled one, one that ended, or one that starts after seven days", async () => {
    await ready();
    const titles = self.upcoming.map((meeting) => meeting.title?.untrusted);
    // By start; the two that start together are in the order of their ids.
    expect(titles.filter((title) => !title?.startsWith("canary-tied"))).toEqual([
      "canary-began-two-days-ago",
      "canary-all-day-today",
      "canary-ends-in-a-second",
      "canary-in-progress",
      "canary-owner-is-a-guest",
      "canary-inside-seven-days",
      "canary-last-second-of-seven-days",
    ]);
    expect(titles.slice(4, 6).sort()).toEqual(["canary-tied-one", "canary-tied-two"]);
    const tied = self.upcoming.slice(4, 6).map((meeting) => meeting.id);
    expect(tied).toEqual([...tied].sort());
    // Ends after now, and starts before now plus seven days: neither edge is inside.
    for (const absent of [
      "canary-cancelled",
      "canary-ended",
      "canary-after-seven-days",
      "canary-no-readable-time",
      "canary-ended-now",
      "canary-starts-at-seven-days",
    ]) {
      expect(titles).not.toContain(absent);
    }

    const allDay = titled("canary-all-day-today");
    // An all-day event is served by its dates, the first and the last day it covers (its
    // exclusive end less a day), with no instants.
    expect(allDay).toEqual({
      id: expect.stringMatching(/^evt_/),
      title: { untrusted: "canary-all-day-today" },
      startsAt: null,
      endsAt: null,
      date: "2026-03-10",
      lastDate: "2026-03-10",
      allDay: true,
      cancelled: false,
      participants: [],
    });
    const inProgress = titled("canary-in-progress");
    expect([instant(inProgress.startsAt), instant(inProgress.endsAt), inProgress.allDay, inProgress.cancelled]).toEqual(
      [hoursFrom(NOW, -1).getTime(), hoursFrom(NOW, 1).getTime(), false, false],
    );
    for (const meeting of self.upcoming) expect(meeting.cancelled, meeting.title?.untrusted).toBe(false);
  });

  it("an event with no attendees and one where the owner is only an attendee both appear", async () => {
    await ready();
    expect(titled("canary-all-day-today").participants).toEqual([]);
    // The organizer first, then the other participant; the owner, an attendee, is not one.
    expect(titled("canary-owner-is-a-guest").participants).toEqual([
      {
        id: seed.entityOf(orla.address),
        kind: "person",
        name: { untrusted: orla.name },
        address: { untrusted: orla.address },
      },
      {
        id: seed.entityOf(pia.address),
        kind: "person",
        name: { untrusted: pia.name },
        address: { untrusted: pia.address },
      },
    ]);
  });

  it("participants leave out the owner, and `response` is the owner's", async () => {
    await ready();
    const inProgress = titled("canary-in-progress");
    // Two participants, by id, neither the owner. Their own responses are not the view's.
    expect(inProgress.participants.map((one) => one.id)).toEqual(
      [seed.entityOf(pia.address), seed.entityOf(quill.address)].sort(),
    );
    expect(inProgress.response).toBe("tentative");
    expect(titled("canary-owner-is-a-guest").response).toBe("accepted");
    // Where the owner gave no response, the view has none: not the one participant's "accepted".
    expect(titled("canary-inside-seven-days").response).toBeUndefined();
    expect(titled("canary-began-two-days-ago").response).toBeUndefined();

    const text = JSON.stringify(self.upcoming);
    for (const address of [OWNER, ALIAS]) expect(text).not.toContain(address);
    const owner: EntityId = seed.ownerEntity();
    expect(text).not.toContain(owner);
  });

  it("`timeZone` is null", async () => {
    await ready();
    expect(self.timeZone).toBeNull();
    // The owner's addresses, each once, in the order of each address's lowest account row id, as
    // pi_admin reads them: the account's (which two source accounts share) and the alias.
    const { db } = store as TestStore;
    const rows = await queryAs<{ value_fp: string }>(
      db.urls.admin,
      "select a.value_fp from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'owner' order by a.id",
    );
    const addressOf = new Map([OWNER, ALIAS].map((address) => [fingerprint(db.keys, "address", address), address]));
    const expected = [...new Set(rows.map((row) => row.value_fp))].map((print) => addressOf.get(print));
    expect(expected.slice().sort()).toEqual([ALIAS, OWNER].sort());
    expect(self.addresses.map((one) => one.untrusted)).toEqual(expected);
  });

  // Last in this block, since it sets the owner's zone. An all-day event's days are
  // the owner's local days once they set one: today's has ended where the owner's day has.
  it("with the owner's zone set, an all-day event is upcoming while its day lasts in that zone", async () => {
    await ready();
    const { admin, reader } = store as TestStore;
    const { token } = await admin.clients.addClient(registration("self-zone-client", ["own"]));
    const titlesIn = async () => {
      const view = SelfView.parse(outcomeValue(await reader.getSelf(token)));
      return { zone: view.timeZone, titles: view.upcoming.map((one) => one.title?.untrusted) };
    };
    expect(await titlesIn()).toMatchObject({ zone: null, titles: expect.arrayContaining(["canary-all-day-today"]) });
    // At noon UTC on the 10th it is two in the morning of the 11th on Kiritimati: the 10th is over.
    await admin.accounts.setTimeZone("Pacific/Kiritimati");
    const ahead = await titlesIn();
    expect(ahead.zone).toBe("Pacific/Kiritimati");
    expect(ahead.titles).not.toContain("canary-all-day-today");
    expect(ahead.titles).toContain("canary-in-progress");
    // In Chicago the 10th runs to five in the morning UTC on the 11th: still upcoming.
    await admin.accounts.setTimeZone("America/Chicago");
    expect((await titlesIn()).titles).toContain("canary-all-day-today");
  });
});

describe("get_self: contacts", { timeout: 180_000 }, () => {
  it("contacts the owner wrote to or met come first; each group ranks by tier and warmth, then emails in 30 days, then 90 days, then meetings in 90 days, then id; at most 20", async () => {
    const store = await openStore({ compartments: ["own"], now: NOW });
    try {
      const seed = storeSeeder(store.writer, NOW);
      const mail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
      const calendar = await store.writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER);
      const owner: Person = { address: OWNER };
      const person = (key: string): Required<Person> => ({
        address: `${key}@contacts.example.org`,
        name: `Contact ${key}`,
      });
      let sent = 0;
      // One message from each person on each of the given days before now.
      const wrote = async (key: string, days: number[]): Promise<void> => {
        for (const day of days)
          await seed.mail(mail, {
            id: `contact-${(sent += 1)}`,
            from: person(key),
            to: [owner],
            at: daysFrom(NOW, -day),
            subject: `canary-contact-${key}`,
          });
      };
      const met = (id: string, days: number, keys: string[], cancelled = false): Promise<void> =>
        seed.event(calendar, {
          id,
          title: `canary-${id}`,
          start: daysFrom(NOW, -days),
          end: hoursFrom(daysFrom(NOW, -days), 1),
          organizer: owner,
          attendees: keys.map(person),
          ...(cancelled ? { cancelled: true } : {}),
        });

      // emails30d, emails90d, meetings90d:
      await wrote("c1", [1, 2]); //                3, 3, 0  with the message the owner sent
      await seed.mail(mail, {
        id: "contact-sent",
        from: owner,
        to: [person("c1")],
        at: daysFrom(NOW, -3),
        subject: "canary-contact-sent",
        sent: true,
      });
      await wrote("c2", [4, 5, 40, 50, 60]); //    2, 5, 0
      await wrote("c3", [6, 7, 41, 51]); //        2, 4, 0
      await wrote("c4", [8, 9, 42, 52]); //        2, 4, 2
      await wrote("c5", [11, 12, 43, 53]); //      2, 4, 1
      await wrote("c6", [13]); //                  1, 1, 0
      await wrote("c7", [14]); //                  1, 1, 0
      const fillers = Array.from({ length: 12 }, (_, n) => `f${String(n).padStart(2, "0")}`);
      for (const [n, key] of fillers.entries()) await wrote(key, [45 + n]); // 0, 1, 0, twelve times
      await met("g1", 10, ["c4", "c5"]);
      await met("g2", 70, ["c4"]);
      await met("g3", 20, ["m1", "m2", "m3"]); //  0, 0, 1, three times

      // Never a contact: mail only before the 90 days, a meeting only ahead, a meeting only
      // cancelled.
      await wrote("old", [100]);
      await met("g-ahead", -2, ["ahead"]);
      await met("g-cancelled", 15, ["cancelled"], true);

      const { token } = await store.admin.clients.addClient(registration("self-client", ["own"]));
      const self = SelfView.parse(outcomeValue(await store.reader.getSelf(token)));
      const id = (key: string): EntityId => seed.entityOf(person(key).address);
      const byId = (keys: string[]): EntityId[] => keys.map(id).sort();
      const row = (key: EntityId, counts: number[]) => [key, ...counts];

      // Twenty-two people qualify. First those the owner wrote to (c1) or met (c4, c5 and the
      // three seen only in a meeting), then those who only wrote; the last two fillers by id are cut.
      // Within a group, tier and warmth first: no warmth build ran, so the
      // audience is rebuilding, no one has a tier, and each group ranks by volume (the order within
      // a place by tier is read-warmth.db.test.ts').
      expect(self.contacts.map((one) => [one.id, one.emails30d, one.emails90d, one.meetings90d])).toEqual([
        row(id("c1"), [3, 3, 0]),
        row(id("c4"), [2, 4, 2]),
        row(id("c5"), [2, 4, 1]),
        ...byId(["m1", "m2", "m3"]).map((key) => row(key, [0, 0, 1])),
        row(id("c2"), [2, 5, 0]),
        row(id("c3"), [2, 4, 0]),
        ...byId(["c6", "c7"]).map((key) => row(key, [1, 1, 0])),
        ...byId(fillers)
          .slice(0, 10)
          .map((key) => row(key, [0, 1, 0])),
      ]);
      expect(self.contacts).toHaveLength(20);
      // A contact is a person, with its name and address.
      expect(self.contacts.find((one) => one.id === id("c1"))).toEqual({
        id: id("c1"),
        kind: "person",
        name: { untrusted: person("c1").name },
        address: { untrusted: person("c1").address },
        emails30d: 3,
        emails90d: 3,
        meetings90d: 0,
      });
      for (const key of ["old", "ahead", "cancelled"])
        expect(self.contacts.map((one) => one.id)).not.toContain(id(key));

      // Upcoming holds the one meeting ahead; the call's row counts both lists.
      expect(self.upcoming.map((meeting) => meeting.title?.untrusted)).toEqual(["canary-g-ahead"]);
      expect(await callLog(store.db.urls.admin)).toEqual([
        { client: "self-client", tool: "get_self", rows: 22, outcome: "ok" },
      ]);
    } finally {
      await store.close();
    }
  });

  it("the windows are closed at both ends: a message or a meeting exactly thirty or ninety days back, or exactly at now, is inside", async () => {
    const store = await openStore({ compartments: ["own"], now: NOW });
    try {
      const seed = storeSeeder(store.writer, NOW);
      const mail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
      const calendar = await store.writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER);
      const owner: Person = { address: OWNER };
      const person = (key: string): Required<Person> => ({ address: `${key}@edges.example.org`, name: `Edge ${key}` });
      const second = 1000;
      const wrote = (key: string, at: Date): Promise<void> =>
        seed.mail(mail, { id: `edge-${key}`, from: person(key), to: [owner], at, subject: `canary-edge-${key}` });
      const met = (key: string, start: Date): Promise<void> =>
        seed.event(calendar, {
          id: `edge-${key}`,
          title: `canary-edge-${key}`,
          start,
          end: hoursFrom(start, 1),
          organizer: owner,
          attendees: [person(key)],
        });

      await wrote("thirty", daysFrom(NOW, -30)); //                                   1, 1, 0
      await wrote("thirty-one", new Date(daysFrom(NOW, -30).getTime() - second)); //  0, 1, 0
      await wrote("ninety", daysFrom(NOW, -90)); //                                   0, 1, 0
      await wrote("ninety-one", new Date(daysFrom(NOW, -90).getTime() - second)); //  none
      await wrote("now", NOW); //                                                     1, 1, 0
      await wrote("ahead", new Date(NOW.getTime() + second)); //                      none: after now
      await met("met-ninety", daysFrom(NOW, -90)); //                                 0, 0, 1
      await met("met-ninety-one", new Date(daysFrom(NOW, -90).getTime() - second)); // none
      await met("met-now", NOW); //                                                   0, 0, 1
      await met("met-ahead", new Date(NOW.getTime() + second)); //                    none: after now

      const { token } = await store.admin.clients.addClient(registration("self-client", ["own"]));
      const self = SelfView.parse(outcomeValue(await store.reader.getSelf(token)));
      const id = (key: string): EntityId => seed.entityOf(person(key).address);
      const byId = (keys: string[]): EntityId[] => keys.map(id).sort();
      // Those met come first: the owner met them, and the others only wrote. With no warmth build
      // the two met tie on every count, so by id.
      expect(self.contacts.map((one) => [one.id, one.emails30d, one.emails90d, one.meetings90d])).toEqual([
        ...byId(["met-now", "met-ninety"]).map((key) => [key, 0, 0, 1]),
        ...byId(["thirty", "now"]).map((key) => [key, 1, 1, 0]),
        ...byId(["thirty-one", "ninety"]).map((key) => [key, 0, 1, 0]),
      ]);

      // A meeting that starts at now exactly is the next one, not the last one.
      const atNow = EntityView.parse(outcomeValue(await store.reader.getEntity(token, { id: id("met-now") })));
      expect([atNow.lastMeeting, atNow.nextMeeting?.title]).toEqual([null, { untrusted: "canary-edge-met-now" }]);
      const justAhead = EntityView.parse(outcomeValue(await store.reader.getEntity(token, { id: id("met-ahead") })));
      expect([justAhead.lastMeeting, justAhead.nextMeeting?.title]).toEqual([
        null,
        { untrusted: "canary-edge-met-ahead" },
      ]);
      const longAgo = EntityView.parse(outcomeValue(await store.reader.getEntity(token, { id: id("met-ninety-one") })));
      expect([longAgo.lastMeeting?.title, longAgo.nextMeeting]).toEqual([
        { untrusted: "canary-edge-met-ninety-one" },
        null,
      ]);
      // The mail counts of an entity are over all time, whatever the windows say.
      expect(
        EntityView.parse(outcomeValue(await store.reader.getEntity(token, { id: id("ninety-one") }))).mail.inbound,
      ).toBe(1);
      expect(
        EntityView.parse(outcomeValue(await store.reader.getEntity(token, { id: id("ahead") }))).mail.inbound,
      ).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("one who only wrote ranks below a correspondent who wrote less; a sender of bulk mail in the ninety days, a no-reply address and the owner's own other address are left out", async () => {
    const store = await openStore({ compartments: ["own"], now: NOW });
    try {
      const seed = storeSeeder(store.writer, NOW);
      const mail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
      const owner: Person = { address: OWNER };
      const friend = { address: "friend@people.example.org", name: "Friend Canary" };
      const lister = { address: "lister@people.example.org", name: "Lister Canary" };
      const letters = { address: "letters@club.example.org", name: "Club Letters" };
      const quiet = { address: "quiet@people.example.org", name: "Quiet Canary" };
      const veteran = { address: "veteran@people.example.org", name: "Veteran Canary" };
      const shop = { address: "orders@shop.example.com", name: "Shop Orders" };
      const noReply = { address: "no-reply@family.example.net", name: "Family Notices" };
      const alias = { address: "owner.alias@people.example.org", name: "Owner Alias" };
      let sent = 0;
      const from = (who: Person, days: number, bulk = false): Promise<void> =>
        seed.mail(mail, {
          id: `auto-${(sent += 1)}`,
          from: who,
          to: [owner],
          at: daysFrom(NOW, -days),
          subject: "canary-auto",
          ...(bulk ? { bulk } : {}),
        });
      const to = (who: Person, days: number): Promise<void> =>
        seed.mail(mail, {
          id: `auto-${(sent += 1)}`,
          from: owner,
          to: [who],
          at: daysFrom(NOW, -days),
          subject: "canary-auto-sent",
          sent: true,
        });

      // emails in 30 days:
      await from(friend, 2); //                                    2: wrote and was written to
      await to(friend, 3);
      await to(lister, 4); //                                      1: written to, so not last for its bulk mail
      await from(lister, 5, true);
      for (const day of [1, 2, 3, 4, 5, 6]) await from(letters, day); // 6: only wrote
      await from(quiet, 7); //                                     1: only wrote
      await from(veteran, 8); //                                   2: only wrote; its bulk mail is older than ninety days
      await from(veteran, 9);
      await from(veteran, 100, true);
      for (const day of [1, 2, 3, 4, 5, 6, 7, 8]) await from(shop, day); // 8: only wrote, and sends bulk mail
      await from(shop, 9, true);
      for (const day of [1, 2, 3]) await to(noReply, day); //     3: written to, at a no-reply address
      for (const day of [1, 2, 3, 4, 5]) await from(alias, day); // 5: the owner's own, declared below
      // The owner declares the address their own; until the next re-derive a person still holds it.
      await store.admin.accounts.addOwnerAddress(alias.address, "own");

      const { token } = await store.admin.clients.addClient(registration("self-client", ["own"]));
      const self = SelfView.parse(outcomeValue(await store.reader.getSelf(token)));
      expect(self.contacts.map((one) => [one.address?.untrusted, one.emails30d])).toEqual([
        [friend.address, 2],
        [lister.address, 1],
        [letters.address, 6],
        [veteran.address, 2],
        [quiet.address, 1],
      ]);
    } finally {
      await store.close();
    }
  });

  it(`a message the owner sent to more than ${WROTE_TO_MAX_RECIPIENTS} recipients, To, Cc and Bcc together, makes none of them one the owner wrote to; one to ${WROTE_TO_MAX_RECIPIENTS} or fewer does`, async () => {
    const store = await openStore({ compartments: ["own"], now: NOW });
    try {
      const seed = storeSeeder(store.writer, NOW);
      const mail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
      const owner: Person = { address: OWNER };
      const people = (group: string, count: number): Person[] =>
        Array.from({ length: count }, (_, n) => ({
          address: `${group}-${String(n + 1).padStart(3, "0")}@guests.example.org`,
        }));
      const crowd = people("crowd", 500);
      const eleven = people("eleven", WROTE_TO_MAX_RECIPIENTS + 1);
      const ten = people("ten", WROTE_TO_MAX_RECIPIENTS);
      const trio = people("trio", 3);
      const pen = { address: "pen@people.example.org", name: "Pen Canary" };
      // Each send is spread over To, Cc and Bcc; each recipient's one message is in thirty days.
      const send = (id: string, to: Person[], days: number): Promise<void> => {
        const third = Math.ceil(to.length / 3);
        return seed.mail(mail, {
          id,
          from: owner,
          to: to.slice(0, third),
          cc: to.slice(third, 2 * third),
          bcc: to.slice(2 * third),
          at: daysFrom(NOW, -days),
          sent: true,
        });
      };
      await send("crowd", crowd, 2);
      await send("eleven", eleven, 3);
      await send("ten", ten, 4);
      await send("trio", trio, 5);
      // Pen only wrote, twice: above those of the large sends, who have one message each.
      for (const day of [6, 7])
        await seed.mail(mail, { id: `pen-${day}`, from: pen, to: [owner], at: daysFrom(NOW, -day) });

      const { token } = await store.admin.clients.addClient(registration("self-client", ["own"]));
      const self = SelfView.parse(outcomeValue(await store.reader.getSelf(token)));
      const listed = self.contacts.map((one) => [one.address?.untrusted, one.emails30d] as const);
      const addresses = (group: Person[]): string[] => group.map((one) => one.address);
      expect(listed).toHaveLength(20);
      expect(
        listed
          .slice(0, 13)
          .map(([address]) => address)
          .sort(),
      ).toEqual([...addresses(trio), ...addresses(ten)].sort());
      expect(listed[13]).toEqual([pen.address, 2]);
      for (const [address, emails30d] of listed.slice(14)) {
        expect([...addresses(eleven), ...addresses(crowd)]).toContain(address);
        expect(emails30d).toBe(1);
      }
    } finally {
      await store.close();
    }
  });

  it("mail the owner sent, or bulk mail, that a client cannot see changes neither its order nor the statements sent", async () => {
    const mixed = await openStore({ now: NOW });
    const bare = await openStore({ now: NOW });
    try {
      const work = "owner.work@example.org";
      const moss = { address: "moss@hidden.example.org", name: "Moss Canary" };
      const lark = { address: "lark@hidden.example.org", name: "Lark Canary" };
      // The same personal mail in both stores: Moss wrote three times, Lark once.
      const seedOwn = async (store: TestStore): Promise<StoreSeeder> => {
        const seed = storeSeeder(store.writer, NOW);
        const mail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
        for (const day of [1, 2, 3])
          await seed.mail(mail, {
            id: `own-moss-${day}`,
            from: moss,
            to: [{ address: OWNER }],
            at: daysFrom(NOW, -day),
          });
        await seed.mail(mail, { id: "own-lark", from: lark, to: [{ address: OWNER }], at: daysFrom(NOW, -4) });
        return seed;
      };
      const seed = await seedOwn(mixed);
      await seedOwn(bare);
      // Only in the mixed store, under employer:example: the owner wrote to Lark, and Moss sent bulk mail.
      const workMail = await mixed.writer.ensureSourceAccount("work", "google_mail", "employer:example", work);
      await seed.mail(workMail, {
        id: "work-to-lark",
        from: { address: work },
        to: [lark],
        at: daysFrom(NOW, -5),
        sent: true,
      });
      await seed.mail(workMail, {
        id: "work-moss-bulk",
        from: moss,
        to: [{ address: work }],
        at: daysFrom(NOW, -6),
        bulk: true,
      });

      let clients = 0;
      const look = async (store: TestStore, compartments: string[]) => {
        const { token } = await store.admin.clients.addClient(
          registration(`self-client-${(clients += 1)}`, compartments),
        );
        const recorded = recordingPool(store.readerPool);
        const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
        const self = SelfView.parse(outcomeValue(await reader.getSelf(token)));
        return {
          order: self.contacts.map((one) => [one.address?.untrusted, one.emails90d]),
          statements: recorded.statements,
        };
      };

      const narrow = await look(mixed, ["own"]);
      expect(narrow.order).toEqual([
        [moss.address, 3],
        [lark.address, 1],
      ]);
      expect(narrow).toEqual(await look(bare, ["own"]));
      // The positive control: a client cleared for both sees the owner wrote to Lark and that Moss
      // sends bulk mail, so Moss is left out.
      expect((await look(mixed, ["own", "employer:example"])).order).toEqual([[lark.address, 2]]);
    } finally {
      await mixed.close();
      await bare.close();
    }
  });
});
