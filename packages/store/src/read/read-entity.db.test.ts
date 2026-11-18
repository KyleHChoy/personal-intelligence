import {
  type EntityId,
  EntityView,
  MessageId,
  type ReadOutcome,
  SearchResult,
  SelfView,
  type TimelineEntry,
  TimelineView,
} from "@intelligence/contracts/personal";
import type { Person } from "@intelligence/personal-core/items";
import { afterAll, describe, expect, it } from "vitest";
import { readAs } from "../test-support/connections.ts";
import { NAMES_KNOWLEDGE } from "../test-support/order.ts";
import { recordingPool } from "../test-support/recording.ts";
import { callLog, openStore, type TestStore } from "../test-support/store.ts";
import {
  daysFrom,
  hoursFrom,
  instant,
  iso,
  MISSING_ENTITY,
  outcomeValue,
  registration,
} from "../test-support/values.ts";
import { seedLines } from "../test-support/warmth-lines.ts";
import { type StoreSeeder, seedWorld, storeSeeder, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";
import { HEAD_LIST } from "./read-card.ts";

// The stores are seeded through the writer, with hand-written people on reserved domains.

const NOW = new Date("2026-03-10T12:00:00.000Z");
const NOT_FOUND = { ok: false, code: "not_found" };

const labelOf = (entry: TimelineEntry): string | undefined =>
  entry.kind === "email"
    ? entry.subject?.untrusted
    : entry.kind === "meeting"
      ? entry.meeting.title?.untrusted
      : undefined;
const mailOf = (view: EntityView) => ({
  ...view.mail,
  firstAt: instant(view.mail.firstAt),
  lastAt: instant(view.mail.lastAt),
});

describe("store", { timeout: 180_000 }, () => {
  it("a hidden id and a missing id are both not_found, for getEntity and getTimeline", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const { token: own } = await store.admin.clients.addClient(registration("own-client", ["own"]));
      const { token: wide } = await store.admin.clients.addClient(
        registration("wide-client", ["own", "employer:example"]),
      );
      const hidden = world.entityOf(WORLD.workOnly.address);
      const recorded = recordingPool(store.readerPool);
      const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });

      // One call as the client can observe it, apart from its duration: the answer, the
      // statements sent for it, and the policy.calls row.
      const observed = async (call: () => Promise<ReadOutcome<unknown>>) => {
        recorded.statements.length = 0;
        const before = (await callLog(store.db.urls.admin)).length;
        const answer = await call();
        return {
          answer,
          statements: [...recorded.statements],
          logged: (await callLog(store.db.urls.admin)).slice(before),
        };
      };

      const tools: [string, (token: string, id: EntityId) => Promise<ReadOutcome<unknown>>][] = [
        ["get_entity", (token, id) => reader.getEntity(token, { id })],
        ["get_timeline", (token, id) => reader.getTimeline(token, { id })],
      ];
      for (const [tool, call] of tools) {
        // The positive control: the id is real, and a client cleared for its compartment sees it.
        expect((await call(wide, hidden)).ok, tool).toBe(true);

        const forHidden = await observed(() => call(own, hidden));
        const forMissing = await observed(() => call(own, MISSING_ENTITY));
        expect(forHidden.answer, tool).toEqual(NOT_FOUND);
        expect(forMissing.answer, tool).toEqual(NOT_FOUND);
        // Alike: the same statements, and the same row in the call log.
        expect(forHidden, tool).toEqual(forMissing);
        expect(forHidden.logged, tool).toEqual([{ client: "own-client", tool, rows: 0, outcome: "not_found" }]);
        expect(
          forHidden.statements.some((text) => NAMES_KNOWLEDGE.test(text)),
          tool,
        ).toBe(true);

        // The owner entity is never returned, even to a client that sees its addresses: its id
        // is refused as a missing one is, with the same statements and the same row logged.
        // The control: under that token the owner's row is one pi_reader does see.
        const owner = world.ownerEntity();
        expect(
          await readAs(store.db, own, (query) =>
            query("select id, kind from knowledge.entities where id = $1", [owner]),
          ),
          tool,
        ).toEqual([{ id: owner, kind: "owner" }]);
        expect(
          await readAs(store.db, own, (query) => query("select id from knowledge.entities where id = $1", [hidden])),
          tool,
        ).toEqual([]);
        expect(await observed(() => call(own, owner)), tool).toEqual(forMissing);
        expect(await call(wide, owner), tool).toEqual(NOT_FOUND);
        // And a person the client does see is found.
        expect((await call(own, world.entityOf(WORLD.both.address))).ok, tool).toBe(true);
      }
    } finally {
      await store.close();
    }
  });

  it("a timeline of 105 entries returns 100, newest first, with from and to inclusive", async () => {
    const store = await openStore({ compartments: ["own"], now: NOW });
    try {
      const seed = storeSeeder(store.writer, NOW);
      const mail = await store.writer.ensureSourceAccount(
        "personal",
        "google_mail",
        "own",
        "owner.timeline@example.com",
      );
      const owner: Person = { address: "owner.timeline@example.com" };
      const tamsin: Person = { address: "tamsin@example.com", name: "Tamsin Timeline" };
      // One hundred and five messages up to now, an hour apart, the newest at now exactly; and
      // one an hour after now.
      for (let k = 0; k < 105; k += 1)
        await seed.mail(mail, {
          id: `timeline-${k}`,
          from: tamsin,
          to: [owner],
          at: hoursFrom(NOW, -k),
          subject: `canary-hour-${k}`,
        });
      await seed.mail(mail, {
        id: "timeline-ahead",
        from: tamsin,
        to: [owner],
        at: hoursFrom(NOW, 1),
        subject: "canary-hour-ahead",
      });
      const { token } = await store.admin.clients.addClient(registration("timeline-client", ["own"]));
      const id = seed.entityOf(tamsin.address);

      const hours = async (args: { from?: Date; to?: Date; limit?: number }): Promise<number[]> => {
        const view = TimelineView.parse(
          outcomeValue(
            await store.reader.getTimeline(token, {
              id,
              ...(args.from === undefined ? {} : { from: iso(args.from) }),
              ...(args.to === undefined ? {} : { to: iso(args.to) }),
              ...(args.limit === undefined ? {} : { limit: args.limit }),
            }),
          ),
        );
        // Each entry as the hours it lies before now.
        return view.entries.map((entry) => (NOW.getTime() - Date.parse(entry.at)) / 3_600_000);
      };
      const range = (first: number, last: number): number[] =>
        Array.from({ length: last - first + 1 }, (_, n) => first + n);

      // At most 100, newest first; `to` defaults to now, inclusive, so the message at now is
      // first and the one after now is absent.
      expect(await hours({})).toEqual(range(0, 99));
      expect(await hours({ limit: 100 })).toEqual(range(0, 99));
      expect(await hours({ limit: 5 })).toEqual(range(0, 4));
      // `from` and `to` are both inclusive.
      expect(await hours({ from: hoursFrom(NOW, -20), to: hoursFrom(NOW, -10) })).toEqual(range(10, 20));
      expect(await hours({ from: hoursFrom(NOW, -3) })).toEqual(range(0, 3));
      expect(await hours({ to: hoursFrom(NOW, -103) })).toEqual(range(103, 104));
      expect(await hours({ from: hoursFrom(NOW, -7), to: hoursFrom(NOW, -7) })).toEqual([7]);
      // A later `to` reaches the message after now; `from` defaults to unbounded.
      expect(await hours({ to: hoursFrom(NOW, 2) })).toEqual(range(-1, 98));
      expect(await hours({ to: hoursFrom(NOW, -50) })).toEqual(range(50, 104));
      expect((await callLog(store.db.urls.admin)).at(-1)).toEqual({
        client: "timeline-client",
        tool: "get_timeline",
        rows: 55,
        outcome: "ok",
      });

      // An email entry, whole.
      const [newest] = TimelineView.parse(
        outcomeValue(await store.reader.getTimeline(token, { id, limit: 1 })),
      ).entries;
      expect(newest).toEqual({
        kind: "email",
        id: expect.stringMatching(/^msg_/),
        at: expect.any(String),
        direction: "inbound",
        subject: { untrusted: "canary-hour-0" },
        thread: { untrusted: "thread-timeline-0" },
      });
    } finally {
      await store.close();
    }
  });
});

