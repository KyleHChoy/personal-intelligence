import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EntityId, NETWORK_FIRST_MOST, OWNER_TIE_TYPE, TIERS } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { testId } from "../../test-support/clients.ts";
import { type Message, worldMessages } from "../../test-support/commitment-fixtures.ts";
import { session } from "../../test-support/connections.ts";
import { queryAs, sealRow } from "../../test-support/database.ts";
import { type FactSpec, seedFacts } from "../../test-support/fact-fixtures.ts";
import { claimRecord } from "../../test-support/pipeline-fixtures.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { MISSING_ENTITY } from "../../test-support/values.ts";
import { buildAs, warmthWorld } from "../../test-support/warmth-fixtures.ts";
import { seedWorld, WORLD_NOW } from "../../test-support/world.ts";
import { Admin } from "../admin.ts";

// Three people the owner writes with (warmth built for the owner's audience), one they do not but whom a
// relationship ties to the first, and an organization one of them works at. Claims are committed through
// the Pipeline and beliefs written as the rebuild writes them. Reserved domains and made-up ids only.

const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(WORLD_NOW.getTime() - days * DAY_MS).toISOString();
const OWN = ["own"];
// Claim text that must never reach the graph's answer.
const CANARY = "canary-people-claim-text";

let store: TestStore;
let warmth: ReturnType<typeof warmthWorld>;
let owner: string;
const people: string[] = [];
let stranger: string;
let organization: string;
// An organization the first person only invests in: no workplace.
let investedOrganization: string;
let namedOrganization: string;
let domainOrganization: string;
let heldSubject: string;
let unnamedTie: string;
let unnamedHop: string;
let beyond: string;
let nameOnly: string;

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example", "family"] });
  const world = await seedWorld(store.writer, store.admin);
  owner = world.ownerEntity();

  warmth = warmthWorld(store.db);
  for (const exchanges of [4, 2, 1]) {
    const person = await warmth.person(OWN);
    for (let n = 0; n < exchanges; n += 1) {
      const thread = testId("thr");
      await warmth.mail(OWN, { at: daysAgo(3 + n * 7), to: [person], thread });
      await warmth.mail(OWN, { at: daysAgo(3 + n * 7 - 0.1), from: person, thread });
    }
    people.push(person);
  }
  stranger = await warmth.person(OWN);
  // One the owner writes with whom no read names, one a relationship names and no read names, and one
  // known only past them; and one known by a name alone, with no address.
  unnamedTie = await warmth.person(OWN, { named: false });
  for (const n of [0, 1]) {
    const thread = testId("thr");
    await warmth.mail(OWN, { at: daysAgo(4 + n * 7), to: [unnamedTie], thread });
    await warmth.mail(OWN, { at: daysAgo(4 + n * 7 - 0.1), from: unnamedTie, thread });
  }
  unnamedHop = await warmth.person(OWN, { named: false });
  beyond = await warmth.person(OWN);
  nameOnly = await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    const made = await seed.entity("person");
    await seed.alias(OWN, made);
    return made;
  });
  organization = await session(store.db.urls.admin, (query) => seeder(store.db, query).entity("organization"));
  const [first, second, third] = people as [string, string, string];
  // The third person's organizations: one their address's domain is on, and one an affiliation
  // names by name only, as a saved contact's does.
  namedOrganization = await session(store.db.urls.admin, (query) => seeder(store.db, query).entity("organization"));
  investedOrganization = await session(store.db.urls.admin, (query) => seeder(store.db, query).entity("organization"));
  // Each warmth person's account is on the same seeded domain (each made by a seeder of its own),
  // so the third gets a second account, on a domain of its own, which the organization holds.
  domainOrganization = await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    const made = await seed.entity("organization");
    await seed.account(OWN);
    const own = await seed.account(OWN, third);
    const [account] = await query<{ domain_fp: string }>("select domain_fp from knowledge.accounts where id = $1", [
      own,
    ]);
    const id = testId("dom");
    await query(
      "insert into knowledge.domains (id, domain_fp, entity_id, domain_enc, compartments) values ($1, $2, $3, $4, $5)",
      [
        id,
        account?.domain_fp,
        made,
        sealRow(store.db.keys, "own", { table: "knowledge.domains", id, column: "domain_enc" }, "seed-third.test"),
        OWN,
      ],
    );
    return made;
  });

  // The organization the second person works at holds a domain only under a compartment outside the
  // owner's audience: nothing of it may reach the map.
  await session(store.db.urls.admin, (query) => seeder(store.db, query).domain(["family"], organization));

  // A held message from the first person: never on the timeline, which states the reader's filters.
  const held = await warmth.mail(OWN, { at: daysAgo(1), from: first, held: true });
  const [message] = await queryAs<{ id: string }>(
    store.db.urls.admin,
    "select id from knowledge.messages where evidence_id = $1",
    [held],
  );
  heldSubject = message?.id ?? "";
  // Two iMessage lines with the first person, as the participant step writes them.
  for (const line of [0, 1]) {
    await queryAs(
      store.db.urls.writer,
      "insert into knowledge.chat_lines (id, evidence_id, line, entity_id, direction, occurred_at, others, thread_fp, compartments) values ($1, $2, $3, $4, 'inbound', $5, 1, $6, $7)",
      [`chl_01J9Z${"Y".repeat(20)}${line}`, held, line, first, daysAgo(2 + line), "a".repeat(64), OWN],
    );
  }

  const messages = await worldMessages(store);
  const on = (n: number): Message => messages.filter((one) => one.compartment === "own")[n] as Message;
  const specs: FactSpec[] = [
    {
      key: "rel-first-stranger",
      type: "relationship",
      kind: "relationship",
      subject: first,
      by: first,
      message: on(0),
      fields: { counterparty: stranger, note: CANARY },
      fieldKinds: { note: "text" },
      values: { counterparty: stranger },
      entities: [first, stranger],
    },
    {
      key: "aff-first-investor",
      type: "affiliation",
      kind: "affiliation",
      subject: first,
      by: first,
      message: on(1),
      fields: { organization: investedOrganization, relation: "investor", note: CANARY },
      fieldKinds: { note: "text" },
      values: { organization: investedOrganization, relation: "investor" },
      entities: [first, investedOrganization],
    },
    {
      key: "aff-second-org",
      type: "affiliation",
      kind: "affiliation",
      subject: second,
      by: second,
      message: on(1),
      fields: { organization, note: CANARY },
      fieldKinds: { note: "text" },
      values: { organization },
      entities: [second, organization],
    },
    {
      key: "aff-third-named",
      type: "affiliation",
      kind: "affiliation",
      subject: third,
      by: third,
      message: on(0),
      fields: { relation: "employee", organization_name: "Example Named Org", note: CANARY },
      fieldKinds: { note: "text" },
      values: { relation: "employee" },
      entities: [third, namedOrganization],
    },
    {
      key: "rel-first-hop",
      type: "relationship",
      kind: "relationship",
      subject: first,
      by: first,
      message: on(0),
      fields: { counterparty: unnamedHop, note: CANARY },
      fieldKinds: { note: "text" },
      values: { counterparty: unnamedHop },
      entities: [first, unnamedHop],
    },
    {
      key: "rel-hop-beyond",
      type: "relationship",
      kind: "relationship",
      subject: unnamedHop,
      by: unnamedHop,
      message: on(1),
      fields: { counterparty: beyond, note: CANARY },
      fieldKinds: { note: "text" },
      values: { counterparty: beyond },
      entities: [unnamedHop, beyond],
    },
    {
      key: "owed-first",
      type: "commitment",
      kind: "commitment",
      subject: owner,
      by: owner,
      message: on(2),
      fields: { counterparty: first, note: CANARY },
      fieldKinds: { note: "text" },
      values: { counterparty: first },
      entities: [first],
    },
  ];
  await seedFacts(store, owner, specs, [OWN]);
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("owner people reads", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("before the owner's warmth is built, each read refuses rebuilding", async () => {
    await expect(store.admin.people.network()).rejects.toMatchObject({ code: "rebuilding" });
    await expect(store.admin.people.person(people[0] as EntityId)).rejects.toMatchObject({ code: "rebuilding" });
    await expect(store.admin.people.timeline({ entity: people[0] as EntityId })).rejects.toMatchObject({
      code: "rebuilding",
    });
    await buildAs(store.db, OWN);
  });

  // The tiers list names where each works, from a current affiliation belief in the owner's
  // audience; an address on an organization's domain is no belief and names none, nor does an
  // affiliation the person does not work at (investor, board, alumnus).
  it("R-P8: peopleTiers names each person's organization from their current affiliation, and none from a domain alone or an investment", async () => {
    const [first, second, third] = people as [string, string, string];
    const rows = new Map(
      (await store.admin.tiers.peopleTiers()).people.map((row) => [row.entity as string, row.organization?.id ?? null]),
    );
    expect(rows.get(second)).toBe(organization);
    expect(rows.get(third)).toBe(namedOrganization);
    expect(rows.get(first)).toBeNull();
    expect(rows.get(stranger) ?? null).toBeNull();
    expect([...rows.values()]).not.toContain(domainOrganization);
    expect([...rows.values()]).not.toContain(investedOrganization);
    // A page names the same workplaces as the whole list: each page's people alone are read.
    const page = await store.admin.tiers.peopleTiers({ limit: 1 });
    expect(page.people.map((row) => [row.entity, row.organization?.id ?? null])).toEqual(
      page.people.map((row) => [row.entity, rows.get(row.entity) ?? null]),
    );
    const rest = await store.admin.tiers.peopleTiers({
      limit: 200,
      ...(page.next === null ? {} : { cursor: page.next }),
    });
    for (const row of rest.people) expect(row.organization?.id ?? null).toBe(rows.get(row.entity) ?? null);
  });

  it("R-P3: the first load is the owner, their people and their organizations, bounded, with no claim text", async () => {
    const view = await store.admin.people.network({ tiers: [...TIERS] });
    const ids = view.nodes.map((one) => one.id);
    expect(ids[0]).toBe(owner);
    expect(ids).toEqual(expect.arrayContaining([...people, organization]));
    expect(view.nodes.length).toBeLessThanOrEqual(NETWORK_FIRST_MOST);
    expect(view.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: owner, to: people[0], kind: "tie", fact: null })]),
    );
    expect(view.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: people[1], to: organization, kind: "affiliation" })]),
    );
    // The stranger has no tie of the owner's, so is not in the first load; nor is the relationship to them.
    expect(ids).not.toContain(stranger);
    // Everyone here has an address, so no node is known by a name alone, and no goal targets
    // anyone.
    expect(view.nodes.some((one) => one.nameOnly === true || one.goal === true)).toBe(false);
    expect(JSON.stringify(view)).not.toContain(CANARY);
    expect(view.more).toBe(false);

    const bounded = await store.admin.people.network({ tiers: [...TIERS], limit: 2 });
    expect(bounded.nodes).toHaveLength(2);
    expect(bounded.more).toBe(true);
  });

  it("R-P3: an organization with no name carries its domain within the owner's audience, and no other", async () => {
    const view = await store.admin.people.network({ tiers: [...TIERS] });
    const nodes = new Map(view.nodes.map((one) => [one.id as string, one]));
    // The positive control: a domain under `own`, with no name on record.
    expect(nodes.get(domainOrganization)).toMatchObject({ name: null, address: { untrusted: "seed-third.test" } });
    // The same shape of organization, its one domain under a compartment outside the audience.
    expect(nodes.get(organization)).toMatchObject({ kind: "organization", name: null });
    expect(nodes.get(organization)?.address).toBeUndefined();
    // A person's addresses stay off the map.
    expect(nodes.get(people[0] as string)?.address).toBeUndefined();
  });

  it("R-P3: organizations come with their people: by an affiliation that names one by name only, and by an address's domain", async () => {
    const third = people[2] as EntityId;
    const view = await store.admin.people.network({ tiers: [...TIERS] });
    const organizations = view.nodes.filter((one) => one.kind === "organization").map((one) => one.id);
    // The seeded world's people bring their own organizations by domain too.
    expect(organizations).toEqual(expect.arrayContaining([organization, namedOrganization, domainOrganization]));
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: third,
          to: namedOrganization,
          kind: "affiliation",
          fact: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]),
    );
    // The domain's affiliation cites no claim.
    expect(view.edges).toEqual(
      expect.arrayContaining([
        { from: third, to: domainOrganization, kind: "affiliation", weight: expect.any(Number), fact: null },
      ]),
    );
    expect(JSON.stringify(view)).not.toContain(CANARY);
    // An organization's neighbours are its people; a person's include their organizations.
    expect(
      (await store.admin.people.networkExpand(domainOrganization as EntityId))?.nodes.map((one) => one.id),
    ).toEqual([third]);
    expect((await store.admin.people.networkExpand(third))?.nodes.map((one) => one.id).sort()).toEqual(
      [owner, namedOrganization, domainOrganization].sort(),
    );
    // A full load keeps room for the organizations of the people it shows: a load of four is the owner,
    // two people and an organization one of them holds.
    const full = await store.admin.people.network({ tiers: [...TIERS], limit: 4 });
    expect(full.nodes.filter((one) => one.kind === "organization").length).toBeGreaterThanOrEqual(1);
    // Paths reach the domain's organization only as an observed hop.
    const byDomain = (await store.admin.people.paths(domainOrganization as EntityId))?.paths[0];
    expect(byDomain?.nodes.map((one) => one.id)).toEqual([owner, third, domainOrganization]);
    expect(byDomain?.edges.map((one) => one.kind)).toEqual(["tie", "same_domain"]);
  });

  it("R-P3: an expand answers only the node's neighbours", async () => {
    const first = people[0] as EntityId;
    const around = await store.admin.people.networkExpand(first);
    const ids = around?.nodes.map((one) => one.id) ?? [];
    // The map draws every affiliation, an investment too.
    expect(ids.sort()).toEqual([owner, stranger, investedOrganization].sort());
    expect(around?.edges.every((edge) => edge.from === first || edge.to === first)).toBe(true);
    expect(JSON.stringify(around)).not.toContain(CANARY);
    expect((await store.admin.people.networkExpand(organization as EntityId))?.nodes.map((one) => one.id)).toEqual([
      people[1],
    ]);
    expect(await store.admin.people.networkExpand(MISSING_ENTITY)).toBeNull();
  });

  it("R-P2: paths reach a person through the owner's tie and a relationship, and an organization through an affiliation", async () => {
    const toStranger = await store.admin.people.paths(stranger as EntityId);
    expect(toStranger?.paths[0]?.nodes.map((one) => one.id)).toEqual([owner, people[0], stranger]);
    expect(toStranger?.paths[0]?.edges.map((one) => one.kind)).toEqual(["tie", "relationship"]);
    expect(toStranger?.paths[0]?.edges[1]?.fact).toMatch(/^[0-9a-f]{64}$/);
    const toOrganization = await store.admin.people.paths(organization as EntityId);
    expect(toOrganization?.paths[0]?.nodes.map((one) => one.id)).toEqual([owner, people[1], organization]);
    expect(JSON.stringify(toStranger)).not.toContain(CANARY);
    expect(await store.admin.people.paths(MISSING_ENTITY)).toBeNull();
  });

  // Find a path from someone else, neither end the owner.
  it("R-P2: paths from a source run between two people neither of whom is the owner, through the owner or not", async () => {
    const [first, second] = people as [string, string];
    // Past the owner: a relationship, an unnamed hop and a relationship, with no tie of the owner's.
    const past = (await store.admin.people.paths(beyond as EntityId, stranger as EntityId))?.paths[0];
    expect(past?.nodes.map((one) => one.id)).toEqual([stranger, first, unnamedHop, beyond]);
    expect(past?.edges.map((one) => one.kind)).toEqual(["relationship", "relationship", "relationship"]);
    expect(past?.nodes[2]?.name).toBeNull();
    // Through the owner: their ties to the second and the first, then those two people's relationship.
    const through = (await store.admin.people.paths(stranger as EntityId, second as EntityId))?.paths[0];
    expect(through?.nodes.map((one) => one.id)).toEqual([second, owner, first, stranger]);
    expect(through?.edges.map((one) => [one.kind, one.fact === null])).toEqual([
      ["tie", true],
      ["tie", true],
      ["relationship", false],
    ]);
    expect(through?.weakest).toBeGreaterThan(0);
    expect(JSON.stringify([past, through])).not.toContain(CANARY);
    // To an organization from one who works there: one hop, scored.
    const member = (await store.admin.people.paths(organization as EntityId, second as EntityId))?.paths[0];
    expect(member?.nodes.map((one) => one.id)).toEqual([second, organization]);
    expect(member?.edges.map((one) => one.kind)).toEqual(["affiliation"]);
    expect(Number.isFinite(member?.weakest)).toBe(true);
    // To an organization through a shared workplace's member.
    expect(
      (await store.admin.people.paths(organization as EntityId, first as EntityId))?.paths[0]?.nodes.map(
        (one) => one.id,
      ),
    ).toEqual([first, owner, second, organization]);
    // To the owner from someone else; from the owner is the path without a source; one person at both ends has none.
    expect(
      (await store.admin.people.paths(owner as EntityId, stranger as EntityId))?.paths[0]?.nodes.map((one) => one.id),
    ).toEqual([stranger, first, owner]);
    expect(await store.admin.people.paths(stranger as EntityId, owner as EntityId)).toEqual(
      await store.admin.people.paths(stranger as EntityId),
    );
    expect((await store.admin.people.paths(stranger as EntityId, stranger as EntityId))?.paths).toEqual([]);
    // An unnamed, unknown or organization source is in no read.
    expect(await store.admin.people.paths(beyond as EntityId, unnamedHop as EntityId)).toBeNull();
    expect(await store.admin.people.paths(beyond as EntityId, MISSING_ENTITY)).toBeNull();
    expect(await store.admin.people.paths(beyond as EntityId, organization as EntityId)).toBeNull();
  });

  it("R-P4: the panel names the person, their warmth and the open commitments each way", async () => {
    const panel = await store.admin.people.person(people[0] as EntityId);
    expect(panel?.who).toMatchObject({ id: people[0], kind: "person" });
    expect(panel?.warmth?.tier).not.toBeNull();
    expect(panel?.commitments).toEqual({ owedByOwner: 1, owedToOwner: 0 });
    expect(panel?.ruledTier).toBeNull();
    expect(panel?.ignoreRuling).toBeNull();
    expect(panel?.lead.tie).toBeNull();
    expect(panel?.lead.lastMeeting).toBeNull();
    expect(panel?.lead.lastThread?.message).not.toBe(heldSubject);
    expect(panel?.lead.lastThread?.at).toBe(stamp(new Date(daysAgo(3 - 0.1))));
    expect(panel?.lead.lastChat).toBe(stamp(new Date(daysAgo(2))));
    expect(panel?.lead.lastContact).toBe("chat");
    expect(JSON.stringify(panel?.lead)).not.toContain(CANARY);
    expect(await store.admin.people.person(organization as EntityId)).toBeNull();
  });

  it("owner-reads: the lead counts a meeting the owner kept, and names their confirmed tie", async () => {
    const person = await warmth.person(OWN);
    await warmth.meeting(OWN, [person], daysAgo(0.5), { response: "declined" });
    await warmth.meeting(OWN, [person], daysAgo(0.6), { response: "needsAction" });
    await warmth.meeting(OWN, [person], daysAgo(0.7), { cancelled: true });
    await warmth.meeting(OWN, [person], daysAgo(0.8), { response: "tentative" });
    await warmth.meeting(OWN, [person], daysAgo(1.5), { response: "accepted" });
    const before = await store.admin.people.person(person as EntityId);
    expect(before?.lead.tie).toBeNull();
    expect(before?.lead.lastMeeting?.at).toBe(stamp(new Date(daysAgo(0.8))));
    expect(before?.lead.lastContact).toBe("meeting");

    const evidence = await session(store.db.urls.admin, async (query) => {
      await seeder(store.db, query).into("knowledge.claim_releases")(OWN);
      const [release] = (await query(
        "select evidence_id from knowledge.claim_releases order by created_at desc, ruling_id desc limit 1",
      )) as { evidence_id: string }[];
      return release?.evidence_id ?? "";
    });
    await session(store.db.urls.pipeline, async (query) => {
      const base = claimRecord(evidence, OWN, person, {
        n: 900,
        type: OWNER_TIE_TYPE,
        factKey: "lead tie",
        entities: [person],
        origin: "agent_record",
      });
      const record = {
        ...base,
        claim: {
          ...base.claim,
          content: { type: OWNER_TIE_TYPE, subject: person, fields: { relation: "mentor", closeness: "inner" } },
        },
        subjectKind: "person",
        fieldKinds: { relation: "enum", closeness: "enum" },
      };
      const id = fingerprint(store.db.keys, "claim", testId("tie"));
      await query(
        `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, compartments, released, content_enc)
         values ($1, $2, $3, $4, $5, 1, array['m-owner'], array['own'], true, $6)`,
        [
          id,
          evidence,
          OWNER_TIE_TYPE,
          daysAgo(1),
          fingerprint(store.db.keys, "fact", "lead tie"),
          sealRow(
            store.db.keys,
            "own",
            { table: "knowledge.claims", id, column: "content_enc" },
            JSON.stringify(record),
          ),
        ],
      );
      await query(
        "insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, array['own'])",
        [id, person],
      );
    });
    expect((await store.admin.people.person(person as EntityId))?.lead.tie).toBe("mentor");
  });

  it("R-P1: the timeline holds mail, iMessage lines and facts, a month a page, never a held message", async () => {
    const first = people[0] as EntityId;
    const all: { kind: string; id: string; at: string; title: { untrusted: string } | null }[] = [];
    let cursor: string | undefined;
    const months: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const one = await store.admin.people.timeline({
        entity: first,
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (one === null) throw new Error("no timeline");
      months.push(one.month);
      for (const entry of one.entries) expect(entry.at.slice(0, 7)).toBe(one.month);
      all.push(...one.entries);
      if (one.next === null) break;
      cursor = one.next;
    }
    const kinds = new Set(all.map((one) => one.kind));
    expect([...kinds].sort()).toEqual(["fact", "imessage", "mail"]);
    expect(all.filter((one) => one.kind === "mail")).toHaveLength(8);
    expect(all.filter((one) => one.kind === "imessage")).toHaveLength(2);
    // A fact's entry says what it is, in its claim's words.
    expect(all.filter((one) => one.kind === "fact").map((one) => one.title?.untrusted)).toEqual(
      expect.arrayContaining([CANARY]),
    );
    expect(all.filter((one) => one.kind === "fact").every((one) => one.title?.untrusted === CANARY)).toBe(true);
    expect(all.map((one) => one.id)).not.toContain(heldSubject);
    // Newest first, each once, across pages.
    const times = all.map((one) => Date.parse(one.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(new Set(all.map((one) => `${one.kind} ${one.id}`)).size).toBe(all.length);
    await expect(store.admin.people.timeline({ entity: first, cursor: "bm90LWEtY3Vyc29y" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(await store.admin.people.timeline({ entity: MISSING_ENTITY })).toBeNull();
  });

  // A person no read names is no list row, map node or search hit; in the middle of a path they
  // are a hop alone.
  it("an unnamed person is in no read, and only a hop of a path", async () => {
    const first = people[0] as EntityId;
    const tiers = (await store.admin.tiers.peopleTiers()).people.map((row) => row.entity as string);
    expect(tiers).toEqual(expect.arrayContaining([...people]));
    expect(tiers).not.toContain(unnamedTie);
    const nodes = (await store.admin.people.network({ tiers: [...TIERS] })).nodes.map((one) => one.id as string);
    expect(nodes).not.toContain(unnamedTie);
    expect(nodes).not.toContain(unnamedHop);
    expect((await store.admin.people.networkExpand(owner as EntityId))?.nodes.map((one) => one.id)).not.toContain(
      unnamedTie,
    );
    expect((await store.admin.people.networkExpand(first))?.nodes.map((one) => one.id)).not.toContain(unnamedHop);
    expect(await store.admin.people.networkExpand(unnamedHop as EntityId)).toBeNull();
    expect(await store.admin.people.paths(unnamedHop as EntityId)).toBeNull();
    expect(await store.admin.people.paths(unnamedTie as EntityId)).toBeNull();
    const through = (await store.admin.people.paths(beyond as EntityId))?.paths[0];
    expect(through?.nodes.map((one) => one.id)).toEqual([owner, first, unnamedHop, beyond]);
    expect(through?.nodes[2]?.name).toBeNull();
    expect(through?.nodes[3]?.name).not.toBeNull();
    const hits = (await store.admin.search.entities("seed-person")).hits.map((hit) => hit.who.id as string);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).not.toContain(unnamedTie);
    expect(hits).not.toContain(unnamedHop);
  });

  // Remove hides the person's group and ignores their addresses under one ruling; its lift brings
  // them back. A person known by a name alone can be removed.
  it("Remove takes a person out of every read, its undo brings them back, and one known by name alone can be removed", async () => {
    const second = people[1] as EntityId;
    const ruling = await store.admin.ignores.addIgnore("entity", second, { requestId: testId("req") });
    expect((await store.admin.tiers.peopleTiers()).people.map((row) => row.entity)).not.toContain(second);
    expect((await store.admin.people.network({ tiers: [...TIERS] })).nodes.map((one) => one.id)).not.toContain(second);
    expect(await store.admin.people.paths(second)).toBeNull();
    expect((await store.admin.search.entities("seed-person")).hits.map((hit) => hit.who.id)).not.toContain(second);
    expect((await store.admin.people.person(second))?.ignoreRuling).toBe(ruling);
    expect(await store.admin.ignores.liftIgnore(ruling, { requestId: testId("req") })).toBe(true);
    expect((await store.admin.tiers.peopleTiers()).people.map((row) => row.entity)).toContain(second);
    expect((await store.admin.people.person(second))?.ignoreRuling).toBeNull();

    const hidden = await store.admin.ignores.addIgnore("entity", nameOnly, { requestId: testId("req") });
    const [row] = await queryAs<{ entity_ids: string[] }>(
      store.db.urls.admin,
      "select entity_ids from knowledge.person_hides where ruling_id = $1 and lifted_at is null",
      [hidden],
    );
    expect(row?.entity_ids).toEqual([nameOnly]);
    expect((await store.admin.ignores.listIgnore()).find((one) => one.id === hidden)).toMatchObject({
      target: "entity",
      values: 1,
      liftedAt: null,
    });
    expect((await store.admin.ignores.ignoredWho()).get(hidden)?.map((one) => one.id)).toEqual([nameOnly]);
    await expect(store.admin.ignores.addIgnore("entity", nameOnly, { requestId: testId("req") })).rejects.toMatchObject(
      {
        code: "already_settled",
      },
    );
  });

  // A write made by another Admin (as by another process) is in the next read; and an erased person
  // is in no read after the erasure.
  it("a write by another process is in the next read, and an erased person is in no read", async () => {
    const third = people[2] as EntityId;
    const second = people[1] as EntityId;
    const dir = await mkdtemp(join(tmpdir(), "pi-people-erase-"));
    const other = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal: join(dir, "keys.json.erasures"),
    });
    try {
      expect((await store.admin.people.network({ tiers: [...TIERS] })).nodes.map((one) => one.id)).toContain(second);
      const ruling = await other.ignores.addIgnore("entity", second, { requestId: testId("req") });
      expect((await store.admin.people.network({ tiers: [...TIERS] })).nodes.map((one) => one.id)).not.toContain(
        second,
      );
      await other.ignores.liftIgnore(ruling, { requestId: testId("req") });
      expect((await store.admin.people.network({ tiers: [...TIERS] })).nodes.map((one) => one.id)).toContain(third);

      // A Remove of theirs keeps no id of an erased person (invariant 10).
      await other.ignores.addIgnore("entity", third, { requestId: testId("req") });
      await other.erasure.erasePerson(third, { requestId: testId("req") });
      expect(
        await queryAs(store.db.urls.admin, "select ruling_id from knowledge.person_hides where $1 = any (entity_ids)", [
          third,
        ]),
      ).toEqual([]);
      // The erasure took the owner's beliefs and emptied their warmth build: the map says it is rebuilding
      // until the next run, and no read names the erased person.
      await expect(store.admin.people.network({ tiers: [...TIERS] })).rejects.toMatchObject({ code: "rebuilding" });
      expect(await store.admin.people.paths(third)).toBeNull();
      expect((await store.admin.tiers.peopleTiers()).people.map((row) => row.entity)).not.toContain(third);
      expect((await store.admin.search.entities("seed-person")).hits.map((hit) => hit.who.id)).not.toContain(third);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
