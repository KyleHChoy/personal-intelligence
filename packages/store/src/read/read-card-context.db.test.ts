import { ContextView, type EntityId, EntityView, type EventId, LIFE_DOMAINS } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { openUnder } from "../core/seal.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { ownerSide, personNeed, personRole, type Spec, seedSpecs } from "../test-support/context-db-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { MISSING_ENTITY, outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";

// The card's lines, find_facts' `belief`, and `context`, through the reader, on the synthetic
// world. Reserved domains only.

const OWN = ["own"];
const VIEWS = ["self", "people", "work"];

describe("the card, find_facts' belief and context", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string; pat: string };
  let messages: Message[];
  let full: Client;
  let selfOnly: Client;
  let selfWork: Client;
  let noTool: Client;
  const on = (compartment: string, n: number): Message =>
    messages.filter((one) => one.compartment === compartment)[n] as Message;
  const fact = (key: string): string => fingerprint(store.db.keys, "fact", key);
  const card = async (client: Client, id: string) =>
    EntityView.parse(outcomeValue(await store.reader.getEntity(client.token, { id: id as EntityId })));
  const context = async (client: Client, args: Parameters<TestStore["reader"]["context"]>[1]) =>
    ContextView.parse(outcomeValue(await store.reader.context(client.token, args)));

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = {
      owner: world.ownerEntity(),
      blake: world.entityOf(WORLD.both.address),
      pat: world.entityOf(WORLD.ownOnly.address),
    };
    messages = await worldMessages(store);
    // `own` by time: Blake -5d, the owner -4d, Pat -3d, Blake -2d. `employer:example`'s seventh
    // message is the owner's, at -6d.
    const { owner, blake, pat } = people;
    const specs: Spec[] = [
      ownerSide("ctx-goal", "goal", owner, on("own", 1), "career", "canary-ctx-goal for the interview"),
      {
        ...ownerSide("ctx-pref", "goal", owner, on("own", 1), "career", "canary-ctx-pref for the interview"),
        kind: "preference",
        fields: { what: "canary-ctx-pref for the interview", polarity: "prefers", domain: "career" },
        fieldKinds: { what: "text", polarity: "enum", domain: "enum" },
        values: { polarity: "prefers", domain: "career" },
      },
      // The owner's own word: about the owner, only their word builds a situation.
      ownerSide("ctx-situation", "situation", owner, on("own", 3), "career", "canary-ctx-situation for the interview"),
      // The owner's role as Blake said it, a career line whose cite names Blake, whom the career
      // section then names: another's word builds a role. A role is never a fragment, so the owner's
      // career lines are phrases of more than FRAGMENT_WORDS words, which a section shows beside it.
      { ...personRole("ctx-owner-role", owner, on("own", 3), "canary-ctx-owner-role"), by: blake },
      ownerSide("ctx-health", "goal", owner, on("own", 1), "health", "canary-ctx-health"),
      // Work mail's: for the wide audience alone.
      ownerSide("ctx-work-goal", "goal", owner, on("employer:example", 7), "career", "canary-work-ctx-goal"),
      // One need resting on three claims.
      ownerSide("c-many", "need", owner, on("own", 0), "career", "canary-many-1 for the interview"),
      ownerSide("c-many", "need", owner, on("own", 1), "career", "canary-many-2 for the interview"),
      ownerSide("c-many", "need", owner, on("own", 3), "career", "canary-many-3 for the interview"),
      // An open commitment of the owner's to Blake.
      {
        key: "ctx-commit",
        kind: "commitment",
        subject: owner,
        by: owner,
        message: on("own", 1),
        fields: { counterparty: blake, what: "canary-ctx-commit" },
        fieldKinds: { counterparty: "entity", what: "text" },
        values: { counterparty: blake },
      },
      personRole("b-role", blake, on("own", 0), "canary-ctx-blake-title"),
      personNeed("b-need", blake, on("own", 3), "career", "canary-ctx-blake-need"),
      // Thirty-two of Pat's, more than a card holds, in two domains.
      ...Array.from({ length: 32 }, (_, n) =>
        personNeed(`p-need-${n}`, pat, on("own", 2), n % 2 === 0 ? "career" : "health", `canary-pat-need-${n}`),
      ),
    ];
    await seedSpecs(store, owner, specs);
    await store.admin.work.addGoal("Rehearse for the job interview.", "own", { requestId: "req-k3d-goal-interview" });
    await store.admin.work.addGoal("Plan the garden.", "own", { requestId: "req-k3d-goal-garden" });
    full = await insertReader(store, "k3d-full", OWN, {
      tools: ["get_entity", "find_facts", "context", "list_goals"],
      views: VIEWS,
    });
    selfOnly = await insertReader(store, "k3d-self", OWN, { tools: ["context"], views: ["self"] });
    // The goals the owner set reach a client holding list_goals and the Work view.
    selfWork = await insertReader(store, "k3d-self-work", OWN, {
      tools: ["context", "list_goals"],
      views: ["self", "work"],
    });
    noTool = await insertReader(store, "k3d-no-tool", OWN, { tools: ["get_entity", "find_facts"], views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("a card's lines run by section, at most thirty, with more when cut", async () => {
    const view = await card(full, people.pat);
    expect(view.facts).toBeUndefined();
    expect(view.lines).toHaveLength(30);
    expect(view.more).toBe(true);
    // Each section one run: career, then health (one time, so in the domains' order).
    const runs = view.lines!.map((one) => one.domain).filter((domain, i, all) => i === 0 || all[i - 1] !== domain);
    expect(runs).toEqual(["career", "health"]);
    expect(LIFE_DOMAINS.indexOf("career")).toBeLessThan(LIFE_DOMAINS.indexOf("health"));
    for (const line of view.lines!) expect(line.line.untrusted).toMatch(/^Need: canary-pat-need-\d+$/);
    // Blake's: the role leads.
    const blake = await card(full, people.blake);
    expect(blake.lines!.map((one) => one.kind)).toEqual(["role", "need"]);
    expect(blake.lines![0]?.line.untrusted).toMatch(/^canary-ctx-blake-title at Example Co, since /);
  });

  it("find_facts' belief gives every claim behind a line the caller can read, newest first, and takes limit alone", async () => {
    const all = outcomeValue(await store.reader.findFacts(full.token, { belief: fact("c-many") }));
    expect(all.facts.map((one) => (one.type === "need" ? one.fields.what.untrusted : ""))).toEqual([
      "canary-many-3 for the interview",
      "canary-many-2 for the interview",
      "canary-many-1 for the interview",
    ]);
    expect(all.more).toBe(false);
    expect(all.facts.every((one) => one.status === "active")).toBe(true);
    const two = outcomeValue(await store.reader.findFacts(full.token, { belief: fact("c-many"), limit: 2 }));
    expect(two.facts).toHaveLength(2);
    expect(two.more).toBe(true);
    expect(await store.reader.findFacts(full.token, { belief: fact("c-many"), type: "need" })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    // A key no belief of the caller's audience holds, and one only work mail's audience holds.
    expect(await store.reader.findFacts(full.token, { belief: "f".repeat(64) })).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await store.reader.findFacts(full.token, { belief: fact("ctx-work-goal") })).toEqual({
      ok: false,
      code: "not_found",
    });
    // A line's fact from get_entity is one find_facts takes.
    const [line] = (await card(full, people.blake)).lines!;
    expect(outcomeValue(await store.reader.findFacts(full.token, { belief: line!.fact })).facts).toHaveLength(1);
  });

  it("context serves the sections its words pick, the people they name, their open work, the goals that share its words, and the passages", async () => {
    const view = await context(full, { task: "Prepare for my job interview" });
    expect(view.domains).toEqual(["career"]);
    expect(view.sections.map((one) => one.domain)).toEqual(["career"]);
    const text = JSON.stringify(view);
    for (const words of ["canary-ctx-goal", "canary-ctx-pref", "canary-ctx-situation", "canary-many-3"])
      expect(text).toContain(words);
    expect(text).not.toContain("canary-ctx-health");
    for (const needle of WORLD.workNeedles) expect(text).not.toContain(needle);
    // Blake, whom the career section names, with Blake's card's lines.
    expect(view.sections[0]?.people.map((one) => one.who.id)).toEqual([people.blake]);
    expect(view.people.map((one) => one.who.id)).toEqual([people.blake]);
    expect(view.people[0]?.lines.map((one) => one.kind)).toEqual(["role", "need"]);
    expect(view.commitments.map((one) => one.what?.untrusted)).toEqual(["canary-ctx-commit"]);
    expect(view.goals.map((one) => one.statement.untrusted)).toEqual(["Rehearse for the job interview."]);
    // Each passage is a served line's first cite's.
    const served = new Set(
      [...view.sections.flatMap((one) => one.lines), ...view.people.flatMap((one) => one.lines)].map((one) => one.fact),
    );
    expect(view.evidence.length).toBeGreaterThan(0);
    for (const one of view.evidence) expect(served.has(one.fact)).toBe(true);

    // The read log: each served line's fact key and each commitment's; each passage's message bound.
    const [row] = await queryAs<{ bound: string[]; fact_key_fps: string[]; goals: string[] }>(
      store.db.urls.admin,
      "select bound, fact_key_fps, goals from ledger.read_log where client_id = $1 and tool = 'context' order by id desc limit 1",
      [full.id],
    );
    expect([...(row?.fact_key_fps ?? [])].sort()).toEqual(
      [...new Set([...served, ...view.commitments.map((one) => one.belief.fact)])].sort(),
    );
    expect(row?.goals).toEqual(view.goals.map((one) => one.id));
    const passages = await queryAs<{ evidence_id: string }>(
      store.db.urls.admin,
      "select evidence_id from knowledge.messages where id = any($1)",
      [view.evidence.flatMap((one) => (one.source.kind === "message" ? [one.source.id] : []))],
    );
    for (const one of passages) expect(row?.bound).toContain(one.evidence_id);
  });

  it("context with domain names one section; with entity, that card first; an id the caller cannot see is not_found", async () => {
    const health = await context(full, { task: "anything", domain: "health" });
    expect(health.sections.map((one) => one.domain)).toEqual(["health"]);
    expect(JSON.stringify(health)).not.toContain("canary-ctx-goal");
    const named = await context(full, { task: "catch up", entity: people.pat as EntityId });
    expect(named.people.map((one) => one.who.id)).toEqual([people.pat]);
    expect(named.people[0]?.lines.length).toBeGreaterThan(0);
    expect(named.people[0]?.more).toBe(true);
    expect(await store.reader.context(full.token, { task: "catch up", entity: MISSING_ENTITY })).toEqual({
      ok: false,
      code: "not_found",
    });
    // With event, the meeting's people: Blake's meeting at +3d.
    const meetings = await queryAs<{ id: string; compartments: string[]; title_enc: unknown }>(
      store.db.urls.admin,
      "select event_id as id, compartments, title_enc from knowledge.event_details order by event_id",
    );
    const meeting = meetings.find(
      (row) =>
        row.title_enc !== null &&
        openUnder(
          store.db.keys,
          row.compartments,
          { table: "knowledge.event_details", id: row.id, column: "title_enc" },
          row.title_enc as never,
        ) === WORLD.ownMeeting,
    );
    const met = await context(full, { task: "catch up", event: meeting!.id as EventId });
    expect(met.people.map((one) => one.who.id)).toEqual([people.blake]);
    // Words that pick no domain, for a meeting: career first where the owner has it, never recency's.
    const recent = await context(full, { task: "what next" });
    const forPeople = ["career", "ventures", "education"];
    expect(met.domains).toEqual([]);
    expect(met.sections.map((one) => one.domain).filter((domain) => !forPeople.includes(domain))).toEqual(
      met.sections
        .filter((one) => one.people.some((person) => person.who.id === people.blake))
        .map((one) => one.domain)
        .filter((domain) => !forPeople.includes(domain)),
    );
    expect(recent.sections.length).toBeGreaterThanOrEqual(met.sections.length);
    expect(
      await store.reader.context(full.token, { task: "catch up", event: `evt_${"0".repeat(26)}` as EventId }),
    ).toEqual({ ok: false, code: "not_found" });
    // No domain picked: the most recently active sections.
    const none = await context(full, { task: "what next" });
    expect(none.domains).toEqual([]);
    expect(none.sections.length).toBeGreaterThan(0);
  });

  it("context serves no part whose view the client lacks, and a client without the tool is refused", async () => {
    const view = await context(selfOnly, { task: "Prepare for my job interview" });
    expect(view.sections.map((one) => one.domain)).toEqual(["career"]);
    expect(view.people).toEqual([]);
    expect(view.commitments).toEqual([]);
    expect(view.goals).toEqual([]);
    // Passages need the people view, as get_evidence_span does.
    expect(view.evidence).toEqual([]);
    // With work and no people view, the open commitments and goals are served all the same: the
    // commitment with Blake, whom the career section names, though no card is.
    const work = await context(selfWork, { task: "Prepare for my job interview" });
    expect(work.people).toEqual([]);
    expect(work.evidence).toEqual([]);
    expect(work.commitments.map((one) => one.what?.untrusted)).toEqual(["canary-ctx-commit"]);
    expect(work.goals.map((one) => one.statement.untrusted)).toEqual(["Rehearse for the job interview."]);
    // entity needs the people view: without it, left out and not looked up.
    expect((await context(selfOnly, { task: "catch up", entity: MISSING_ENTITY })).people).toEqual([]);
    expect(await store.reader.context(noTool.token, { task: "Prepare for my job interview" })).toEqual({
      ok: false,
      code: "not_permitted",
    });
    expect(await store.reader.context(full.token, { task: "" })).toEqual({ ok: false, code: "invalid_request" });
  });
});
