import {
  ClaimRecord,
  type EntityId,
  EntityView,
  FactList,
  PathList,
  SearchResult,
  SelfView,
  type Tier,
} from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { openUnder } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { OWNER } from "../test-support/cast.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { type IdentityWorld, inIdentityWorld, req } from "../test-support/identity-fixtures.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedLines } from "../test-support/warmth-lines.ts";
import { Reader } from "./read.ts";

// What an outcome test found of people and projects, as the production roles read it, on made-up
// values: who `get_self` calls closest, who `find_paths` reaches at an organization, what a card says of
// a close tie seen nowhere, what agents said of a project, a name nobody holds, and one status for a
// lapsed commitment. Reserved domains and synthetic names only.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const DAY = 86_400_000;
const TOOLS = ["get_self", "search", "get_entity", "find_paths", "find_facts", "record", "find_records"];
const VIEWS = ["self", "people", "work"];
const FIRM = "Harrow Tunnelling Works";

const reader = (world: IdentityWorld) =>
  new Reader({ pool: world.store.readerPool, keys: world.db.keys, log: world.store.log, now: () => world.store.now });
const client = (world: IdentityWorld, name: string, clearance: string[], tools = TOOLS, views = VIEWS) =>
  insertReader(world.store, name, clearance, { tools, views });
const contact = (world: IdentityWorld, slug: string, extra: { organization?: string; title?: string } = {}) =>
  world.save(world.accounts.personalContacts, slug, {
    names: [`${slug} Testperson`],
    emails: [`${slug}@people.test`],
    ...extra,
  });

type Warmth = { warmth: number; tier: Tier; owner?: boolean; chatAt?: Date | null };

// A label's lines, seeded as the ranking's inputs (test-support/warmth-lines.ts): the owner's word as a
// tier ruling, a chat as a two-way day.
const warmthRows = (world: IdentityWorld, label: string[], rows: Record<string, Warmth>): Promise<void> =>
  seedLines(
    world.db,
    label,
    Object.entries(rows).map(([entity, row]) => ({
      entity,
      tier: row.tier,
      warmth: row.warmth,
      tierSource: row.owner === true ? "owner" : "inferred",
      ...(row.chatAt === undefined || row.chatAt === null ? {} : { chatAt: row.chatAt }),
    })),
    { today: world.store.now },
  );

// A contact's stored claim of one type about one person, as the belief step would read it.
async function claimOf(world: IdentityWorld, person: string, type: string): Promise<ClaimRecord & { fact: string }> {
  const [row] = await world.sql<{ id: string; compartments: string[]; content_enc: never; fact_key_fp: string }>(
    `select c.id, c.compartments, c.content_enc, c.fact_key_fp from knowledge.claims c
     join knowledge.claim_entities n on n.claim_id = c.id
     where c.type = $1 and n.entity_id = $2 order by c.id limit 1`,
    [type, person],
  );
  if (row === undefined) throw new Error(`no ${type} claim`);
  const record = ClaimRecord.parse(
    JSON.parse(
      openUnder(
        world.db.keys,
        row.compartments,
        { table: "knowledge.claims", id: row.id, column: "content_enc" },
        row.content_enc,
      ),
    ),
  );
  return { ...record, fact: row.fact_key_fp };
}

type Stated = { person: string; kind: "role" | "affiliation" };

// A claim of each of these on the person's contact item, known by the world's date; the fact keys.
// Every belief is computed when asked, so `audience` is kept for the callers' shape.
async function believe(world: IdentityWorld, _audience: string[], stated: Stated[]): Promise<string[]> {
  const facts: string[] = [];
  for (const one of stated) facts.push((await claimOf(world, one.person, one.kind)).fact);
  await knownBy(world.db, world.store.now);
  return facts;
}
const paths = async (world: IdentityWorld, who: Client, target: string) =>
  PathList.parse(outcomeValue(await reader(world).findPaths(who.token, { target: target as EntityId })));
const card = async (world: IdentityWorld, who: Client, id: string) =>
  EntityView.parse(outcomeValue(await reader(world).getEntity(who.token, { id: id as EntityId })));
const self = async (world: IdentityWorld, who: Client) =>
  SelfView.parse(outcomeValue(await reader(world).getSelf(who.token)));

