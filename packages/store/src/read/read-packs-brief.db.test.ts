import {
  type ClaimRecord,
  CommitmentList,
  type CompiledBelief,
  ContextPack,
  EntityId,
  EntityView,
  EventId,
  type PackItem,
  type PackSection,
} from "@intelligence/contracts/personal";
import { attendeeFacts } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import { bulkCommitments } from "../test-support/bulk-claims.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { factRecordOf } from "../test-support/fact-fixtures.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger, recordingPool } from "../test-support/recording.ts";
import { eventIdOf, openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// Claims are committed through the Pipeline, their beliefs computed when asked. No model is called.
// Reserved domains only.

const OWN = ["own"];
const TOOLS = ["get_entity", "build_context_pack", "get_commitments"];
const VIEWS = ["self", "people", "work"];
const ABSENT = "ent_01JABCDEFGHJKMNPQRSTVWXYZ0";

type Spec = {
  key: string;
  type: string;
  subject: string;
  by: string;
  message: Message;
  fields: Record<string, unknown>;
  fieldKinds: Record<string, string>;
  values: Record<string, unknown>;
  entities: string[];
  status?: "active" | "stale" | "closed";
  // The claim's time, in place of its message's, and whether it takes the fact back: what the
  // belief computed at read reads its status from.
  at?: string;
  reversal?: true;
};

function recordOf(spec: Spec, owner: string): ClaimRecord {
  return factRecordOf({ ...spec, ...(spec.reversal === true ? { statementKind: "reversal" as const } : {}) }, owner);
}

// Commits the specs' claims, item by item, and returns their records by key. A commit replaces
// every claim of its item, so an item's claims already committed (`existing`) are committed again
// beside the new ones.
async function commit(
  store: TestStore,
  owner: string,
  specs: Spec[],
  existing: ReadonlyMap<string, ClaimRecord> = new Map(),
): Promise<Map<string, ClaimRecord>> {
  const records = new Map(specs.map((spec) => [spec.key, recordOf(spec, owner)]));
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const byItem = new Map<string, ClaimRecord[]>();
    for (const record of records.values())
      byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
    for (const record of existing.values()) {
      const item = byItem.get(record.claim.primaryEvidenceId);
      if (item !== undefined) item.push(record);
    }
    for (const [evidenceId, claims] of byItem)
      expect(await pipeline.commit(batchOf(evidenceId as never, claims))).toBe("committed");
  } finally {
    await pipeline.close();
  }
  await knownBy(store.db, WORLD_NOW);
  return records;
}

const section = (pack: ContextPack, name: PackSection): PackItem[] =>
  pack.items.filter((item) => item.section === name);
const beliefsIn = (pack: ContextPack): CompiledBelief[] =>
  section(pack, "facts").flatMap((item) => (item.kind === "belief" ? [item.belief] : []));

