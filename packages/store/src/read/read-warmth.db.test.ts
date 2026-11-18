import {
  ContextView,
  type EntityId,
  EntityView,
  type EventId,
  PathList,
  PeopleList,
  type RulingId,
  SearchResult,
  SelfView,
} from "@intelligence/contracts/personal";
import { warmthRules } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { req } from "../test-support/identity-fixtures.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { type LineSeed, resetLines, seedLines } from "../test-support/warmth-lines.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";

// Every read that orders people by closeness ranks the caller's clearance at read from the per-label
// warmth days (identity/warmth-days.ts rankWarmth), and list_people lists them. The lines are seeded
// as their inputs (test-support/warmth-lines.ts seedLines), each label's days apart, so these tests do
// not depend on the day build. The seeded world (test-support/world.ts, seedWorld): under `own`, Blake
// and the owner wrote each other and Pat only wrote; under `employer:example`, Blake and Wren and the
// owner wrote each other (Wren six times), and a meeting with both was at -50h. Synthetic names only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const TOOLS = ["get_self", "get_entity", "search", "find_paths", "context", "list_people"];
const VIEWS = ["self", "people", "work"];

const WORK = ["employer:example"];

describe("warmth reads", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { blake: string; pat: string; wren: string };
  let own: Client;
  let wide: Client;
  let work: Client;
  let selfOnly: Client;
  let wideSelf: Client;

  // A label's lines seeded, its days replaced: a client reads the sum of every label within its clearance.
  const seedWarmth = (label: string[], rows: LineSeed[], options: { removed?: boolean } = {}) =>
    seedLines(store.db, label, rows, { ...options, today: WORLD_NOW });

  const entity = async (client: Client, id: string) =>
    EntityView.parse(outcomeValue(await store.reader.getEntity(client.token, { id: id as EntityId })));
  const list = async (client: Client, args: Parameters<TestStore["reader"]["listPeople"]>[1] = {}) =>
    PeopleList.parse(outcomeValue(await store.reader.listPeople(client.token, args)));
  const contactIds = async (client: Client) =>
    SelfView.parse(outcomeValue(await store.reader.getSelf(client.token)))
      .contacts.map((one) => one.id as string)
      .filter((id) => Object.values(people).includes(id));

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = {
      blake: world.entityOf(WORLD.both.address),
      pat: world.entityOf(WORLD.ownOnly.address),
      wren: world.entityOf(WORLD.workOnly.address),
    };
    own = await insertReader(store, "warmth-own", OWN, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "warmth-wide", WIDE, { tools: TOOLS, views: VIEWS });
    work = await insertReader(store, "warmth-work", ["employer:example"], { tools: TOOLS, views: VIEWS });
    selfOnly = await insertReader(store, "warmth-self", OWN, { tools: ["get_self", "list_people"], views: ["self"] });
    wideSelf = await insertReader(store, "warmth-wide-self", WIDE, { tools: ["get_self"], views: ["self"] });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("an audience never built answers rebuilding: get_entity's line has no tier, and list_people lists no one", async () => {
    expect((await entity(own, people.blake)).warmth).toMatchObject({
      tier: null,
      tierSource: null,
      warmth: null,
      stale: false,
      rebuilding: true,
    });
    expect(await list(own)).toEqual({ people: [], next: null, rebuilding: true });
  });

  it("an audience built with no people answers an empty list, not rebuilding; a person with no row has no line", async () => {
    await seedWarmth(OWN, []);
    expect(await list(own)).toEqual({ people: [], next: null, rebuilding: false });
    expect((await entity(own, people.blake)).warmth).toBeUndefined();
  });

  it("an audience a removal emptied answers rebuilding until the next build", async () => {
    await seedWarmth(OWN, [], { removed: true });
    expect(await list(own)).toEqual({ people: [], next: null, rebuilding: true });
    expect((await entity(own, people.blake)).warmth).toMatchObject({ tier: null, rebuilding: true });
    await seedWarmth(OWN, [{ entity: people.blake, tier: "close", warmth: 2 }]);
    expect((await entity(own, people.blake)).warmth).toMatchObject({
      tier: "close",
      warmth: 2,
      rebuilding: false,
      stale: false,
    });
  });

  it("get_entity serves the sum of the labels within the caller's clearance, never a label outside it", async () => {
    await resetLines(store.db);
    await seedWarmth(OWN, [{ entity: people.blake, tier: "close", warmth: 2 }]);
    await seedWarmth(WORK, [{ entity: people.blake, tier: "inner", warmth: 5 }]);
    const line = (await entity(own, people.blake)).warmth;
    expect(line).toMatchObject({
      tier: "close",
      tierSource: "inferred",
      dormant: false,
      warmth: 2,
      active: 2,
      depth: 2,
      replyRate: null,
      replyHours: null,
      theyStart: null,
      channels: ["email", "calendar"],
      stale: false,
      rebuilding: false,
    });
    expect(line?.firstTwoWayAt).not.toBeNull();
    expect(line?.lastTwoWayAt).not.toBeNull();
    // The work label alone reads its own days; both labels read the days summed.
    expect((await entity(work, people.blake)).warmth).toMatchObject({ tier: "inner", warmth: 5 });
    expect((await entity(wide, people.blake)).warmth).toMatchObject({
      tier: "inner",
      tierSource: "inferred",
      warmth: 7,
    });
  });

  it("list_people lists tier order, then warmth, paged by after; dormant and tiers filter", async () => {
    await resetLines(store.db);
    await seedWarmth(WORK, [
      { entity: people.pat, tier: "known", warmth: 1 },
      { entity: people.wren, tier: "close", warmth: 9, dormant: true },
      { entity: people.blake, tier: "inner", warmth: 2 },
    ]);
    const all = await list(wide);
    expect(all.rebuilding).toBe(false);
    expect(all.next).toBeNull();
    expect(all.people.map((one) => [one.id, one.warmth.tier])).toEqual([
      [people.blake, "inner"],
      [people.wren, "close"],
      [people.pat, "known"],
    ]);
    expect(all.people[0]?.address).toEqual({ untrusted: WORLD.both.address });
    // One a page, by the cursor each page answers.
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const one = await list(wide, { limit: 1, ...(after === undefined ? {} : { after }) });
      seen.push(...one.people.map((person) => person.id as string));
      if (one.next === null) break;
      after = one.next;
    }
    expect(seen).toEqual([people.blake, people.wren, people.pat]);
    expect((await list(wide, { dormant: true })).people.map((one) => one.id)).toEqual([people.wren]);
    expect((await list(wide, { tiers: ["known", "inner"] })).people.map((one) => one.id)).toEqual([
      people.blake,
      people.pat,
    ]);
    // A cursor the server did not issue is refused.
    expect(await store.reader.listPeople(wide.token, { after: "not-a-cursor" })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    // The narrow clearance lists its own label's days and the owner's word it can see: Pat's ruled tier
    // reaches it by Pat's own address; Wren, whom it cannot see, is never listed.
    await seedWarmth(OWN, [{ entity: people.blake, tier: "regular", warmth: 1 }]);
    expect((await list(own)).people.map((one) => [one.id, one.warmth.tier])).toEqual([
      [people.blake, "regular"],
      [people.pat, "known"],
    ]);
  });

  it("a client without the People view gets not_permitted from list_people", async () => {
    expect(await store.reader.listPeople(selfOnly.token, {})).toEqual({ ok: false, code: "not_permitted" });
  });

  it("search's first page holds the highest-tiered match even when it has the fewest emails", async () => {
    // Each name has a word that starts "canary": one match rank for all three. Wren has the most
    // emails and Pat the fewest.
    await resetLines(store.db);
    await seedWarmth(WORK, [
      { entity: people.pat, tier: "inner", warmth: 0.5 },
      { entity: people.blake, tier: "known", warmth: 7 },
      { entity: people.wren, tier: "regular", warmth: 3 },
    ]);
    const search = async (limit: number) =>
      SearchResult.parse(outcomeValue(await store.reader.search(wide.token, { query: "canary", limit }))).results.map(
        (one) => one.id,
      );
    expect(await search(1)).toEqual([people.pat]);
    expect(await search(3)).toEqual([people.pat, people.wren, people.blake]);
  });

  it("find_paths weighs the own-tie hop by its tier, and by the floor with no tier", async () => {
    const score = async () =>
      PathList.parse(
        outcomeValue(await store.reader.findPaths(own.token, { target: people.blake as EntityId })),
      ).paths.map((path) => path.score);
    const weights = warmthRules().pathWeights;
    await resetLines(store.db);
    await seedWarmth(OWN, [{ entity: people.blake, tier: "inner", warmth: 3 }]);
    expect(await score()).toEqual([weights.inner]);
    await seedWarmth(OWN, [{ entity: people.blake, tier: "known", warmth: 3 }]);
    expect(await score()).toEqual([weights.known]);
    await resetLines(store.db);
    expect(await score()).toEqual([weights["one-way"]]);
  });

  it("get_self keeps its places and orders within a place by tier, then warmth; a self-only client by warmth alone", async () => {
    // Under `own`, the owner wrote to Blake and only Pat wrote: Blake's place comes first whatever
    // Pat's tier.
    await resetLines(store.db);
    await seedWarmth(OWN, [
      { entity: people.pat, tier: "inner", warmth: 9 },
      { entity: people.blake, tier: "known", warmth: 1 },
    ]);
    expect(await contactIds(own)).toEqual([people.blake, people.pat]);
    // Under both, the owner wrote to Blake and Wren: one place, by tier. Blake's days are both labels'.
    await seedWarmth(WORK, [
      { entity: people.blake, tier: "close", warmth: 1 },
      { entity: people.wren, tier: "known", warmth: 8 },
    ]);
    expect(await contactIds(wide)).toEqual([people.blake, people.wren, people.pat]);
    await seedWarmth(WORK, [
      { entity: people.wren, tier: "inner", warmth: 1, tierSource: "owner" },
      { entity: people.blake, tier: "known", warmth: 5 },
    ]);
    expect(await contactIds(wide)).toEqual([people.wren, people.blake, people.pat]);
    // A client that may not learn the owner's confirmed tier is served the order by warmth alone.
    expect(await contactIds(wideSelf)).toEqual([people.blake, people.wren, people.pat]);
  });

  it("context picks the meeting's people and orders them by tier, then warmth", async () => {
    const meeting = (await entity(wide, people.blake)).lastMeeting?.id as EventId | undefined;
    expect(meeting).toBeDefined();
    const ordered = async () =>
      ContextView.parse(
        outcomeValue(await store.reader.context(wide.token, { task: "prepare the meeting", event: meeting })),
      ).people.map((one) => one.who.id);
    await resetLines(store.db);
    await seedWarmth(WORK, [
      { entity: people.wren, tier: "inner", warmth: 1 },
      { entity: people.blake, tier: "regular", warmth: 6 },
    ]);
    expect(await ordered()).toEqual([people.wren, people.blake]);
    await seedWarmth(WORK, [
      { entity: people.wren, tier: "outer", warmth: 1 },
      { entity: people.blake, tier: "regular", warmth: 6 },
    ]);
    expect(await ordered()).toEqual([people.blake, people.wren]);
  });

  it("a merged group is ranked as one line from its members' days at once, and a lift splits it at once", async () => {
    await resetLines(store.db);
    await seedWarmth(WORK, [
      { entity: people.pat, tier: "regular", warmth: 1 },
      { entity: people.wren, tier: "close", warmth: 4 },
    ]);
    const ruling: RulingId = await store.admin.identity.linkPeople(
      people.pat as EntityId,
      people.wren as EntityId,
      "same",
      {
        requestId: req(),
      },
    );
    const group = [people.pat, people.wren].sort();
    // The group's days are both members' summed: no build waits, so nothing is served stale.
    for (const id of group)
      expect((await entity(wide, id)).warmth, id).toMatchObject({
        tier: "close",
        warmth: 5,
        stale: false,
        rebuilding: false,
      });
    expect((await list(wide)).people.map((one) => [one.id, one.warmth.stale])).toEqual([[group[0], false]]);
    // A lift: each member is ranked from its own days again, at once.
    expect(await store.admin.identity.liftIdentity(ruling, { requestId: req() })).toBe(true);
    expect((await entity(wide, people.pat)).warmth).toMatchObject({ tier: "regular", warmth: 1, stale: false });
    expect((await entity(wide, people.wren)).warmth).toMatchObject({ tier: "close", warmth: 4, stale: false });
  });
});
