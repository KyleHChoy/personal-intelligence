import {
  BeliefList,
  type EntityId,
  EntityView,
  FactList,
  type MessageId,
  SearchResult,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { seedFacts } from "../test-support/fact-fixtures.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// Claims are committed through the Pipeline, which binds those of an anchored item. No model is
// called. Reserved domains only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const TOOLS = ["get_entity", "get_timeline", "search", "get_beliefs", "find_facts"];
let serial = 0;
const request = (): string => `req-read-projects-${(serial += 1)}-${testId("x").slice(-8)}`;

describe("get_entity for a project", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let messages: Message[];
  let heron: EntityId;
  let hidden: EntityId;
  let wren: EntityId;
  let work: Client;
  let peopleOnly: Client;
  let wideWork: Client;
  let ownerId: string;
  let blakeId: string;
  const fact = (key: string): string => fingerprint(store.db.keys, "fact", key);
  const freshReader = () => {
    const recorded = recordingPool(store.readerPool);
    return {
      reader: new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now }),
      statements: recorded.statements,
    };
  };
  const entity = async (client: Client, id: EntityId) => freshReader().reader.getEntity(client.token, { id });

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    const owner = world.ownerEntity();
    const blake = world.entityOf(WORLD.both.address);
    ownerId = owner;
    blakeId = blake;
    messages = await worldMessages(store);
    const own = messages.filter((one) => one.compartment === "own");
    const employer = messages.filter((one) => one.compartment === "employer:example");
    const first = own[0] as Message;
    const workMessage = employer[0] as Message;
    heron = await store.admin.projects.add("Canary project: the heron survey", { requestId: request() });
    await store.admin.projects.anchor(heron, first.id as MessageId, { requestId: request() });
    hidden = await store.admin.projects.add("Canary project: the employer's", {
      compartment: "employer:example",
      requestId: request(),
    });
    await store.admin.projects.anchor(hidden, workMessage.id as MessageId, { requestId: request() });
    wren = await store.admin.projects.add("Canary Wren Count", { requestId: request() });
    await seedFacts(
      store,
      owner,
      [
        {
          key: "pj-status",
          type: "project.status",
          kind: "project_status",
          subject: heron,
          subjectKind: "project",
          by: blake,
          message: first,
          fields: { status: "active", what: "canary-status-heron" },
          fieldKinds: { status: "enum", what: "text" },
          values: { status: "active" },
          entities: [heron, blake],
        },
        {
          key: "pj-decision",
          type: "project.decision",
          kind: "decision",
          subject: heron,
          subjectKind: "project",
          by: blake,
          message: first,
          fields: { what: "canary-decision-oak" },
          fieldKinds: { what: "text" },
          entities: [heron, blake],
        },
        // Blake's commitment to the owner in the anchored thread: compiled with the project.
        {
          key: "pj-owes",
          type: "commitment",
          kind: "commitment",
          subject: blake,
          by: blake,
          message: first,
          fields: { counterparty: owner, what: "canary-owes-heron" },
          fieldKinds: { counterparty: "entity", what: "text" },
          values: { counterparty: owner },
          entities: [blake],
        },
        // Mail code found in a project, its thread anchored to none: read through the claim's subject.
        {
          key: "wren-status",
          type: "project.status",
          kind: "project_status",
          subject: wren,
          subjectKind: "project",
          by: blake,
          message: own[1] as Message,
          fields: { status: "paused", what: "canary-wren-status" },
          fieldKinds: { status: "enum", what: "text" },
          values: { status: "paused" },
          entities: [wren, blake],
        },
        {
          key: "wren-step",
          type: "project.next_step",
          subject: wren,
          subjectKind: "project",
          by: blake,
          message: own[1] as Message,
          fields: { what: "canary-wren-step", who: blake },
          fieldKinds: { what: "text", who: "entity" },
          values: { who: blake },
          entities: [wren, blake],
        },
        // The employer's project's status, which an own client never sees.
        {
          key: "pj-hidden",
          type: "project.status",
          kind: "project_status",
          subject: hidden,
          subjectKind: "project",
          by: blake,
          message: workMessage,
          fields: { status: "blocked" },
          fieldKinds: { status: "enum" },
          values: { status: "blocked" },
          entities: [hidden, blake],
        },
      ],
      [OWN, WIDE],
    );
    work = await insertReader(store, "work-projects", OWN, { tools: TOOLS, views: ["people", "work"] });
    peopleOnly = await insertReader(store, "people-projects", OWN, { tools: TOOLS, views: ["people"] });
    wideWork = await insertReader(store, "wide-projects", WIDE, { tools: TOOLS, views: ["people", "work"] });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("holds its name, its status, its decisions and the commitments of its threads, each cited", async () => {
    const view = EntityView.parse(outcomeValue(await entity(work, heron)));
    expect(view).toMatchObject({
      id: heron,
      kind: "project",
      names: [{ untrusted: "Canary project: the heron survey" }],
      addresses: [],
      status: "active",
    });
    expect(view.facts!.beliefs.map((one) => one.kind)).toEqual(["project_status", "decision", "commitment"]);
    expect(view.facts!.beliefs.map((one) => one.fact)).toEqual([
      fact("pj-status"),
      fact("pj-decision"),
      fact("pj-owes"),
    ]);
    for (const belief of view.facts!.beliefs) expect(belief.cites.length).toBeGreaterThan(0);
    expect(JSON.stringify(view.facts)).toContain("canary-decision-oak");
    expect(JSON.stringify(view.facts)).toContain("canary-owes-heron");
    expect(view.facts!.beliefs[0]?.subject).toMatchObject({
      id: heron,
      kind: "project",
      name: { untrusted: "Canary project: the heron survey" },
    });
  });

  it("mail code found in a project reaches its record with no anchor, its status a belief and its next step a claim, each cited", async () => {
    const view = EntityView.parse(outcomeValue(await entity(work, wren)));
    expect(view.facts!.beliefs.map((one) => one.kind)).toEqual(["project_status"]);
    expect(view.facts!.beliefs[0]?.fact).toBe(fact("wren-status"));
    expect(view.facts!.beliefs[0]?.cites.length).toBeGreaterThan(0);
    expect(JSON.stringify(view.facts)).toContain("canary-wren-step");
  });

  it("names the people and the messages its claims rest on, with no anchor; a project with no claims stays empty", async () => {
    const view = EntityView.parse(outcomeValue(await entity(work, wren)));
    expect(view.people.map((one) => one.id)).toEqual([blakeId]);
    expect(view.mail.inbound + view.mail.outbound).toBe(1);
    expect(view.mail.lastAt).not.toBeNull();
    const empty = await store.admin.projects.add("Canary Empty Plot", { requestId: request() });
    expect(EntityView.parse(outcomeValue(await entity(work, empty)))).toMatchObject({
      people: [],
      mail: { inbound: 0, outbound: 0 },
    });
  });

  it("get_timeline lists those messages", async () => {
    const { entries } = outcomeValue(await freshReader().reader.getTimeline(work.token, { id: wren }));
    expect(entries.filter((one) => one.kind === "email")).toHaveLength(1);
  });

  it("an anchored thread's messages count, and a claim under a label the caller lacks adds nothing", async () => {
    const view = EntityView.parse(outcomeValue(await entity(work, heron)));
    expect(view.mail.inbound + view.mail.outbound).toBeGreaterThan(0);
    const wide = EntityView.parse(outcomeValue(await entity(wideWork, heron)));
    expect(wide.mail).toEqual(view.mail);
    expect(wide.people.map((one) => one.id)).toEqual(view.people.map((one) => one.id));
    expect(view.people.map((one) => one.id)).not.toContain(ownerId);
  });

  it("a project is not_found to a client without work, with the same statements as a hidden one", async () => {
    const narrow = freshReader();
    expect(await narrow.reader.getEntity(peopleOnly.token, { id: heron })).toEqual({ ok: false, code: "not_found" });
    const hiddenRead = freshReader();
    expect(await hiddenRead.reader.getEntity(work.token, { id: hidden })).toEqual({ ok: false, code: "not_found" });
    const reads = (list: string[]) => list.filter((text) => /\b(knowledge|projections)\./.test(text));
    expect(reads(narrow.statements).length).toBeGreaterThan(0);
    expect(reads(narrow.statements)).toEqual(reads(hiddenRead.statements));
  });

  it("a project the caller cannot see changes nothing it reads", async () => {
    const narrow = EntityView.parse(outcomeValue(await entity(work, heron)));
    const wide = EntityView.parse(outcomeValue(await entity(wideWork, heron)));
    expect({
      names: narrow.names,
      status: narrow.status,
      facts: narrow.facts!.beliefs.map((one) => one.fact),
      more: narrow.facts!.more,
    }).toEqual({
      names: wide.names,
      status: wide.status,
      facts: wide.facts!.beliefs.map((one) => one.fact),
      more: wide.facts!.more,
    });
    expect(JSON.stringify(narrow)).not.toContain("blocked");
    expect(EntityView.parse(outcomeValue(await entity(wideWork, hidden))).status).toBe("active");
  });

  it("get_beliefs serves a project's status and decision to a client with work, citing their claims, and not to one without", async () => {
    const withWork = BeliefList.parse(
      outcomeValue(await freshReader().reader.getBeliefs(work.token, { state: "any" })),
    );
    expect(
      withWork.beliefs
        .filter((one) => one.subject.kind === "project" && one.subject.id !== wren)
        .map((one) => one.fact)
        .sort(),
    ).toEqual([fact("pj-decision"), fact("pj-status")].sort());
    for (const belief of withWork.beliefs) expect(belief.cites.length).toBeGreaterThan(0);
    const without = BeliefList.parse(
      outcomeValue(await freshReader().reader.getBeliefs(peopleOnly.token, { state: "any" })),
    );
    expect(without.beliefs.some((one) => one.subject.kind === "project")).toBe(false);
  });

  it("find_facts finds a project's claims by the parent type, each naming the project as its Who", async () => {
    const found = FactList.parse(outcomeValue(await freshReader().reader.findFacts(work.token, { type: "project" })));
    const about = (id: EntityId) => found.facts.filter((one) => (one.subject as { id?: string }).id === id);
    expect(
      about(heron)
        .map((one) => one.type)
        .sort(),
    ).toEqual(["project.decision", "project.status"]);
    expect(
      about(wren)
        .map((one) => one.type)
        .sort(),
    ).toEqual(["project.next_step", "project.status"]);
    for (const one of about(heron))
      expect(one.subject).toMatchObject({
        id: heron,
        kind: "project",
        name: { untrusted: "Canary project: the heron survey" },
      });
    expect(JSON.stringify(found)).not.toContain("blocked");
  });

  it("search finds a project by its name, for a client with work, and never a hidden one", async () => {
    const found = SearchResult.parse(outcomeValue(await freshReader().reader.search(work.token, { query: "heron" })));
    expect(found.results).toEqual([
      {
        id: heron,
        kind: "project",
        name: { untrusted: "Canary project: the heron survey" },
        address: null,
        lastInteractionAt: null,
      },
    ]);
    expect(
      SearchResult.parse(outcomeValue(await freshReader().reader.search(work.token, { query: "employer's" }))).results,
    ).toEqual([]);
    // By part of its name, from any word on.
    for (const query of ["wren cou", "Canary Wren"])
      expect(
        SearchResult.parse(outcomeValue(await freshReader().reader.search(work.token, { query }))).results.map(
          (one) => one.id,
        ),
      ).toEqual([wren]);
    expect(
      SearchResult.parse(outcomeValue(await freshReader().reader.search(peopleOnly.token, { query: "heron" }))).results,
    ).toEqual([]);
  });
});
