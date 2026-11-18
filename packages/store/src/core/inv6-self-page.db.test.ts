import { type GetSelfArgs, SelfView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reader } from "../read/read.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { recordingPool } from "../test-support/recording.ts";
import { careerSpecs, type SelfSpec, seedSelf } from "../test-support/self-page-fixtures.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";

// Invariant 6 for the self page: a client cleared for `own` alone gets the same sections, in the
// same order, with the same lines, people, counts and `more`, the same goals, and sends the same
// statements, before and after the store gains what it cannot see: claims about the owner in work
// mail, one naming Blake (whom it sees) and one Wren (whom it does not), a newer goal in a domain
// it has no section for, the work audience's beliefs over all of them, and a goal set under the
// work compartment. A client cleared for both is the control: it sees each change. Reserved domains
// and made-up words only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const VIEWS = ["self", "people", "work"];
const ASKS: GetSelfArgs[] = [{}, { domain: "career" }, { history: true }];

describe("invariant 6: get_self's sections", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string; pat: string; wren: string };
  let narrow: Client;
  let wide: Client;

  // What a client sees of the self page: everything but `contacts` and `upcoming`,
  // which earlier invariant 6 tests hold; and the statements sent, but the session's opening,
  // which only a client's first call sends.
  const page = async (client: Client, args: GetSelfArgs) => {
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
    const view = SelfView.parse(outcomeValue(await reader.getSelf(client.token, args)));
    return {
      sections: view.sections,
      housekeeping: view.housekeeping,
      goals: view.goals,
      changes: view.changes,
      statements: recorded.statements.filter((text) => !/policy\.open_session/.test(text)),
    };
  };
  const pages = (client: Client) => Promise.all(ASKS.map((args) => page(client, args)));

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = {
      owner: world.ownerEntity(),
      blake: world.entityOf(WORLD.both.address),
      pat: world.entityOf(WORLD.ownOnly.address),
      wren: world.entityOf(WORLD.workOnly.address),
    };
    const own = (await worldMessages(store)).filter((one) => one.compartment === "own");
    await seedSelf(store, people.owner, careerSpecs(people, own));
    await store.admin.work.addGoal("canary-goal-set", "own", { requestId: "req-inv6-k3c-goal" });
    narrow = await insertReader(store, "inv6-k3c-own", OWN, { tools: ["get_self", "list_goals"], views: VIEWS });
    wide = await insertReader(store, "inv6-k3c-wide", WIDE, { tools: ["get_self", "list_goals"], views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("the sections, their order, lines, people, counts and more, and the goals are the same with and without hidden claims and beliefs about the owner", async () => {
    const before = await pages(narrow);
    const wideBefore = await pages(wide);

    // The hidden rows, all in work mail, the newest the store holds.
    const work = (await worldMessages(store)).filter((one) => one.compartment === "employer:example").reverse();
    const [newest, next, third] = work as [Message, Message, Message];
    const { owner, blake, wren } = people;
    const text = { what: "text", domain: "enum" };
    const hidden: SelfSpec[] = [
      {
        key: "k3c-hidden-travel",
        type: "goal",
        by: owner,
        message: newest,
        fields: { what: "canary-hidden-travel", domain: "travel" },
        fieldKinds: text,
        values: { domain: "travel" },
        tier: "owner",
      },
      {
        key: "k3c-hidden-blake",
        type: "preference",
        // The owner's own word, naming Blake: about the owner only their own word builds a belief.
        by: owner,
        names: [blake],
        message: next,
        fields: { what: "canary-hidden-blake", polarity: "prefers", domain: "career" },
        fieldKinds: { ...text, polarity: "enum" },
        values: { polarity: "prefers", domain: "career" },
        tier: "owner",
      },
      {
        key: "k3c-hidden-wren",
        type: "situation",
        by: owner,
        names: [wren],
        message: third,
        fields: { what: "canary-hidden-wren", domain: "career" },
        fieldKinds: text,
        values: { domain: "career" },
        tier: "owner",
      },
      {
        key: "k3c-hidden-closed",
        type: "constraint",
        by: owner,
        message: newest,
        fields: { what: "canary-hidden-closed", domain: "health" },
        fieldKinds: text,
        values: { domain: "health" },
        status: "closed",
        tier: "owner",
      },
    ];
    // The work audience's beliefs rebuilt over every claim; the own audience's are untouched, as a
    // rebuild leaves them when no claim it reads changed.
    await seedSelf(store, owner, hidden);
    await store.admin.work.addGoal("canary-hidden-goal", "employer:example", { requestId: "req-inv6-k3c-hidden-goal" });

    const after = await pages(narrow);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("canary-hidden");

    // The control: the wide client sees the new section first, Blake in one claim more, Wren, the
    // hidden lines and the goal.
    const wideAfter = await pages(wide);
    expect(wideAfter).not.toEqual(wideBefore);
    const [whole, career, history] = wideAfter as [
      Awaited<ReturnType<typeof page>>,
      Awaited<ReturnType<typeof page>>,
      Awaited<ReturnType<typeof page>>,
    ];
    expect(whole.sections?.[0]?.domain).toBe("travel");
    const counts = new Map(career.sections?.[0]?.people.map((one) => [one.who.id as string, one.claims]));
    expect(counts.get(blake)).toBe(3);
    expect(counts.has(wren)).toBe(true);
    expect(JSON.stringify(career.sections)).toContain("canary-hidden-blake");
    expect(JSON.stringify(history.sections)).toContain("canary-hidden-closed");
    expect(whole.goals?.map((one) => one.statement.untrusted).sort()).toEqual([
      "canary-goal-set",
      "canary-hidden-goal",
    ]);
  });
});
