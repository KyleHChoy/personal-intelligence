import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceDeletion } from "@intelligence/contracts";
import {
  type ClaimRecord,
  type EntityId,
  EntityView,
  type FindPathsArgs,
  type MessageId,
  PathList,
  SearchResult,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { orgNameFp } from "../core/org-names.ts";
import { ERASURE_HOOKS } from "../erasure/erasure-hooks.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { type MailFixture, mail, mailSourceId } from "../test-support/items.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, recordingReader, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { MISSING_ENTITY, outcomeValue } from "../test-support/values.ts";
import { seedLines } from "../test-support/warmth-lines.ts";

// Organizations known only by name. The affiliation claims that name them are committed through the
// Pipeline as a replay commits them, each in a letter of its own, so the commit files each name;
// the sync's binding step makes the organizations; the reads serve them. The beliefs a path walks
// are computed at read from those claims. No model is called. Synthetic people on reserved domains,
// and made-up organizations, only.

const NOW = new Date("2026-10-01T09:00:00Z");
const OWN = ["own"];
const WORK = ["employer:example"];
const TOOLS = ["search", "get_entity", "find_paths"];
const VIEWS = ["self", "people", "work"];
const NOT_FOUND = { ok: false, code: "not_found" };

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
// Ada: the owner mailed Ada both ways. Bram and Cy each wrote once. Wren: the owner's colleague,
// mailed both ways at work.
const ADA: Who = { address: "ada.fenn@speaker-one.test", name: "Ada Fenn" };
const BRAM: Who = { address: "bram.holt@speaker-two.test", name: "Bram Holt" };
const CY: Who = { address: "cy.dunn@speaker-three.test", name: "Cy Dunn" };
const WREN: Who = { address: "wren.oak@partner-two.test", name: "Wren Oak" };

let store: TestStore;
const freshReader = () => recordingReader(store);
let pipeline: Pipeline;
let accounts: Accounts;
let own: Client;
let wide: Client;
const ids: Record<"owner" | "ada" | "bram" | "cy" | "wren", string> = {} as never;

let letters = 0;
const letter = (from: Who, to: Who[], labels: string[] = ["INBOX"], at = "2026-09-10T09:00:00Z"): MailFixture => {
  letters += 1;
  const n = String(letters).padStart(4, "0");
  return mail({
    id: `gm-nrg-${n}`,
    threadId: `thread-nrg-${n}`,
    messageId: `nrg-${n}@named-orgs.test`,
    at,
    from,
    to,
    subject: "A note",
    labels,
  });
};

const addressFp = (address: string): string => fingerprint(store.db.keys, "address", address);
const holderOf = async (fp: string): Promise<string> =>
  one(
    await queryAs<{ entity_id: string }>(
      store.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fp],
    ),
  ).entity_id;
const sync = () => store.writer.bindNamed(NOW);

let claims = 0;
type Said = { fact: string; record: ClaimRecord; evidence: string; fixture: MailFixture };
// One affiliation, said by `speaker` of themselves in a letter of its own to the owner, naming its
// organization by name alone; committed as a replay commits it.
async function worksAt(
  speaker: Who,
  subject: string,
  organization: string,
  options: { work?: boolean; at?: string } = {},
): Promise<Said> {
  claims += 1;
  const work = options.work === true;
  const at = options.at ?? "2026-09-12T09:00:00Z";
  const fixture = letter(speaker, [work ? ME_AT_WORK : ME], ["INBOX"], at);
  const evidence = await stored(store.writer, work ? accounts.workMail : accounts.personalMail, fixture);
  const base = claimRecord(evidence, work ? WORK : OWN, subject, {
    n: claims,
    type: "affiliation",
    factKey: `nrg affiliation ${claims}`,
    validFrom: at,
    entities: [subject],
  });
  const content = { type: "affiliation", subject, fields: { relation: "employee", organization_name: organization } };
  const record = {
    ...base,
    claim: { ...base.claim, assertedBy: subject, content },
    subjectKind: "person",
    fieldKinds: { relation: "enum", organization_name: "text" },
  } as unknown as ClaimRecord;
  expect(await pipeline.commit(batchOf(evidence, [record]))).toBe("committed");
  return { fact: fingerprint(store.db.keys, "claim", record.claim.id), record, evidence, fixture };
}

// The organization each label's name rows give a name, as the admin reads them.
const organizationsOf = async (name: string): Promise<{ entity_id: string; compartments: string[] }[]> =>
  queryAs(
    store.db.urls.admin,
    "select distinct entity_id, compartments from knowledge.org_names where name_fp = $1 order by compartments",
    [orgNameFp(store.db.keys, name)],
  );
