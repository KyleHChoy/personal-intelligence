import {
  EntityId,
  EntityView,
  type ReadOutcome,
  SearchResult,
  SelfView,
  type TimelineEntry,
  TimelineView,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Keys } from "../core/keys.ts";
import { OWNER_ONLY } from "../test-support/catalogue.ts";
import { KNOWLEDGE, syncedBy, tablesIn } from "../test-support/catalogue-grants.ts";
import { readAs, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { NAMES_KNOWLEDGE } from "../test-support/order.ts";
import { PUBLIC, PUBLIC_NOW, publicMeetingId, publicMemberId, seedPublic } from "../test-support/public.ts";
import { recordingPool } from "../test-support/recording.ts";
import { callLog, knowledgeRowsAs, knowledgeTables, leftOn, openStore, type TestStore } from "../test-support/store.ts";
import {
  daysFrom,
  hoursFrom,
  instant,
  iso,
  MALFORMED_TOKENS,
  MISSING_ENTITY,
  outcomeValue,
  registration as registrationOf,
  UNKNOWN_TOKEN,
} from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";
import { HEAD_LIST } from "./read-card.ts";

// The gates read the same world many times a minute, past the default read budgets, and are no test
// of them: every client gets the most the bounds allow.
const registration = (name: string, compartments: string[]) =>
  registrationOf(name, compartments, {
    quota: { maxItemsDay: 100_000, maxCharsDay: 100_000_000, maxRowsDay: 1_000_000, maxCallsMinute: 600 },
  });

// Gate tests through the Reader: with no token, an unknown token or a revoked token pi_reader sees
// no row; a client cleared only for `public` sees no `own` row, and its counts and order are those
// of an empty store; a client token does not survive its transaction on a pooled connection; and a
// client cleared for `own` sees nothing of employer:example.
//
// Response time is the one thing a client can measure that these tests do not: a timing test
// would be flaky here. Where a rule says a hidden row changes nothing a client sees, the tests
// assert it on everything observable and deterministic instead: the answer and its order and
// counts, the number and text of the statements sent, and the policy.calls row. They do it by
// seeding a twin store in which the hidden rows never existed and comparing the two.

const TIMEOUT = 240_000;
const UNAUTHORIZED = { ok: false, code: "unauthorized" };
const NOT_FOUND = { ok: false, code: "not_found" };

type Call<World> = (reader: Reader, token: string, world: World) => Promise<ReadOutcome<unknown>>;

// One call as a client can observe it, apart from its duration: its answer, the statements the
// reader sent for it, and the policy.calls rows it left. On a reader of its own, with the
// store's keys unless others are given.
async function observed<World>(
  store: TestStore,
  token: string,
  world: World,
  call: Call<World>,
  keys: Keys = store.db.keys,
) {
  const recorded = recordingPool(store.readerPool);
  const reader = new Reader({ pool: recorded.pool, keys, log: store.log, now: () => store.now });
  const before = (await callLog(store.db.urls.admin)).length;
  const answer = await call(reader, token, world);
  const logged = (await callLog(store.db.urls.admin)).slice(before);
  return { answer, statements: recorded.statements, logged };
}

// The keys of some compartments only.
const keysFor = (keys: Keys, compartments: string[]): Keys => ({
  compartments: new Map([...keys.compartments].filter(([name]) => compartments.includes(name))),
  fingerprintKey: keys.fingerprintKey,
});

// A value with every row id replaced by what the fixture calls it, so two stores seeded through
// the writer, whose ids are random, can be compared. An id with no name keeps only its prefix.
// An organization's `people` come by id, so their order is each store's own: they are compared
// by address.
function named(value: unknown, names: Map<string, string>): unknown {
  if (typeof value === "string")
    return /^(ent|msg|evt)_[0-9A-HJKMNP-TV-Z]{26}$/.test(value) ? (names.get(value) ?? value.slice(0, 3)) : value;
  if (Array.isArray(value)) return value.map((one) => named(one, names));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, one]) => {
        const plain = named(one, names);
        return [
          key,
          key === "people" && Array.isArray(plain)
            ? [...plain].sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1))
            : plain,
        ];
      }),
    );
  }
  return value;
}

const labelOf = (entry: TimelineEntry): string | undefined =>
  entry.kind === "email"
    ? entry.subject?.untrusted
    : entry.kind === "meeting"
      ? entry.meeting.title?.untrusted
      : undefined;

