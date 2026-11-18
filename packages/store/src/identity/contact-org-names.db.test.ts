import { type EntityId, EntityView, PathList, SearchResult } from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import { orgNameFp } from "../core/org-names.ts";
import { Reader } from "../read/read.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { type IdentityWorld, inIdentityWorld } from "../test-support/identity-fixtures.ts";
import { knownBy } from "../test-support/known-by.ts";
import { seeder } from "../test-support/seeder.ts";
import { outcomeValue } from "../test-support/values.ts";
import { MADE_TODAY } from "../write/named-orgs.ts";

// A contact's organization, filed when its claims are written and found by name through the reads
// an agent uses, as the production roles run them. The backfill of claims stored before they were
// filed. Made-up values on reserved domains.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const TOOLS = ["search", "get_entity", "find_paths"];
const VIEWS = ["self", "people", "work"];
const MAREN = "maren@contact-org.test";
const NOW = new Date("2026-09-15T12:00:00Z");

const reader = (world: IdentityWorld) =>
  new Reader({ pool: world.store.readerPool, keys: world.db.keys, log: world.store.log, now: () => world.store.now });
const search = async (world: IdentityWorld, client: Client, query: string) =>
  SearchResult.parse(outcomeValue(await reader(world).search(client.token, { query }))).results;
const client = (world: IdentityWorld, name: string, clearance: string[]) =>
  insertReader(world.store, name, clearance, { tools: TOOLS, views: VIEWS });
const nameRows = (world: IdentityWorld) =>
  world.sql<{ claim_id: string; name_fp: string; compartments: string[] }>(
    "select claim_id, name_fp, compartments from knowledge.claim_org_names order by claim_id",
  );
const organizationsNamed = (world: IdentityWorld, name: string) =>
  world.sql<{ entity_id: string }>("select distinct entity_id from knowledge.org_names where name_fp = $1", [
    orgNameFp(world.db.keys, name),
  ]);
const saveMaren = (world: IdentityWorld) =>
  world.save(world.accounts.personalContacts, "maren", {
    names: ["Maren Holt"],
    emails: [MAREN],
    organization: "Northwind Holdings",
    title: "Head of Research",
  });

