import type { Claim } from "@intelligence/contracts";
import { type ClaimRecord, type EntityId, EntityView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimKey, fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { QUENTIN, WORK_ONLY } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { factRecordOf } from "../test-support/fact-fixtures.ts";
import { MAIL } from "../test-support/items-named.ts";
import { knownBy } from "../test-support/known-by.ts";
import {
  type AgentWorld,
  batchOf,
  claimRecord,
  rowsOf,
  stored,
  withAgents,
} from "../test-support/pipeline-fixtures.ts";
import { recordingLogger, recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, outcomeValue, registration } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { SUBJECT_KEYS } from "./computed-beliefs.ts";
import { Reader } from "./read.ts";

// get_entity's facts. Claims are committed through the Pipeline, their beliefs computed when asked.
// No model is called. Reserved domains only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const TOOLS = ["get_entity"];
const VIEWS = ["self", "people", "work"];

type Spec = {
  key: string;
  type: string;
  kind: string;
  subject: string;
  by: string;
  message: Message;
  fields: Record<string, unknown>;
  fieldKinds: Record<string, string>;
  values: Record<string, unknown>;
  entities: string[];
  status?: "active" | "stale";
  // The claim's time, in place of its message's: an old one ages the belief computed from it.
  at?: string;
  disputed?: boolean;
};

async function seed(
  store: TestStore,
  owner: string,
  specs: Spec[],
  _audiences: string[][],
): Promise<Map<string, ClaimRecord>> {
  const records = new Map(specs.map((spec) => [spec.key, factRecordOf(spec, owner)]));
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const byItem = new Map<string, ClaimRecord[]>();
    for (const record of records.values())
      byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
    for (const [evidenceId, claims] of byItem)
      expect(await pipeline.commit(batchOf(evidenceId as never, claims))).toBe("committed");
    await knownBy(store.db, store.now);
  } finally {
    await pipeline.close();
  }
  return records;
}

describe("get_entity's compiled facts", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string; pat: string };
  let own: Client;
  let wide: Client;
  let messages: Message[];

  const freshReader = () => {
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
    return { reader, statements: recorded.statements };
  };
  const entity = async (client: Client, id: string) =>
    EntityView.parse(outcomeValue(await freshReader().reader.getEntity(client.token, { id: id as EntityId })));
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
    messages = await worldMessages(store);
    const text = (value: string) => value;
    await seed(
      store,
      people.owner,
      [
        {
          key: "k-role",
          type: "role",
          kind: "role",
          subject: people.blake,
          by: people.blake,
          message: on("own", 0),
          fields: { title: text("canary-title-blake") },
          fieldKinds: { title: "text" },
          values: {},
          entities: [people.blake],
        },
        {
          key: "k-rel",
          type: "relationship",
          kind: "relationship",
          subject: people.blake,
          by: people.owner,
          message: on("own", 1),
          fields: { counterparty: people.owner, relation: "sibling" },
          fieldKinds: { counterparty: "entity", relation: "enum" },
          values: { counterparty: people.owner, relation: "sibling" },
          entities: [people.blake],
        },
        {
          key: "k-need",
          type: "need",
          kind: "need",
          subject: people.blake,
          by: people.blake,
          message: on("own", 2),
          fields: { what: text("canary-need-blake") },
          fieldKinds: { what: "text" },
          values: {},
          entities: [people.blake],
          status: "stale",
          // Said 70 days ago: a need is stale after 60.
          at: daysFrom(WORLD_NOW, -70).toISOString(),
        },
        // Pat's, which names Blake as its counterparty: not Blake's belief.
        {
          key: "k-pat-rel",
          type: "relationship",
          kind: "relationship",
          subject: people.pat,
          by: people.pat,
          message: on("own", 3),
          fields: { counterparty: people.blake, relation: "friend" },
          fieldKinds: { counterparty: "entity", relation: "enum" },
          values: { counterparty: people.blake, relation: "friend" },
          entities: [people.pat, people.blake],
        },
        // The employer's, for the wide audience alone.
        {
          key: "k-work-role",
          type: "role",
          kind: "role",
          subject: people.blake,
          by: people.blake,
          message: on("employer:example", 0),
          fields: { title: text("canary-work-title") },
          fieldKinds: { title: "text" },
          values: {},
          entities: [people.blake],
        },
      ],
      [OWN, WIDE],
    );
    own = await insertReader(store, "own-entity-facts", OWN, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "wide-entity-facts", ["own", "employer:example"], { tools: TOOLS, views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  // The card serves its beliefs as lines, the current role and the
  // relationship to the owner first, each rendered from its one cite; no fact in no belief.
  it("get_entity's lines are the person's beliefs, each from its citing claim, the head first, and none it only names", async () => {
    const view = await entity(own, people.blake);
    expect(view.facts).toBeUndefined();
    expect(view.lines!.map((one) => one.kind)).toEqual(["role", "relationship", "need"]);
    for (const line of view.lines!) expect(line.cites).toBe(1);
    expect(view.lines![0]?.line.untrusted).toMatch(/^canary-title-blake, since /);
    expect(view.lines![1]?.line.untrusted).toMatch(/^Sibling: /);
    expect(view.lines![2]).toMatchObject({ status: "stale", line: { untrusted: "Need: canary-need-blake" } });
    expect(view.more).toBe(false);
    // Pat's belief that names Blake is Pat's, not Blake's.
    expect((await entity(own, people.pat)).lines!.map((one) => one.kind)).toEqual(["relationship"]);
  });

  it("a claim the caller cannot see changes no line, order or more", async () => {
    const narrow = await entity(own, people.blake);
    const both = await entity(wide, people.blake);
    expect(both.lines!.map((one) => one.kind).sort()).toEqual(["need", "relationship", "role", "role"]);
    const work = both.lines!.filter((one) => one.line.untrusted.includes("canary-work-title")).map((one) => one.fact);
    expect(work).toHaveLength(1);
    expect(narrow.lines!.map((one) => one.fact).sort()).toEqual(
      both
        .lines!.map((one) => one.fact)
        .filter((fact) => !work.includes(fact))
        .sort(),
    );
    expect(JSON.stringify(narrow)).not.toContain("canary-work-title");
    expect(narrow.more).toBe(false);
  });

  it("get_entity sends the same statements for an entity with no belief and one with several", async () => {
    const first = freshReader();
    outcomeValue(await first.reader.getEntity(own.token, { id: people.pat as EntityId }));
    const second = freshReader();
    outcomeValue(await second.reader.getEntity(own.token, { id: people.blake as EntityId }));
    // From the compiled facts' first statement on: the earlier ones are get_entity's own.
    const facts = (list: string[]) => list.slice(list.indexOf(SUBJECT_KEYS));
    expect(facts(first.statements).length).toBeGreaterThan(8);
    expect(facts(first.statements)).toEqual(facts(second.statements));
  });
});