const organizationOf = async (name: string, label: string[]): Promise<string> =>
  one((await organizationsOf(name)).filter((row) => row.compartments.join(",") === label.join(","))).entity_id;

// The affiliation claims committed so far, known by the world's date: a path's beliefs are computed
// at read from them, under the reader's clock.
const believed = (): Promise<void> => knownBy(store.db, NOW);

const target = (id: string): FindPathsArgs => ({ target: id as EntityId });
const paths = async (client: Client, id: string): Promise<PathList> =>
  PathList.parse(outcomeValue(await freshReader().reader.findPaths(client.token, target(id))));
const routes = (list: PathList): string[][] =>
  list.paths.map((path) => path.hops.map((hop) => `${hop.from.id}>${hop.to.id}:${hop.via}`));
const entity = async (client: Client, id: string) =>
  freshReader().reader.getEntity(client.token, { id: id as EntityId });
const search = async (client: Client, query: string): Promise<SearchResult> =>
  SearchResult.parse(outcomeValue(await freshReader().reader.search(client.token, { query })));

let ada: Said;
let bram: Said;

beforeAll(async () => {
  store = await openStore({ now: NOW });
  pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  accounts = await connect(store.writer);
  const w = store.writer;
  await stored(w, accounts.personalMail, letter(ME, [ADA], ["SENT"]));
  await stored(w, accounts.personalMail, letter(ADA, [ME]));
  for (const who of [BRAM, CY]) await stored(w, accounts.personalMail, letter(who, [ME]));
  await stored(w, accounts.workMail, letter(ME_AT_WORK, [WREN], ["SENT"]));
  await stored(w, accounts.workMail, letter(WREN, [ME_AT_WORK]));
  ids.owner = one(
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
  for (const [key, who] of [
    ["ada", ADA],
    ["bram", BRAM],
    ["cy", CY],
    ["wren", WREN],
  ] as const)
    ids[key] = await holderOf(addressFp(who.address));
  // Ada is in the owner's inner tier, so a path's weakest hop is the hop past Ada.
  await seedLines(store.db, OWN, [{ entity: ids.ada as string, tier: "inner", warmth: 1 }], { today: NOW });
  own = await insertReader(store, "own-nrg", OWN, { tools: TOOLS, views: VIEWS });
  wide = await insertReader(store, "wide-nrg", [...WORK, ...OWN], { tools: TOOLS, views: VIEWS });
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await pipeline?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("organizations known by name alone", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("two affiliations naming Northwind under one label resolve to one named organization", async () => {
    ada = await worksAt(ADA, ids.ada, "Northwind");
    bram = await worksAt(BRAM, ids.bram, "  northwind ");
    // The commit filed each name beside its claim, with no text.
    const filed = await queryAs<{ claim_id: string; name_fp: string; compartments: string[] }>(
      store.db.urls.admin,
      "select claim_id, name_fp, compartments from knowledge.claim_org_names order by claim_id",
    );
    expect(filed.map((row) => row.claim_id).sort()).toEqual([ada.fact, bram.fact].sort());
    expect(new Set(filed.map((row) => row.name_fp))).toEqual(new Set([orgNameFp(store.db.keys, "Northwind")]));
    expect(await sync()).toMatchObject({ orgMade: 1, orgBound: 2 });
    const [northwind, ...others] = await organizationsOf("Northwind");
    expect(others).toEqual([]);
    expect(northwind?.compartments).toEqual(OWN);
    const made = one(
      await queryAs<{ kind: string; named: boolean }>(
        store.db.urls.admin,
        "select kind, named from knowledge.entities where id = $1",
        [northwind?.entity_id],
      ),
    );
    expect(made).toEqual({ kind: "organization", named: true });
    // A second sync finds nothing to do.
    expect(await sync()).toMatchObject({ orgMade: 0, orgBound: 0 });
    // Invariant 3: no claim names the organization; the claims are as committed.
    const entities = await queryAs<{ entity_id: string }>(
      store.db.urls.admin,
      "select entity_id from knowledge.claim_entities where claim_id = any($1) order by entity_id",
      [[ada.fact, bram.fact]],
    );
    expect(entities.map((row) => row.entity_id).sort()).toEqual([ids.ada, ids.bram].sort());
  });

  it("under another label the same name resolves to another organization", async () => {
    await worksAt(WREN, ids.wren, "Northwind", { work: true });
    expect(await sync()).toMatchObject({ orgMade: 1, orgBound: 1 });
    const own = await organizationOf("Northwind", OWN);
    const work = await organizationOf("Northwind", WORK);
    expect(own).not.toBe(work);
  });

  it("a named organization is served nameOnly, by its name, with the people whose claims name it", async () => {
    const northwind = await organizationOf("Northwind", OWN);
    const view = EntityView.parse(outcomeValue(await entity(own, northwind)));
    expect(view).toMatchObject({ id: northwind, kind: "organization", nameOnly: true, addresses: [] });
    // Each spelling an item wrote, once; the one a Who shows is its first name row's.
    expect(view.names.map((name) => name.untrusted).sort()).toEqual(["Northwind", "northwind"]);
    expect(view.people.map((person) => person.id).sort()).toEqual([ids.ada, ids.bram].sort());
    const found = await search(own, "northwind");
    expect(
      found.results.map((result) => [
        result.id,
        result.kind,
        result.nameOnly ?? false,
        result.name?.untrusted.toLowerCase(),
      ]),
    ).toEqual([[northwind, "organization", true, "northwind"]]);
  });

  it("a path bridges through a named organization at 0.5, and reaches it as a target", async () => {
    await believed();
    const northwind = await organizationOf("Northwind", OWN);
    const list = await paths(own, ids.bram);
    expect(routes(list)).toEqual([[`${ids.owner}>${ids.ada}:own_tie`, `${ids.ada}>${ids.bram}:affiliation`]]);
    expect(list.paths[0]?.score).toBe(0.5);
    expect(list.paths[0]?.hops[1]?.facts.sort()).toEqual([ada.fact, bram.fact].sort());
    const toOrganization = await paths(own, northwind);
    expect(routes(toOrganization)[0]).toEqual([
      `${ids.owner}>${ids.ada}:own_tie`,
      `${ids.ada}>${northwind}:affiliation`,
    ]);
    expect(toOrganization.paths[0]?.hops[1]?.to).toMatchObject({
      id: northwind,
      kind: "organization",
      nameOnly: true,
      address: null,
    });
    expect(toOrganization.paths[0]?.hops[1]?.to.name?.untrusted.toLowerCase()).toBe("northwind");
  });

  it("invariant 6: a named organization under employer:x changes nothing an own-only client reads", async () => {
    const northwind = await organizationOf("Northwind", OWN);
    const { reader, during } = freshReader();
    const calls: (() => Promise<unknown>)[] = [
      () => reader.search(own.token, { query: "northwind" }),
      () => reader.search(own.token, { query: "contoso" }),
      () => reader.getEntity(own.token, { id: northwind as EntityId }),
      () => reader.getEntity(own.token, { id: MISSING_ENTITY }),
      () => reader.findPaths(own.token, target(ids.bram)),
      () => reader.findPaths(own.token, target(northwind)),
      () => reader.findPaths(own.token, target(MISSING_ENTITY)),
    ];
    // The reader opens the client's session on its first call: one call first.
    await reader.search(own.token, { query: "northwind" });
    const before = [];
    for (const call of calls) before.push(await during(call));

    // Under the employer's label: Wren works at Contoso Labs, and Bram, at work, at Northwind too.
    await worksAt(WREN, ids.wren, "Contoso Labs", { work: true, at: "2026-09-13T09:00:00Z" });
    await worksAt(WREN, ids.bram, "Northwind", { work: true, at: "2026-09-14T09:00:00Z" });
    await sync();
    await believed();
    const hidden = await organizationOf("Contoso Labs", WORK);

    for (const [n, call] of calls.entries()) {
      const after = await during(call);
      expect(JSON.stringify(after.answer), String(n)).toBe(JSON.stringify(before[n]?.answer));
      expect(after.statements, String(n)).toEqual(before[n]?.statements);
    }
    // Contoso is a refusal like an absent id, after the same statements.
    const refused = await during(() => reader.getEntity(own.token, { id: hidden as EntityId }));
    const absent = await during(() => reader.getEntity(own.token, { id: MISSING_ENTITY }));
    expect(refused.answer).toEqual(NOT_FOUND);
    expect(refused.statements).toEqual(absent.statements);

    // The control: the wide client is shown it.
    expect(EntityView.parse(outcomeValue(await entity(wide, hidden)))).toMatchObject({
      nameOnly: true,
      names: [{ untrusted: "Contoso Labs" }],
    });
    expect((await search(wide, "contoso")).results.map((result) => result.id)).toEqual([hidden]);
  });

  it("a re-extraction that drops the name removes its item's name row, and withholds an organization nothing else names", async () => {
    const litware = await worksAt(CY, ids.cy, "Litware");
    await sync();
    const made = await organizationOf("Litware", OWN);
    expect(EntityView.parse(outcomeValue(await entity(own, made)))).toMatchObject({ nameOnly: true });
    // The item extracted again, its affiliation gone: its claim and the claim's name row go.
    expect(await pipeline.commit(batchOf(litware.evidence, []))).toBe("committed");
    expect(
      await queryAs(store.db.urls.admin, "select claim_id from knowledge.claim_org_names where claim_id = $1", [
        litware.fact,
      ]),
    ).toEqual([]);
    expect(await sync()).toMatchObject({ orgRemoved: 1 });
    expect(await organizationsOf("Litware")).toEqual([]);
    expect(await entity(own, made)).toEqual(NOT_FOUND);
  });

  it("deleting the only item that names an organization withholds it", async () => {
    const fabrikam = await worksAt(CY, ids.cy, "Fabrikam");
    await sync();
    const made = await organizationOf("Fabrikam", OWN);
    expect(EntityView.parse(outcomeValue(await entity(own, made)))).toMatchObject({
      nameOnly: true,
      names: [{ untrusted: "Fabrikam" }],
    });
    await store.writer.applyDeletion(accounts.personalMail, {
      sourceAccount: accounts.personalMail.id,
      sourceItemId: mailSourceId(fabrikam.fixture),
    } as SourceDeletion);
    // Its claim, its claim's name row and its organization's name row went with the item.
    expect(
      // erasure-proves: knowledge.claim_org_names.claim_id
      await queryAs(store.db.urls.admin, "select claim_id from knowledge.claim_org_names where claim_id = $1", [
        fabrikam.fact,
      ]),
    ).toEqual([]);
    expect(await organizationsOf("Fabrikam")).toEqual([]);
    expect(await entity(own, made)).toEqual(NOT_FOUND);
    expect((await search(own, "fabrikam")).results).toEqual([]);
    expect(await freshReader().reader.findPaths(own.token, target(made))).toEqual(NOT_FOUND);
    // And nothing makes it again.
    expect(await sync()).toMatchObject({ orgMade: 0, orgBound: 0 });
  });

  it("erasure: an erased item's organization is withheld, and the hook removes an erased organization's names", async () => {
    const tailspin = await worksAt(CY, ids.cy, "Tailspin Works");
    await sync();
    const made = await organizationOf("Tailspin Works", OWN);
    const folder = await mkdtemp(join(tmpdir(), "pi-nrg-erase-"));
    const admin = createAdmin({
      url: store.db.urls.admin,
      keys: store.db.keys,
      log: recordingLogger().log,
      journal: join(folder, "keys.json.erasures"),
    });
    try {
      const message = one(
        await queryAs<{ id: MessageId }>(
          store.db.urls.admin,
          "select id from knowledge.messages where evidence_id = $1",
          [tailspin.evidence],
        ),
      ).id;
      const dry = await admin.erasure.eraseItem(
        { kind: "message", id: message },
        { requestId: "nrg-erase-dry", dryRun: true },
      );
      expect(dry.more.org_names).toBe(1);
      await admin.erasure.eraseItem({ kind: "message", id: message }, { requestId: "nrg-erase" });
    } finally {
      await admin.close();
      await rm(folder, { recursive: true, force: true });
    }
    expect(await organizationsOf("Tailspin Works")).toEqual([]);
    expect(await entity(own, made)).toEqual(NOT_FOUND);
    expect(await sync()).toMatchObject({ orgMade: 0, orgBound: 0 });

    // The hook, handed an erased organization: its name rows go, and it is withheld.
    const northwind = await organizationOf("Northwind", OWN);
    const hook = ERASURE_HOOKS.find((one) => one.name === "org_names");
    const erased = {
      evidenceIds: [],
      refs: [{ kind: "entity", id: northwind }],
      addressFps: [],
      sources: [],
      records: [],
      recordEvidenceIds: [],
      erasureId: null,
      factKeyFps: [],
      nameFps: [],
      claimKeys: [],
      claimIds: [],
    } as unknown as Parameters<NonNullable<typeof hook>["run"]>[1];
    const removed = await session(
      store.db.urls.admin,
      (query) => hook?.run(query, erased, { dryRun: false, now: NOW, keys: store.db.keys }) ?? Promise.resolve(-1),
    );
    expect(removed).toBe(2);
    expect(await entity(own, northwind)).toEqual(NOT_FOUND);
  });
});