describe("the reader's gate", { timeout: TIMEOUT }, () => {
  it("no token, an unknown token and a revoked token each see nothing", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const { token: valid } = await store.admin.clients.addClient(
        registration("wide-client", ["own", "employer:example"]),
      );
      const { token: revoked } = await store.admin.clients.addClient(
        registration("revoked-client", ["own", "employer:example"]),
      );
      expect(await store.admin.clients.revokeClient("revoked-client")).toBe(true);

      // Every knowledge table the catalogue lists is asked: those the reader has a policy on
      // through the queries below, and the owner's own (OWNER_ONLY) refused outright.
      expect(await knowledgeTables(store.db.urls.admin)).toEqual(
        tablesIn("knowledge")
          .map((table) => table.name)
          .sort(),
      );
      const tables = KNOWLEDGE.map((table) => table.name).sort();
      const ownerOnly = tablesIn("knowledge").filter((table) => OWNER_ONLY.includes(table.name));
      expect(ownerOnly.map((table) => table.name).sort()).toEqual(["knowledge.owner_decisions", "knowledge.vetoes"]);
      for (const table of ownerOnly) {
        for (const token of [valid, null]) {
          expect(
            await sqlState(() =>
              readAs(store.db, token, (query) => query(`select ${table.column} from ${table.name}`)),
            ),
            table.name,
          ).toBe("42501");
        }
        // The positive control: the admin's same statement.
        expect(
          await sqlState(() => queryAs(store.db.urls.admin, `select ${table.column} from ${table.name}`)),
          `control: ${table.name}`,
        ).toBeNull();
      }

      // The positive control: with a valid token, the same queries return rows from every table
      // a sync fills. Extraction's tables hold no row of this world.
      const seen = await knowledgeRowsAs(store.db, valid);
      for (const table of tables.filter(syncedBy)) expect(seen[table], table).toBeGreaterThan(0);

      // Through raw SQL as pi_reader: no token set, an empty one, an unknown one, a revoked one,
      // and ones of no token's shape.
      for (const bad of [null, "", UNKNOWN_TOKEN, revoked, ...MALFORMED_TOKENS]) {
        const counts = await knowledgeRowsAs(store.db, bad);
        for (const table of tables)
          expect(
            counts[table],
            `${table} with ${bad === revoked ? "a revoked token" : JSON.stringify(bad?.slice(0, 40))}`,
          ).toBe(0);
      }

      // Through the Reader, where no token is the empty string.
      const blake = world.entityOf(WORLD.both.address);
      for (const bad of ["", UNKNOWN_TOKEN, revoked, ...MALFORMED_TOKENS]) {
        expect(await store.reader.getSelf(bad)).toEqual(UNAUTHORIZED);
        expect(await store.reader.search(bad, { query: "blake" })).toEqual(UNAUTHORIZED);
        expect(await store.reader.getEntity(bad, { id: blake })).toEqual(UNAUTHORIZED);
        expect(await store.reader.getTimeline(bad, { id: blake })).toEqual(UNAUTHORIZED);
        expect(await store.reader.client(bad)).toBeNull();
      }
      expect(await callLog(store.db.urls.admin)).toEqual([]);

      // The positive control: the same four calls answer with a valid token.
      const self = SelfView.parse(outcomeValue(await store.reader.getSelf(valid)));
      expect(self.contacts.length).toBeGreaterThan(0);
      expect(
        SearchResult.parse(outcomeValue(await store.reader.search(valid, { query: "blake" }))).results.map(
          (one) => one.id,
        ),
      ).toEqual([blake]);
      expect(EntityView.parse(outcomeValue(await store.reader.getEntity(valid, { id: blake }))).id).toBe(blake);
      expect(
        TimelineView.parse(outcomeValue(await store.reader.getTimeline(valid, { id: blake }))).entries.length,
      ).toBeGreaterThan(0);
      expect((await store.reader.client(valid))?.name).toBe("wide-client");
    } finally {
      await store.close();
    }
  });

  it("a public client sees only public rows", async () => {
    const mixed = await openStore({ compartments: ["own", "public"], now: PUBLIC_NOW, writer: false });
    let bare: TestStore | undefined;
    let flipped: TestStore | undefined;
    try {
      // Two twins, with the same keys and the same ids: one with the `own` rows never written,
      // and one with every row, written so that each table's physical order runs against its ids.
      bare = await openStore({ keyFile: mixed.db.keyFile, now: PUBLIC_NOW, writer: false });
      flipped = await openStore({ keyFile: mixed.db.keyFile, now: PUBLIC_NOW, writer: false });
      // An entity id has no time part. They sort: owner, A, B, C, D, the members, the organization.
      const ids = {
        owner: EntityId.parse(`ent_0${"0".repeat(25)}`),
        a: EntityId.parse(`ent_1${"A".repeat(25)}`),
        b: EntityId.parse(`ent_2${"B".repeat(25)}`),
        c: EntityId.parse(`ent_3${"C".repeat(25)}`),
        d: EntityId.parse(`ent_4${"D".repeat(25)}`),
        org: EntityId.parse(`ent_6${"G".repeat(25)}`),
      };
      await seedPublic(mixed.db.urls.admin, mixed.db.keys, ids);
      await seedPublic(bare.db.urls.admin, bare.db.keys, ids, { only: ["public"] });
      await seedPublic(flipped.db.urls.admin, flipped.db.keys, ids, { reversed: true });

      const { token: narrow } = await mixed.admin.clients.addClient(registration("public-client", ["public"]));
      const { token: wide } = await mixed.admin.clients.addClient(registration("wide-client", ["own", "public"]));
      const { token: alone } = await bare.admin.clients.addClient(registration("public-client", ["public"]));
      const { token: turned } = await flipped.admin.clients.addClient(registration("public-client", ["public"]));
      const { token: turnedWide } = await flipped.admin.clients.addClient(
        registration("wide-client", ["own", "public"]),
      );
      const { reader } = mixed;
      const counts = (view: SelfView) =>
        view.contacts.map((one) => [one.id, one.emails30d, one.emails90d, one.meetings90d]);
      const at = (days: number): number => daysFrom(PUBLIC_NOW, -days).getTime();
      const search = async (token: string, query: string) =>
        SearchResult.parse(outcomeValue(await reader.search(token, { query }))).results;
      const entity = async (token: string, id: EntityId) =>
        EntityView.parse(outcomeValue(await reader.getEntity(token, { id })));
      const visible = Array.from({ length: PUBLIC.members.visible }, (_, n) => publicMemberId("visible", n));
      const hidden = Array.from({ length: PUBLIC.members.hidden }, (_, n) => publicMemberId("hidden", n));
      // The week in which B has `own` messages and no `public` one.
      const hiddenWeek = { from: iso(daysFrom(PUBLIC_NOW, -10)), to: iso(daysFrom(PUBLIC_NOW, -6.5)) };

      // The positive control: a client cleared for `own` as well counts the `own` rows, which
      // puts B first, finds C and D, and sees B's other name, the hidden meeting and the hidden
      // members.
      const wideB = await entity(wide, ids.b);
      expect(wideB.mail.inbound).toBe(8);
      expect([instant(wideB.mail.firstAt), instant(wideB.mail.lastAt)]).toEqual([at(40), at(0.5)]);
      expect(wideB.names).toEqual([{ untrusted: PUBLIC.b.name }, { untrusted: PUBLIC.b.ownName }]);
      expect(wideB.nextMeeting?.title).toEqual({ untrusted: PUBLIC.meetings.own });
      expect((await search(wide, "avery")).map((one) => [one.id, one.name?.untrusted])).toEqual([
        [ids.b, PUBLIC.b.ownName],
        [ids.a, PUBLIC.a.name],
      ]);
      expect((await search(wide, "hiddenalias")).map((one) => one.id)).toEqual([ids.b]);
      expect((await search(wide, "corin")).map((one) => one.id)).toEqual([ids.c]);
      expect((await entity(wide, ids.c)).mail.inbound).toBe(2);
      expect((await entity(wide, ids.d)).mail).toMatchObject({ inbound: 1, outbound: 0 });
      const wideSelf = SelfView.parse(outcomeValue(await reader.getSelf(wide)));
      expect(counts(wideSelf)).toEqual([
        [ids.b, 7, 8, 0],
        [ids.a, 3, 3, 0],
        [ids.c, 2, 2, 0],
        [ids.d, 1, 1, 0],
      ]);
      expect(wideSelf.upcoming.map((meeting) => meeting.title?.untrusted)).toEqual([
        PUBLIC.meetings.own,
        PUBLIC.meetings.one,
        PUBLIC.meetings.two,
      ]);
      expect(
        TimelineView.parse(
          outcomeValue(await reader.getTimeline(wide, { id: ids.b, from: iso(daysFrom(PUBLIC_NOW, -60)) })),
        ).entries,
      ).toHaveLength(8);
      expect(
        TimelineView.parse(outcomeValue(await reader.getTimeline(wide, { id: ids.b, ...hiddenWeek }))).entries,
      ).toHaveLength(3);
      expect(TimelineView.parse(outcomeValue(await reader.getTimeline(wide, { id: ids.d }))).entries).toHaveLength(2);
      expect((await entity(wide, ids.org)).people.map((one) => one.id)).toEqual(
        [ids.a, ids.b, ids.d, ...[...visible, ...hidden].sort()].slice(0, HEAD_LIST),
      );

      // The client cleared for `public` alone.
      const who = (id: EntityId, person: { name: string; address: string }) => ({
        id,
        kind: "person",
        name: { untrusted: person.name },
        address: { untrusted: person.address },
      });
      const organization = { id: ids.org, kind: "organization", name: null, address: { untrusted: PUBLIC.domain } };
      const b = await entity(narrow, ids.b);
      expect(b.mail.inbound).toBe(3);
      const shown = (meeting: EntityView["nextMeeting"]) =>
        meeting === null ? null : { ...meeting, startsAt: instant(meeting.startsAt), endsAt: instant(meeting.endsAt) };
      expect({
        ...b,
        mail: { ...b.mail, firstAt: instant(b.mail.firstAt), lastAt: instant(b.mail.lastAt) },
        nextMeeting: shown(b.nextMeeting),
      }).toEqual({
        id: ids.b,
        kind: "person",
        names: [{ untrusted: PUBLIC.b.name }],
        addresses: [{ untrusted: PUBLIC.b.address }],
        organization,
        people: [],
        mail: { inbound: 3, outbound: 0, firstAt: at(6), lastAt: at(4) },
        lastMeeting: null,
        // What the page leads with, of the public rows alone: the same last message `mail` counts, the
        // same next meeting, and no tier or tie.
        lead: {
          lastContact: "message",
          lastMeeting: null,
          lastThread: { at: new Date(at(4)).toISOString(), message: expect.stringMatching(/^msg_/) },
          nextStep: {
            at: new Date(at(-1)).toISOString(),
            kind: "meeting",
            meeting: publicMeetingId("two"),
          },
          openCommitments: null,
          organization: null,
          role: null,
          tie: null,
          tier: null,
        },
        nextMeeting: {
          id: publicMeetingId("two"),
          title: { untrusted: PUBLIC.meetings.two },
          startsAt: at(-1),
          endsAt: hoursFrom(daysFrom(PUBLIC_NOW, 1), 1).getTime(),
          allDay: false,
          cancelled: false,
          participants: [who(ids.b, PUBLIC.b)],
        },
        details: [],
        shared: false,
        // A card's lines, in place of compiled facts.
        lines: [],
        more: false,
        // The card counts the public rows alone; the meeting is to come.
        current: {},
        // No warmth build ran, so the audience is rebuilding.
        warmth: {
          tier: null,
          tierSource: null,
          dormant: false,
          warmth: null,
          active: null,
          depth: null,
          firstTwoWayAt: null,
          lastTwoWayAt: null,
          replyRate: null,
          replyHours: null,
          theyStart: null,
          channels: [],
          stale: false,
          rebuilding: true,
        },
        knownVia: {
          firstThread: { at: new Date(at(6)).toISOString(), message: expect.stringMatching(/^msg_/) },
          meetings: null,
          sharedMailDomain: organization,
          coRecipients: [],
        },
      });

      // A, then B, by id: both have three visible messages. If `own` rows were counted, B would
      // come first; and B's name is its `public` one, though its `own` one is on a later item.
      const found = await search(narrow, "avery");
      expect(found.map((one) => ({ ...one, lastInteractionAt: instant(one.lastInteractionAt) }))).toEqual([
        { ...who(ids.a, PUBLIC.a), lastInteractionAt: at(1) },
        { ...who(ids.b, PUBLIC.b), lastInteractionAt: at(4) },
      ]);
      const self = SelfView.parse(outcomeValue(await reader.getSelf(narrow)));
      expect(counts(self)).toEqual([
        [ids.a, 3, 3, 0],
        [ids.b, 3, 3, 0],
      ]);
      expect(self.addresses).toEqual([{ untrusted: PUBLIC.ownerAddress.public }]);
      // The two meetings at one instant, by id, and not the `own` one before them.
      expect(
        self.upcoming.map((meeting) => [
          meeting.id,
          meeting.title?.untrusted,
          meeting.participants.map((one) => one.id),
        ]),
      ).toEqual([
        [publicMeetingId("one"), PUBLIC.meetings.one, [ids.a]],
        [publicMeetingId("two"), PUBLIC.meetings.two, [ids.b]],
      ]);

      // No C, by name, by address or by id. No name of B's that only `own` shows.
      expect(await search(narrow, "corin")).toEqual([]);
      expect(await search(narrow, PUBLIC.c.address)).toEqual([]);
      expect(await reader.getEntity(narrow, { id: ids.c })).toEqual(NOT_FOUND);
      expect(await reader.getTimeline(narrow, { id: ids.c })).toEqual(NOT_FOUND);
      expect(await search(narrow, "hiddenalias")).toEqual([]);

      // No D: it has a `public` interaction row, and no account row the client can see. An
      // entity is reached only through a visible account or domain row.
      expect(await knowledgeRowsAs(mixed.db, narrow)).toMatchObject({
        "knowledge.interaction_log": 7,
        "knowledge.messages": 7,
        "knowledge.entities": 3 + PUBLIC.members.visible + 1,
      });
      expect(await search(narrow, "dara")).toEqual([]);
      expect(await search(narrow, PUBLIC.d.address)).toEqual([]);
      expect(await reader.getEntity(narrow, { id: ids.d })).toEqual(NOT_FOUND);
      expect(await reader.getTimeline(narrow, { id: ids.d })).toEqual(NOT_FOUND);
      expect(self.contacts.map((one) => one.id)).not.toContain(ids.d);

      // The organization's people: the first HEAD_LIST the client can see, by id. Ten hidden
      // members sort among the first twenty, so a cap taken before they are gone would return fewer.
      const org = await entity(narrow, ids.org);
      expect(org.people.map((one) => one.id)).toEqual([ids.a, ids.b, ...visible].slice(0, HEAD_LIST));
      expect(org.people).toHaveLength(HEAD_LIST);
      expect(org.addresses).toEqual([{ untrusted: PUBLIC.domain }]);

      // B's timeline: its `public` messages, and nothing in the week that holds only `own` ones.
      const timeline = async (id: EntityId, window: object = {}) =>
        TimelineView.parse(outcomeValue(await reader.getTimeline(narrow, { id, ...window }))).entries.map((entry) => [
          entry.kind,
          instant(entry.at),
          labelOf(entry),
        ]);
      expect(await timeline(ids.b, { from: iso(daysFrom(PUBLIC_NOW, -60)) })).toEqual([
        ["email", at(4), "open subject b 0"],
        ["email", at(5), "open subject b 1"],
        ["email", at(6), "open subject b 2"],
      ]);
      expect(await timeline(ids.b, hiddenWeek)).toEqual([]);
      // A's two messages at one instant come by id.
      expect(await timeline(ids.a)).toEqual([
        ["email", at(1), "open subject a 0"],
        ["email", at(2), "open subject a 1"],
        ["email", at(2), "open subject a 2"],
      ]);

      // Its counts and order are those of a store without the `own` rows: every answer, the
      // statements sent for it and the row it leaves in policy.calls are the same in the twin.
      // They are the same again in the store written against id order, where a reader that
      // returned rows as the tables give them would answer otherwise; and the same from a reader
      // whose keys lack `own`, which can open nothing the token's rows do not hold.
      const far = { from: iso(daysFrom(PUBLIC_NOW, -60)), to: iso(daysFrom(PUBLIC_NOW, 2)) };
      const calls: [string, Call<null>][] = [
        ["get_self", (r, t) => r.getSelf(t)],
        ["search avery", (r, t) => r.search(t, { query: "avery" })],
        ["search example", (r, t) => r.search(t, { query: "example" })],
        ["search member, three", (r, t) => r.search(t, { query: "member", limit: 3 })],
        ["search brook", (r, t) => r.search(t, { query: "brook", limit: 1 })],
        ["search corin", (r, t) => r.search(t, { query: "corin" })],
        ["search C's address", (r, t) => r.search(t, { query: PUBLIC.c.address })],
        ["search B's hidden name", (r, t) => r.search(t, { query: "hiddenalias" })],
        ["search dara", (r, t) => r.search(t, { query: "dara" })],
        ["search D's address", (r, t) => r.search(t, { query: PUBLIC.d.address })],
        ["get_entity A", (r, t) => r.getEntity(t, { id: ids.a })],
        ["get_entity B", (r, t) => r.getEntity(t, { id: ids.b })],
        ["get_entity C", (r, t) => r.getEntity(t, { id: ids.c })],
        ["get_entity D", (r, t) => r.getEntity(t, { id: ids.d })],
        ["get_entity the organization", (r, t) => r.getEntity(t, { id: ids.org })],
        ["get_entity a member", (r, t) => r.getEntity(t, { id: publicMemberId("visible", 3) })],
        ["get_entity a hidden member", (r, t) => r.getEntity(t, { id: publicMemberId("hidden", 3) })],
        ["get_entity the owner", (r, t) => r.getEntity(t, { id: ids.owner })],
        ["get_timeline A", (r, t) => r.getTimeline(t, { id: ids.a })],
        ["get_timeline A, two entries", (r, t) => r.getTimeline(t, { id: ids.a, limit: 2 })],
        ["get_timeline B", (r, t) => r.getTimeline(t, { id: ids.b })],
        ["get_timeline B, a wide window", (r, t) => r.getTimeline(t, { id: ids.b, ...far })],
        ["get_timeline B, the hidden week", (r, t) => r.getTimeline(t, { id: ids.b, ...hiddenWeek })],
        ["get_timeline B, one entry", (r, t) => r.getTimeline(t, { id: ids.b, limit: 1 })],
        ["get_timeline C", (r, t) => r.getTimeline(t, { id: ids.c })],
        ["get_timeline D", (r, t) => r.getTimeline(t, { id: ids.d })],
      ];
      const publicKeys = keysFor(mixed.db.keys, ["public"]);
      for (const [name, call] of calls) {
        const inMixed = await observed(mixed, narrow, null, call);
        expect(inMixed, `${name}, without the own rows`).toEqual(await observed(bare, alone, null, call));
        expect(inMixed, `${name}, written against id order`).toEqual(await observed(flipped, turned, null, call));
        expect(inMixed, `${name}, without the own key`).toEqual(await observed(mixed, narrow, null, call, publicKeys));
        expect(inMixed.logged, name).toHaveLength(1);
        expect(
          inMixed.statements.some((text) => NAMES_KNOWLEDGE.test(text)),
          name,
        ).toBe(true);
        const text = JSON.stringify(inMixed.answer);
        for (const needle of PUBLIC.ownNeedles) expect(text, `${name} holds ${needle}`).not.toContain(needle);
        // The wide client's answers do not turn on the tables' physical order either.
        expect((await observed(mixed, wide, null, call)).answer, `${name}, wide, written against id order`).toEqual(
          (await observed(flipped, turnedWide, null, call)).answer,
        );
      }
      // The positive control for the needles: the wide client's answers hold them.
      const wideText = JSON.stringify([
        wideSelf,
        wideB,
        await reader.getTimeline(wide, { id: ids.c }),
        await entity(wide, ids.c),
        await entity(wide, ids.d),
      ]);
      for (const needle of PUBLIC.ownNeedles) expect(wideText, needle).toContain(needle);
    } finally {
      await flipped?.close();
      await bare?.close();
      await mixed.close();
    }
  });

  it("a client cleared for own sees nothing of employer:example", async () => {
    const mixed = await openStore({ now: WORLD_NOW });
    let bare: TestStore | undefined;
    try {
      // The twin: the same world, as if the work account had never been connected.
      bare = await openStore({ now: WORLD_NOW });
      const seeded = await seedWorld(mixed.writer, mixed.admin);
      const bareSeeded = await seedWorld(bare.writer, bare.admin, { labels: ["personal"] });

      const { token: own } = await mixed.admin.clients.addClient(registration("own-client", ["own"]));
      const { token: wide } = await mixed.admin.clients.addClient(
        registration("wide-client", ["own", "employer:example"]),
      );
      const { token: alone } = await bare.admin.clients.addClient(registration("own-client", ["own"]));
      const { reader } = mixed;

      const blake = seeded.entityOf(WORLD.both.address);
      const pat = seeded.entityOf(WORLD.ownOnly.address);
      const wren = seeded.entityOf(WORLD.workOnly.address);
      const owner = seeded.ownerEntity();
      const at = (days: number): number => daysFrom(WORLD_NOW, days).getTime();
      const counts = (view: SelfView) =>
        view.contacts.map((one) => [one.id, one.emails30d, one.emails90d, one.meetings90d]);
      const titles = (view: SelfView) => view.upcoming.map((meeting) => meeting.title?.untrusted);
      const ids = (result: SearchResult) => result.results.map((one) => one.id);
      const search = async (token: string, query: string) =>
        SearchResult.parse(outcomeValue(await reader.search(token, { query })));
      const ahead = { to: iso(daysFrom(WORLD_NOW, 30)) };
      // The days in which Blake wrote only under the employer's label.
      const workDays = { from: iso(daysFrom(WORLD_NOW, -21)), to: iso(daysFrom(WORLD_NOW, -19)) };
      // The organization of a domain, as a client finds it.
      const organizationOf = async (store: TestStore, token: string, domain: string): Promise<EntityId> => {
        const found = SearchResult.parse(
          outcomeValue(await store.reader.search(token, { query: domain })),
        ).results.find((one) => one.kind === "organization");
        if (found === undefined) throw new Error(`no organization for ${domain}`);
        return found.id as EntityId;
      };
      type World = { entityOf(address: string): EntityId; organization: EntityId };
      const world: World = { entityOf: seeded.entityOf, organization: await organizationOf(mixed, own, "example.com") };
      const bareWorld: World = {
        entityOf: bareSeeded.entityOf,
        organization: await organizationOf(bare, alone, "example.com"),
      };

      // The positive control: a client cleared for both sees both people and the full counts. Within
      // a place they rank by tier and warmth; no warmth build ran, so the audience is
      // rebuilding and they rank by volume: Wren, then Blake. Pat was never written to, so comes
      // after both.
      const wideSelf = SelfView.parse(outcomeValue(await reader.getSelf(wide)));
      expect(counts(wideSelf)).toEqual([
        [wren, 7, 7, 1],
        [blake, 6, 6, 1],
        [pat, 1, 1, 0],
      ]);
      expect(titles(wideSelf)).toEqual([WORLD.workMeetingNext, WORLD.ownMeeting]);
      expect(wideSelf.addresses.map((one) => one.untrusted).sort()).toEqual(
        [WORLD.ownerPersonal, WORLD.ownerWork].sort(),
      );
      expect(ids(await search(wide, WORLD.workOnly.address))).toEqual([wren]);
      expect(ids(await search(wide, "wren"))).toEqual([wren]);
      expect(ids(await search(wide, WORLD.both.workName.toLowerCase()))).toEqual([blake]);
      expect((await search(wide, "example.org")).results.map((one) => one.kind).sort()).toEqual([
        "organization",
        "person",
      ]);
      expect(EntityView.parse(outcomeValue(await reader.getEntity(wide, { id: wren }))).mail).toMatchObject({
        inbound: 6,
        outbound: 1,
      });
      expect(
        TimelineView.parse(outcomeValue(await reader.getTimeline(wide, { id: wren }))).entries.length,
      ).toBeGreaterThan(0);
      const wideBlake = EntityView.parse(outcomeValue(await reader.getEntity(wide, { id: blake })));
      expect(wideBlake.names).toEqual([{ untrusted: WORLD.both.ownName }, { untrusted: WORLD.both.workName }]);
      expect(wideBlake.addresses).toEqual([{ untrusted: WORLD.both.address }]);
      expect({
        ...wideBlake.mail,
        firstAt: instant(wideBlake.mail.firstAt),
        lastAt: instant(wideBlake.mail.lastAt),
      }).toEqual({
        inbound: 4,
        outbound: 2,
        firstAt: at(-20),
        lastAt: at(-1),
      });
      expect(wideBlake.lastMeeting?.title).toEqual({ untrusted: WORLD.workMeetingLast });
      expect(wideBlake.lastMeeting?.participants.map((one) => one.id).sort()).toEqual([blake, wren].sort());
      expect(wideBlake.nextMeeting?.title).toEqual({ untrusted: WORLD.workMeetingNext });
      expect(
        TimelineView.parse(outcomeValue(await reader.getTimeline(wide, { id: blake, ...ahead }))).entries.map(labelOf),
      ).toEqual([
        WORLD.ownMeeting,
        WORLD.workMeetingNext,
        "canary-work-subject-new",
        WORLD.ownSubjects.second,
        WORLD.workMeetingLast,
        WORLD.ownSubjects.sent,
        WORLD.ownSubjects.first,
        "canary-work-subject-sent",
        "canary-work-subject-old",
      ]);
      expect(
        TimelineView.parse(outcomeValue(await reader.getTimeline(wide, { id: blake, ...workDays }))).entries.map(
          labelOf,
        ),
      ).toEqual(["canary-work-subject-old"]);
      // Blake's latest name of all is the work one.
      expect((await search(wide, WORLD.both.address)).results[0]?.name).toEqual({ untrusted: WORLD.both.workName });

      // A person seen only in work mail is not found, by search, by id, or among the contacts.
      expect(ids(await search(own, WORLD.workOnly.address))).toEqual([]);
      expect(ids(await search(own, "wren"))).toEqual([]);
      expect(ids(await search(own, "example.org"))).toEqual([]);
      expect(await reader.getEntity(own, { id: wren })).toEqual(NOT_FOUND);
      expect(await reader.getTimeline(own, { id: wren })).toEqual(NOT_FOUND);
      const self = SelfView.parse(outcomeValue(await reader.getSelf(own)));
      expect(counts(self)).toEqual([
        [blake, 3, 3, 0],
        [pat, 1, 1, 0],
      ]);

      // A work meeting is absent from upcoming, and the owner's work address from addresses.
      expect(titles(self)).toEqual([WORLD.ownMeeting]);
      expect(self.upcoming[0]?.participants.map((one) => one.id)).toEqual([blake]);
      expect(self.addresses).toEqual([{ untrusted: WORLD.ownerPersonal }]);

      // A person seen under both labels shows only the `own` interactions, names, addresses,
      // meetings and timeline entries, and only the `own` times: when it was first seen under
      // the employer's label is not shown. Its name is the latest `own` one, and it is not
      // found by the name only the employer's label shows.
      const view = EntityView.parse(outcomeValue(await reader.getEntity(own, { id: blake })));
      expect(view.names).toEqual([{ untrusted: WORLD.both.ownName }]);
      expect(view.addresses).toEqual([{ untrusted: WORLD.both.address }]);
      expect({ ...view.mail, firstAt: instant(view.mail.firstAt), lastAt: instant(view.mail.lastAt) }).toEqual({
        inbound: 2,
        outbound: 1,
        firstAt: at(-5),
        lastAt: at(-2),
      });
      expect(view.lastMeeting).toBeNull();
      expect(view.nextMeeting?.title).toEqual({ untrusted: WORLD.ownMeeting });
      expect(view.nextMeeting?.participants.map((one) => one.id)).toEqual([blake]);
      expect(
        TimelineView.parse(outcomeValue(await reader.getTimeline(own, { id: blake, ...ahead }))).entries.map(labelOf),
      ).toEqual([WORLD.ownMeeting, WORLD.ownSubjects.second, WORLD.ownSubjects.sent, WORLD.ownSubjects.first]);
      expect(
        TimelineView.parse(outcomeValue(await reader.getTimeline(own, { id: blake, ...workDays }))).entries,
      ).toEqual([]);
      expect(ids(await search(own, WORLD.both.workName.toLowerCase()))).toEqual([]);
      expect((await search(own, WORLD.both.address)).results.map((one) => [one.id, one.name])).toEqual([
        [blake, { untrusted: WORLD.both.ownName }],
      ]);

      // The organization of example.com holds the two people seen under `own`, by id, each under
      // its `own` name; and never the owner, whose own address is on that domain.
      const blakeAsOwn = {
        id: blake,
        kind: "person",
        name: { untrusted: WORLD.both.ownName },
        address: { untrusted: WORLD.both.address },
      };
      const patAsOwn = {
        id: pat,
        kind: "person",
        name: { untrusted: WORLD.ownOnly.name },
        address: { untrusted: WORLD.ownOnly.address },
      };
      const organization = EntityView.parse(outcomeValue(await reader.getEntity(own, { id: world.organization })));
      expect(organization.people).toEqual([blakeAsOwn, patAsOwn].sort((left, right) => (left.id < right.id ? -1 : 1)));
      expect(organization.addresses).toEqual([{ untrusted: "example.com" }]);
      const widePeople = EntityView.parse(
        outcomeValue(await reader.getEntity(wide, { id: world.organization })),
      ).people;
      expect(widePeople.map((one) => one.id)).toEqual([blake, pat].sort());
      for (const text of [JSON.stringify(organization), JSON.stringify(widePeople)]) {
        expect(text).not.toContain(owner);
        expect(text).not.toContain(WORLD.ownerPersonal);
      }
      // The positive control: the owner's account row on that domain is one the client's token sees.
      expect((await knowledgeRowsAs(mixed.db, own))["knowledge.accounts"]).toBe(3);

      // And everything else observable is as in a store the work account never reached: the
      // answers (with each store's own random ids named), the statements, the policy.calls rows.
      // The answers are the same from a reader whose keys lack the employer's compartment, which
      // can open nothing the token's rows do not hold; and the same from a reader that has just
      // answered the wide client, which may carry nothing from one call to the next.
      const names = (one: World): Map<string, string> =>
        new Map([
          [one.entityOf(WORLD.both.address), "blake"],
          [one.entityOf(WORLD.ownOnly.address), "pat"],
          [one.organization, "example.com"],
        ]);
      const calls: [string, Call<World>][] = [
        ["get_self", (r, t) => r.getSelf(t)],
        ["search canary", (r, t) => r.search(t, { query: "canary" })],
        ["search blake", (r, t) => r.search(t, { query: "blake" })],
        ["search Blake's address", (r, t) => r.search(t, { query: WORLD.both.address })],
        ["search Blake's work name", (r, t) => r.search(t, { query: WORLD.both.workName.toLowerCase() })],
        ["search wren", (r, t) => r.search(t, { query: "wren" })],
        ["search the work-only address", (r, t) => r.search(t, { query: WORLD.workOnly.address })],
        ["search example.org", (r, t) => r.search(t, { query: "example.org" })],
        ["search example.com", (r, t) => r.search(t, { query: "example.com" })],
        ["get_entity Blake", (r, t, w) => r.getEntity(t, { id: w.entityOf(WORLD.both.address) })],
        ["get_entity Pat", (r, t, w) => r.getEntity(t, { id: w.entityOf(WORLD.ownOnly.address) })],
        ["get_entity example.com", (r, t, w) => r.getEntity(t, { id: w.organization })],
        ["get_entity nobody", (r, t) => r.getEntity(t, { id: MISSING_ENTITY })],
        ["get_timeline Blake", (r, t, w) => r.getTimeline(t, { id: w.entityOf(WORLD.both.address) })],
        ["get_timeline Blake, ahead", (r, t, w) => r.getTimeline(t, { id: w.entityOf(WORLD.both.address), ...ahead })],
        [
          "get_timeline Blake, back",
          (r, t, w) =>
            r.getTimeline(t, { id: w.entityOf(WORLD.both.address), from: iso(hoursFrom(WORLD_NOW, -24 * 60)) }),
        ],
        [
          "get_timeline Blake, the work days",
          (r, t, w) => r.getTimeline(t, { id: w.entityOf(WORLD.both.address), ...workDays }),
        ],
        ["get_timeline Pat", (r, t, w) => r.getTimeline(t, { id: w.entityOf(WORLD.ownOnly.address) })],
      ];
      const ownKeys = keysFor(mixed.db.keys, ["own"]);
      const carried = new Reader({ pool: mixed.readerPool, keys: mixed.db.keys, log: mixed.log, now: () => mixed.now });
      for (const [name, call] of calls) {
        const inMixed = await observed(mixed, own, world, call);
        const inBare = await observed(bare, alone, bareWorld, call);
        expect({ ...inMixed, answer: named(inMixed.answer, names(world)) }, name).toEqual({
          ...inBare,
          answer: named(inBare.answer, names(bareWorld)),
        });
        expect(inMixed.logged, name).toHaveLength(1);
        const text = JSON.stringify(inMixed.answer);
        for (const needle of [...WORLD.workNeedles, wren, owner])
          expect(text, `${name} holds ${needle}`).not.toContain(needle);

        expect(
          (await observed(mixed, own, world, call, ownKeys)).answer,
          `${name}, without the employer's key`,
        ).toEqual(inMixed.answer);
        // The wide client first, then the `own` client, on one reader.
        await call(carried, wide, world);
        expect(await call(carried, own, world), `${name}, after the wide client`).toEqual(inMixed.answer);
      }
      // The positive control for the needles: the wide client's answers hold them.
      const wideText = JSON.stringify([
        wideSelf,
        wideBlake,
        await reader.getTimeline(wide, { id: blake, ...ahead }),
        await search(wide, "example.org"),
      ]);
      for (const needle of [...WORLD.workNeedles, wren]) expect(wideText, needle).toContain(needle);
    } finally {
      await bare?.close();
      await mixed.close();
    }
  });

  it("the token does not survive its transaction", async () => {
    const store = await openStore({ now: WORLD_NOW, readerMax: 1 });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const { token } = await store.admin.clients.addClient(registration("wide-client", ["own", "employer:example"]));
      const blake = world.entityOf(WORLD.both.address);
      const count = "select count(*)::int as n from knowledge.accounts";
      const rows = async (client: {
        query(text: string): Promise<{ rows: { n: number }[] }>;
      }): Promise<number | undefined> => (await client.query(count)).rows[0]?.n;

      // On the pool's one connection: rows inside the transaction, none after it ends.
      const first = await store.readerPool.connect();
      let backend: unknown;
      try {
        backend = (await first.query("select pg_backend_pid() as pid")).rows[0]?.pid;
        for (const end of ["commit", "rollback"]) {
          await first.query("begin");
          await first.query("select set_config('pi.client_token', $1, true)", [token]);
          expect(await rows(first), `before ${end}`).toBeGreaterThan(0);
          await first.query(end);
          expect(await rows(first), `after ${end}`).toBe(0);
        }
      } finally {
        first.release();
      }

      // And after each kind of Reader call, a raw query on that same connection sees nothing:
      // no row, no token, no transaction left open. The last kind is a call that fails, on a
      // reader whose statements naming knowledge are rejected as a database error is.
      const failing = recordingPool(store.readerPool, { rejectWhen: (text) => NAMES_KNOWLEDGE.test(text) });
      const broken = new Reader({ pool: failing.pool, keys: store.db.keys, log: store.log, now: () => store.now });
      const calls: [string, () => Promise<unknown>, (answer: unknown) => void][] = [
        [
          "search",
          () => store.reader.search(token, { query: "blake" }),
          (answer) => expect(outcomeValue(answer as ReadOutcome<SearchResult>).results).toHaveLength(1),
        ],
        [
          "get_self",
          () => store.reader.getSelf(token),
          (answer) => expect((answer as ReadOutcome<SelfView>).ok).toBe(true),
        ],
        [
          "get_entity",
          () => store.reader.getEntity(token, { id: blake }),
          (answer) => expect((answer as ReadOutcome<EntityView>).ok).toBe(true),
        ],
        [
          "get_timeline",
          () => store.reader.getTimeline(token, { id: blake }),
          (answer) => expect((answer as ReadOutcome<TimelineView>).ok).toBe(true),
        ],
        ["client", () => store.reader.client(token), (answer) => expect(answer).toMatchObject({ name: "wide-client" })],
        [
          "not_found",
          () => store.reader.getEntity(token, { id: MISSING_ENTITY }),
          (answer) => expect(answer).toEqual(NOT_FOUND),
        ],
        [
          "invalid_request",
          () => store.reader.search(token, { query: "blake", limit: 26 }),
          (answer) => expect(answer).toEqual({ ok: false, code: "invalid_request" }),
        ],
        [
          "unauthorized",
          () => store.reader.search(UNKNOWN_TOKEN, { query: "blake" }),
          (answer) => expect(answer).toEqual(UNAUTHORIZED),
        ],
        [
          "unavailable, a search",
          () => broken.search(token, { query: "blake" }),
          (answer) => expect(answer).toEqual({ ok: false, code: "unavailable" }),
        ],
        [
          "unavailable, get_self",
          () => broken.getSelf(token),
          (answer) => expect(answer).toEqual({ ok: false, code: "unavailable" }),
        ],
      ];
      for (const [name, call, check] of calls) {
        check(await call());
        expect(await leftOn(store.readerPool), name).toEqual({ backend, accounts: 0, token: "", idle: true });
      }
    } finally {
      await store.close();
    }
  });
});
