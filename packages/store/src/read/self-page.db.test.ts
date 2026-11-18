import {
  compactResult,
  type GetSelfArgs,
  SELF_SECTION_LINES,
  type SelfSection,
  SelfView,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { orderFault } from "../test-support/order.ts";
import { recordingPool } from "../test-support/recording.ts";
import { careerSpecs, seedSelf } from "../test-support/self-page-fixtures.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// No model is called. Reserved domains and made-up words only.

const OWN = ["own"];
const VIEWS = ["self", "people", "work"];
// About 8 000 tokens by context-sizes.test.ts's measure.
const DOMAIN_BOUND = 32_000;

describe("get_self's sections", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string; pat: string };
  let agent: Client;
  let noGoals: Client;
  let own: Message[];

  const call = async (client: Client, args: GetSelfArgs = {}) => {
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
    const view = SelfView.parse(outcomeValue(await reader.getSelf(client.token, args)));
    return { view, statements: recorded.statements };
  };
  const section = (view: SelfView, domain: string): SelfSection | undefined =>
    view.sections?.find((one) => one.domain === domain);
  const words = (one: SelfSection | undefined): string[] => (one?.lines ?? []).map((line) => line.line.untrusted);

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = {
      owner: world.ownerEntity(),
      blake: world.entityOf(WORLD.both.address),
      pat: world.entityOf(WORLD.ownOnly.address),
    };
    own = (await worldMessages(store)).filter((one) => one.compartment === "own");
    // The health goal is stated in two messages, so its line's since and at draw on two cites, and
    // the read log binds both.
    const [first, , third] = own as [Message, Message, Message];
    const specs = careerSpecs(people, own).map((spec) =>
      spec.key === "k3c-health" ? { ...spec, message: first, also: [third] } : spec,
    );
    await seedSelf(store, people.owner, specs);
    await store.admin.work.addGoal("canary-goal-set", "own", { requestId: "req-k3c-goal" });
    // An agent as `pi clients defaults` registers one: every view, list_goals among its tools.
    agent = await insertReader(store, "k3c-agent", OWN, { tools: ["get_self", "list_goals"], views: VIEWS });
    noGoals = await insertReader(store, "k3c-no-goals", OWN, { tools: ["get_self"], views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("get_self({ domain: career }) answers in one call: role, affiliation, goal with its deadline, situation, preferences and constraint, and its people, within bounds", async () => {
    const { view } = await call(agent, { domain: "career" });
    expect(view.sections?.map((one) => one.domain)).toEqual(["career"]);
    // The section alone: it says so, and repeats none of what a whole get_self holds.
    expect(view).toMatchObject({ domain: "career", addresses: [], upcoming: [], contacts: [] });
    expect(view.openItems).toBeUndefined();
    expect(view.work).toBeUndefined();
    const whole = (await call(agent, {})).view;
    expect(whole.domain).toBeUndefined();
    expect(whole.addresses.length).toBeGreaterThan(0);
    const career = section(view, "career") as SelfSection;
    const since = (n: number) => (own[n] as Message).sentAt.slice(0, 10);
    expect(words(career).slice(0, 2)).toEqual([
      `Employee at Example Labs, since ${since(3)}`,
      `canary-title-engineer at Example Labs, since ${since(0)}`,
    ]);
    expect(words(career).slice(2, 6).sort()).toEqual([
      "Avoids: canary-pref-commute",
      "Constraint: canary-constraint-notice, until 2026-11-15",
      "Goal: canary-goal-offer, by 2026-12-01",
      "Prefers: canary-pref-remote",
    ]);
    // The situation Pat reported of the owner is a claim and no belief: about the owner only their
    // own word counts, so a belief computed at read never holds it.
    expect(words(career).slice(6)).toEqual([]);
    expect(JSON.stringify(career.lines)).not.toContain("canary-situation-interviewing");
    expect(career.lines.map((line) => line.tier)).toEqual(["source", "source", "owner", "owner", "owner", "owner"]);
    const goal = career.lines.find((line) => line.kind === "goal");
    expect(goal).toMatchObject({ by: "2026-12-01", domain: "career", status: "active", cites: 1 });
    // The people named in its beliefs' claims, by count: Blake in two (Pat's report counts in none).
    expect(career.people.map((one) => [one.who.id, one.claims])).toEqual([[people.blake, 2]]);
    expect(career.more).toBe(false);
    // Nothing of health, and no stated: sections replace it.
    expect(JSON.stringify(view)).not.toContain("canary-goal-marathon");
    expect("stated" in view).toBe(false);
    // The head: the goals the owner set, computed as beliefs, which this agent reads with list_goals.
    expect(view.goals?.map((one) => one.statement.untrusted)).toEqual(["canary-goal-set"]);
    // Within bounds: ten lines of a kind, and about 8 000 tokens in the wire form.
    for (const kind of new Set(career.lines.map((line) => line.kind)))
      expect(career.lines.filter((line) => line.kind === kind).length).toBeLessThanOrEqual(SELF_SECTION_LINES);
    expect([...JSON.stringify(compactResult("get_self", view))].length).toBeLessThan(DOMAIN_BOUND);
  });

  it("without domain, one section a domain, newest first, and no stated; history adds the closed line", async () => {
    const { view } = await call(agent);
    expect(view.sections?.map((one) => one.domain)).toEqual(["career", "health"]);
    expect(words(section(view, "health"))).toEqual(["Goal: canary-goal-marathon, by 2027-04-01"]);
    expect("stated" in view).toBe(false);
    expect(JSON.stringify(view.sections)).not.toContain("canary-pref-old");
    // The closed line is a fragment, which a whole page leaves off while the section holds better,
    // and says so; a domain's read holds it.
    const { view: page } = await call(agent, { history: true });
    expect(section(page, "career")?.more).toBe(true);
    const { view: past } = await call(agent, { history: true, domain: "career" });
    const closed = section(past, "career")?.lines.find((line) => line.line.untrusted === "Prefers: canary-pref-old");
    expect(closed?.status).toBe("closed");
    const { view: current } = await call(agent, { domain: "career" });
    expect(JSON.stringify(current.sections)).not.toContain("canary-pref-old");
  });

  it("serves the goals the owner set only to a client holding list_goals (0041's row policy)", async () => {
    const { view } = await call(noGoals, { domain: "career" });
    expect(view.goals).toEqual([]);
    // The control: the same clearance and views, with list_goals.
    expect((await call(agent, { domain: "career" })).view.goals).toHaveLength(1);
  });

  // What get_self's description says its goals are: list_goals' default, the active goals the owner
  // set. A goal the owner only stated in mail is no goal there: it is a section's line, and
  // list_goals with stated lists it, which is where an agent checks before proposing one.
  it("get_self's goals are list_goals' default; a goal only stated in mail is listed by list_goals with stated", async () => {
    const reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
    const { view } = await call(agent);
    const listed = outcomeValue(await reader.listGoals(agent.token, {}));
    // The same goals; get_self ranks them in the owner's order, list_goals lists newest first.
    expect(view.goals?.map((one) => one.id).sort()).toEqual(listed.goals.map((one) => one.id).sort());
    expect(listed.goals).toHaveLength(1);
    expect(JSON.stringify(view.goals)).not.toContain("canary-goal-offer");
    // The stated goal is a line of its section, which a whole page may cut: the domain's read holds it.
    const { view: career } = await call(agent, { domain: "career" });
    expect(JSON.stringify(career.goals)).not.toContain("canary-goal-offer");
    expect(words(section(career, "career"))).toContain("Goal: canary-goal-offer, by 2026-12-01");
    const stated = outcomeValue(await reader.listGoals(agent.token, { status: "any", stale: true, stated: true }));
    expect(stated.goals.map((one) => one.statement.untrusted)).toEqual(
      expect.arrayContaining(["canary-goal-set", "canary-goal-offer"]),
    );
  });

  it("every statement ends in an order by a key, and the read log names the served lines' facts", async () => {
    const { view, statements } = await call(agent, { domain: "career" });
    for (const text of statements) expect(orderFault(text), text).toBeNull();
    const [row] = await queryAs<{ fact_key_fps: string[]; goals: string[] }>(
      store.db.urls.admin,
      "select fact_key_fps, goals from ledger.read_log where client_id = $1 and tool = 'get_self' order by id desc limit 1",
      [agent.id],
    );
    // Every served line's fact, and the closed preference `changes` lists.
    const lines = (section(view, "career")?.lines ?? []).map((line) => line.fact);
    expect(view.changes.map((one) => one.kind)).toEqual(["preference"]);
    expect(row?.fact_key_fps).toEqual(expect.arrayContaining(lines));
    expect(row?.fact_key_fps).toHaveLength(lines.length + view.changes.length);
    expect(row?.goals).toEqual(view.goals?.map((one) => one.id));
  });

  // A line's since, at and cites draw on every cite of its belief, so the read log binds each
  // cite's message, not only the first's (the latest).
  it("the read log binds the message of every cite a served line drew on", async () => {
    const { view } = await call(agent, { domain: "health" });
    const [line] = section(view, "health")?.lines ?? [];
    const [first, , third] = own as [Message, Message, Message];
    expect(line).toMatchObject({ cites: 2, since: first.sentAt, at: third.sentAt });
    const [row] = await queryAs<{ bound: string[] }>(
      store.db.urls.admin,
      "select bound from ledger.read_log where client_id = $1 and tool = 'get_self' order by id desc limit 1",
      [agent.id],
    );
    expect(row?.bound).toEqual(expect.arrayContaining([first.evidenceId, third.evidenceId]));
  });
});
