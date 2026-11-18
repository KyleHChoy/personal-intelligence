import { BELIEF_KINDS_BY_SUBJECT, BeliefList, type EntityId, TimelineView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { bulkCommitments } from "../test-support/bulk-claims.ts";
import { insertClient } from "../test-support/clients.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { readAs, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { moreOwnMail, seedFacts } from "../test-support/fact-fixtures.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore, withDatabase } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, MISSING_ENTITY, outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { BELIEF_KEYS } from "./computed-beliefs.ts";
import { Reader } from "./read.ts";

// Claims are committed through the Pipeline, their beliefs computed when asked. No model is called.
// Reserved domains only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const TOOLS = ["get_beliefs", "get_timeline"];
const EVERY_VIEW = ["self", "people", "work"];

describe("0025", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("log_call accepts get_beliefs once 0025 has run", () =>
    withDatabase(async (db) => {
      const client = await insertClient(db, "caller", ["own"]);
      expect(
        await sqlState(() =>
          readAs(db, client.token, (query) => query("select policy.log_call('get_beliefs', 2, 'ok')")),
        ),
      ).toBeNull();
      expect(await queryAs(db.urls.admin, "select tool, rows from policy.calls")).toEqual([
        { tool: "get_beliefs", rows: 2 },
      ]);
      // The control: a name no migration added is still refused.
      expect(
        await sqlState(() =>
          readAs(db, client.token, (query) => query("select policy.log_call('not_a_tool', 0, 'ok')")),
        ),
      ).toBe("23503");
    }));
});