describe("get_self's closest contacts", () => {
  it("hold a two-way chat with no mail and a tie the owner stated, by tier then warmth, and mail alone does not outrank them", () =>
    inIdentityWorld(async (world) => {
      for (const slug of ["ada", "bea", "cal", "dot"]) await contact(world, slug);
      const [ada, bea, cal, dot] = await Promise.all(
        ["ada", "bea", "cal", "dot"].map((slug) => world.person(`${slug}@people.test`)),
      );
      const now = world.store.now.getTime();
      await warmthRows(world, ["own"], {
        [ada as string]: { warmth: 20, tier: "inner", owner: true, chatAt: new Date(now - 4 * DAY) },
        [bea as string]: { warmth: 0, tier: "inner", owner: true },
        // A chat past the ninety days and no tier the owner set: nothing says they are close now.
        [cal as string]: { warmth: 3, tier: "regular", chatAt: new Date(now - 120 * DAY) },
        // A recent chat under a lower tier still counts, after both.
        [dot as string]: { warmth: 9, tier: "regular", chatAt: new Date(now - 2 * DAY) },
      });
      const own = await client(world, "pp-own", ["own"]);
      const contacts = (await self(world, own)).contacts;
      expect(contacts.map((one) => one.id)).toEqual([ada, bea, dot]);
      expect(contacts[0]).toMatchObject({ emails90d: 0, meetings90d: 0, lastTwoWayAt: expect.any(String) });
      expect(contacts[1]?.lastTwoWayAt).toBeUndefined();

      // A client without the people view keeps what it had: neither the owner's word nor a chat puts anyone on its
      // list, and no line says when they last spoke.
      const selfOnly = await client(world, "pp-self", ["own"], ["get_self"], ["self"]);
      expect((await self(world, selfOnly)).contacts).toEqual([]);

      // Another audience's rows move nothing: its list holds no one of these, the same as with none.
      const work = await client(world, "pp-work", ["employer:example"]);
      expect((await self(world, work)).contacts).toEqual([]);
    }));
});

describe("find_paths to an organization", () => {
  it("reaches a contact whose firm is written in words, where a domain's organization holds that very name", () =>
    inIdentityWorld(async (world) => {
      // Someone mailed from the domain makes its organization; a contact names the firm in words alone.
      await world.save(world.accounts.personalContacts, "staff", {
        names: ["Staff Testperson"],
        emails: ["staff@harrow-works.test"],
      });
      await contact(world, "maren", { organization: FIRM, title: "Test Engineering Intern" });
      await contact(world, "other", { organization: "Unrelated Firm", title: "Clerk" });
      await world.store.writer.bindNamed(world.store.now);
      const staff = await world.person("staff@harrow-works.test");
      const maren = await world.person("maren@people.test");
      const other = await world.person("other@people.test");
      const [org] = await world.sql<{ entity_id: string }>(
        "select e.id as entity_id from knowledge.entities e join knowledge.domains d on d.entity_id = e.id where d.domain_fp = $1",
        [fingerprint(world.db.keys, "domain", "harrow-works.test")],
      );
      const target = org?.entity_id as EntityId;
      expect(target).toBeDefined();
      await world.store.admin.identity.nameOrganization(target, FIRM, { requestId: req() });
      const [fact] = await believe(
        world,
        ["own"],
        [
          { person: maren, kind: "affiliation" },
          { person: other, kind: "affiliation" },
        ],
      );
      const own = await client(world, "pp-paths", ["own"]);
      const found = await paths(world, own, target);
      const starts = found.paths.map((path) => path.hops[0]?.to.id);
      expect(starts).toContain(maren);
      expect(starts).not.toContain(other);
      const route = found.paths.find((path) => path.hops[0]?.to.id === maren);
      expect(route?.hops.map((hop) => hop.via)).toEqual(["own_tie", "affiliation"]);
      expect(route?.hops[1]?.to.id).toBe(target);
      expect(route?.hops[1]?.facts?.length).toBeGreaterThan(0);
      expect(fact).toBeDefined();
      expect(staff).toBeDefined();

      // A client that cannot see the contact finds the same as for an unrelated organization: nothing of them.
      const work = await client(world, "pp-paths-work", ["employer:example"]);
      expect(JSON.stringify(await reader(world).findPaths(work.token, { target }))).not.toContain(maren);
    }));

  it("a role alone reaches the organization it names; an affiliation of the same two is the hop's fact", () =>
    inIdentityWorld(async (world) => {
      await contact(world, "rory", { organization: "Rook Holdings", title: "Director" });
      await contact(world, "sian", { organization: "Rook Holdings", title: "Director" });
      await world.store.writer.bindNamed(world.store.now);
      const rory = await world.person("rory@people.test");
      const sian = await world.person("sian@people.test");
      const [org] = await world.sql<{ entity_id: string }>("select entity_id from knowledge.org_names limit 1");
      const [roryRole, sianJob] = await believe(
        world,
        ["own"],
        [
          { person: rory, kind: "role" },
          { person: sian, kind: "affiliation" },
          { person: sian, kind: "role" },
        ],
      );
      expect(roryRole && sianJob).toBeTruthy();
      const own = await client(world, "pp-role", ["own"]);
      const routes = (await paths(world, own, org?.entity_id as string)).paths;
      expect(routes.map((path) => path.hops[0]?.to.id).sort()).toEqual([rory, sian].sort());
      const claims = async (person: string, type: string) =>
        (
          await world.sql<{ id: string }>(
            `select c.id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
             where c.type = $1 and n.entity_id = $2 order by c.id limit 1`,
            [type, person],
          )
        )[0]?.id;
      const sianRoute = routes.find((path) => path.hops[0]?.to.id === sian);
      const hopFacts = sianRoute?.hops[1]?.facts ?? [];
      expect(hopFacts).toContain(await claims(sian, "affiliation"));
      expect(hopFacts).not.toContain(await claims(sian, "role"));
    }));

  it("ranks before it cuts: the one close person among more than twenty is the first path, whatever the ids", () =>
    inIdentityWorld(async (world) => {
      const slugs = Array.from({ length: 22 }, (_, n) => `crowd${String(n).padStart(2, "0")}`);
      for (const slug of slugs) await contact(world, slug, { organization: "Crowd Holdings", title: "Staff" });
      await world.store.writer.bindNamed(world.store.now);
      const people = await Promise.all(slugs.map((slug) => world.person(`${slug}@people.test`)));
      const last = [...people].sort().at(-1) as string;
      const [org] = await world.sql<{ entity_id: string }>("select entity_id from knowledge.org_names limit 1");
      await believe(
        world,
        ["own"],
        people.map((person) => ({ person, kind: "affiliation" as const })),
      );
      await warmthRows(world, ["own"], { [last]: { warmth: 3, tier: "inner", owner: true } });
      const own = await client(world, "pp-crowd", ["own"]);
      const found = await paths(world, own, org?.entity_id as string);
      expect(found.paths).toHaveLength(20);
      expect(found.cut).toBe(true);
      expect(found.paths[0]?.hops[0]?.to.id).toBe(last);
      expect(found.paths[0]?.score).toBeGreaterThan(found.paths[1]?.score ?? 1);
    }));
});

