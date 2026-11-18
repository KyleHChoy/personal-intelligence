import type { Claim } from "@intelligence/contracts";
import {
  type ClaimRecord,
  CONNECTION_TYPE,
  type EntityId,
  EntityView,
  FiledMention,
  type FindPathsArgs,
  PathList,
  SearchResult,
} from "@intelligence/contracts/personal";
import { namedKey } from "@intelligence/personal-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealRow } from "../core/seal.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { type MailFixture, mail } from "../test-support/items.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, recordingReader, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { MISSING_ENTITY, outcomeValue } from "../test-support/values.ts";
import { seedLines } from "../test-support/warmth-lines.ts";
import { namedScope } from "../write/named-binding.ts";

// The reads of named people and the paths loader's hops to them. Named people are made by the
// binding step from filed names, as a sync makes them; the relation claims that name them are
// committed through the Pipeline as a replay would commit them, each in a letter of its own; a
// confirmed connection is seeded as the owner's release leaves one. No model is called. Synthetic
// people on reserved domains only.

const NOW = new Date("2026-10-01T09:00:00Z");
const OWN = ["own"];
const WORK = ["employer:example"];
const TOOLS = ["search", "get_entity", "find_paths", "list_people"];
const VIEWS = ["self", "people", "work"];
const NOT_FOUND = { ok: false, code: "not_found" };

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
// Ada: the owner mailed Ada both ways, the introducer. Bram wrote once. Kit wrote once. Theo
// Brandt wrote once: a Theo with an address. Wren: the owner's colleague, mailed both ways at work.
const ADA: Who = { address: "ada.fenn@speaker-one.test", name: "Ada Fenn" };
const BRAM: Who = { address: "bram.holt@speaker-two.test", name: "Bram Holt" };
const KIT: Who = { address: "kit.moss@speaker-three.test", name: "Kit Moss" };
const THEO_B: Who = { address: "theo.brandt@speaker-four.test", name: "Theo Brandt" };
const MO: Who = { address: "mo.reyes@speaker-five.test", name: "Mo Reyes" };
const WREN: Who = { address: "wren.oak@partner-two.test", name: "Wren Oak" };

let store: TestStore;
const freshReader = () => recordingReader(store);
let pipeline: Pipeline;
let accounts: Accounts;
let own: Client;
let wide: Client;
const ids: Record<"owner" | "ada" | "bram" | "kit" | "theoB" | "mo" | "wren" | "theo" | "zoe" | "juno", string> =
  {} as never;

let letters = 0;
const letter = (from: Who, to: Who[], labels: string[] = ["INBOX"], at = "2026-09-10T09:00:00Z"): MailFixture => {
  letters += 1;
  const n = String(letters).padStart(4, "0");
  return mail({
    id: `gm-rds-${n}`,
    threadId: `thread-rds-${n}`,
    messageId: `rds-${n}@second-degree-reads.test`,
    at,
    from,
    to,
    subject: "A note",
    labels,
  });
};

const addressFp = (address: string): string => fingerprint(store.db.keys, "address", address);
const nameFp = (name: string): string => fingerprint(store.db.keys, "name", name);
const keyFpOf = (name: string, label: string[]): string =>
  addressFp(namedKey(fingerprint(store.db.keys, "source_id", namedScope(nameFp(name), label, null))) ?? "");
const holderOf = async (fp: string): Promise<string> =>
  one(
    await queryAs<{ entity_id: string }>(
      store.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fp],
    ),
  ).entity_id;

// A letter from the speaker, with a first-hand relation naming `name` filed; then the sync's
// binding step makes the named person. Its id.
async function named(speaker: Who, name: string, work = false): Promise<string> {
  const account = work ? accounts.workMail : accounts.personalMail;
  const evidence = await stored(store.writer, account, letter(speaker, [work ? ME_AT_WORK : ME]));
  const mention = FiledMention.parse({
    name,
    type: "relationship",
    field: "counterparty",
    firstHand: true,
    subjectFp: addressFp(speaker.address),
    speakerFp: addressFp(speaker.address),
  });
  expect(await pipeline.commit(batchOf(evidence, [], { unresolved: 1, mentions: [mention] }))).toBe("committed");
  expect(await store.writer.bindNamed(NOW)).toMatchObject({ created: 1 });
  return holderOf(keyFpOf(name, work ? WORK : OWN));
}

