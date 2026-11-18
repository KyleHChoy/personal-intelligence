import type { Claim, FieldKind } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type ClaimRecord,
  type EntityId,
  FactList,
  type FactType,
  type FactView,
  type FindFactsArgs,
  type MessageId,
  type ReadOutcome,
  SearchResult,
  SelfView,
  type SubjectKind,
  type Who,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { sha256Hex } from "../test-support/clients.ts";
import { asClaimsOwner, readAs, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { NAMES_KNOWLEDGE, orderFault } from "../test-support/order.ts";
import { batchOf } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { callLog, leftOn, openStore, recordingReader, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import {
  daysFrom,
  MALFORMED_TOKENS,
  MISSING_ENTITY,
  outcomeValue,
  registration,
  UNKNOWN_TOKEN,
} from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";

// find_facts. The world is seeded through the writer, and its facts through the Pipeline: hand-written claim records under `own`
// and `employer:example`, as the extraction would hand them over, every belief computed at read. No model is called. Each
// refusal has its positive control in the same test.

// The claim rows of a belief type ($1) policy.belief_inputs gives the token for every fact key it
// sees, by label.
const BELIEF_INPUTS = `
  select i.compartments[1] as c from policy.belief_inputs(
    array(select distinct c.fact_key_fp from knowledge.claims c order by c.fact_key_fp), 'infinity')
    as i where i.part = 'claim' and i.word = any ($1::text[]) order by i.id`;

const BOTH = ["own", "employer:example"];
const _WIDE_AUDIENCE = ["employer:example", "own"];
const FACT_TOOLS = {
  tools: ["get_self", "search", "get_entity", "get_timeline", "find_messages", "read_message", "find_facts"] as (
    | "find_facts"
    | "get_self"
    | "search"
  )[],
  views: ["self", "people", "work"] as ("self" | "people" | "work")[],
};
const NOT_PERMITTED = { ok: false, code: "not_permitted" };
const NOT_FOUND = { ok: false, code: "not_found" };
const UNAUTHORIZED = { ok: false, code: "unauthorized" };
const UNAVAILABLE = { ok: false, code: "unavailable" };
const NAMES_PROJECTIONS = /"?projections"?\s*\./i;
const LOG_CALL = /log_call\s*\(/i;

// The world's messages that carry facts, by when each was sent.
const ITEMS = {
  ownBlakeFirst: -5,
  ownSent: -4,
  ownPat: -3,
  ownBlakeSecond: -2,
  workBlakeNew: -1,
  workSent: -6,
  workWren0: -7,
} as const;
type Item = keyof typeof ITEMS;

type People = { owner: string; blake: string; pat: string; wren: string };

// One hand-written fact: what the extraction would have committed for it.
type FactSpec = {
  item: Item;
  n: number;
  type: FactType;
  subject: keyof People;
  statedBy: keyof People | null;
  basis: "explicit_self" | "third_party";
  fields: Record<string, unknown>;
  kinds: Record<string, FieldKind>;
  factKey: string;
  thirdParty?: boolean;
  agentReported?: boolean;
};

// The facts, by name. `who` fields name a person of `People`, filled in when the world is known.
const FACTS = {
  // The owner's promise and Blake's, each with a belief under both audiences.
  blakePromise: {
    item: "ownBlakeFirst",
    n: 1,
    type: "commitment",
    subject: "blake",
    statedBy: "blake",
    basis: "explicit_self",
    fields: { counterparty: "@owner", what: "canary-fact-deck", due: "2026-03-20" },
    kinds: { counterparty: "entity", what: "text", due: "date" },
    factKey: "k-blake-deck",
  },
  // Its `when` is a time other than the message's: the order and the bounds do not follow it.
  lunchPlan: {
    item: "ownBlakeFirst",
    n: 2,
    type: "plan",
    subject: "owner",
    statedBy: "blake",
    basis: "third_party",
    fields: { counterparty: "@blake", what: "canary-fact-lunch", when: "2026-04-01T10:00:00.000Z" },
    kinds: { counterparty: "entity", what: "text", when: "date" },
    factKey: "k-lunch",
  },
  ownerPromise: {
    item: "ownSent",
    n: 1,
    type: "commitment",
    subject: "owner",
    statedBy: "owner",
    basis: "explicit_self",
    fields: { counterparty: "@blake", what: "canary-fact-owner-promise", due: "2026-03-12T17:00:00.000Z" },
    kinds: { counterparty: "entity", what: "text", due: "date" },
    factKey: "k-owner-promise",
  },
  // A commitment whose fact key has no belief: Blake's word of the owner's promise, and a commitment
  // counts only its subject's own word.
  unbuilt: {
    item: "ownSent",
    n: 2,
    type: "commitment",
    subject: "owner",
    statedBy: "blake",
    basis: "third_party",
    fields: { counterparty: "@blake", what: "canary-fact-unbuilt" },
    kinds: { counterparty: "entity", what: "text" },
    factKey: "k-unbuilt",
  },
  // Taken from a message the system sent: beside the owner's promise, in no belief's support.
  agentReported: {
    item: "ownSent",
    n: 3,
    type: "commitment",
    subject: "owner",
    statedBy: "owner",
    basis: "explicit_self",
    fields: { counterparty: "@blake", what: "canary-fact-agent" },
    kinds: { counterparty: "entity", what: "text" },
    factKey: "k-owner-promise",
    agentReported: true,
  },
  receipt: {
    item: "ownPat",
    n: 1,
    type: "transaction.receipt",
    subject: "owner",
    statedBy: "pat",
    basis: "third_party",
    fields: {
      merchant: "canary-merchant",
      amount: 42.5,
      currency: "EUR",
      date: "2026-03-07",
      order_ref: "canary-order-7",
    },
    kinds: { merchant: "text", amount: "number", currency: "enum", date: "date", order_ref: "text" },
    factKey: "k-receipt",
  },
  patPromise: {
    item: "ownPat",
    n: 2,
    type: "commitment",
    subject: "pat",
    statedBy: "pat",
    basis: "explicit_self",
    fields: { counterparty: "@owner", what: "canary-fact-pat" },
    kinds: { counterparty: "entity", what: "text" },
    factKey: "k-pat",
  },
  // Blake's report of Pat's promise: beside it, under the same fact key, and in no support.
  patReport: {
    item: "ownBlakeSecond",
    n: 1,
    type: "commitment",
    subject: "pat",
    statedBy: "blake",
    basis: "third_party",
    fields: { counterparty: "@owner", what: "canary-fact-pat-report" },
    kinds: { counterparty: "entity", what: "text" },
    factKey: "k-pat",
    thirdParty: true,
  },
  workBlake: {
    item: "workBlakeNew",
    n: 1,
    type: "commitment",
    subject: "blake",
    statedBy: "blake",
    basis: "explicit_self",
    fields: { counterparty: "@owner", what: "canary-work-fact-blake" },
    kinds: { counterparty: "entity", what: "text" },
    factKey: "k-work-blake",
  },
  wrenPlan: {
    item: "workWren0",
    n: 1,
    type: "plan",
    subject: "wren",
    statedBy: "wren",
    basis: "explicit_self",
    fields: { counterparty: "@owner", what: "canary-work-fact-wren", when: "2026-03-15" },
    kinds: { counterparty: "entity", what: "text", when: "date" },
    factKey: "k-wren",
  },
} as const satisfies Record<string, FactSpec>;
type FactName = keyof typeof FACTS;
const OWN_FACTS: FactName[] = [
  "blakePromise",
  "lunchPlan",
  "ownerPromise",
  "unbuilt",
  "agentReported",
  "receipt",
  "patPromise",
  "patReport",
];
const WORK_FACTS: FactName[] = ["workBlake", "wrenPlan"];

type Message = { id: MessageId; evidenceId: string; sentAt: string; compartment: string };

type FactWorld = {
  store: TestStore;
  people: People;
  messages: Record<Item, Message>;
  // Each fact's keyed id, as find_facts returns it.
  ids: Record<FactName, string>;
  records: Record<FactName, ClaimRecord>;
  tokens: { own: string; wide: string; work: string };
};

const compartmentOf = (item: Item): string => (item.startsWith("own") ? "own" : "employer:example");

// What the extraction would commit for one fact of the world.
function recordOf(name: string, spec: FactSpec, message: Message, people: People): ClaimRecord {
  const entity = (value: unknown): unknown =>
    typeof value === "string" && value.startsWith("@") ? people[value.slice(1) as keyof People] : value;
  const fields = Object.fromEntries(Object.entries(spec.fields).map(([key, value]) => [key, entity(value)]));
  const named = [
    spec.subject,
    spec.statedBy,
    ...Object.values(spec.fields).flatMap((value) =>
      typeof value === "string" && value.startsWith("@") ? [value.slice(1)] : [],
    ),
  ];
  const claim = {
    id: sha256Hex(`claim ${name} ${message.evidenceId} ${spec.n}`),
    content: { type: spec.type, subject: people[spec.subject], fields },
    statementKind: "stated_fact",
    basis: spec.basis,
    ...(spec.statedBy === null ? {} : { assertedBy: people[spec.statedBy] }),
    validFrom: message.sentAt,
    evidence: [{ evidenceId: message.evidenceId, span: `s:${spec.n}` }],
    primaryEvidenceId: message.evidenceId,
    label: { compartments: [message.compartment], readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "backfill",
    systemOriginated: spec.agentReported === true,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  const kind: SubjectKind = spec.subject === "owner" ? "owner" : "person";
  return {
    claim,
    subjectKind: kind,
    disclosure: spec.thirdParty === true ? ["third_party"] : [],
    factKey: spec.factKey,
    lane: spec.type === "transaction.receipt" ? "transaction" : "correspondence",
    fieldKinds: spec.kinds,
    // Each once, the owner left out.
    entities: [
      ...new Set(named.filter((one): one is keyof People => one !== null && one !== "owner").map((one) => people[one])),
    ],
    origin: spec.agentReported === true ? "agent_record" : "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

// The world's messages, read as pi_admin, by the day each was sent.
async function messagesOf(store: TestStore): Promise<Record<Item, Message>> {
  const rows = await queryAs<{ id: MessageId; evidence_id: string; sent_at: Date; compartment: string }>(
    store.db.urls.admin,
    "select id, evidence_id, sent_at, compartments[1] as compartment from knowledge.messages order by sent_at, id",
  );
  const found = {} as Record<Item, Message>;
  for (const [item, days] of Object.entries(ITEMS) as [Item, number][]) {
    const row = rows.find((one) => one.sent_at.getTime() === daysFrom(WORLD_NOW, days).getTime());
    if (row === undefined) throw new Error(`no message for ${item}`);
    expect(row.compartment, item).toBe(compartmentOf(item));
    found[item] = {
      id: row.id,
      evidenceId: row.evidence_id,
      sentAt: row.sent_at.toISOString(),
      compartment: row.compartment,
    };
  }
  return found;
}

// The world, its facts committed item by item through the Pipeline and known by its date, and
// three clients: cleared for own, for both, and for the employer alone.
async function seedFacts(store: TestStore, options: { facts?: FactName[] } = {}): Promise<FactWorld> {
  const world = await seedWorld(store.writer, store.admin);
  const people: People = {
    owner: world.ownerEntity(),
    blake: world.entityOf(WORLD.both.address),
    pat: world.entityOf(WORLD.ownOnly.address),
    wren: world.entityOf(WORLD.workOnly.address),
  };
  const messages = await messagesOf(store);
  const names = options.facts ?? [...OWN_FACTS, ...WORK_FACTS];
  const records = {} as Record<FactName, ClaimRecord>;
  const ids = {} as Record<FactName, string>;
  for (const name of names) {
    const spec: FactSpec = FACTS[name];
    records[name] = recordOf(name, spec, messages[spec.item], people);
    ids[name] = fingerprint(store.db.keys, "claim", records[name].claim.id);
  }
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    for (const item of Object.keys(ITEMS) as Item[]) {
      const claims = names.filter((name) => FACTS[name].item === item).map((name) => records[name]);
      if (claims.length > 0)
        expect(await pipeline.commit(batchOf(messages[item].evidenceId, claims)), item).toBe("committed");
    }
  } finally {
    await pipeline.close();
  }
  await knownBy(store.db, WORLD_NOW);
  const { token: own } = await store.admin.clients.addClient(registration("own-client", ["own"], FACT_TOOLS));
  const { token: wide } = await store.admin.clients.addClient(registration("wide-client", BOTH, FACT_TOOLS));
  const { token: work } = await store.admin.clients.addClient(
    registration("work-client", ["employer:example"], FACT_TOOLS),
  );
  return { store, people, messages, ids, records, tokens: { own, wide, work } };
}

const facts = (outcome: ReadOutcome<FactList>): FactList => FactList.parse(outcomeValue(outcome));
const idsOf = (list: FactList): string[] => list.facts.map((fact) => fact.id);

// The fact names in the order find_facts must give them: newest first by the message's sent
// time, then by keyed id.
function ordered(world: FactWorld, names: FactName[]): string[] {
  return names
    .map((name) => ({ id: world.ids[name], at: world.messages[FACTS[name].item].sentAt }))
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? 1 : -1))
    .map((one) => one.id);
}

const factNamed = (world: FactWorld, list: FactList, name: FactName): FactView => {
  const found = list.facts.find((fact) => fact.id === world.ids[name]);
  if (found === undefined) throw new Error(`no fact ${name}`);
  return found;
};

// A person's Who as the other tools give one: search's result for the address.
async function whoBySearch(world: FactWorld, token: string, address: string): Promise<Who> {
  const results = SearchResult.parse(outcomeValue(await world.store.reader.search(token, { query: address }))).results;
  const found = results.find((result) => result.address?.untrusted === address);
  if (found === undefined) throw new Error(`search found no ${address}`);
  return { id: found.id, kind: found.kind, name: found.name, address: found.address };
}

// The owner's Who: no name, and the owner's visible account with the lowest id, which is the
// first of get_self's addresses.
async function ownerWho(world: FactWorld, token: string): Promise<Who> {
  const self = SelfView.parse(outcomeValue(await world.store.reader.getSelf(token)));
  return { id: world.people.owner as EntityId, kind: "owner", name: null, address: self.addresses[0] ?? null };
}

describe("find_facts", { timeout: DB_TEST_TIMEOUT }, () => {
  let world: FactWorld;

  beforeAll(async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      world = await seedFacts(store);
    } catch (error) {
      await store.close();
      throw error;
    }
  }, DB_TEST_TIMEOUT);

  afterAll(async () => {
    await world?.store.close();
  });

  it("a client with no work view is refused, and nothing in knowledge or projections is named", async () => {
    const { store } = world;
    const { token: noView } = await store.admin.clients.addClient(
      registration("no-work-view", BOTH, { ...FACT_TOOLS, views: ["self", "people"] }),
    );
    const { token: noTool } = await store.admin.clients.addClient(
      registration("no-fact-tool", BOTH, { views: FACT_TOOLS.views }),
    );
    const { reader, during } = recordingReader(store);
    for (const [name, token] of [
      ["no-work-view", noView],
      ["no-fact-tool", noTool],
    ] as const) {
      const before = await callLog(store.db.urls.admin);
      const { answer, statements } = await during(() => reader.findFacts(token, { type: "commitment" }));
      expect(answer, name).toEqual(NOT_PERMITTED);
      for (const text of statements) {
        expect(text, name).not.toMatch(NAMES_KNOWLEDGE);
        expect(text, name).not.toMatch(NAMES_PROJECTIONS);
      }
      expect(await callLog(store.db.urls.admin), name).toEqual([
        ...before,
        { client: name, tool: "find_facts", rows: 0, outcome: "not_permitted" },
      ]);
    }

    // The positive control: a client with the tool and its view reads knowledge, and computes its
    // beliefs at read: no stored answer is read.
    const { answer, statements } = await during(() => reader.findFacts(world.tokens.wide, { type: "commitment" }));
    expect(answer.ok).toBe(true);
    expect(statements.some((text) => NAMES_KNOWLEDGE.test(text))).toBe(true);
    expect(statements.some((text) => text.includes("policy.belief_inputs("))).toBe(true);
    expect(statements.some((text) => NAMES_PROJECTIONS.test(text))).toBe(false);
  });

  it("facts come newest first by the message's sent time, then by id, and more says whether others matched", async () => {
    const { reader } = world.store;
    const all = facts(await reader.findFacts(world.tokens.own, {}));
    expect(idsOf(all)).toEqual(ordered(world, OWN_FACTS));
    expect(all.more).toBe(false);
    const wide = facts(await reader.findFacts(world.tokens.wide, {}));
    expect(idsOf(wide)).toEqual(ordered(world, [...OWN_FACTS, ...WORK_FACTS]));

    // Every limit cuts the same order, and `more` is true exactly when facts were left out.
    for (let limit = 1; limit <= OWN_FACTS.length + 1; limit += 1) {
      const page = facts(await reader.findFacts(world.tokens.own, { limit }));
      expect(idsOf(page), `limit ${limit}`).toEqual(idsOf(all).slice(0, limit));
      expect(page.more, `limit ${limit}`).toBe(limit < OWN_FACTS.length);
    }
    // The default limit is 20, more than the world holds.
    expect(facts(await reader.findFacts(world.tokens.wide, {})).facts).toHaveLength(
      OWN_FACTS.length + WORK_FACTS.length,
    );
  });

  it("order and bounds follow the message's sent time", async () => {
    const { reader } = world.store;
    const { lunchPlan } = world.records;
    // Its sealed content names another time; the stored valid_from is the message's sent time.
    expect(lunchPlan.claim.content.fields.when).not.toBe(world.messages.ownBlakeFirst.sentAt);
    const list = facts(await reader.findFacts(world.tokens.own, {}));
    expect(factNamed(world, list, "lunchPlan").at).toBe(world.messages.ownBlakeFirst.sentAt);

    // `from` and `to` are inclusive, on the sent time.
    const at = world.messages.ownSent.sentAt;
    const exactly = facts(await reader.findFacts(world.tokens.own, { from: at, to: at }));
    expect(new Set(idsOf(exactly))).toEqual(
      new Set([world.ids.ownerPromise, world.ids.unbuilt, world.ids.agentReported]),
    );
    const after = facts(await reader.findFacts(world.tokens.own, { from: at }));
    expect(idsOf(after)).toEqual(
      ordered(world, ["ownerPromise", "unbuilt", "agentReported", "receipt", "patPromise", "patReport"]),
    );
    const before = facts(await reader.findFacts(world.tokens.own, { to: at }));
    expect(idsOf(before)).toEqual(
      ordered(world, ["ownerPromise", "unbuilt", "agentReported", "blakePromise", "lunchPlan"]),
    );
    // The plan's own `when` is no bound: a window around it finds nothing.
    const around = facts(
      await reader.findFacts(world.tokens.own, { from: "2026-04-01T00:00:00.000Z", to: "2026-04-02T00:00:00.000Z" }),
    );
    expect(around).toEqual({ facts: [], more: false });
    // A bound given with an offset is read as the instant it names.
    const offset = facts(
      await reader.findFacts(world.tokens.own, { from: at.replace("Z", "+00:00"), to: at.replace("Z", "+00:00") }),
    );
    expect(idsOf(offset)).toEqual(idsOf(exactly));
  });

  it("a type finds itself, and the parent finds its children", async () => {
    const { reader } = world.store;
    const of = async (type: FindFactsArgs["type"]) => idsOf(facts(await reader.findFacts(world.tokens.own, { type })));
    expect(await of("transaction")).toEqual([world.ids.receipt]);
    expect(await of("transaction.receipt")).toEqual([world.ids.receipt]);
    expect(await of("plan")).toEqual([world.ids.lunchPlan]);
    expect(await of("commitment")).toEqual(
      ordered(world, ["blakePromise", "ownerPromise", "unbuilt", "agentReported", "patPromise", "patReport"]),
    );
    // A type the contract does not name is a bad argument, logged, with nothing read.
    expect(await reader.findFacts(world.tokens.own, { type: "trans" } as never)).toEqual({
      ok: false,
      code: "invalid_request",
    });
  });

  it("an entity finds the facts that name it as subject, speaker or field", async () => {
    const { reader } = world.store;
    const of = async (entity: string, token = world.tokens.own) =>
      idsOf(facts(await reader.findFacts(token, { entity: entity as EntityId })));
    // Blake: subject of a promise, speaker of a plan and a report, the counterparty of three.
    expect(await of(world.people.blake)).toEqual(
      ordered(world, ["blakePromise", "lunchPlan", "ownerPromise", "unbuilt", "agentReported", "patReport"]),
    );
    // Pat: subject of a promise and of Blake's report, speaker of the receipt.
    expect(await of(world.people.pat)).toEqual(ordered(world, ["receipt", "patPromise", "patReport"]));
    // With the other filters.
    expect(
      idsOf(facts(await reader.findFacts(world.tokens.own, { entity: world.people.blake as EntityId, type: "plan" }))),
    ).toEqual([world.ids.lunchPlan]);
    expect(await of(world.people.blake, world.tokens.wide)).toEqual(
      ordered(world, [
        "blakePromise",
        "lunchPlan",
        "ownerPromise",
        "unbuilt",
        "agentReported",
        "patReport",
        "workBlake",
      ]),
    );
  });

  it("the owner's id, a hidden id and an unknown id answer not_found alike", async () => {
    const { store } = world;
    const { reader, during } = recordingReader(store);
    const answers: { answer: unknown; statements: string[] }[] = [];
    // Wren is seen only under the employer's compartment.
    for (const id of [world.people.owner, world.people.wren, MISSING_ENTITY]) {
      const before = (await callLog(store.db.urls.admin)).length;
      const observed = await during(() => reader.findFacts(world.tokens.own, { entity: id as EntityId }));
      expect(observed.answer, id).toEqual(NOT_FOUND);
      expect((await callLog(store.db.urls.admin)).slice(before), id).toEqual([
        { client: "own-client", tool: "find_facts", rows: 0, outcome: "not_found" },
      ]);
      answers.push(observed);
    }
    // The same statements for all three.
    for (const one of answers) expect(one.statements).toEqual(answers[0]?.statements);
    // The positive control: the hidden id is found by the client that sees it.
    expect(idsOf(facts(await reader.findFacts(world.tokens.wide, { entity: world.people.wren as EntityId })))).toEqual([
      world.ids.wrenPlan,
    ]);
  });

  it("a text value is under untrusted, and a number, a date and a currency code are not", async () => {
    const list = facts(await world.store.reader.findFacts(world.tokens.own, {}));
    const receipt = factNamed(world, list, "receipt");
    expect(receipt.type).toBe("transaction.receipt");
    expect(receipt.fields).toEqual({
      merchant: { untrusted: "canary-merchant" },
      amount: 42.5,
      currency: "EUR",
      date: "2026-03-07",
      order_ref: { untrusted: "canary-order-7" },
    });
    const promise = factNamed(world, list, "ownerPromise");
    if (promise.type !== "commitment") throw new Error("not a commitment");
    expect(promise.fields.what).toEqual({ untrusted: "canary-fact-owner-promise" });
    expect(promise.fields.due).toBe("2026-03-12T17:00:00.000Z");
    const plan = factNamed(world, list, "lunchPlan");
    if (plan.type !== "plan") throw new Error("not a plan");
    expect(plan.fields.what).toEqual({ untrusted: "canary-fact-lunch" });
    expect(plan.fields.when).toBe("2026-04-01T10:00:00.000Z");
    // No text of evidence is anywhere outside an `untrusted`.
    const bare = JSON.stringify(list, (key, value: unknown) => (key === "untrusted" ? "" : value));
    expect(bare).not.toMatch(/canary-fact|canary-merchant|canary-order|Canary|@example\./);
  });

  it("a fact names the message read_message takes", async () => {
    const { reader } = world.store;
    const list = facts(await reader.findFacts(world.tokens.own, {}));
    for (const name of OWN_FACTS) {
      const fact = factNamed(world, list, name);
      expect(fact.message, name).toBe(world.messages[FACTS[name].item].id);
      expect(fact.source, name).toBe("mail");
      const message = outcomeValue(await reader.readMessage(world.tokens.own, { id: fact.message as MessageId }));
      expect(message.at, name).toBe(fact.at);
    }
  });

  it("the owner as subject is a Who of kind owner, with no name", async () => {
    const { reader } = world.store;
    for (const token of [world.tokens.own, world.tokens.wide]) {
      const list = facts(await reader.findFacts(token, {}));
      const owner = await ownerWho(world, token);
      const blake = await whoBySearch(world, token, WORLD.both.address);
      const pat = await whoBySearch(world, token, WORLD.ownOnly.address);
      expect(owner.address).not.toBeNull();

      const promise = factNamed(world, list, "ownerPromise");
      expect(promise.subject).toEqual(owner);
      expect(promise.statedBy).toEqual(owner);
      if (promise.type !== "commitment") throw new Error("not a commitment");
      expect(promise.fields.counterparty).toEqual(blake);
      // Blake's promise to the owner: the owner as a field.
      const blakes = factNamed(world, list, "blakePromise");
      expect(blakes.subject).toEqual(blake);
      if (blakes.type !== "commitment") throw new Error("not a commitment");
      expect(blakes.fields.counterparty).toEqual(owner);
      // The receipt: the owner's, stated by Pat.
      const receipt = factNamed(world, list, "receipt");
      expect(receipt.subject).toEqual(owner);
      expect(receipt.statedBy).toEqual(pat);
      expect([receipt.basis, receipt.statementKind]).toEqual(["third_party", "stated_fact"]);
    }
  });

  it("the status is the caller's own audience's, only on a claim in that belief's support, and absent where no belief is kept", async () => {
    const { reader } = world.store;
    const statusOf = (list: FactList, name: FactName) => factNamed(world, list, name).status;
    const own = facts(await reader.findFacts(world.tokens.own, {}));
    const wide = facts(await reader.findFacts(world.tokens.wide, {}));
    // The belief computed under each caller's clearance: the same claims, the same status.
    expect([statusOf(own, "blakePromise"), statusOf(wide, "blakePromise")]).toEqual(["active", "active"]);
    expect([statusOf(own, "patPromise"), statusOf(wide, "patPromise")]).toEqual(["active", "active"]);
    expect(statusOf(wide, "workBlake")).toBe("active");
    for (const list of [own, wide]) {
      // A receipt: no belief kind. A plan: none either. A commitment with no belief yet.
      for (const name of ["receipt", "lunchPlan", "unbuilt"] as const)
        expect("status" in factNamed(world, list, name), name).toBe(false);
      // A third party's report beside the commitment it speaks of: the key's belief, not its support.
      const report = factNamed(world, list, "patReport");
      expect("status" in report).toBe(false);
      expect([report.basis, report.thirdParty]).toEqual(["third_party", true]);
      expect(factNamed(world, list, "patPromise").thirdParty).toBe(false);
    }
    // A client cleared for the employer alone: the belief its own clearance computes, and none
    // for a plan.
    const work = facts(await reader.findFacts(world.tokens.work, {}));
    expect(idsOf(work)).toEqual(ordered(world, WORK_FACTS));
    expect(statusOf(work, "workBlake")).toBe("active");
    expect("status" in factNamed(world, work, "wrenPlan")).toBe(false);
  });

  it("a fact from a message the system sent says agentReported, and carries no status", async () => {
    const list = facts(await world.store.reader.findFacts(world.tokens.own, {}));
    const agent = factNamed(world, list, "agentReported");
    expect(agent.agentReported).toBe(true);
    expect("status" in agent).toBe(false);
    // The positive control: the owner's own promise beside it, under the same fact key.
    const promise = factNamed(world, list, "ownerPromise");
    expect([promise.agentReported, promise.status]).toEqual([false, "active"]);
    for (const fact of list.facts) if (fact.id !== agent.id) expect(fact.agentReported).toBe(false);
  });

  it("find_facts writes one call row, with the number of facts", async () => {
    const { store } = world;
    const log = () => callLog(store.db.urls.admin);
    for (const [args, rows] of [
      [{}, OWN_FACTS.length],
      [{ limit: 3 }, 3],
      [{ type: "plan" }, 1],
      [{ from: "2027-01-01T00:00:00.000Z" }, 0],
    ] as const) {
      const before = await log();
      const answer = await store.reader.findFacts(world.tokens.own, args as FindFactsArgs);
      expect(facts(answer).facts.length).toBe(rows);
      expect(await log()).toEqual([...before, { client: "own-client", tool: "find_facts", rows, outcome: "ok" }]);
    }
    for (const [args, outcome] of [
      [{ limit: 51 }, "invalid_request"],
      [{ from: "not a time" }, "invalid_request"],
      [{ extra: true }, "invalid_request"],
      [{ entity: MISSING_ENTITY }, "not_found"],
    ] as const) {
      const before = await log();
      expect(await store.reader.findFacts(world.tokens.own, args as never)).toEqual({ ok: false, code: outcome });
      expect(await log()).toEqual([...before, { client: "own-client", tool: "find_facts", rows: 0, outcome }]);
    }
  });

  it("every reader query has an order by, find_facts' too", async () => {
    const { reader, during } = recordingReader(world.store);
    const calls: [string, () => Promise<ReadOutcome<FactList>>][] = [
      ["all", () => reader.findFacts(world.tokens.wide, {})],
      [
        "a type and a window",
        () =>
          reader.findFacts(world.tokens.wide, {
            type: "transaction",
            from: "2026-01-01T00:00:00.000Z",
            to: "2026-12-31T00:00:00.000Z",
            limit: 2,
          }),
      ],
      ["an entity", () => reader.findFacts(world.tokens.own, { entity: world.people.blake as EntityId })],
      ["an unknown entity", () => reader.findFacts(world.tokens.own, { entity: MISSING_ENTITY })],
    ];
    for (const [name, call] of calls) {
      const { answer, statements } = await during(call);
      expect(answer.ok || name === "an unknown entity", name).toBe(true);
      expect(
        statements.some((text) => NAMES_KNOWLEDGE.test(text)),
        name,
      ).toBe(true);
      for (const text of statements) expect(orderFault(text), `${name}: ${text}`).toBeNull();
      // projections is not knowledge, so it is held to the rule here: its one statement ends in
      // an order by the belief's key.
      for (const text of statements.filter((one) => NAMES_PROJECTIONS.test(one)))
        expect(text, name).toMatch(/order by b\.id\s*$/i);
    }
  });

  it("no token, an unknown token and a revoked token each see no fact and no belief", async () => {
    const { store } = world;
    const { token: revoked } = await store.admin.clients.addClient(
      registration("revoked-fact-client", BOTH, FACT_TOOLS),
    );
    expect(await store.admin.clients.revokeClient("revoked-fact-client")).toBe(true);
    const counts = (token: string | null) =>
      readAs(store.db, token, async (query) => ({
        claims: (await query("select id from knowledge.claims")).length,
        entities: (await query("select claim_id from knowledge.claim_entities")).length,
        // What a belief computed at read is built from: every claim of a belief type the token sees.
        beliefs: (await query(BELIEF_INPUTS, [[...BELIEF_TYPES]])).length,
      }));
    for (const bad of [null, "", UNKNOWN_TOKEN, revoked, ...MALFORMED_TOKENS])
      expect(await counts(bad)).toEqual({ claims: 0, entities: 0, beliefs: 0 });
    const before = await callLog(store.db.urls.admin);
    for (const bad of ["", UNKNOWN_TOKEN, revoked, ...MALFORMED_TOKENS])
      expect(await store.reader.findFacts(bad, {})).toEqual(UNAUTHORIZED);
    expect(await callLog(store.db.urls.admin)).toEqual(before);
    // The positive control: a valid token reads every one of them.
    expect(await counts(world.tokens.wide)).toEqual({ claims: 10, entities: 11, beliefs: 7 });
    expect(facts(await store.reader.findFacts(world.tokens.wide, {})).facts).toHaveLength(10);
  });

  it("a client sees only the facts and beliefs of its own clearance", async () => {
    const { store } = world;
    const counts = (token: string) =>
      readAs(store.db, token, async (query) => ({
        claims: (await query<{ c: string }>("select compartments[1] as c from knowledge.claims order by id")).map(
          (row) => row.c,
        ),
        beliefs: (await query<{ c: string }>(BELIEF_INPUTS, [[...BELIEF_TYPES]])).map((row) => row.c),
      }));
    // The claims of a belief type its beliefs are computed from: the own commitments, and the
    // employer's one.
    expect(await counts(world.tokens.own)).toEqual({
      claims: Array.from({ length: 8 }, () => "own"),
      beliefs: Array.from({ length: 6 }, () => "own"),
    });
    expect(await counts(world.tokens.work)).toEqual({
      claims: ["employer:example", "employer:example"],
      beliefs: ["employer:example"],
    });
    const own = facts(await store.reader.findFacts(world.tokens.own, {}));
    expect(JSON.stringify(own)).not.toMatch(/canary-work|Canary-Workname|Canary-Workonly|example\.org/);
    const work = facts(await store.reader.findFacts(world.tokens.work, {}));
    // Blake is seen under both, by one address; the owner's personal address and Pat are own alone.
    expect(JSON.stringify(work)).not.toMatch(/canary-fact|Canary-Both"|Canary-Ownonly|pat\.ownonly|owner\.personal/);
    // The positive control: the wide client's answer holds both.
    const wide = JSON.stringify(facts(await store.reader.findFacts(world.tokens.wide, {})));
    expect(wide).toMatch(/canary-work-fact/);
    expect(wide).toMatch(/canary-fact-deck/);
    expect(wide).toMatch(/pat\.ownonly/);
    expect(wide).toMatch(/Canary-Workonly/);
  });

  it("the token does not survive its transaction", async () => {
    const { store } = world;
    const { backend } = await leftOn(store.readerPool);
    expect(facts(await store.reader.findFacts(world.tokens.wide, {})).facts.length).toBeGreaterThan(0);
    const left = await leftOn(store.readerPool);
    expect(left.token).toBe("");
    expect(left.accounts).toBe(0);
    expect(left.idle).toBe(true);
    expect(typeof backend).toBe("number");
  });
});

describe("find_facts against a changed store", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a client cleared for own alone gets the same facts, statuses, order and more with and without the employer's claims", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedFacts(store);
      const { reader, during } = recordingReader(store);
      const argsList: FindFactsArgs[] = [
        {},
        { limit: 3 },
        { limit: 8 },
        { type: "commitment" },
        { entity: world.people.blake as EntityId },
        { from: world.messages.ownSent.sentAt },
      ];
      const observe = async () => {
        const seen = [];
        for (const args of argsList) {
          const before = (await callLog(store.db.urls.admin)).length;
          const { answer, statements } = await during(() => reader.findFacts(world.tokens.own, args));
          seen.push({ answer, statements, logged: (await callLog(store.db.urls.admin)).slice(before) });
        }
        return seen;
      };
      // The reader's first call for a client also opens the client's session and its
      // later calls reuse it: that call is made first, so the calls compared are alike.
      expect((await reader.findFacts(world.tokens.own, {})).ok).toBe(true);
      const withEmployer = await observe();
      // Not vacuous: the employer's claims are there, and a wide client sees them.
      expect(facts(await reader.findFacts(world.tokens.wide, {})).facts).toHaveLength(10);

      // The employer's claims and their entities removed: the beliefs computed from them go with them.
      // As the claims' owner: pi_admin removes no claim directly.
      await asClaimsOwner(store.db, async (query) => {
        await query("delete from knowledge.claim_entities where compartments = '{employer:example}'");
        await query("delete from knowledge.claims where compartments = '{employer:example}'");
      });
      expect(facts(await reader.findFacts(world.tokens.wide, {})).facts).toHaveLength(8);
      expect(await observe()).toEqual(withEmployer);
    } finally {
      await store.close();
    }
  });

  it("a claim of another compartment that reached the reader does not open", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedFacts(store);
      const { log, db, reader } = store;
      // The positive control: the own client is answered, with nothing of the employer's.
      const before = facts(await reader.findFacts(world.tokens.own, {}));
      expect(idsOf(before)).toEqual(ordered(world, OWN_FACTS));

      // In this test database only: pi_reader's row policy on claims lets every row through, as
      // a policy written wrongly would. The reader's keys are then all that stands.
      await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("alter policy pi_reader_select on knowledge.claims using (true)");
        await query("alter policy pi_reader_select on knowledge.claim_entities using (true)");
      });
      // Not vacuous: the employer's claims reach a session that carries the own token.
      const reached = await readAs(db, world.tokens.own, (query) =>
        query<{ c: string }>("select distinct compartments[1] as c from knowledge.claims order by 1"),
      );
      expect(reached.map((row) => row.c)).toEqual(["employer:example", "own"]);
      // The employer's messages are still hidden by their own policy; let them through too, so
      // the claim is joined to its message and has to be opened.
      await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("alter policy pi_reader_select on knowledge.messages using (not held)");
      });

      const logged = await callLog(db.urls.admin);
      const events = log.events.length;
      expect(await reader.findFacts(world.tokens.own, {})).toEqual(UNAVAILABLE);
      expect(log.events.slice(events)).toEqual([{ event: "read_failed", code: "unavailable" }]);
      expect(await callLog(db.urls.admin)).toEqual(logged);

      // The other control: through the same policies the wide client is answered, so it is the
      // keys that refused.
      expect(facts(await reader.findFacts(world.tokens.wide, {})).facts).toHaveLength(10);
    } finally {
      await store.close();
    }
  });

  it("find_facts returns no fact whose message is held", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedFacts(store);
      const { db, reader } = store;
      const held = world.messages.ownPat;
      const before = facts(await reader.findFacts(world.tokens.own, {}));
      expect(idsOf(before)).toContain(world.ids.receipt);

      // Held by hand, after its claims were written.
      await queryAs(db.urls.admin, "update knowledge.messages set held = true where id = $1", [held.id]);
      const kept = OWN_FACTS.filter((name) => FACTS[name].item !== "ownPat");
      const logBefore = (await callLog(db.urls.admin)).length;
      const during = facts(await reader.findFacts(world.tokens.own, {}));
      expect(idsOf(during)).toEqual(ordered(world, kept));
      expect(during.more).toBe(false);
      expect((await callLog(db.urls.admin)).slice(logBefore)).toEqual([
        { client: "own-client", tool: "find_facts", rows: kept.length, outcome: "ok" },
      ]);
      // `more` and the limit are over the rows returned: the held facts take no place.
      const page = facts(await reader.findFacts(world.tokens.own, { limit: kept.length }));
      expect([page.facts.length, page.more]).toEqual([kept.length, false]);
      // Nor by the entity whose facts they are.
      expect(idsOf(facts(await reader.findFacts(world.tokens.own, { entity: world.people.pat as EntityId })))).toEqual([
        world.ids.patReport,
      ]);

      // The row policy, not the statement's clause, is the control: a statement with no `not
      // held` in it finds no row for the message.
      expect(
        await readAs(db, world.tokens.own, (query) =>
          query("select m.id from knowledge.messages m where m.id = $1", [held.id]),
        ),
      ).toEqual([]);
      // The positive control of that: an unheld message is found by the same statement.
      expect(
        await readAs(db, world.tokens.own, (query) =>
          query("select m.id from knowledge.messages m where m.id = $1", [world.messages.ownSent.id]),
        ),
      ).toEqual([{ id: world.messages.ownSent.id }]);

      // Present once the message is released.
      expect(await store.admin.held.releaseHeld({ id: held.id })).toEqual({ released: 1 });
      expect(facts(await reader.findFacts(world.tokens.own, {}))).toEqual(before);
    } finally {
      await store.close();
    }
  });

  it("find_facts sends the same statements for one fact and for fifty", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedFacts(store, { facts: [] });
      const item = world.messages.ownBlakeFirst;
      // Sixty promises of Blake's to the owner in one message, as one commit.
      const records = Array.from({ length: 60 }, (_, n) =>
        recordOf(`many-${n}`, { ...FACTS.blakePromise, n: n + 1, factKey: `k-many-${n}` }, item, world.people),
      );
      const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
      try {
        expect(await pipeline.commit(batchOf(item.evidenceId, records))).toBe("committed");
      } finally {
        await pipeline.close();
      }
      await knownBy(store.db, WORLD_NOW);
      const { reader, during } = recordingReader(store);
      // The reader's first call for a client also opens the client's session and its
      // later calls reuse it: that call is made first, so the calls compared are alike.
      expect((await reader.findFacts(world.tokens.own, {})).ok).toBe(true);
      for (const extra of [{}, { entity: world.people.blake as EntityId }, { type: "commitment" as const }]) {
        const small = await during(() => reader.findFacts(world.tokens.own, { ...extra, limit: 1 }));
        const large = await during(() => reader.findFacts(world.tokens.own, { ...extra, limit: 50 }));
        expect([facts(small.answer).facts.length, facts(large.answer).facts.length]).toEqual([1, 50]);
        expect(facts(large.answer).facts.every((fact) => fact.status === "active")).toBe(true);
        expect(large.statements).toEqual(small.statements);
        expect(large.statements.filter((text) => LOG_CALL.test(text))).toHaveLength(1);
      }
      // And for a page with no fact at all.
      const none = await during(() => reader.findFacts(world.tokens.own, { from: "2027-01-01T00:00:00.000Z" }));
      const some = await during(() => reader.findFacts(world.tokens.own, {}));
      expect(facts(none.answer).facts).toEqual([]);
      expect(none.statements).toEqual(some.statements);
    } finally {
      await store.close();
    }
  });
});