describe("get_beliefs and the timeline's facts", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string; pat: string };
  let own: Client;
  let wide: Client;
  let peopleOnly: Client;
  let messages: Message[];
  const fact = (key: string): string => fingerprint(store.db.keys, "fact", key);

  const freshReader = () => {
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
    return { reader, statements: recorded.statements };
  };
  const beliefs = async (client: Client, args: Parameters<Reader["getBeliefs"]>[1] = {}) =>
    BeliefList.parse(outcomeValue(await freshReader().reader.getBeliefs(client.token, args)));
  const on = (compartment: string, n = 0): Message =>
    messages.filter((one) => one.compartment === compartment)[n] as Message;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = {
      owner: world.ownerEntity(),
      blake: world.entityOf(WORLD.both.address),
      pat: world.entityOf(WORLD.ownOnly.address),
    };
    await moreOwnMail(store, world.accounts.personalMail);
    messages = await worldMessages(store);
    await seedFacts(
      store,
      people.owner,
      [
        {
          key: "gb-role",
          type: "role",
          kind: "role",
          subject: people.blake,
          by: people.blake,
          message: on("own", 0),
          fields: { title: "canary-title-blake" },
          fieldKinds: { title: "text" },
          values: {},
          entities: [people.blake],
        },
        {
          key: "gb-need",
          type: "need",
          kind: "need",
          subject: people.blake,
          by: people.blake,
          message: on("own", 1),
          fields: { what: "canary-need-blake" },
          fieldKinds: { what: "text" },
          values: {},
          entities: [people.blake],
          // Said 70 days ago: a need is stale after 60.
          at: daysFrom(WORLD_NOW, -70).toISOString(),
        },
        {
          key: "gb-pat-cap",
          type: "capability",
          kind: "capability",
          subject: people.pat,
          by: people.pat,
          message: on("own", 2),
          fields: { what: "canary-cap-pat" },
          fieldKinds: { what: "text" },
          values: {},
          entities: [people.pat],
        },
        {
          key: "gb-pat-old",
          type: "situation",
          kind: "situation",
          subject: people.pat,
          by: people.pat,
          message: on("own", 3),
          fields: { what: "canary-situation-pat" },
          fieldKinds: { what: "text" },
          values: {},
          entities: [people.pat],
          // Said 130 days ago: a person's situation has ended after 120.
          at: daysFrom(WORLD_NOW, -130).toISOString(),
        },
        // The owner's own goal: the Self view's.
        {
          key: "gb-owner-goal",
          type: "goal",
          kind: "goal",
          subject: people.owner,
          by: people.owner,
          message: on("own", 4),
          fields: { what: "canary-goal-owner" },
          fieldKinds: { what: "text" },
          values: {},
          entities: [],
        },
        // Blake's word to the owner: a fact on Blake's timeline that names the owner in a field.
        {
          key: "gb-owes",
          type: "commitment",
          kind: "commitment",
          subject: people.blake,
          by: people.blake,
          message: on("own", 5),
          fields: { counterparty: people.owner, what: "canary-owes-owner" },
          fieldKinds: { counterparty: "entity", what: "text" },
          values: { counterparty: people.owner },
          entities: [people.blake],
        },
        // Blake's word that the owner promised Blake something: a claim with no belief (a commitment
        // counts only its subject's own word), about the owner, naming Blake.
        {
          key: "gb-owner-promise",
          type: "commitment",
          subject: people.owner,
          by: people.blake,
          message: on("own", 5),
          fields: { counterparty: people.blake, what: "canary-owner-promise" },
          fieldKinds: { counterparty: "entity", what: "text" },
          entities: [people.blake],
        },
        // The employer's, for the wide audience alone.
        {
          key: "gb-work-role",
          type: "role",
          kind: "role",
          subject: people.blake,
          by: people.blake,
          message: on("employer:example", 0),
          fields: { title: "canary-work-title" },
          fieldKinds: { title: "text" },
          values: {},
          entities: [people.blake],
        },
      ],
      [OWN, WIDE],
    );
    own = await insertReader(store, "own-get-beliefs", OWN, { tools: TOOLS, views: EVERY_VIEW });
    wide = await insertReader(store, "wide-get-beliefs", WIDE, { tools: TOOLS, views: EVERY_VIEW });
    peopleOnly = await insertReader(store, "people-get-beliefs", OWN, { tools: TOOLS, views: ["people"] });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("get_beliefs returns every expected belief of the world with its citing claim", async () => {
    const all = await beliefs(own, { state: "any" });
    expect(new Set(all.beliefs.map((one) => one.fact))).toEqual(
      new Set(["gb-role", "gb-need", "gb-pat-cap", "gb-pat-old", "gb-owner-goal", "gb-owes"].map(fact)),
    );
    for (const belief of all.beliefs) {
      expect(belief.cites).toHaveLength(1);
      const cite = belief.cites[0];
      expect(cite !== undefined && "fields" in cite ? cite.subject.id : null).toBe(belief.subject.id);
    }
    expect(all.more).toBe(false);
    // Ordered by kind in the People view's list, whatever the subject: one kind's beliefs together.
    const ranks = all.beliefs.map((one) => BELIEF_KINDS_BY_SUBJECT.person.indexOf(one.kind));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // The default is open: the ended situation is closed.
    expect((await beliefs(own)).beliefs.map((one) => one.fact)).not.toContain(fact("gb-pat-old"));
    expect((await beliefs(own, { state: "closed" })).beliefs.map((one) => one.fact)).toEqual([fact("gb-pat-old")]);
    // By kind, and by entity.
    expect((await beliefs(own, { kind: "need" })).beliefs.map((one) => one.fact)).toEqual([fact("gb-need")]);
    expect(new Set((await beliefs(own, { entity: people.blake as EntityId })).beliefs.map((one) => one.fact))).toEqual(
      new Set([fact("gb-role"), fact("gb-need"), fact("gb-owes")]),
    );
    // The limit, and more.
    const one = await beliefs(own, { state: "any", limit: 1 });
    expect(one.beliefs).toHaveLength(1);
    expect(one.more).toBe(true);
  });

  it("a client with people alone gets no owner belief, and the same statements as a client of the same clearance with self", async () => {
    const narrow = freshReader();
    const scoped = BeliefList.parse(outcomeValue(await narrow.reader.getBeliefs(peopleOnly.token, { state: "any" })));
    const full = freshReader();
    const every = BeliefList.parse(outcomeValue(await full.reader.getBeliefs(own.token, { state: "any" })));
    expect(scoped.beliefs.map((one) => one.fact)).toEqual(
      every.beliefs.map((one) => one.fact).filter((one) => one !== fact("gb-owner-goal")),
    );
    expect(scoped.beliefs.every((one) => one.subject.kind !== "owner")).toBe(true);
    expect(scoped.more).toBe(every.more);
    // The statements differ only in the session and log rows each client writes.
    const reads = (list: string[]) => list.filter((text) => /\b(knowledge|projections)\./.test(text));
    expect(reads(narrow.statements).length).toBeGreaterThan(3);
    expect(reads(narrow.statements)).toEqual(reads(full.statements));
  });

  it("get_beliefs with the owner's id is not_found, and so is a missing one", async () => {
    expect(await freshReader().reader.getBeliefs(own.token, { entity: people.owner as EntityId })).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await freshReader().reader.getBeliefs(own.token, { entity: MISSING_ENTITY })).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("a hidden compartment changes no belief, order or more", async () => {
    const narrow = await beliefs(own, { state: "any" });
    const both = await beliefs(wide, { state: "any" });
    const work = fact("gb-work-role");
    expect(both.beliefs.map((one) => one.fact)).toContain(work);
    expect(narrow.beliefs.map((one) => one.fact)).toEqual(
      both.beliefs.map((one) => one.fact).filter((one) => one !== work),
    );
    expect(JSON.stringify(narrow)).not.toContain("canary-work-title");
    expect(narrow.more).toBe(false);
  });

  it("the timeline interleaves facts by time and its limit counts them", async () => {
    const timeline = TimelineView.parse(
      outcomeValue(await freshReader().reader.getTimeline(own.token, { id: people.blake as EntityId })),
    );
    const facts = timeline.entries.filter((entry) => entry.kind === "fact");
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(facts)).toContain("canary-title-blake");
    // A fact naming the owner in a field shows them as the owner.
    const owes = facts.find((entry) => JSON.stringify(entry).includes("canary-owes-owner"));
    expect(owes?.kind === "fact" && owes.fact.type === "commitment" ? owes.fact.fields.counterparty.kind : null).toBe(
      "owner",
    );
    // Newest first, over every kind.
    const times = timeline.entries.map((entry) => Date.parse(entry.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(new Set(timeline.entries.map((entry) => entry.kind)).size).toBeGreaterThan(1);
    const cut = TimelineView.parse(
      outcomeValue(await freshReader().reader.getTimeline(own.token, { id: people.blake as EntityId, limit: 2 })),
    );
    expect(cut.entries).toEqual(timeline.entries.slice(0, 2));
    expect(JSON.stringify(timeline)).toContain("canary-owner-promise");
    const narrow = freshReader();
    const scoped = TimelineView.parse(
      outcomeValue(await narrow.reader.getTimeline(peopleOnly.token, { id: people.blake as EntityId })),
    );
    expect(JSON.stringify(scoped)).not.toContain("canary-owner-promise");
    expect(scoped.entries).toEqual(
      timeline.entries.filter((entry) => !JSON.stringify(entry).includes("canary-owner-promise")),
    );
    const full = freshReader();
    await full.reader.getTimeline(own.token, { id: people.blake as EntityId });
    const reads = (list: string[]) => list.filter((text) => /\b(knowledge|projections)\./.test(text));
    expect(reads(narrow.statements)).toEqual(reads(full.statements));
    // The employer's fact is not on a narrow client's timeline.
    expect(JSON.stringify(timeline)).not.toContain("canary-work-title");
    const wider = TimelineView.parse(
      outcomeValue(await freshReader().reader.getTimeline(wide.token, { id: people.blake as EntityId })),
    );
    expect(JSON.stringify(wider)).toContain("canary-work-title");
  });

  // Last: it links two people, which every test above reads unlinked.
  it("an entity's beliefs are its group's, each member's its own and none merged", async () => {
    const blake = (await beliefs(own, { entity: people.blake as EntityId, state: "any" })).beliefs
      .map((one) => one.fact)
      .sort();
    const pat = (await beliefs(own, { entity: people.pat as EntityId, state: "any" })).beliefs
      .map((one) => one.fact)
      .sort();
    expect(blake.length).toBeGreaterThan(0);
    expect(pat.length).toBeGreaterThan(0);
    await store.admin.identity.linkPeople(people.blake as EntityId, people.pat as EntityId, "same", {
      requestId: "gb-link-blake-pat",
    });
    const group = await beliefs(own, { entity: people.blake as EntityId, state: "any" });
    expect(group.beliefs.map((one) => one.fact).sort()).toEqual([...blake, ...pat].sort());
    expect(new Set(group.beliefs.map((one) => one.subject.id))).toEqual(new Set([people.blake, people.pat]));
    expect(
      (await beliefs(own, { entity: people.pat as EntityId, state: "any" })).beliefs.map((one) => one.fact).sort(),
    ).toEqual([...blake, ...pat].sort());
  });
  // Last, since its commitments stay in the world.
  it("past 5 000 beliefs more is true", async () => {
    // Pat's commitments to Pat, under the own audience: open, people's, older than every fact above.
    await bulkCommitments(store, {
      owner: people.owner,
      subject: people.pat,
      counterparty: people.pat,
      count: 5000,
      at: new Date("2025-06-01T00:00:00.000Z"),
    });
    const { reader, statements } = freshReader();
    const value = BeliefList.parse(outcomeValue(await reader.getBeliefs(own.token, { kind: "need" })));
    // The seeded need, stated after every bulk commitment and so read first; the reading stops at the ceiling.
    expect(value.beliefs.map((one) => one.fact)).toEqual([fact("gb-need")]);
    expect(value.more).toBe(true);
    // One statement of the 5 001 newest keys, and of the 5 000 kept only those whose belief may be
    // a need computed, in one read; then the citing claims' viewer reads those of its keys the list
    // did not compute, here none, in one.
    expect(statements.filter((text) => text === BELIEF_KEYS)).toHaveLength(1);
    expect(statements.filter((text) => text.includes("policy.belief_inputs("))).toHaveLength(2);
  });
});