describe("a contact's organization", () => {
  it("is filed with its claims under their label, and found by name by a cleared client and by no other", () =>
    inIdentityWorld(async (world) => {
      await saveMaren(world);
      const claims = await world.sql<{ id: string; compartments: string[] }>(
        "select id, compartments from knowledge.claims where type = any($1) order by id",
        [["affiliation", "role"]],
      );
      expect(claims).toHaveLength(2);
      expect(await nameRows(world)).toEqual(
        claims.map((row) => ({
          claim_id: row.id,
          name_fp: orgNameFp(world.db.keys, "Northwind Holdings"),
          compartments: row.compartments,
        })),
      );

      await world.store.writer.bindNamed(NOW);
      const [northwind, ...others] = await organizationsNamed(world, "Northwind Holdings");
      expect(others).toEqual([]);
      const id = northwind?.entity_id as EntityId;

      // The positive control: cleared for `own`, by the organization's name, with who works there.
      const own = await client(world, "own-con", ["own"]);
      expect((await search(world, own, "northwind holdings")).map((one) => [one.id, one.kind, one.nameOnly])).toEqual([
        [id, "organization", true],
      ]);
      const view = EntityView.parse(outcomeValue(await reader(world).getEntity(own.token, { id })));
      expect(view.names.map((name) => name.untrusted)).toEqual(["Northwind Holdings"]);
      expect(view.people.map((person) => person.id)).toEqual([await world.person(MAREN)]);

      // The owner's own search finds it by name too, within an audience a claim gives them.
      await session(world.db.urls.admin, (query) => seeder(world.db, query).claim(["own"]));
      const hits = (await world.store.admin.search.entities("northwind holdings")).hits;
      expect(hits.map((hit) => [hit.who.id, hit.who.nameOnly])).toEqual([[id, true]]);

      // Not cleared for `own`: nothing, and the same answer as a name nothing holds.
      const work = await client(world, "work-con", ["employer:example"]);
      expect(await search(world, work, "northwind holdings")).toEqual(await search(world, work, "no such firm"));
      expect(await search(world, work, "northwind holdings")).toEqual([]);
      expect(await reader(world).getEntity(work.token, { id })).toEqual(
        await reader(world).getEntity(work.token, { id: "ent_00000000000000000000000000" as EntityId }),
      );
    }));

  it("from a contact outside `own` stays withheld, even from a client cleared for that compartment", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.workContacts, "wren", {
        names: ["Wren Oak"],
        emails: ["wren@contact-org.test"],
        organization: "Fabrikam Partners",
      });
      await world.store.writer.bindNamed(NOW);
      expect(await organizationsNamed(world, "Fabrikam Partners")).toHaveLength(1);
      const wide = await client(world, "wide-con", ["own", "employer:example"]);
      expect(await search(world, wide, "fabrikam partners")).toEqual([]);
    }));

  it("is walked by find_paths: a saved contact's affiliation bridges to the organization it names, for a cleared client", () =>
    inIdentityWorld(async (world) => {
      await saveMaren(world);
      await world.store.writer.bindNamed(NOW);
      const [northwind] = await organizationsNamed(world, "Northwind Holdings");
      const id = northwind?.entity_id as EntityId;
      const own = await client(world, "own-path", ["own"]);
      const paths = async () =>
        PathList.parse(outcomeValue(await reader(world).findPaths(own.token, { target: id }))).paths.map((path) =>
          path.hops.map((hop) => hop.via),
        );
      // The contact's affiliation claim builds its belief at read, once the claim is
      // known by the reader's clock: before, the reader's world has no such claim.
      expect(await paths()).toEqual([]);
      await knownBy(world.db, world.store.now);
      expect(await paths()).toEqual([["own_tie", "affiliation"]]);

      // A client not cleared for `own` sees neither the organization nor a way to it.
      const work = await client(world, "work-path", ["employer:example"]);
      expect(await reader(world).findPaths(work.token, { target: id })).toEqual(
        await reader(world).findPaths(work.token, { target: "ent_00000000000000000000000000" as EntityId }),
      );
    }));

  it("is not named again by a revision that writes the same claim, and goes with a revision that drops it", () =>
    inIdentityWorld(async (world) => {
      await saveMaren(world);
      await world.store.writer.bindNamed(NOW);
      expect(await world.store.writer.reclaimContacts({ dryRun: false })).toMatchObject({ written: 0, removed: 0 });
      expect(await nameRows(world)).toHaveLength(2);
      await world.save(world.accounts.personalContacts, "maren", { names: ["Maren Holt"], emails: [MAREN] });
      expect(await nameRows(world)).toEqual([]);
    }));
});