describe("a close tie the system saw nothing of", () => {
  it("names the other records under that whole name on the card, a card with contact no such hint, and a record the caller cannot see no name", () =>
    inIdentityWorld(async (world) => {
      const save = (account: typeof world.accounts.personalContacts, slug: string, name: string) =>
        world.save(account, slug, { names: [name], emails: [`${slug}@people.test`] });
      await save(world.accounts.personalContacts, "robin1", "Robin Testperson");
      await save(world.accounts.personalContacts, "robin2", "Robin Testperson");
      await save(world.accounts.workContacts, "robin3", "Robin Testperson");
      await save(world.accounts.personalContacts, "lone", "Lone Testperson");
      const [one, two, three, lone] = await Promise.all(
        ["robin1", "robin2", "robin3", "lone"].map((slug) => world.person(`${slug}@people.test`)),
      );
      const now = world.store.now.getTime();
      await warmthRows(world, ["own"], {
        [one as string]: { warmth: 0, tier: "inner", owner: true },
        [two as string]: { warmth: 22, tier: "close", chatAt: new Date(now - DAY) },
        [lone as string]: { warmth: 0, tier: "inner", owner: true },
      });
      const own = await client(world, "pp-card", ["own"]);
      const stated = await card(world, own, one as string);
      expect(stated.lead?.tier).toBe("inner");
      expect(stated.lead?.sameName?.map((who) => who.id)).toEqual([two]);
      expect(JSON.stringify(stated)).not.toContain(three as string);
      // A stated tie's silence says nothing of them.
      expect(stated.lead?.nextStep?.kind).toBe("channel_unseen");
      // The record that holds the chat says nothing of it: its line saw the contact.
      expect((await card(world, own, two as string)).lead?.sameName).toBeUndefined();
      // No other record of the name: no field.
      expect((await card(world, own, lone as string)).lead?.sameName).toBeUndefined();
    }));

  it("the other record may hold the name only on a contact of two addresses joined by a ruling, which makes no alias", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "dana1", {
        names: ["Dana Testperson"],
        emails: ["dana1@people.test"],
      });
      await world.save(world.accounts.personalContacts, "dana2", {
        names: ["Dana Testperson"],
        emails: ["dana2@people.test", "dana3@people.test"],
      });
      const [stated, other, third] = await Promise.all(
        ["dana1", "dana2", "dana3"].map((slug) => world.person(`${slug}@people.test`)),
      );
      await warmthRows(world, ["own"], { [stated as string]: { warmth: 0, tier: "inner", owner: true } });
      const own = await client(world, "pp-two", ["own"]);
      // Until they are joined the contact names neither, here as everywhere.
      expect((await card(world, own, stated as string)).lead?.sameName).toBeUndefined();
      await world.admin.identity.linkPeople(other as EntityId, third as EntityId, "same", {
        requestId: "pp-dana-same-request",
      });
      const names = (await card(world, own, stated as string)).lead?.sameName?.map((who) => who.id);
      expect(names).toHaveLength(1);
      expect([other, third]).toContain(names?.[0]);
    }));

  it("a contact under a label the token lacks moves nothing in sameName", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "ivy1", {
        names: ["Ivy Testperson"],
        emails: ["ivy1@people.test"],
      });
      await world.save(world.accounts.personalContacts, "ivy2", { names: ["Ivy Plain"], emails: ["ivy2@people.test"] });
      await world.save(world.accounts.personalContacts, "ivy3", { names: ["Ivy Plain"], emails: ["ivy3@people.test"] });
      // Under the other label alone, the two addresses hold the whole name.
      await world.save(world.accounts.workContacts, "ivy-work", {
        names: ["Ivy Testperson"],
        emails: ["ivy2@people.test", "ivy3@people.test"],
      });
      const [stated, other, third] = await Promise.all(
        ["ivy1", "ivy2", "ivy3"].map((slug) => world.person(`${slug}@people.test`)),
      );
      await world.admin.identity.linkPeople(other as EntityId, third as EntityId, "same", {
        requestId: "pp-ivy-same-request",
      });
      const row = { [stated as string]: { warmth: 0, tier: "inner" as const, owner: true } };
      await warmthRows(world, ["own"], row);
      const own = await client(world, "pp-ivy-own", ["own"]);
      expect((await card(world, own, stated as string)).lead?.sameName).toBeUndefined();
      // The positive control: cleared for the label, the same call finds them.
      const wide = await client(world, "pp-ivy-wide", ["own", "employer:example"]);
      expect((await card(world, wide, stated as string)).lead?.sameName).toHaveLength(1);
    }));

  it("the other record may hold the name only as the owner's name for them", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "kai1", {
        names: ["Kai Testperson"],
        emails: ["kai1@people.test"],
      });
      await world.save(world.accounts.personalContacts, "kai2", {
        names: ["Kai Nickname"],
        emails: ["kai2@people.test"],
      });
      const [stated, other] = await Promise.all(["kai1", "kai2"].map((slug) => world.person(`${slug}@people.test`)));
      await world.admin.identity.namePerson(other as EntityId, "Kai Testperson", { requestId: "pp-kai-name-request" });
      await warmthRows(world, ["own"], { [stated as string]: { warmth: 0, tier: "inner", owner: true } });
      const own = await client(world, "pp-own-name", ["own"]);
      expect((await card(world, own, stated as string)).lead?.sameName?.map((who) => who.id)).toEqual([other]);
    }));
});