describe("meeting_prep@4 and person_brief@1", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string; pat: string; wren: string };
  let messages: Message[];
  let specs: Spec[];
  let records: Map<string, ClaimRecord>;
  let own: Client;
  let wide: Client;
  let ownNext: string;

  const freshReader = () => {
    const recorded = recordingPool(store.readerPool);
    return {
      reader: new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now }),
      statements: recorded.statements,
    };
  };
  const brief = async (client: Client, entity: string) =>
    ContextPack.parse(
      outcomeValue(
        await freshReader().reader.buildContextPack(client.token, {
          purpose: "person_brief",
          entity: EntityId.parse(entity),
        }),
      ),
    );
  const prep = async (client: Client, event: string) =>
    ContextPack.parse(
      outcomeValue(
        await freshReader().reader.buildContextPack(client.token, {
          purpose: "meeting_prep",
          event: EventId.parse(event),
        }),
      ),
    );
  const entity = async (client: Client, id: string) =>
    EntityView.parse(outcomeValue(await freshReader().reader.getEntity(client.token, { id: EntityId.parse(id) })));
  // The nth message of a compartment, counting round when the world has fewer.
  const on = (compartment: string, n: number): Message => {
    const of = messages.filter((one) => one.compartment === compartment);
    return of[n % of.length] as Message;
  };

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = {
      owner: world.ownerEntity(),
      blake: world.entityOf(WORLD.both.address),
      pat: world.entityOf(WORLD.ownOnly.address),
      wren: world.entityOf(WORLD.workOnly.address),
    };
    messages = await worldMessages(store);
    const { owner, blake, pat } = people;
    const text = { what: "text" };
    specs = [
      {
        key: "b-role",
        type: "role",
        subject: blake,
        by: blake,
        message: on("own", 0),
        fields: { title: "canary-brief-title" },
        fieldKinds: { title: "text" },
        values: {},
        entities: [blake],
      },
      {
        key: "b-consent",
        type: "consent",
        subject: blake,
        by: blake,
        message: on("own", 1),
        fields: { about: "introduce", what: "canary-brief-consent" },
        fieldKinds: { about: "enum", ...text },
        values: { about: "introduce" },
        entities: [blake],
      },
      {
        key: "b-rule",
        type: "contact_rule",
        subject: blake,
        by: blake,
        message: on("own", 2),
        fields: { rule: "only_via", channel: "email", what: "canary-brief-rule" },
        fieldKinds: { rule: "enum", channel: "enum", ...text },
        values: { rule: "only_via", channel: "email" },
        entities: [blake],
      },
      {
        key: "b-need",
        type: "need",
        subject: blake,
        by: blake,
        message: on("own", 3),
        fields: { what: "canary-brief-need" },
        fieldKinds: text,
        values: {},
        entities: [blake],
        status: "stale",
        // Said 70 days ago: a need is stale after 60.
        at: daysFrom(WORLD_NOW, -70).toISOString(),
      },
      // Not an attendee kind: in the brief, not in the meeting's facts.
      {
        key: "b-goal",
        type: "goal",
        subject: blake,
        by: blake,
        message: on("own", 4),
        fields: { what: "canary-brief-goal" },
        fieldKinds: text,
        values: {},
        entities: [blake],
      },
      // Closed: in the brief, not in the meeting's facts, which hold open beliefs only.
      {
        key: "b-affiliation",
        type: "affiliation",
        subject: blake,
        by: blake,
        message: on("own", 5),
        fields: { relation: "member", organization_name: "canary-brief-club" },
        fieldKinds: { relation: "enum", organization_name: "text" },
        values: { relation: "member" },
        entities: [blake],
        status: "closed",
        reversal: true,
      },
      // The open commitments between Blake and the owner, either way, and one closed; Pat's is not
      // Blake's.
      {
        key: "b-owes",
        type: "commitment",
        subject: blake,
        by: blake,
        message: on("own", 6),
        fields: { counterparty: owner, what: "canary-brief-owes" },
        fieldKinds: { counterparty: "entity", ...text },
        values: { counterparty: owner },
        entities: [blake],
      },
      {
        key: "b-owed",
        type: "commitment",
        subject: owner,
        by: owner,
        message: on("own", 7),
        fields: { counterparty: blake, what: "canary-brief-owed" },
        fieldKinds: { counterparty: "entity", ...text },
        values: { counterparty: blake },
        entities: [blake],
      },
      {
        key: "b-done",
        type: "commitment",
        subject: blake,
        by: blake,
        message: on("own", 8),
        fields: { counterparty: owner, what: "canary-brief-done" },
        fieldKinds: { counterparty: "entity", ...text },
        values: { counterparty: owner },
        entities: [blake],
        status: "closed",
        reversal: true,
      },
      {
        key: "p-owes",
        type: "commitment",
        subject: pat,
        by: pat,
        message: on("own", 9),
        fields: { counterparty: owner, what: "canary-brief-pat" },
        fieldKinds: { counterparty: "entity", ...text },
        values: { counterparty: owner },
        entities: [pat],
      },
      {
        key: "p-role",
        type: "role",
        subject: pat,
        by: pat,
        message: on("own", 10),
        fields: { title: "canary-brief-pat-title" },
        fieldKinds: { title: "text" },
        values: {},
        entities: [pat],
      },
    ];
    records = await commit(store, owner, specs);
    own = await insertReader(store, "brief-own", OWN, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "brief-wide", ["own", "employer:example"], { tools: TOOLS, views: VIEWS });
    ownNext = await eventIdOf(store, WORLD.ownMeeting);
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("meeting_prep's new version holds each attendee's open facts of the six kinds, five each, after commitments", async () => {
    const pack = await prep(own, ownNext);
    expect(pack.template).toBe("meeting_prep@8");
    const attendees = section(pack, "attendees").flatMap((item) =>
      item.kind === "attendee" ? [item.attendee.who] : [],
    );
    expect(attendees.map((who) => who.id)).toContain(people.blake);
    // Each attendee's beliefs as get_beliefs compiles them (get_entity serves lines), narrowed as
    // the pack narrows them.
    const beliefs = await insertReader(store, "brief-beliefs", OWN, { tools: ["get_beliefs"], views: VIEWS });
    const compiled = (
      await Promise.all(
        attendees.map(
          async (who) =>
            outcomeValue(
              await freshReader().reader.getBeliefs(beliefs.token, {
                entity: EntityId.parse(who.id),
                state: "any",
                limit: 50,
              }),
            ).beliefs,
        ),
      )
    ).flat();
    const expected = attendeeFacts(attendees, compiled);
    expect(beliefsIn(pack)).toEqual(expected);
    // Blake's: the role, the stale need, the consent and the contact rule; not the goal, the closed
    // affiliation or a commitment.
    const kinds = beliefsIn(pack)
      .filter((one) => one.subject.id === people.blake)
      .map((one) => one.kind);
    expect(kinds).toEqual(["need", "role", "consent", "contact_rule"]);
    for (const item of section(pack, "facts"))
      expect(item).toMatchObject({ kind: "belief", required: false, provenance: "source" });
    expect([...new Set(pack.items.map((item) => item.section))]).toEqual(
      ["event", "attendees", "commitments", "facts", "recent_messages"].filter(
        (name) => section(pack, name as PackSection).length > 0,
      ),
    );
    // A belief holds no text; the words are in its cites, under untrusted.
    expect(JSON.stringify(beliefsIn(pack))).toContain("canary-brief-consent");
    expect(JSON.stringify(beliefsIn(pack))).not.toContain("canary-brief-goal");
  });

  it("person_brief holds the person, their beliefs and their open commitments with the owner", async () => {
    const pack = await brief(own, people.blake);
    expect(pack.template).toBe("person_brief@5");
    expect(pack.purpose).toBe("person_brief");
    // The card's parts are get_entity's alone; a brief's person is without them. So are its lines
    // and their `more`.
    const {
      lines: _lines,
      more: _more,
      current: _current,
      warmth: _warmth,
      knownVia: _knownVia,
      ...person
    } = await entity(own, people.blake);
    expect(section(pack, "person")).toEqual([
      {
        id: people.blake,
        section: "person",
        required: true,
        provenance: "source",
        asOf: pack.asOf,
        kind: "entity",
        entity: person,
      },
    ]);
    // Every compiled belief but a commitment, in get_beliefs' order (compileFacts'), closed ones
    // included.
    const reader = await insertReader(store, "brief-person-beliefs", OWN, { tools: ["get_beliefs"], views: VIEWS });
    const compiled = outcomeValue(
      await freshReader().reader.getBeliefs(reader.token, {
        entity: EntityId.parse(people.blake),
        state: "any",
        limit: 50,
      }),
    ).beliefs;
    expect(beliefsIn(pack)).toEqual(compiled.filter((one) => one.kind !== "commitment"));
    expect(beliefsIn(pack).map((one) => one.kind)).toEqual([
      "need",
      "role",
      "affiliation",
      "goal",
      "consent",
      "contact_rule",
    ]);
    for (const item of section(pack, "facts")) expect(item).toMatchObject({ kind: "belief", required: true });
    // The open commitments with Blake on either side, as get_commitments gives them.
    const listed = CommitmentList.parse(
      outcomeValue(
        await freshReader().reader.getCommitments(own.token, { with: EntityId.parse(people.blake), state: "open" }),
      ),
    );
    const commitments = section(pack, "commitments").flatMap((item) =>
      item.kind === "commitment" ? [item.commitment] : [],
    );
    expect(commitments).toEqual(listed.commitments);
    expect(commitments.map((one) => one.what?.untrusted).sort()).toEqual(["canary-brief-owed", "canary-brief-owes"]);
    // Blake's latest messages, at most ten, newest first.
    const recent = section(pack, "recent_messages").flatMap((item) => (item.kind === "message" ? [item.message] : []));
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThanOrEqual(10);
    expect(recent.map((one) => one.at)).toEqual([...recent.map((one) => one.at)].sort().reverse());
    expect([...new Set(pack.items.map((item) => item.section))]).toEqual([
      "person",
      "facts",
      "commitments",
      "recent_messages",
    ]);
    expect(pack.truncated).toBe(false);
    expect(JSON.stringify(pack)).not.toContain("canary-brief-pat");
  });

  it("person_brief logs its items, each belief's and commitment's fact, and each shown message as shown, and nothing as bound", async () => {
    const client = await insertReader(store, "brief-log", OWN, { tools: TOOLS, views: VIEWS });
    const pack = await brief(client, people.blake);
    const [row] = await queryAs<{ bound: string[]; shown: string[]; fact_key_fps: string[] }>(
      store.db.urls.admin,
      "select bound, shown, fact_key_fps from ledger.read_log where client_id = $1 order by id",
      [client.id],
    );
    expect(row?.bound).toEqual([]);
    expect([...(row?.fact_key_fps ?? [])].sort()).toEqual(
      pack.items
        .filter((item) => item.kind === "belief" || item.kind === "commitment")
        .map((item) => item.id)
        .sort(),
    );
    expect(row?.shown).toContain(records.get("b-consent")?.claim.primaryEvidenceId);
    const [logged] = await queryAs<{ template: string; item_ids: string[] }>(
      store.db.urls.admin,
      "select template, item_ids from ledger.context_packs where client_id = $1 order by id",
      [client.id],
    );
    expect(logged).toEqual({ template: "person_brief@5", item_ids: pack.items.map((item) => item.id) });
  });

  it("person_brief for a hidden id and an absent one answer not_found with the same statements, and so does the owner's id", async () => {
    const ask = async (id: string) => {
      const { reader, statements } = freshReader();
      return {
        answer: await reader.buildContextPack(own.token, { purpose: "person_brief", entity: EntityId.parse(id) }),
        statements,
      };
    };
    const hidden = await ask(people.wren);
    const absent = await ask(ABSENT);
    const owner = await ask(people.owner);
    for (const one of [hidden, absent, owner]) expect(one.answer).toEqual({ ok: false, code: "not_found" });
    expect(hidden.statements).toEqual(absent.statements);
    expect(owner.statements).toEqual(absent.statements);
    // The control: the same client sees Blake.
    expect((await brief(own, people.blake)).items.length).toBeGreaterThan(0);
  });

  it("person_brief needs the people view: a client without it is not permitted", async () => {
    const narrow = await insertReader(store, "brief-no-people", OWN, { tools: TOOLS, views: ["self", "work"] });
    expect(
      await freshReader().reader.buildContextPack(narrow.token, {
        purpose: "person_brief",
        entity: EntityId.parse(people.blake),
      }),
    ).toEqual({ ok: false, code: "not_permitted" });
    // A client without work gets the brief with no commitments section.
    const noWork = await insertReader(store, "brief-no-work", OWN, { tools: TOOLS, views: ["self", "people"] });
    const pack = await brief(noWork, people.blake);
    expect(section(pack, "commitments")).toEqual([]);
    expect(section(pack, "facts").length).toBeGreaterThan(0);
  });

  it("no pack section raises a card or writes outside policy.log_pack and the call's own logs", async () => {
    const cards = async () =>
      (await queryAs<{ n: number }>(store.db.urls.admin, "select count(*)::int as n from ledger.cards"))[0]?.n;
    const before = await cards();
    const statements: string[] = [];
    for (const build of [
      (reader: Reader) =>
        reader.buildContextPack(own.token, { purpose: "person_brief", entity: EntityId.parse(people.blake) }),
      (reader: Reader) =>
        reader.buildContextPack(own.token, { purpose: "meeting_prep", event: EventId.parse(ownNext) }),
    ]) {
      const recorded = freshReader();
      outcomeValue(await build(recorded.reader));
      statements.push(...recorded.statements);
    }
    expect(await cards()).toBe(before);
    expect(statements.filter((text) => /\b(insert|update|delete)\b/i.test(text))).toEqual([]);
    const calls = [
      ...new Set(
        statements.flatMap((text) =>
          [...text.matchAll(/\b(policy|ledger|knowledge|projections|vault)\.([a-z_]+)\(/g)].map(
            (match) => `${match[1]}.${match[2]}`,
          ),
        ),
      ),
    ].sort();
    // policy.withheld_entities reads only: the commitments section asks it once of the counterparties.
    // policy.released_records reads only: a released claim is cited only while its release is in
    // force. policy.client_clearance and policy.current_client_kind read only: the second degree asks
    // list_goals' gate whether the caller may see goals. policy.belief_inputs reads only: the beliefs
    // are computed at read.
    expect(calls).toEqual(
      [
        "policy.belief_inputs",
        "policy.client_clearance",
        "policy.current_client",
        "policy.current_client_kind",
        "policy.live_corrections",
        "policy.log_call",
        "policy.log_pack",
        "policy.log_read",
        "policy.open_session",
        "policy.read_allowance",
        "policy.released_records",
        "policy.withheld_entities",
      ].filter((name) => calls.includes(name)),
    );
    expect(calls).toContain("policy.log_pack");
  });

  it("person_brief cuts a person's facts to 40 and says truncated; only beliefs count, not claims in no belief", async () => {
    // Pat: 41 open needs, each its own fact key, each resting on its own claim.
    const { pat } = people;
    const many: Spec[] = Array.from({ length: 41 }, (_, n) => ({
      key: `p-need-${n}`,
      type: "need",
      subject: pat,
      by: pat,
      message: on("own", 20 + n),
      fields: { what: `canary-brief-pat-need-${n}` },
      fieldKinds: { what: "text" },
      values: {},
      entities: [pat],
    }));
    const added = await commit(store, people.owner, many, records);
    specs.push(...many);
    for (const [key, record] of added) records.set(key, record);
    const pack = await brief(own, pat);
    expect(section(pack, "facts")).toHaveLength(40);
    expect(pack.truncated).toBe(true);
    // Blake's has fewer than 40 beliefs and 20 commitments: not truncated.
    expect((await brief(own, people.blake)).truncated).toBe(false);
  });

  // Last: it writes the employer's claims and beliefs, which the tests above do not expect.
  it("a hidden compartment changes no item, order, truncated flag or hash of either pack", async () => {
    const before = {
      brief: JSON.stringify(await brief(own, people.blake)),
      prep: JSON.stringify(await prep(own, ownNext)),
    };
    const wideBefore = await brief(wide, people.blake);
    // The employer's: Blake's role, consent and contact rule there, and an open commitment of Blake's
    // to the owner.
    const work = (n: number) => on("employer:example", n);
    const { owner, blake } = people;
    const employer: Spec[] = [
      {
        key: "w-role",
        type: "role",
        subject: blake,
        by: blake,
        message: work(0),
        fields: { title: "canary-work-title" },
        fieldKinds: { title: "text" },
        values: {},
        entities: [blake],
      },
      {
        key: "w-consent",
        type: "consent",
        subject: blake,
        by: blake,
        message: work(1),
        fields: { about: "quote", what: "canary-work-consent" },
        fieldKinds: { about: "enum", what: "text" },
        values: { about: "quote" },
        entities: [blake],
      },
      {
        key: "w-rule",
        type: "contact_rule",
        subject: blake,
        by: blake,
        message: work(2),
        fields: { rule: "do_not_contact", channel: "any", what: "canary-work-rule" },
        fieldKinds: { rule: "enum", channel: "enum", what: "text" },
        values: { rule: "do_not_contact", channel: "any" },
        entities: [blake],
      },
      {
        key: "w-owes",
        type: "commitment",
        subject: blake,
        by: blake,
        message: work(3),
        fields: { counterparty: owner, what: "canary-work-owes" },
        fieldKinds: { counterparty: "entity", what: "text" },
        values: { counterparty: owner },
        entities: [blake],
      },
    ];
    await commit(store, owner, employer, records);
    // The client cleared for own alone: the same bytes, hash included.
    expect(JSON.stringify(await brief(own, people.blake))).toBe(before.brief);
    expect(JSON.stringify(await prep(own, ownNext))).toBe(before.prep);
    // The control: the client cleared for both sees the employer's beliefs and commitment.
    const wideAfter = await brief(wide, people.blake);
    expect(wideAfter.hash).not.toBe(wideBefore.hash);
    for (const canary of ["canary-work-title", "canary-work-consent", "canary-work-rule", "canary-work-owes"])
      expect(JSON.stringify(wideAfter)).toContain(canary);
  });

  // After B2: it fills the audience past the ceiling of 5 000 beliefs read.
  it("meeting_prep with the audience's beliefs past the ceiling says truncated, with the work view or without it", async () => {
    await bulkCommitments(store, {
      owner: people.owner,
      subject: people.owner,
      counterparty: people.pat,
      count: 5001,
      at: new Date("2026-03-01T00:00:00.000Z"),
    });
    const noWork = await insertReader(store, "brief-ceiling", OWN, { tools: TOOLS, views: ["self", "people"] });
    const without = await prep(noWork, ownNext);
    expect(section(without, "commitments")).toEqual([]);
    expect(without.truncated).toBe(true);
    expect((await prep(own, ownNext)).truncated).toBe(true);
  });
});