let claims = 0;
// One relation claim, said by `speaker` in a letter of its own to the owner, committed as a replay
// commits it; its stored id (a fact id) and its record.
async function said(
  speaker: Who,
  by: string,
  content: { type: "relationship" | "intro_offer"; subject: string; fields: Record<string, string> },
  options: { at: string; work?: boolean },
): Promise<{ fact: string; record: ClaimRecord }> {
  claims += 1;
  const work = options.work === true;
  const evidence = await stored(
    store.writer,
    work ? accounts.workMail : accounts.personalMail,
    letter(speaker, [work ? ME_AT_WORK : ME], ["INBOX"], options.at),
  );
  const others = Object.values(content.fields).filter((value) => value.startsWith("ent_"));
  const base = claimRecord(evidence, work ? WORK : OWN, content.subject, {
    n: claims,
    type: content.type,
    factKey: `rds ${content.type} ${claims}`,
    validFrom: options.at,
    entities: [content.subject, ...others],
  });
  const fieldKinds =
    content.type === "intro_offer" ? { person: "entity", offer: "enum" } : { counterparty: "entity", relation: "enum" };
  const record = {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: by,
      basis: "third_party",
      content: { ...base.claim.content, ...content },
    } as Claim,
    subjectKind: "person",
    fieldKinds,
  } as ClaimRecord;
  expect(await pipeline.commit(batchOf(evidence, [record]))).toBe("committed");
  return { fact: fingerprint(store.db.keys, "claim", record.claim.id), record };
}

// A connection the owner confirmed, as the owner's release leaves it: a released claim under `own` of an
// agent record whose release is in force. Its id and its release's ruling.
async function confirmedConnection(subject: string, other: string): Promise<{ claim: string; ruling: string }> {
  // The release, as the owner's confirm writes it (pi_admin); the claim, as the pipeline commits it.
  const { ruling, evidence } = await session(store.db.urls.admin, async (query) => {
    await seeder(store.db, query).into("knowledge.claim_releases")(OWN);
    const [release] = (await query(
      "select ruling_id, evidence_id from knowledge.claim_releases order by created_at desc, ruling_id desc limit 1",
    )) as { ruling_id: string; evidence_id: string }[];
    return { ruling: release?.ruling_id ?? "", evidence: release?.evidence_id ?? "" };
  });
  return session(store.db.urls.pipeline, async (query) => {
    claims += 1;
    const base = claimRecord(evidence, OWN, subject, {
      n: claims,
      type: CONNECTION_TYPE,
      factKey: `rds connection ${claims}`,
      entities: [subject, other],
      origin: "agent_record",
    });
    const record = {
      ...base,
      claim: {
        ...base.claim,
        content: { type: CONNECTION_TYPE, subject, fields: { kind: "knows", other, inferred: false } },
      },
      subjectKind: "person",
      fieldKinds: { kind: "enum", other: "entity" },
    };
    const id = fingerprint(store.db.keys, "claim", testId("connection"));
    await query(
      `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, compartments, released, content_enc)
       values ($1, $2, $3, $4, $5, 1, array['m-owner'], array['own'], true, $6)`,
      [
        id,
        evidence,
        CONNECTION_TYPE,
        "2026-09-11T09:00:00Z",
        fingerprint(store.db.keys, "fact", `rds connection ${claims}`),
        sealRow(store.db.keys, "own", { table: "knowledge.claims", id, column: "content_enc" }, JSON.stringify(record)),
      ],
    );
    for (const entity of [subject, other])
      await query(
        "insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, array['own'])",
        [id, entity],
      );
    return { claim: id, ruling };
  });
}

const target = (id: string, maxHops?: number): FindPathsArgs => ({
  target: id as EntityId,
  ...(maxHops === undefined ? {} : { maxHops }),
});
const paths = async (client: Client, args: FindPathsArgs): Promise<PathList> =>
  PathList.parse(outcomeValue(await freshReader().reader.findPaths(client.token, args)));
const routes = (list: PathList): string[][] =>
  list.paths.map((path) =>
    path.hops.map((hop) => `${hop.from.id}>${hop.to.id}:${hop.via}${hop.offer === undefined ? "" : `/${hop.offer}`}`),
  );
const entity = async (client: Client, id: string) =>
  freshReader().reader.getEntity(client.token, { id: id as EntityId });
const search = async (client: Client, query: string): Promise<SearchResult> =>
  SearchResult.parse(outcomeValue(await freshReader().reader.search(client.token, { query })));

