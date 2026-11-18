import { SearchResult } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { type FactSpec, moreOwnMail, seedFacts } from "../test-support/fact-fixtures.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// Claims are committed through the Pipeline, as the extraction commits them. No model is called.
// Reserved domains only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const TOOLS = ["search"];
const EVERY_VIEW = ["self", "people", "work"];

describe("search's match mode", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string; pat: string };
  let own: Client;
  let wide: Client;
  let peopleOnly: Client;
  let messages: Message[];
  const on = (compartment: string, n = 0): Message =>
    messages.filter((one) => one.compartment === compartment)[n] as Message;
  const freshReader = () => {
    const recorded = recordingPool(store.readerPool);
    return {
      reader: new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now }),
      statements: recorded.statements,
    };
  };
  const match = async (client: Client, query: string, mode: "needs" | "capabilities", limit?: number) =>
    SearchResult.parse(
      outcomeValue(
        await freshReader().reader.search(client.token, { query, mode, ...(limit === undefined ? {} : { limit }) }),
      ),
    );
  const need = (
    key: string,
    subject: string,
    message: Message,
    what: string,
    statementKind?: "reversal",
  ): FactSpec => ({
    key,
    type: "need",
    subject,
    by: subject,
    message,
    fields: { what },
    fieldKinds: { what: "text" },
    entities: [subject],
    ...(statementKind === undefined ? {} : { statementKind }),
  });

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
        need("m-blake", people.blake, on("own", 0), "Blake needs a kitchen designer."),
        need("m-pat", people.pat, on("own", 1), "Pat needs a designer for the garden."),
        need("m-pat-reversed", people.pat, on("own", 2), "Pat no longer needs a kitchen designer.", "reversal"),
        need("m-owner", people.owner, on("own", 3), "I need a kitchen designer too."),
        { ...need("m-cap", people.blake, on("own", 4), "Blake designs kitchens."), type: "capability" },
        // The employer's, which a narrow client cannot see.
        need("m-work", people.blake, on("employer:example", 0), "A kitchen designer for the office."),
      ],
      [],
    );
    own = await insertReader(store, "own-match", OWN, { tools: TOOLS, views: EVERY_VIEW });
    wide = await insertReader(store, "wide-match", WIDE, { tools: TOOLS, views: EVERY_VIEW });
    peopleOnly = await insertReader(store, "people-match", OWN, { tools: TOOLS, views: ["people"] });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("each claim is scored by its own tokens, ordered by score then newest, and a reversal is never a match", async () => {
    const found = await match(own, "kitchen designer", "needs");
    expect(found.results).toEqual([]);
    const shown = (found.matches ?? []).map((one) => [
      one.fact.fields && "what" in one.fact.fields ? (one.fact.fields.what as { untrusted: string }).untrusted : null,
      one.score,
    ]);
    expect(shown).toEqual([
      ["I need a kitchen designer too.", 2],
      ["Blake needs a kitchen designer.", 2],
      ["Pat needs a designer for the garden.", 1],
    ]);
    expect(found.more).toBe(false);
    // The capabilities mode reads capabilities alone.
    expect((await match(own, "kitchens", "capabilities")).matches?.map((one) => one.fact.type)).toEqual(["capability"]);
    // A names search answers as before, with no matches.
    expect((await freshReader().reader.search(own.token, { query: "kitchen" })).ok).toBe(true);
  });

  it("a client without the self view gets no match about the owner", async () => {
    const found = await match(peopleOnly, "kitchen designer", "needs");
    expect(found.matches?.every((one) => one.fact.subject.kind !== "owner")).toBe(true);
    expect(found.matches).toHaveLength(2);
  });

  it("adding a claim the caller cannot see changes no score, order or more", async () => {
    const narrow = await match(own, "kitchen designer", "needs");
    const both = await match(wide, "kitchen designer", "needs");
    const hidden = (both.matches ?? []).filter((one) => JSON.stringify(one).includes("for the office"));
    expect(hidden).toHaveLength(1);
    // Each by its fact and score, in order: the owner's Who shows the account each client sees.
    const scored = (list: typeof narrow.matches) => (list ?? []).map((one) => [one.fact.id, one.score]);
    expect(scored(narrow.matches)).toEqual(scored((both.matches ?? []).filter((one) => !hidden.includes(one))));
    expect(JSON.stringify(narrow)).not.toContain("for the office");
    // The limit and more are over the order.
    const one = await match(own, "kitchen designer", "needs", 1);
    expect(one.matches).toHaveLength(1);
    expect(one.more).toBe(true);
  });

  it("past 2 000 claims more is true", async () => {
    const bulk = on("own", 5);
    await seedFacts(
      store,
      people.owner,
      Array.from({ length: 2001 }, (_, n) => need(`m-bulk-${n}`, people.pat, bulk, `Pat needs filler number ${n}.`)),
      [],
    );
    // Every one of the newest 2 000 is filler, so the kitchen claims are not read.
    const found = await match(own, "filler", "needs");
    expect(found.matches).toHaveLength(25);
    expect(found.more).toBe(true);
    const none = await match(own, "kitchen", "needs");
    expect(none.matches).toEqual([]);
    expect(none.more).toBe(true);
  });
});