// One store for the tests below, seeded once and only read.
//
// Mail, with the owner's address left out of each list:
//   m1  -10d  Xavi -> owner
//   m2   -9d  owner -> Xavi, cc Xavi again (SENT)
//   m3   -1d  Yara -> owner, cc Xavi, Cade
//   m4   -3d  owner -> Yara, Zed (SENT)
//   m5   -2d  Yara -> owner, cc Cade
//   m7, m8  -15d  Yara -> owner, at one instant
//   m9  -20d  Yara -> owner, cc fifty-two people of one organization
//   m10 -100d Nell -> owner, an item with no thread id
// Meetings, each organized by the owner with Xavi:
//   e1 -5d; e2 -2d; e3 -30h, cancelled; e4 +1d, cancelled; e5 +2d; e6 +4d, where Xavi is
//   named "Xavi Renamed"; e7 with no readable time, last changed at -6d.
describe("an entity and its timeline", { timeout: 180_000 }, () => {
  const OWNER = "owner.entity@example.com";
  const xavi = { address: "xavi@quarry.example.org", name: "Xavi Direct" };
  const yara = { address: "yara@quarry.example.org", name: "Yara Sender" };
  const cade = { address: "cade@elsewhere.example.com", name: "Cade Cconly" };
  const zed = { address: "zed@elsewhere.example.com", name: "Zed Second" };
  const nell = { address: "nell@elsewhere.example.com", name: "Nell Nothread" };
  const CROWD: Required<Person>[] = Array.from({ length: 52 }, (_, n) => ({
    address: `member${String(n).padStart(2, "0")}@crowd.example.org`,
    name: `Crowd Member${String(n).padStart(2, "0")}`,
  }));

  let store: TestStore | undefined;
  let seed: StoreSeeder;
  let token = "";
  const at = (days: number): number => daysFrom(NOW, days).getTime();
  const reader = (): Reader => (store as TestStore).reader;
  const entity = async (id: EntityId) => EntityView.parse(outcomeValue(await reader().getEntity(token, { id })));
  const timeline = async (id: EntityId, to?: Date) =>
    TimelineView.parse(
      outcomeValue(await reader().getTimeline(token, { id, ...(to === undefined ? {} : { to: iso(to) }) })),
    ).entries;
  const self = async () => SelfView.parse(outcomeValue(await reader().getSelf(token)));
  const contact = async (id: EntityId) => {
    const found = (await self()).contacts.find((one) => one.id === id);
    return found === undefined ? null : [found.emails30d, found.emails90d, found.meetings90d];
  };

  // The store is seeded once, by the first test that asks, and only read after that. Every test
  // awaits it, so a failure to seed fails each test and skips none.
  let seeded: Promise<void> | undefined;
  const ready = (): Promise<void> => (seeded ??= prepare());
  const prepare = async (): Promise<void> => {
    store = await openStore({ compartments: ["own"], now: NOW });
    seed = storeSeeder(store.writer, NOW);
    const mail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
    const calendar = await store.writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER);
    const owner: Person = { address: OWNER };
    const day = (days: number): Date => daysFrom(NOW, days);

    await seed.mail(mail, { id: "m1", from: xavi, to: [owner], at: day(-10), subject: "canary-m1" });
    await seed.mail(mail, {
      id: "m2",
      from: owner,
      to: [xavi],
      cc: [{ address: xavi.address.toUpperCase() }],
      at: day(-9),
      subject: "canary-m2",
      sent: true,
    });
    await seed.mail(mail, { id: "m3", from: yara, to: [owner], cc: [xavi, cade], at: day(-1), subject: "canary-m3" });
    await seed.mail(mail, { id: "m4", from: owner, to: [yara, zed], at: day(-3), subject: "canary-m4", sent: true });
    await seed.mail(mail, { id: "m5", from: yara, to: [owner], cc: [cade], at: day(-2), subject: "canary-m5" });
    await seed.mail(mail, { id: "m7", from: yara, to: [owner], at: day(-15), subject: "canary-m7" });
    await seed.mail(mail, { id: "m8", from: yara, to: [owner], at: day(-15), subject: "canary-m8" });
    await seed.mail(mail, { id: "m9", from: yara, to: [owner], cc: CROWD, at: day(-20), subject: "canary-m9" });
    await seed.mail(mail, { id: "m10", from: nell, to: [owner], at: day(-100), subject: "canary-m10", thread: null });

    const guest: Person = { address: xavi.address };
    const meeting = (id: string, start: Date | null, more?: { cancelled?: boolean; guest?: Person; updated?: Date }) =>
      seed.event(calendar, {
        id,
        title: `canary-${id}`,
        start,
        end: start === null ? null : hoursFrom(start, 1),
        organizer: owner,
        attendees: [more?.guest ?? guest],
        ...(more?.cancelled === undefined ? {} : { cancelled: more.cancelled }),
        ...(more?.updated === undefined ? {} : { updated: more.updated }),
      });
    await meeting("e1", day(-5));
    await meeting("e2", day(-2));
    await meeting("e3", hoursFrom(NOW, -30), { cancelled: true });
    await meeting("e4", day(1), { cancelled: true });
    await meeting("e5", day(2));
    await meeting("e6", day(4), { guest: { address: xavi.address, name: "Xavi Renamed" } });
    await meeting("e7", null, { updated: day(-6) });

    ({ token } = await store.admin.clients.addClient(registration("entity-client", ["own"])));
  };

  afterAll(async () => {
    await store?.close();
  });

  it("a co-recipient row counts in no contact count and no mail count, but sets lastAt and shows on the timeline", async () => {
    await ready();
    // Cade is only ever a co-recipient of mail the owner received.
    const cadeId = seed.entityOf(cade.address);
    expect(mailOf(await entity(cadeId))).toEqual({ inbound: 0, outbound: 0, firstAt: at(-2), lastAt: at(-1) });
    expect(await contact(cadeId)).toBeNull();
    expect(
      (await timeline(cadeId)).map((entry) => [
        entry.kind,
        labelOf(entry),
        entry.kind === "email" ? entry.direction : null,
      ]),
    ).toEqual([
      ["email", "canary-m3", "inbound"],
      ["email", "canary-m5", "inbound"],
    ]);
    const found = SearchResult.parse(outcomeValue(await reader().search(token, { query: cade.address }))).results;
    expect(found.map((one) => [one.id, instant(one.lastInteractionAt)])).toEqual([[cadeId, at(-1)]]);

    // Xavi wrote once and was written to once; the message Xavi was only copied on (m3) is the
    // latest thing Xavi is on, and counts nowhere.
    const xaviId = seed.entityOf(xavi.address);
    expect(mailOf(await entity(xaviId))).toEqual({ inbound: 1, outbound: 1, firstAt: at(-10), lastAt: at(-1) });
    expect((await contact(xaviId))?.slice(0, 2)).toEqual([2, 2]);
    expect((await timeline(xaviId)).map(labelOf)).toContain("canary-m3");

    // The positive control: the sender of those messages counts each of them.
    const yaraView = await entity(seed.entityOf(yara.address));
    expect(yaraView.mail.inbound).toBe(5);
    expect(await contact(seed.entityOf(yara.address))).toEqual([6, 6, 0]);
  });

  it("an outbound row and an inbound sender row are both counted, once per message", async () => {
    await ready();
    const xaviId = seed.entityOf(xavi.address);
    const yaraId = seed.entityOf(yara.address);
    const zedId = seed.entityOf(zed.address);

    // m1 is Xavi's as its sender and m2 as its recipient. m2 names Xavi twice and counts once.
    const view = await entity(xaviId);
    expect([view.mail.inbound, view.mail.outbound]).toEqual([1, 1]);
    expect(await contact(xaviId)).toEqual([2, 2, 2]);

    // m4 went to two people: it is one message for each of them.
    expect(mailOf(await entity(zedId))).toEqual({ inbound: 0, outbound: 1, firstAt: at(-3), lastAt: at(-3) });
    expect(await contact(zedId)).toEqual([1, 1, 0]);
    const yaraView = await entity(yaraId);
    expect(mailOf(yaraView)).toEqual({ inbound: 5, outbound: 1, firstAt: at(-20), lastAt: at(-1) });

    // Both directions count, and get_self ranks those the owner wrote to by tier, then warmth,
    // from the lines ranked at read, seeded here as their inputs (test-support/warmth-lines.ts):
    // Xavi's two-way mail and two meetings `close`, Yara's one exchange `regular`, Zed's
    // `known`. Nobody else.
    if (store === undefined) throw new Error("no store");
    await seedLines(
      store.db,
      ["own"],
      [
        { entity: xaviId, tier: "close", warmth: 3 },
        { entity: yaraId, tier: "regular", warmth: 2 },
        { entity: zedId, tier: "known", warmth: 1 },
      ],
      { today: NOW },
    );
    expect((await self()).contacts.map((one) => one.id)).toEqual([xaviId, yaraId, zedId]);
    // Search ranks people of one match by tier, then warmth, before the page is cut: Xavi, then Yara; then their organization.
    const found = SearchResult.parse(
      outcomeValue(await reader().search(token, { query: "quarry.example.org" })),
    ).results;
    expect(found.map((one) => one.id).slice(0, 2)).toEqual([xaviId, yaraId]);
    expect(found.map((one) => one.kind)).toEqual(["person", "person", "organization"]);
  });

  it("a person names its organization, and an organization holds its domain and its people, at most HEAD_LIST", async () => {
    await ready();
    const xaviId = seed.entityOf(xavi.address);
    const yaraId = seed.entityOf(yara.address);
    const person = await entity(xaviId);
    expect(person.kind).toBe("person");
    expect(person.people).toEqual([]);
    expect(person.organization).toMatchObject({
      kind: "organization",
      name: null,
      address: { untrusted: "quarry.example.org" },
    });

    const organization = await entity(person.organization?.id as EntityId);
    const who = (id: EntityId, name: string, address: string) => ({
      id,
      kind: "person",
      name: { untrusted: name },
      address: { untrusted: address },
    });
    expect(organization).toEqual({
      id: person.organization?.id,
      kind: "organization",
      names: [],
      addresses: [{ untrusted: "quarry.example.org" }],
      organization: null,
      // By id. A person's name is the alias whose evidence is latest: for Xavi, the meeting at +4d.
      people: [who(xaviId, "Xavi Renamed", xavi.address), who(yaraId, yara.name, yara.address)].sort((one, other) =>
        one.id < other.id ? -1 : 1,
      ),
      mail: { inbound: 0, outbound: 0, firstAt: null, lastAt: null },
      lastMeeting: null,
      nextMeeting: null,
      details: [],
      shared: false,
      // A card's lines, in place of compiled facts.
      lines: [],
      more: false,
    });
    // An organization has no timeline entries of its own.
    expect(await timeline(organization.id as EntityId)).toEqual([]);

    // Fifty-two people share another organization: its card lists the first HEAD_LIST, by id.
    const member = await entity(seed.entityOf(CROWD[0]?.address ?? ""));
    const crowd = await entity(member.organization?.id as EntityId);
    expect(crowd.addresses).toEqual([{ untrusted: "crowd.example.org" }]);
    expect(crowd.people.map((one) => one.id)).toEqual(
      CROWD.map((one) => seed.entityOf(one.address))
        .sort()
        .slice(0, HEAD_LIST),
    );
  });

  it("a person's names are its distinct aliases by value, and its name the one whose evidence is latest", async () => {
    await ready();
    const xaviId = seed.entityOf(xavi.address);
    const view = await entity(xaviId);
    // Three messages and one meeting name the person; two values, each once.
    expect(view.names).toEqual([{ untrusted: "Xavi Direct" }, { untrusted: "Xavi Renamed" }]);
    // One address, though m2 wrote it in two cases.
    expect(view.addresses).toEqual([{ untrusted: xavi.address }]);
    const [found] = SearchResult.parse(outcomeValue(await reader().search(token, { query: xavi.address }))).results;
    expect(found).toMatchObject({
      id: xaviId,
      kind: "person",
      name: { untrusted: "Xavi Renamed" },
      address: { untrusted: xavi.address },
    });
    // The owner is never among the entities a client is given.
    expect(JSON.stringify([view, await timeline(xaviId, daysFrom(NOW, 10))])).not.toContain(OWNER);
  });

  it("lastMeeting is the latest that started before now and nextMeeting the earliest at or after now, cancelled ones left out", async () => {
    await ready();
    const xaviId = seed.entityOf(xavi.address);
    const view = await entity(xaviId);
    const participant = {
      id: xaviId,
      kind: "person",
      name: { untrusted: "Xavi Renamed" },
      address: { untrusted: xavi.address },
    };
    const shown = (meeting: EntityView["lastMeeting"]) =>
      meeting === null ? null : { ...meeting, startsAt: instant(meeting.startsAt), endsAt: instant(meeting.endsAt) };

    // e3, at -30h, is later than e2 but cancelled. The owner organizes and is no participant,
    // and has no response of its own here, so the view has no `response`.
    expect(shown(view.lastMeeting)).toEqual({
      id: expect.stringMatching(/^evt_/),
      title: { untrusted: "canary-e2" },
      startsAt: at(-2),
      endsAt: hoursFrom(daysFrom(NOW, -2), 1).getTime(),
      allDay: false,
      cancelled: false,
      participants: [participant],
    });
    // e4, at +1d, is earlier than e5 but cancelled. e7 has no start and is neither.
    expect(shown(view.nextMeeting)).toMatchObject({
      title: { untrusted: "canary-e5" },
      startsAt: at(2),
      cancelled: false,
      participants: [participant],
    });

    // Meetings in 90 days: e1 and e2. Not the cancelled e3, not one with no start, none ahead.
    expect(await contact(xaviId)).toEqual([2, 2, 2]);
    // Someone in no meeting has neither.
    const zedView = await entity(seed.entityOf(zed.address));
    expect([zedView.lastMeeting, zedView.nextMeeting]).toEqual([null, null]);
  });

  it("a mail item with no thread id is a thread of one: its own message id", async () => {
    await ready();
    const [entry, ...rest] = await timeline(seed.entityOf(nell.address));
    expect(rest).toEqual([]);
    if (entry?.kind !== "email") throw new Error("expected one email entry");
    expect(entry.subject).toEqual({ untrusted: "canary-m10" });
    expect(MessageId.safeParse(entry.id).success).toBe(true);
    // Never an empty string, and never another message's thread.
    expect(entry.thread).toEqual({ untrusted: entry.id });

    // The positive control: a message with a thread id carries that id, not its own.
    const first = (await timeline(seed.entityOf(xavi.address))).find((one) => labelOf(one) === "canary-m1");
    if (first?.kind !== "email") throw new Error("expected an email entry");
    expect(first.thread).toEqual({ untrusted: "thread-m1" });
    expect(first.thread.untrusted).not.toBe(first.id);
  });

  it("a timeline marks a cancelled meeting, dates a meeting with no start by when it was seen, and breaks ties by id", async () => {
    await ready();
    const xaviId = seed.entityOf(xavi.address);
    const row = (entry: TimelineEntry) => [
      entry.kind,
      labelOf(entry),
      instant(entry.at),
      entry.kind === "meeting"
        ? entry.meeting.cancelled
        : entry.kind === "email"
          ? entry.direction
          : entry.kind === "fact"
            ? entry.fact.id
            : entry.kind,
    ];

    // Up to now, newest first.
    const past = [
      ["email", "canary-m3", at(-1), "inbound"],
      ["meeting", "canary-e3", hoursFrom(NOW, -30).getTime(), true],
      ["meeting", "canary-e2", at(-2), false],
      ["meeting", "canary-e1", at(-5), false],
      ["meeting", "canary-e7", at(-6), false],
      ["email", "canary-m2", at(-9), "outbound"],
      ["email", "canary-m1", at(-10), "inbound"],
    ];
    expect((await timeline(xaviId)).map(row)).toEqual(past);
    // With a later `to`, what lies ahead comes first, the cancelled one marked.
    const ahead = await timeline(xaviId, daysFrom(NOW, 10));
    expect(ahead.map(row)).toEqual([
      ["meeting", "canary-e6", at(4), false],
      ["meeting", "canary-e5", at(2), false],
      ["meeting", "canary-e4", at(1), true],
      ...past,
    ]);
    // The meeting with no readable time has no start and no end.
    const unread = ahead.find((entry) => labelOf(entry) === "canary-e7");
    expect(unread?.kind === "meeting" ? [unread.meeting.startsAt, unread.meeting.endsAt] : undefined).toEqual([
      null,
      null,
    ]);

    // A limit cuts the one list of both kinds, newest first, not each kind apart.
    const cut = async (limit: number, to?: Date) =>
      TimelineView.parse(
        outcomeValue(
          await reader().getTimeline(token, { id: xaviId, limit, ...(to === undefined ? {} : { to: iso(to) }) }),
        ),
      ).entries.map(labelOf);
    expect(await cut(1)).toEqual(["canary-m3"]);
    expect(await cut(3)).toEqual(["canary-m3", "canary-e3", "canary-e2"]);
    expect(await cut(6)).toEqual(["canary-m3", "canary-e3", "canary-e2", "canary-e1", "canary-e7", "canary-m2"]);
    expect(await cut(4, daysFrom(NOW, 10))).toEqual(["canary-e6", "canary-e5", "canary-e4", "canary-m3"]);

    // Yara's two messages at one instant come in the order of their ids.
    const entries = await timeline(seed.entityOf(yara.address));
    expect(
      entries
        .map((entry) => [labelOf(entry), instant(entry.at)])
        .filter(([label]) => label !== "canary-m7" && label !== "canary-m8"),
    ).toEqual([
      ["canary-m3", at(-1)],
      ["canary-m5", at(-2)],
      ["canary-m4", at(-3)],
      ["canary-m9", at(-20)],
    ]);
    const tied = entries.slice(3, 5);
    expect(tied.map(labelOf).sort()).toEqual(["canary-m7", "canary-m8"]);
    const ids = tied.map((entry) => (entry.kind === "email" ? entry.id : ""));
    expect(ids).toEqual([...ids].sort());
  });
});