describe("what agents said of a project", () => {
  const LABEL = "agent:pp-writes";
  const NAME = "Harbor Ledger Build";

  it("sits beside the project unconfirmed, naming it or filed under it, for a client that reads findings, and moves nothing", () =>
    inIdentityWorld(
      async (world) => {
        const project = await world.store.admin.projects.add(NAME, { requestId: req() });
        const writes = await client(world, "pp-writes", ["own", LABEL]);
        const read = reader(world);
        const write = async (body: string, filed?: string) =>
          outcomeValue(
            await read.record(writes.token, {
              kind: "finding",
              body,
              requestId: req(),
              ...(filed === undefined ? {} : { project: filed as never }),
            }),
          ).recordId;
        const byName = await write(`${NAME} is blocked on the second vendor.`);
        const filed = await write("The vendor signed on Tuesday.", project);
        await write("Something else entirely happened.");

        const view = await card(world, writes, project);
        expect(view.reported?.map((one) => one.record).sort()).toEqual([byName, filed].sort());
        for (const one of view.reported ?? []) expect(one.unconfirmed).toBe(true);
        expect(view.status).toBe("active");

        // A client not cleared for the record's label, and one with no tool that reads findings, see none.
        const notCleared = await client(world, "pp-notcleared", ["own"]);
        expect((await card(world, notCleared, project)).reported).toBeUndefined();
        const noFindings = await client(world, "pp-nofindings", ["own", LABEL], ["get_entity"], VIEWS);
        expect((await card(world, noFindings, project)).reported).toBeUndefined();
      },
      [LABEL],
    ));

  it("find_facts takes project.status and project.decision, and a name nobody holds says so, in the same words whether absent or hidden", () =>
    inIdentityWorld(async (world) => {
      await world.store.admin.projects.add("Hidden Kiln Work", { compartment: "employer:example", requestId: req() });
      const own = await client(world, "pp-search", ["own"]);
      const read = reader(world);
      for (const type of ["project.status", "project.decision", "project.next_step", "project"] as const)
        expect(FactList.parse(outcomeValue(await read.findFacts(own.token, { type }))).facts).toEqual([]);
      const absent = SearchResult.parse(outcomeValue(await read.search(own.token, { query: "Vega Testname" })));
      expect(absent.results).toEqual([]);
      expect(absent.note).toContain("A project is one the owner or an agent made");
      expect(outcomeValue(await read.search(own.token, { query: "Hidden Kiln Work" }))).toEqual(absent);
      // An address is no name.
      expect(outcomeValue(await read.search(own.token, { query: "nobody@people.test" }))).toEqual({ results: [] });
    }));
});