// What a compiled belief cites. A finding's claim is cited as find_facts serves it, a FactView with
// `message` null, told from a held message's claim by its ledger.agent_writes row, and never
// bound; a held message's claim is cited as held, with no text; at most six supporting claims
// of a fact key are read. Agent records are written through `record` and taken in by the writer.
describe("what get_entity's compiled beliefs cite", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  const AUDIENCE = ["agent:alpha", "own"];
  const at = (day: number) => new Date(Date.parse("2026-09-01T09:00:00.000Z") + day * 86_400_000).toISOString();

  // A need about the person, of one item, under that item's label, naming the person.
  function need(
    evidence: string,
    label: string | string[],
    person: string,
    n: number,
    words: string,
    options: { day?: number; finding?: boolean; names?: string[] } = {},
  ): ClaimRecord {
    const base = claimRecord(evidence, label, person, {
      n,
      type: "need",
      factKey: `cite-${evidence}-${n}`,
      entities: [person, ...(options.names ?? [])],
      validFrom: at(options.day ?? 0),
      ...(options.finding === true ? { origin: "agent_record" as const, basis: "third_party" as const } : {}),
    });
    const claim = { ...base.claim, content: { ...base.claim.content, fields: { what: words } } } as Claim;
    // A finding has no speaker; a message's claim is the person's own.
    if (options.finding !== true) Object.assign(claim, { assertedBy: person });
    return { ...base, claim, subjectKind: "person", fieldKinds: { what: "text" } } as ClaimRecord;
  }
  const keyed = (record: ClaimRecord, factKey: string): ClaimRecord => ({ ...record, factKey }) as ClaimRecord;
  // A claim's stored id is its id fingerprinted under the store's keys (the commit's `claims`).
  const idOf = (world: AgentWorld, record: ClaimRecord): string => fingerprint(world.db.keys, "claim", record.claim.id);

  it("a need resting only on a confirmed finding is cited by the finding's fact, message null, and bound to nothing; a held message's claim is cited as held, without text; a belief all of whose claims are held is still served", () =>
    withAgents(async (world) => {
      await stored(world.writer, world.accounts.personalMail, MAIL.fromQuentin);
      await stored(world.writer, world.accounts.workMail, MAIL.workOnly);
      const wren = one(
        await rowsOf<{ entity_id: string }>(
          world.db,
          "select entity_id from knowledge.accounts where value_fp = $1 and compartments = $2::text[]",
          [fingerprint(world.db.keys, "address", WORK_ONLY.address), ["employer:example"]],
        ),
      ).entity_id;
      const solo = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const canary = await stored(world.writer, world.accounts.personalMail, MAIL.canary);
      const quentin = one(
        await rowsOf<{ entity_id: string }>(
          world.db,
          "select entity_id from knowledge.accounts where value_fp = $1 and compartments = $2::text[]",
          [fingerprint(world.db.keys, "address", QUENTIN.address), ["own"]],
        ),
      ).entity_id;
      const finding = await world.record("alpha");
      const label = one(
        await rowsOf<{ compartments: string[] }>(
          world.db,
          "select compartments from vault.evidence_items where id = $1",
          [finding.evidence],
        ),
      ).compartments;
      expect([...label].sort()).toEqual(AUDIENCE);

      const found = keyed(
        need(finding.evidence, label, quentin, 1, "canary-cite-finding", { finding: true }),
        "k-finding",
      );
      const heldOnly = keyed(need(canary, "own", quentin, 1, "canary-cite-held-only"), "k-held");
      const heldEarlier = keyed(need(canary, "own", quentin, 2, "canary-cite-held-earlier", { day: 1 }), "k-mixed");
      const shownLater = keyed(need(solo, "own", quentin, 1, "canary-cite-shown-later", { day: 2 }), "k-mixed");
      // The latest, a held message's claim that also names a person the caller cannot see.
      const namesHidden = keyed(
        need(canary, "own", quentin, 3, "canary-cite-names-hidden", { day: 3, names: [wren] }),
        "k-mixed",
      );
      expect(await world.pipeline.commit(batchOf(finding.evidence, [found], { lane: "agent" }))).toBe("committed");
      expect(await world.pipeline.commit(batchOf(canary, [heldOnly, heldEarlier, namesHidden]))).toBe("committed");
      expect(await world.pipeline.commit(batchOf(solo, [shownLater]))).toBe("committed");
      // The owner confirms the finding's card: only a confirmed finding counts in a belief.
      const key = claimKey(world.db.keys, finding.evidence, fingerprint(world.db.keys, "fact", "k-finding"));
      const [card] = await rowsOf<{ id: string }>(
        world.db,
        "select id from ledger.cards where kind = 'agent_claim' and request_id = $1",
        [key],
      );
      if (card === undefined) throw new Error("no card for the finding");
      await world.admin.cards.decide({
        cards: [card.id as never],
        answer: "confirm",
        requestId: testId("req").slice(4),
      });
      await queryAs(world.db.urls.admin, "update knowledge.messages set held = true where evidence_id = $1", [canary]);
      // A reader whose clock stands just after the claims, every one of them known by it, so no need
      // has aged by the day the test runs.
      const pinnedAt = new Date(at(4));
      await knownBy(world.db, pinnedAt);
      const pinned = new Reader({
        pool: world.store.readerPool,
        keys: world.db.keys,
        log: world.store.log,
        now: () => pinnedAt,
      });

      // A client cleared for the finding's label, holding every view its writer held.
      const { token } = await world.admin.clients.addClient(
        registration("delta", AUDIENCE, { views: ["self", "people", "work"], tools: ["get_entity", "find_facts"] }),
      );
      const view = EntityView.parse(outcomeValue(await pinned.getEntity(token, { id: quentin as EntityId })));
      // Each belief is one line, rendered from its one cite.
      const byFact = new Map(view.lines!.map((one) => [one.fact, one]));
      const line = (factKey: string) => byFact.get(fingerprint(world.db.keys, "fact", factKey));

      // The finding's line, and its fact as find_facts serves it, through the line's fact.
      expect(line("k-finding")?.line.untrusted).toBe("Need: canary-cite-finding");
      const behind = outcomeValue(
        await pinned.findFacts(token, { belief: fingerprint(world.db.keys, "fact", "k-finding") }),
      ).facts;
      // It names its agent record, which a planner's basis cites.
      expect(behind).toHaveLength(1);
      expect(behind[0]).toMatchObject({
        id: idOf(world, found),
        message: null,
        record: finding.record,
        source: "agent",
        agentReported: true,
        provenance: "agent_reported",
        status: "active",
        fields: { what: { untrusted: "canary-cite-finding" } },
      });
      const fromFindFacts = outcomeValue(await pinned.findFacts(token, { type: "need" })).facts.find(
        (one) => one.id === idOf(world, found),
      );
      expect(behind[0]).toEqual(fromFindFacts);

      // The held message's claims: its line holds no text, and the belief is still served.
      expect(line("k-held")?.line.untrusted).toBe("Need: (held)");
      // The card renders a belief from its latest claim alone; find_facts'
      // belief gives every one the token returns: the held ones are not among them.
      expect(line("k-mixed")?.line.untrusted).toBe("Need: canary-cite-shown-later");
      expect(
        outcomeValue(
          await pinned.findFacts(token, { belief: fingerprint(world.db.keys, "fact", "k-mixed") }),
        ).facts.map((one) => one.id),
      ).toEqual([idOf(world, shownLater)]);
      const text = JSON.stringify(view);
      for (const words of ["canary-cite-held-only", "canary-cite-held-earlier"]) expect(text).not.toContain(words);
      expect(text).toContain("canary-cite-shown-later");

      // The read log: the shown message's evidence is bound; the finding's and the held one's never.
      // The finding's agent record is shown by its own id, by get_entity and find_facts.
      const client = one(
        await rowsOf<{ id: string }>(world.db, "select id from policy.clients where name = 'delta'"),
      ).id;
      const [logged] = await rowsOf<{ bound: string[]; shown: string[] }>(
        world.db,
        "select bound, shown from ledger.read_log where client_id = $1 and tool = 'get_entity' order by id",
        [client],
      );
      expect(logged?.bound).toEqual([solo]);
      // And the messages knownVia names, the first thread and each co-recipient's latest, by their
      // evidence; never the held one's.
      const known = [
        view.knownVia?.firstThread?.message,
        ...(view.knownVia?.coRecipients ?? []).map((one) => one.message),
      ].filter((one) => one !== undefined);
      expect(known.length).toBeGreaterThan(0);
      const knownEvidence = (
        await rowsOf<{ evidence_id: string }>(
          world.db,
          "select distinct evidence_id from knowledge.messages where id = any($1)",
          [known],
        )
      ).map((row) => row.evidence_id);
      expect([...(logged?.shown ?? [])].sort()).toEqual([finding.record, ...knownEvidence].sort());
      expect(logged?.shown).not.toContain(canary);
      const [listed] = await rowsOf<{ shown: string[] }>(
        world.db,
        "select shown from ledger.read_log where client_id = $1 and tool = 'find_facts' order by id",
        [client],
      );
      expect(listed?.shown).toEqual([finding.record]);

      // A client cleared for the label but lacking a view the finding's writer held (`work`) is not
      // given its ledger.agent_writes row: find_facts, a `work` tool, refuses it outright, and
      // get_entity neither cites the finding as a held message's nor shows the belief resting on it
      // alone.
      const narrow = await world.admin.clients.addClient(
        registration("narrow", AUDIENCE, { views: ["self", "people"], tools: ["get_entity", "find_facts"] }),
      );
      const narrowView = EntityView.parse(
        outcomeValue(await pinned.getEntity(narrow.token, { id: quentin as EntityId })),
      );
      expect(await pinned.findFacts(narrow.token, { type: "need" })).toMatchObject({
        ok: false,
        code: "not_permitted",
      });
      const narrowFacts = narrowView.lines!.map((one) => one.fact);
      expect(narrowFacts).not.toContain(fingerprint(world.db.keys, "fact", "k-finding"));
      expect(narrowFacts).toContain(fingerprint(world.db.keys, "fact", "k-held"));
      expect(JSON.stringify(narrowView)).not.toContain(idOf(world, found));
    }));

  it("at most six supporting claims of a fact key are read, by a window over the claims the token returns, and the card cites the latest", () =>
    withAgents(async (world) => {
      await stored(world.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const solo = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const quentin = one(
        await rowsOf<{ entity_id: string }>(
          world.db,
          "select entity_id from knowledge.accounts where value_fp = $1 and compartments = $2::text[]",
          [fingerprint(world.db.keys, "address", QUENTIN.address), ["own"]],
        ),
      ).entity_id;
      const claims = Array.from({ length: 8 }, (_, index) =>
        keyed(need(solo, "own", quentin, index + 1, `canary-many-${index + 1}`, { day: index }), "k-many"),
      );
      expect(await world.pipeline.commit(batchOf(solo, claims))).toBe("committed");
      const { token } = await world.admin.clients.addClient(
        registration("many", ["own"], { views: ["self", "people", "work"], tools: ["get_entity"] }),
      );
      const recorded = recordingPool(world.store.readerPool);
      const reader = new Reader({ pool: recorded.pool, keys: world.db.keys, log: world.store.log });
      const view = EntityView.parse(outcomeValue(await reader.getEntity(token, { id: quentin as EntityId })));
      // The card's line is rendered from the latest of them.
      expect(view.lines![0]?.line.untrusted).toBe("Need: canary-many-8");
      const support = recorded.statements.filter((text) =>
        text.includes("row_number() over (partition by c.fact_key_fp"),
      );
      expect(support).toHaveLength(1);
    }));
});