describe("the writer's name rows", () => {
  it("are for a contact's claim alone", () =>
    inIdentityWorld(async (world) => {
      const claim = await session(world.db.urls.admin, (query) =>
        seeder(world.db, query).into("knowledge.claims")(["own"]),
      );
      await expect(
        queryAs(
          world.db.urls.writer,
          "insert into knowledge.claim_org_names (claim_id, name_fp, compartments) values ($1, $2, $3)",
          [claim, "c".repeat(64), ["own"]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }));
});

describe("pi contacts file-org-names", () => {
  // As a box holds them today: claims written before a contact's claims were filed.
  const asStored = async (world: IdentityWorld) => {
    await session(world.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query("alter table knowledge.claim_org_names no force row level security");
      await query("delete from knowledge.claim_org_names");
      await query("alter table knowledge.claim_org_names force row level security");
    });
    expect(await nameRows(world)).toEqual([]);
  };

  it("files old rows and binds them; a second run changes nothing; a dry run writes nothing", () =>
    inIdentityWorld(async (world) => {
      await saveMaren(world);
      const filed = await nameRows(world);
      await asStored(world);

      const dry = await world.store.writer.fileContactOrgNames({ dryRun: true });
      expect(dry).toMatchObject({ claims: 2, filed: 2, skipped: 0, orgMade: 0, orgBound: 0 });
      expect(await nameRows(world)).toEqual([]);

      const first = await world.store.writer.fileContactOrgNames({ dryRun: false });
      expect(first).toMatchObject({ claims: 2, filed: 2, skipped: 0, orgMade: 1, orgBound: 1, orgCapped: 0 });
      expect(await nameRows(world)).toEqual(filed);
      const own = await client(world, "own-bf", ["own"]);
      expect((await search(world, own, "northwind holdings")).map((one) => one.kind)).toEqual(["organization"]);

      const second = await world.store.writer.fileContactOrgNames({ dryRun: false });
      expect(second).toMatchObject({ claims: 0, filed: 0, orgMade: 0, orgBound: 0, orgRemoved: 0 });
      expect(await nameRows(world)).toEqual(filed);
      // A count, an id or a code only: no name in what it returns.
      expect(JSON.stringify(second)).not.toContain("Northwind");
    }));

  it("an owner's re-derive files the names in its own transaction; the writer's next pass binds them", () =>
    inIdentityWorld(async (world) => {
      await saveMaren(world);
      await world.save(world.accounts.personalContacts, "pell", {
        names: ["Pell Ardent"],
        emails: ["pell@contact-org.test"],
      });
      expect(await nameRows(world)).toHaveLength(2);
      const { rederived } = await world.store.admin.accounts.addOwnerAddress("pell@contact-org.test", "own");
      expect(rederived).toBe(true);
      expect(await nameRows(world)).toHaveLength(2);
      // A re-derive removes the organization a name made, and only the writer makes one again.
      const own = await client(world, "own-rd", ["own"]);
      expect(await search(world, own, "northwind holdings")).toEqual([]);

      const bound = await world.store.writer.fileContactOrgNames({ dryRun: false });
      expect(bound).toMatchObject({ filed: 0, skipped: 0, orgMade: 1, orgBound: 1 });
      expect(await nameRows(world)).toHaveLength(2);
      expect((await search(world, own, "northwind holdings")).map((one) => one.kind)).toEqual(["organization"]);
    }));

  it("pi_admin files a contact claim's name and no other claim's: pi_writer's policy", () =>
    inIdentityWorld(async (world) => {
      await saveMaren(world);
      const [contact] = await queryAs<{ claim_id: string; name_fp: string; compartments: string[] }>(
        world.db.urls.admin,
        "select claim_id, name_fp, compartments from knowledge.claim_org_names order by claim_id limit 1",
      );
      expect(contact).toBeDefined();
      await asStored(world);
      const insert = "insert into knowledge.claim_org_names (claim_id, name_fp, compartments) values ($1, $2, $3)";
      await queryAs(world.db.urls.admin, insert, [contact?.claim_id, contact?.name_fp, contact?.compartments]);
      const other = await session(world.db.urls.admin, (query) => seeder(world.db, query).claim(["own"]));
      await expect(queryAs(world.db.urls.admin, insert, [other, contact?.name_fp, ["own"]])).rejects.toMatchObject({
        code: "42501",
      });
    }));

  it("spends its own allowance, not the one named people and organizations share", () =>
    inIdentityWorld(async (world) => {
      const made = 25;
      for (let n = 0; n < made; n += 1)
        await world.save(world.accounts.personalContacts, `c${n}`, {
          names: [`Person Number${n}`],
          emails: [`person${n}@contact-org.test`],
          organization: `Fabrikam Unit ${n}`,
        });
      await asStored(world);
      expect(await world.store.writer.fileContactOrgNames({ dryRun: false })).toMatchObject({
        filed: made,
        orgMade: made,
        orgCapped: 0,
      });
      // The allowance named people and organizations share holds none of them.
      const [count] = await world.sql<{ n: number }>(MADE_TODAY, [["own"]]);
      expect(count?.n).toBe(0);
    }));
});