describe("a commitment with the owner on neither side", () => {
  it("reads one status on the card's line and in find_facts", () =>
    inIdentityWorld(async (world) => {
      const old = new Date(world.store.now.getTime() - 60 * DAY);
      await world.mail({
        id: "remy-remark",
        from: { address: "remy@people.test", name: "Remy Testperson" },
        to: [{ address: "pat@people.test" }, { address: OWNER.personal }],
        at: old.toISOString(),
        subject: "A remark to someone else",
        threadId: "remy-remark-thread",
        labels: ["INBOX"],
      });
      const remy = await world.person("remy@people.test");
      const pat = await world.person("pat@people.test");
      const [message] = await world.sql<{ evidence_id: string }>("select evidence_id from knowledge.messages limit 1");
      const evidence = message?.evidence_id as string;
      const base = claimRecord(evidence, "own", remy, { entities: [remy, pat], factKey: "remy-remark" });
      const said = {
        ...base,
        claim: {
          ...base.claim,
          content: { ...base.claim.content, fields: { counterparty: pat, what: "I will send the plans." } },
        },
        subjectKind: "person",
        fieldKinds: { counterparty: "entity", what: "text" },
      } as ClaimRecord;
      const fact = fingerprint(world.db.keys, "fact", "remy-remark");
      // And one with the owner on a side, long past its date.
      const [{ id: ownerId } = { id: "" }] = await world.sql<{ id: string }>(
        "select id from knowledge.entities where kind = 'owner' limit 1",
      );
      const owedBase = claimRecord(evidence, "own", remy, { n: 2, entities: [remy], factKey: "remy-owed" });
      const owed = {
        ...owedBase,
        claim: {
          ...owedBase.claim,
          content: {
            ...owedBase.claim.content,
            fields: { counterparty: ownerId, what: "I will send the deck.", due: "2020-01-01" },
          },
        },
        subjectKind: "person",
        fieldKinds: { counterparty: "entity", what: "text", due: "date" },
      } as ClaimRecord;
      const owedFact = fingerprint(world.db.keys, "fact", "remy-owed");
      const pipeline = createPipeline({ url: world.db.urls.pipeline, keys: world.db.keys, log: recordingLogger().log });
      try {
        expect(await pipeline.commit(batchOf(evidence as never, [said, owed]))).toBe("committed");
      } finally {
        await pipeline.close();
      }
      await knownBy(world.db, world.store.now);
      const own = await client(world, "pp-lapse", ["own"]);
      const line = (await card(world, own, remy)).lines?.find((one) => one.fact === fact);
      expect(line?.status).toBe("dormant");
      const facts = FactList.parse(outcomeValue(await reader(world).findFacts(own.token, { belief: fact as never })));
      expect(new Set(facts.facts.map((one) => one.status))).toEqual(new Set(["dormant"]));
      // One rule, on each side of the owner, on every read that holds a commitment.
      const served = await card(world, own, remy);
      expect(served.lines?.find((one) => one.fact === owedFact)?.status).toBe("dormant");
      const page = await world.admin.people.entityPage(remy as EntityId);
      expect(new Map(page?.facts.beliefs.map((one) => [one.fact, one.status]))).toEqual(
        new Map([
          [fact, "dormant"],
          [owedFact, "dormant"],
        ]),
      );
    }));
});