beforeAll(async () => {
  store = await openStore({ now: NOW });
  pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  accounts = await connect(store.writer);
  const w = store.writer;
  await stored(w, accounts.personalMail, letter(ME, [ADA], ["SENT"]));
  await stored(w, accounts.personalMail, letter(ADA, [ME]));
  for (const who of [BRAM, KIT, THEO_B, MO]) await stored(w, accounts.personalMail, letter(who, [ME]));
  await stored(w, accounts.workMail, letter(ME_AT_WORK, [WREN], ["SENT"]));
  await stored(w, accounts.workMail, letter(WREN, [ME_AT_WORK]));
  ids.owner = one(
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
  for (const [key, who] of [
    ["ada", ADA],
    ["bram", BRAM],
    ["kit", KIT],
    ["theoB", THEO_B],
    ["mo", MO],
    ["wren", WREN],
  ] as const)
    ids[key] = await holderOf(addressFp(who.address));
  // Ada is in the owner's inner tier, so a path's weakest hop is the hop past Ada.
  await seedLines(store.db, OWN, [{ entity: ids.ada as string, tier: "inner", warmth: 1 }], { today: NOW });
  // Theo Marsh and Zoe Lark, named by Ada; Juno Pike, named by Bram in a letter no claim of which
  // names Juno.
  ids.theo = await named(ADA, "Theo Marsh");
  ids.zoe = await named(ADA, "Zoe Lark");
  ids.juno = await named(BRAM, "Juno Pike");
  own = await insertReader(store, "own-rds", OWN, { tools: TOOLS, views: VIEWS });
  wide = await insertReader(store, "wide-rds", [...WORK, ...OWN], { tools: TOOLS, views: VIEWS });
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await pipeline?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("named people served, and the second degree's hops", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a named person nobody visible names is withheld, as a person the caller cannot see is", async () => {
    // No relation claim names Theo yet: the binding's letter holds none.
    expect(await entity(own, ids.theo)).toEqual(NOT_FOUND);
    expect(await entity(own, ids.juno)).toEqual(NOT_FOUND);
    expect((await search(own, "juno")).results).toEqual([]);
    expect(await freshReader().reader.findPaths(own.token, target(ids.juno))).toEqual(NOT_FOUND);
  });

  it("find_paths reaches a named target through an introducer the owner mailed both ways", async () => {
    await said(
      ADA,
      ids.ada,
      { type: "intro_offer", subject: ids.ada, fields: { person: ids.theo, offer: "offered" } },
      { at: "2026-09-12T09:00:00Z" },
    );
    const list = await paths(own, target(ids.theo));
    expect(routes(list)).toEqual([[`${ids.owner}>${ids.ada}:own_tie`, `${ids.ada}>${ids.theo}:intro_offer/offered`]]);
    expect(list.paths[0]?.score).toBe(1);
    // The named person is served known by a name alone, with no address.
    expect(list.paths[0]?.hops[1]?.to).toMatchObject({
      id: ids.theo,
      nameOnly: true,
      address: null,
      name: { untrusted: "Theo Marsh" },
    });
    expect(list.paths[0]?.hops[0]?.to.nameOnly).toBeUndefined();
  });

  it("get_entity serves a named person nameOnly, no address, and the relation claims naming them newest first", async () => {
    const { fact: report } = await said(
      ADA,
      ids.ada,
      { type: "relationship", subject: ids.theo, fields: { counterparty: ids.zoe, relation: "colleague" } },
      { at: "2026-09-14T09:00:00Z" },
    );
    const view = EntityView.parse(outcomeValue(await entity(own, ids.theo)));
    expect(view).toMatchObject({ id: ids.theo, kind: "person", nameOnly: true, addresses: [] });
    const offer = view.mentionedBy?.[1];
    expect(view.mentionedBy?.map((line) => [line.by.id, line.relation ?? line.offer])).toEqual([
      [ids.zoe, "colleague"],
      [ids.ada, "offered"],
    ]);
    expect(view.mentionedBy?.[0]).toMatchObject({
      fact: report,
      at: "2026-09-14T09:00:00.000Z",
      by: { nameOnly: true },
    });
    expect(offer?.heard).toBeUndefined();
    // Searched, a Theo with an address comes first, then the named one.
    expect((await search(own, "theo")).results.map((result) => [result.id, result.nameOnly ?? false])).toEqual([
      [ids.theoB, false],
      [ids.theo, true],
    ]);
  });

  it("a reported relation gives a third-degree path at reportedWeight, 0.3", async () => {
    const list = await paths(own, target(ids.zoe));
    expect(routes(list)).toEqual([
      [
        `${ids.owner}>${ids.ada}:own_tie`,
        `${ids.ada}>${ids.theo}:intro_offer/offered`,
        `${ids.theo}>${ids.zoe}:reported`,
      ],
    ]);
    expect(list.paths[0]?.score).toBe(0.3);
    // Zoe is three hops away, the own tie counted: not within two.
    expect(await paths(own, target(ids.zoe, 2))).toEqual({ paths: [], cut: false });
  });

  it("an acquaintance belief is a hop at 0.5", async () => {
    // Ada's own word, first-hand: its belief, computed at read for the `own` audience
    // once the claim is known by the reader's clock.
    const { fact } = await said(
      ADA,
      ids.ada,
      { type: "relationship", subject: ids.ada, fields: { counterparty: ids.mo, relation: "acquaintance" } },
      { at: "2026-09-15T09:00:00Z" },
    );
    await knownBy(store.db, NOW);
    const list = await paths(own, target(ids.mo));
    expect(routes(list)).toEqual([[`${ids.owner}>${ids.ada}:own_tie`, `${ids.ada}>${ids.mo}:acquaintance`]]);
    expect(list.paths[0]?.hops[1]?.facts).toEqual([fact]);
    expect(list.paths[0]?.score).toBe(0.5);
  });

  it("a confirmed connection is a hop and an unconfirmed one is not", async () => {
    expect(await paths(own, target(ids.kit))).toEqual({ paths: [], cut: false });
    const { ruling } = await confirmedConnection(ids.ada, ids.kit);
    const list = await paths(own, target(ids.kit));
    expect(routes(list)).toEqual([[`${ids.owner}>${ids.ada}:own_tie`, `${ids.ada}>${ids.kit}:connection`]]);
    expect(list.paths[0]?.score).toBe(1);
    // The owner's lift of the release: no longer confirmed, no longer a hop.
    await session(store.db.urls.admin, (query) =>
      query("insert into knowledge.release_lifts (seq, ruling_id, compartments) values (9000001, $1, array['own'])", [
        ruling,
      ]),
    );
    expect(await paths(own, target(ids.kit))).toEqual({ paths: [], cut: false });
  });

  it("a named person under employer:x changes no answer of an own-only client: search, get_entity, find_paths, counts and refusals", async () => {
    const { reader, during } = freshReader();
    const calls: (() => Promise<unknown>)[] = [
      () => reader.search(own.token, { query: "theo" }),
      () => reader.search(own.token, { query: "zed" }),
      () => reader.getEntity(own.token, { id: ids.theo as EntityId }),
      () => reader.getEntity(own.token, { id: MISSING_ENTITY }),
      () => reader.findPaths(own.token, target(ids.theo)),
      () => reader.findPaths(own.token, target(ids.zoe)),
      () => reader.findPaths(own.token, target(MISSING_ENTITY)),
      () => reader.listPeople(own.token, {}),
    ];
    // The reader opens the client's session on its first call: one call first.
    await reader.search(own.token, { query: "theo" });
    const before = [];
    for (const call of calls) before.push(await during(call));

    // Under the employer's label: Wren names Zed Hollis, offers to introduce Zed, and reports that
    // Theo (the owner's own named person) works with Zed.
    const zed = await named(WREN, "Zed Hollis", true);
    await said(
      WREN,
      ids.wren,
      { type: "intro_offer", subject: ids.wren, fields: { person: zed, offer: "offered" } },
      { at: "2026-09-16T09:00:00Z", work: true },
    );
    await said(
      WREN,
      ids.wren,
      { type: "relationship", subject: ids.theo, fields: { counterparty: zed, relation: "colleague" } },
      { at: "2026-09-17T09:00:00Z", work: true },
    );
    await said(
      WREN,
      ids.wren,
      { type: "intro_offer", subject: ids.wren, fields: { person: ids.theo, offer: "offered" } },
      { at: "2026-09-18T09:00:00Z", work: true },
    );

    for (const [n, call] of calls.entries()) {
      const after = await during(call);
      expect(JSON.stringify(after.answer), String(n)).toBe(JSON.stringify(before[n]?.answer));
      expect(after.statements, String(n)).toEqual(before[n]?.statements);
    }
    // Zed is a refusal like an absent id, after the same statements.
    const hidden = await during(() => reader.getEntity(own.token, { id: zed as EntityId }));
    const absent = await during(() => reader.getEntity(own.token, { id: MISSING_ENTITY }));
    expect(hidden.answer).toEqual(NOT_FOUND);
    expect(hidden.statements).toEqual(absent.statements);

    // The control: the wide client is shown Zed and the routes to Zed.
    expect(EntityView.parse(outcomeValue(await entity(wide, zed)))).toMatchObject({ nameOnly: true, addresses: [] });
    expect(routes(await paths(wide, target(zed)))).toContainEqual([
      `${ids.owner}>${ids.wren}:own_tie`,
      `${ids.wren}>${zed}:intro_offer/offered`,
    ]);
  });

  it("a named person is never an own tie nor in list_people", async () => {
    const listed = outcomeValue(await freshReader().reader.listPeople(own.token, {}));
    expect(listed.people.map((person) => person.id)).not.toContain(ids.theo);
    // A path to Theo never starts at Theo.
    expect((await paths(own, target(ids.theo))).paths.every((path) => path.hops[0]?.to.id !== ids.theo)).toBe(true);
  });
});
