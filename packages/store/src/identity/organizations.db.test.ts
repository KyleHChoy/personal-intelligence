import type { CardId, ClaimRecord, EntityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { asWords } from "../test-support/card-lines.ts";
import { connect, OWNER } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { readAs, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { lines, snapshot } from "../test-support/snapshot.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { storeSeeder } from "../test-support/world.ts";

// Organizations with names: an organization is minted and matched by its registrable domain; the
// refold joins those minted earlier from subdomains; and get_entity serves an organization's names,
// the owner's and its claims'.

const TIMEOUT = 180_000;
const AT = (day: number): Date => new Date(Date.UTC(2026, 8, day, 9));
const owner = { address: OWNER.personal };
const ASH = { address: "ash@team.alder.test", name: "Ash Alderley" };
const BO = { address: "bo@mail.alder.test", name: "Bo Alderley" };
const CY = { address: "cy@alder.test", name: "Cy Alderley" };

// A store with the owner's four accounts and a seeder on it, closed when `fn` settles.
async function withOrganizations(
  fn: (
    store: TestStore,
    seed: ReturnType<typeof storeSeeder>,
    accounts: Awaited<ReturnType<typeof connect>>,
  ) => Promise<void>,
): Promise<void> {
  const store = await openStore();
  try {
    const accounts = await connect(store.writer);
    await fn(store, storeSeeder(store.writer, store.now), accounts);
  } finally {
    await store.close();
  }
}

const domainRows = (store: TestStore) =>
  queryAs<{ domain_fp: string; entity_id: string }>(
    store.db.urls.admin,
    "select domain_fp, entity_id from knowledge.domains order by id",
  );

// An organization row as one minted from a whole domain, before the registrable-domain fold: its
// own entity, and a domain row for a whole domain under `own`, written in SQL as pi_admin.
async function oldOrganization(store: TestStore, domain: string): Promise<string> {
  const entity = testId("ent");
  const id = testId("dom");
  await queryAs(store.db.urls.admin, "insert into knowledge.entities (id, kind) values ($1, 'organization')", [entity]);
  await queryAs(
    store.db.urls.admin,
    "insert into knowledge.domains (id, domain_fp, entity_id, domain_enc, compartments) values ($1, $2, $3, $4, $5)",
    [
      id,
      fingerprint(store.db.keys, "domain", domain),
      entity,
      sealUnder(store.db.keys, ["own"], { table: "knowledge.domains", id, column: "domain_enc" }, domain),
      ["own"],
    ],
  );
  return entity;
}

describe("organizations", { timeout: TIMEOUT }, () => {
  it("addresses on two subdomains and on the registrable domain are one organization, with one domain row", () =>
    withOrganizations(async (store, seed, accounts) => {
      for (const [n, from] of [ASH, BO, CY].entries())
        await seed.mail(accounts.personalMail, { id: `k1b-fold-${n}`, from, to: [owner], at: AT(n + 1) });
      const fp = (domain: string): string => fingerprint(store.db.keys, "domain", domain);
      const rows = await domainRows(store);
      expect(rows.map((row) => row.domain_fp)).toEqual([fp("alder.test")]);
      // Each person's account is under the registrable domain, the key of the domain row.
      const held = await queryAs<{ domain_fp: string }>(
        store.db.urls.admin,
        "select distinct a.domain_fp from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person'",
      );
      expect(held.map((row) => row.domain_fp)).toEqual([fp("alder.test")]);

      const { token } = await store.admin.clients.addClient(registration("k1b-fold", ["own"]));
      const people = [ASH, BO, CY].map((one) => seed.entityOf(one.address));
      const organizations = new Set<string | undefined>();
      for (const id of people)
        organizations.add(outcomeValue(await store.reader.getEntity(token, { id })).organization?.id);
      expect([...organizations]).toEqual([rows[0]?.entity_id]);
      const organization = outcomeValue(await store.reader.getEntity(token, { id: rows[0]?.entity_id as EntityId }));
      expect(organization.addresses).toEqual([{ untrusted: "alder.test" }]);
      expect(organization.people.map((one) => one.id).sort()).toEqual([...people].sort());

      // A free mail domain's subdomain mints none, and nor does a relay's.
      await seed.mail(accounts.personalMail, {
        id: "k1b-free",
        from: { address: "dee@mail.gmail.com" },
        to: [owner],
        at: AT(5),
      });
      await seed.mail(accounts.personalMail, {
        id: "k1b-relay",
        from: { address: "x1y2@privaterelay.appleid.com" },
        to: [owner],
        at: AT(6),
      });
      expect(await domainRows(store)).toEqual(rows);
    }));

  it("the owner names an organization, a new name lifts the old one, and get_entity serves the name in force", () =>
    withOrganizations(async (store, seed, accounts) => {
      await seed.mail(accounts.personalMail, { id: "k1b-name", from: CY, to: [owner], at: AT(1) });
      const [row] = await domainRows(store);
      const organization = row?.entity_id as EntityId;
      const { token } = await store.admin.clients.addClient(registration("k1b-name", ["own"]));
      const { token: elsewhere } = await store.admin.clients.addClient(
        registration("k1b-elsewhere", ["employer:example"]),
      );
      expect(outcomeValue(await store.reader.getEntity(token, { id: organization })).names).toEqual([]);

      // Until named, whoOf names an organization by nothing but its domain.
      const employer = async () =>
        outcomeValue(await store.reader.getEntity(token, { id: seed.entityOf(CY.address) })).organization;
      expect(await employer()).toMatchObject({ id: organization, name: null, address: { untrusted: "alder.test" } });

      const first = await store.admin.identity.nameOrganization(organization, "  Alder Works ", {
        requestId: "k1b-name-0001",
      });
      expect(outcomeValue(await store.reader.getEntity(token, { id: organization })).names).toEqual([
        { untrusted: "Alder Works" },
      ]);
      // Every answer that names the organization, through whoOf, gives its name.
      expect(await employer()).toMatchObject({
        id: organization,
        name: { untrusted: "Alder Works" },
        address: { untrusted: "alder.test" },
      });
      expect(
        outcomeValue(await store.reader.search(token, { query: "alder.test" })).results.find(
          (one) => one.id === organization,
        ),
      ).toMatchObject({ name: { untrusted: "Alder Works" } });
      // A repeated request writes nothing.
      expect(
        await store.admin.identity.nameOrganization(organization, "Alder Works", { requestId: "k1b-name-0001" }),
      ).toBe(first);
      const second = await store.admin.identity.nameOrganization(organization, "Alder Works Cooperative", {
        requestId: "k1b-name-0002",
      });
      expect(second).not.toBe(first);
      expect(outcomeValue(await store.reader.getEntity(token, { id: organization })).names).toEqual([
        { untrusted: "Alder Works Cooperative" },
      ]);
      expect((await employer())?.name).toEqual({ untrusted: "Alder Works Cooperative" });
      const named = await queryAs<{ ruling_id: string; lift_ruling_id: string | null; compartments: string[] }>(
        store.db.urls.admin,
        "select ruling_id, lift_ruling_id, compartments from knowledge.organization_names order by lift_ruling_id is null, id",
      );
      expect(named).toEqual([
        { ruling_id: first, lift_ruling_id: second, compartments: ["own"] },
        { ruling_id: second, lift_ruling_id: null, compartments: ["own"] },
      ]);
      // The decision names the organization and holds no name.
      const [decision] = await queryAs<{ kind: string; target_kind: string; target_id: string; body_enc: unknown }>(
        store.db.urls.admin,
        "select kind, target_kind, target_id, body_enc from knowledge.owner_decisions where id = $1",
        [second],
      );
      expect(decision).toEqual({
        kind: "organization_name",
        target_kind: "entity",
        target_id: organization,
        body_enc: null,
      });

      // A client not cleared for the organization's compartment sees neither it nor its name.
      expect(await store.reader.getEntity(elsewhere, { id: organization })).toMatchObject({
        ok: false,
        code: "not_found",
      });
      // The reader's row policy: the live name within the clearance, never a lifted one, nothing
      // with no token, and no column beyond its four.
      const visible = (token: string | null) =>
        readAs(
          store.db,
          token,
          async (query) =>
            (await query<{ id: string }>("select id from knowledge.organization_names order by id")).length,
        );
      expect([await visible(token), await visible(elsewhere), await visible(null)]).toEqual([1, 0, 0]);
      expect(
        await sqlState(() =>
          readAs(store.db, token, (query) => query("select ruling_id from knowledge.organization_names")),
        ),
      ).toBe("42501");
      // A person, an unknown id, an empty name and a control character are refused, writing nothing.
      const before = lines(await snapshot(store.db));
      await expect(
        store.admin.identity.nameOrganization(seed.entityOf(CY.address), "Alder", { requestId: "k1b-name-0003" }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        store.admin.identity.nameOrganization(`ent_${"0".repeat(25)}9` as EntityId, "Alder", {
          requestId: "k1b-name-0004",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        store.admin.identity.nameOrganization(organization, "   ", { requestId: "k1b-name-0005" }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        store.admin.identity.nameOrganization(organization, "Alder\nWorks", { requestId: "k1b-name-0006" }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      expect(lines(await snapshot(store.db))).toEqual(before);
    }));

  it("a role claim's organization_name names the organization it is about, after the owner's name", () =>
    withOrganizations(async (store, seed, accounts) => {
      await seed.mail(accounts.personalMail, { id: "k1b-claim", from: CY, to: [owner], at: AT(1) });
      await seed.mail(accounts.personalMail, {
        id: "k1b-other",
        from: { address: "fen@birch.test", name: "Fen Birchley" },
        to: [owner],
        at: AT(2),
      });
      const [evidence] = await queryAs<{ id: string }>(
        store.db.urls.admin,
        "select id from vault.evidence_items order by ingested_at, id limit 1",
      );
      const fp = (domain: string): string => fingerprint(store.db.keys, "domain", domain);
      const organizationOf = async (domain: string): Promise<string> =>
        (
          await queryAs<{ entity_id: string }>(
            store.db.urls.admin,
            "select entity_id from knowledge.domains where domain_fp = $1",
            [fp(domain)],
          )
        )[0]?.entity_id ?? "";
      const [alder, birch] = [await organizationOf("alder.test"), await organizationOf("birch.test")];
      const cy = seed.entityOf(CY.address);
      const role = (n: number, organization: string, name: string): ClaimRecord => {
        const base = claimRecord(evidence?.id ?? "", "own", cy, {
          n,
          type: "role",
          factKey: `k1b-role-${n}`,
          entities: [cy, organization],
        });
        return {
          ...base,
          subjectKind: "person",
          claim: {
            ...base.claim,
            content: {
              type: "role",
              subject: cy,
              fields: { title: "treasurer", organization, organization_name: name },
            },
          },
          fieldKinds: { title: "text", organization: "entity", organization_name: "text" },
        } as unknown as ClaimRecord;
      };
      const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
      try {
        expect(
          await pipeline.commit(
            batchOf(evidence?.id ?? "", [role(1, alder, "Alder Cooperative"), role(2, birch, "Birch Holdings")]),
          ),
        ).toBe("committed");
      } finally {
        await pipeline.close();
      }
      const { token } = await store.admin.clients.addClient(registration("k1b-claim", ["own"]));
      expect(outcomeValue(await store.reader.getEntity(token, { id: alder as EntityId })).names).toEqual([
        { untrusted: "Alder Cooperative" },
      ]);
      expect(outcomeValue(await store.reader.getEntity(token, { id: birch as EntityId })).names).toEqual([
        { untrusted: "Birch Holdings" },
      ]);
      // whoOf gives each organization its first name, a claim's before the owner names it.
      const employer = async () =>
        outcomeValue(await store.reader.getEntity(token, { id: cy as EntityId })).organization?.name;
      expect(await employer()).toEqual({ untrusted: "Alder Cooperative" });
      await store.admin.identity.nameOrganization(alder as EntityId, "Alder Works", { requestId: "k1b-claim-0001" });
      expect(outcomeValue(await store.reader.getEntity(token, { id: alder as EntityId })).names).toEqual([
        { untrusted: "Alder Works" },
        { untrusted: "Alder Cooperative" },
      ]);
      expect(await employer()).toEqual({ untrusted: "Alder Works" });
    }));

  // A name whoOf serves from a claim is in the call's read log, as get_entity's organization branch
  // logs its names' claims.
  it("whoOf's organization name from a claim is read-logged: the claim's evidence shown and its fact key", () =>
    withOrganizations(async (store, seed, accounts) => {
      await seed.mail(accounts.personalMail, { id: "k1f-claim", from: CY, to: [owner], at: AT(1) });
      await seed.mail(accounts.personalMail, { id: "k1f-ash", from: ASH, to: [owner], at: AT(2) });
      const [evidence] = await queryAs<{ id: string }>(
        store.db.urls.admin,
        "select id from vault.evidence_items order by ingested_at, id limit 1",
      );
      const [alder] = await queryAs<{ entity_id: string }>(
        store.db.urls.admin,
        "select entity_id from knowledge.domains where domain_fp = $1",
        [fingerprint(store.db.keys, "domain", "alder.test")],
      );
      const cy = seed.entityOf(CY.address);
      const base = claimRecord(evidence?.id ?? "", "own", cy, {
        n: 1,
        type: "role",
        factKey: "k1f-role",
        entities: [cy, alder?.entity_id ?? ""],
      });
      const role = {
        ...base,
        subjectKind: "person",
        claim: {
          ...base.claim,
          content: {
            type: "role",
            subject: cy,
            fields: { title: "treasurer", organization: alder?.entity_id, organization_name: "Alder Cooperative" },
          },
        },
        fieldKinds: { title: "text", organization: "entity", organization_name: "text" },
      } as unknown as ClaimRecord;
      const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
      try {
        expect(await pipeline.commit(batchOf(evidence?.id ?? "", [role]))).toBe("committed");
      } finally {
        await pipeline.close();
      }
      const [claim] = await queryAs<{ evidence_id: string; fact_key_fp: string }>(
        store.db.urls.admin,
        "select evidence_id, fact_key_fp from knowledge.claims where type = 'role'",
      );
      const { token } = await store.admin.clients.addClient(registration("k1f-who", ["own"]));
      // Ash's card names Alder by Cy's claim; nothing else on it rests on that claim.
      expect(
        outcomeValue(await store.reader.getEntity(token, { id: seed.entityOf(ASH.address) as EntityId })).organization
          ?.name,
      ).toEqual({ untrusted: "Alder Cooperative" });
      const [log] = await queryAs<{ shown: string[]; fact_key_fps: string[] }>(
        store.db.urls.admin,
        "select shown, fact_key_fps from ledger.read_log where tool = 'get_entity' order by id desc limit 1",
      );
      expect(log?.shown).toContain(claim?.evidence_id);
      expect(log?.fact_key_fps).toContain(claim?.fact_key_fp);
    }));

  it("the refold's dry run writes nothing; the refold joins subdomain organizations under one id, drops a provider's, keeps the owner's name, and then has nothing to do", () =>
    withOrganizations(async (store, seed, accounts) => {
      await seed.mail(accounts.personalMail, { id: "k1b-refold-cy", from: CY, to: [owner], at: AT(1) });
      await seed.mail(accounts.personalMail, { id: "k1b-refold-ash", from: ASH, to: [owner], at: AT(2) });
      const [row] = await domainRows(store);
      const alder = row?.entity_id as EntityId;
      const team = await oldOrganization(store, "team.alder.test");
      const free = await oldOrganization(store, "mail.gmail.com");
      await store.admin.identity.nameOrganization(alder, "Alder Works", { requestId: "k1b-refold-0001" });

      const before = lines(await snapshot(store.db));
      const dry = await store.writer.refoldOrganizations(seed.derive, { dryRun: true });
      expect(dry).toEqual({
        plan: { organizations: 3, after: 1, joined: [{ keep: alder, fold: [team] }], dropped: [free], moved: 2 },
        ignores: { rekeyed: 0, unmatched: 0, coarser: 0 },
        names: { rekeyed: 0, unmatched: 0, coarser: 0 },
        rederived: false,
        items: 0,
      });
      expect(lines(await snapshot(store.db))).toEqual(before);

      const done = await store.writer.refoldOrganizations(seed.derive, { dryRun: false });
      expect(done).toMatchObject({ plan: dry.plan, rederived: true });
      expect(done.items).toBeGreaterThan(0);
      expect((await domainRows(store)).map((one) => one.entity_id)).toEqual([alder]);
      const left = await queryAs<{ id: string }>(
        store.db.urls.admin,
        "select id from knowledge.entities where id = any($1)",
        [[team, free]],
      );
      expect(left).toEqual([]);
      // Ash keeps their id, and names the one organization, which keeps its name.
      const { token } = await store.admin.clients.addClient(registration("k1b-refold", ["own"]));
      expect(
        outcomeValue(await store.reader.getEntity(token, { id: seed.entityOf(ASH.address) })).organization?.id,
      ).toBe(alder);
      expect(outcomeValue(await store.reader.getEntity(token, { id: alder })).names).toEqual([
        { untrusted: "Alder Works" },
      ]);

      // Nothing is left to fold: the refold re-derives nothing.
      expect(await store.writer.refoldOrganizations(seed.derive, { dryRun: false })).toEqual({
        plan: { organizations: 1, after: 1, joined: [], dropped: [], moved: 0 },
        ignores: { rekeyed: 0, unmatched: 0, coarser: 0 },
        names: { rekeyed: 0, unmatched: 0, coarser: 0 },
        rederived: false,
        items: 0,
      });
    }));

  // A list update is simulated by rows keyed by an older fold. Under it `quarry.example.org` folded
  // to `example.org`; under the list now it is an organization of its own.
  it("a refold re-keys a domain ignore ruling to the new fold, so what it covered stays withheld through the re-derive", () =>
    withOrganizations(async (store, seed, accounts) => {
      const QUARRY = { address: "ash@quarry.example.org", name: "Ash Quarry" };
      await seed.mail(accounts.personalMail, { id: "k1b-rekey-ash", from: QUARRY, to: [owner], at: AT(1) });
      await seed.mail(accounts.personalMail, { id: "k1b-rekey-cy", from: CY, to: [owner], at: AT(2) });
      const fp = (domain: string): string => fingerprint(store.db.keys, "domain", domain);
      const old = fp("example.org");
      const now = fp("quarry.example.org");
      await queryAs(store.db.urls.admin, "update knowledge.accounts set domain_fp = $1 where domain_fp = $2", [
        old,
        now,
      ]);
      await queryAs(store.db.urls.admin, "update knowledge.domains set domain_fp = $1 where domain_fp = $2", [
        old,
        now,
      ]);
      // `example.org` folds to itself under both lists: the ruling's key is the old fold's.
      const ruling = await store.admin.ignores.addIgnore("domain", "example.org", { requestId: "k1b-rekey-0001" });
      // And one no stored account holds a key of.
      const never = await store.admin.ignores.addIgnore("domain", "never-written.test", {
        requestId: "k1b-rekey-0002",
      });
      const ash = seed.entityOf(QUARRY.address);
      const { token } = await store.admin.clients.addClient(registration("k1b-rekey", ["own"]));
      expect(await store.reader.getEntity(token, { id: ash })).toEqual({ ok: false, code: "not_found" });
      const keys = async (id: string) =>
        (
          await queryAs<{ value_fps: string[] }>(
            store.db.urls.admin,
            "select value_fps from knowledge.ignore_rulings where ruling_id = $1",
            [id],
          )
        )[0]?.value_fps;

      const before = lines(await snapshot(store.db));
      const dry = await store.writer.refoldOrganizations(seed.derive, { dryRun: true });
      expect(dry.ignores).toEqual({ rekeyed: 1, unmatched: 1, coarser: 0 });
      expect(lines(await snapshot(store.db))).toEqual(before);

      // An organization minted from a subdomain makes the refold re-derive, which keys every row
      // by the list now.
      await oldOrganization(store, "team.alder.test");
      const done = await store.writer.refoldOrganizations(seed.derive, { dryRun: false });
      expect(done).toMatchObject({ ignores: { rekeyed: 1, unmatched: 1, coarser: 0 }, rederived: true });
      const held = await queryAs<{ domain_fp: string }>(
        store.db.urls.admin,
        "select distinct domain_fp from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.id = $1",
        [ash],
      );
      expect(held).toEqual([{ domain_fp: now }]);
      // The ruling keeps its key and gains the new fold's; the other is as it was.
      expect(await keys(ruling)).toEqual([old, now]);
      expect(await keys(never)).toEqual([fp("never-written.test")]);
      expect(await store.reader.getEntity(token, { id: ash })).toEqual({ ok: false, code: "not_found" });
      const [quarry] = await queryAs<{ entity_id: string }>(
        store.db.urls.admin,
        "select entity_id from knowledge.domains where domain_fp = $1",
        [now],
      );
      expect(await store.reader.getEntity(token, { id: quarry?.entity_id as EntityId })).toEqual({
        ok: false,
        code: "not_found",
      });
      // The control: Cy, at a domain no ruling covers, is served.
      expect(outcomeValue(await store.reader.getEntity(token, { id: seed.entityOf(CY.address) })).id).toBe(
        seed.entityOf(CY.address),
      );

      // Nothing more to re-key.
      expect((await store.writer.refoldOrganizations(seed.derive, { dryRun: true })).ignores).toEqual({
        rekeyed: 0,
        unmatched: 1,
        coarser: 0,
      });
    }));

  // An organization's name is keyed by its folded domain, so a refold moves it to the new fold, as
  // it re-keys an ignore ruling. The same simulated list update.
  it("a refold moves the owner's name for an organization to the new fold, so get_entity still serves it", () =>
    withOrganizations(async (store, seed, accounts) => {
      const QUARRY = { address: "ash@quarry.example.org", name: "Ash Quarry" };
      await seed.mail(accounts.personalMail, { id: "k1-names-ash", from: QUARRY, to: [owner], at: AT(1) });
      await seed.mail(accounts.personalMail, { id: "k1-names-cy", from: CY, to: [owner], at: AT(2) });
      const fp = (domain: string): string => fingerprint(store.db.keys, "domain", domain);
      const old = fp("example.org");
      const now = fp("quarry.example.org");
      await queryAs(store.db.urls.admin, "update knowledge.accounts set domain_fp = $1 where domain_fp = $2", [
        old,
        now,
      ]);
      await queryAs(store.db.urls.admin, "update knowledge.domains set domain_fp = $1 where domain_fp = $2", [
        old,
        now,
      ]);
      const organizationOf = async (domainFp: string): Promise<EntityId> =>
        (
          await queryAs<{ entity_id: string }>(
            store.db.urls.admin,
            "select entity_id from knowledge.domains where domain_fp = $1",
            [domainFp],
          )
        )[0]?.entity_id as EntityId;
      const alder = await organizationOf(fp("alder.test"));
      await store.admin.identity.nameOrganization(await organizationOf(old), "Quarry Works", {
        requestId: "k1-names-0001",
      });
      // The control: a name whose key the new list keeps.
      await store.admin.identity.nameOrganization(alder, "Alder Works", { requestId: "k1-names-0002" });
      const keys = () =>
        queryAs<{ domain_fp: string }>(
          store.db.urls.admin,
          "select domain_fp from knowledge.organization_names where lifted_at is null order by created_at",
        );
      expect(await keys()).toEqual([{ domain_fp: old }, { domain_fp: fp("alder.test") }]);

      const before = lines(await snapshot(store.db));
      expect((await store.writer.refoldOrganizations(seed.derive, { dryRun: true })).names).toEqual({
        rekeyed: 1,
        unmatched: 0,
        coarser: 0,
      });
      expect(lines(await snapshot(store.db))).toEqual(before);

      await oldOrganization(store, "team.alder.test");
      const done = await store.writer.refoldOrganizations(seed.derive, { dryRun: false });
      expect(done).toMatchObject({ names: { rekeyed: 1, unmatched: 0, coarser: 0 }, rederived: true });
      expect(await keys()).toEqual([{ domain_fp: now }, { domain_fp: fp("alder.test") }]);
      const { token } = await store.admin.clients.addClient(registration("k1-names", ["own"]));
      expect(outcomeValue(await store.reader.getEntity(token, { id: await organizationOf(now) })).names).toEqual([
        { untrusted: "Quarry Works" },
      ]);
      expect(outcomeValue(await store.reader.getEntity(token, { id: alder })).names).toEqual([
        { untrusted: "Alder Works" },
      ]);
      // Nothing more to move.
      expect((await store.writer.refoldOrganizations(seed.derive, { dryRun: true })).names).toEqual({
        rekeyed: 0,
        unmatched: 0,
        coarser: 0,
      });
    }));

  // A new fold above an old key would widen an ignore or a name to every address under it, so
  // neither is re-keyed to it. And (invariant 11) an ignore left on its old key would lapse, so it
  // is narrowed to the addresses it covered, with a card for the owner; a name stays on its old
  // key. Simulated: rows keyed by `team.alder.test`, as if an older list made it a registrable
  // domain; under the list now it folds to `alder.test`, which also holds Cy.
  it("a refold narrows an ignore to the addresses it covered when the new fold is coarser, with a card, and leaves a name on its old key", () =>
    withOrganizations(async (store, seed, accounts) => {
      await seed.mail(accounts.personalMail, { id: "k1-coarse-ash", from: ASH, to: [owner], at: AT(1) });
      await seed.mail(accounts.personalMail, { id: "k1-coarse-cy", from: CY, to: [owner], at: AT(2) });
      const fp = (domain: string): string => fingerprint(store.db.keys, "domain", domain);
      const team = fp("team.alder.test");
      await queryAs(store.db.urls.admin, "update knowledge.accounts set domain_fp = $1 where value_fp = $2", [
        team,
        fingerprint(store.db.keys, "address", ASH.address),
      ]);
      const organization = (await oldOrganization(store, "team.alder.test")) as EntityId;
      await store.admin.identity.nameOrganization(organization, "Team Alder", { requestId: "k1-coarse-0001" });
      const ruling = await store.admin.ignores.addIgnore("domain", "alder.test", { requestId: "k1-coarse-0002" });
      await queryAs(store.db.urls.admin, "update knowledge.ignore_rulings set value_fps = $2 where ruling_id = $1", [
        ruling,
        [team],
      ]);

      const dry = await store.writer.refoldOrganizations(seed.derive, { dryRun: true });
      expect([dry.ignores, dry.names]).toEqual([
        { rekeyed: 1, unmatched: 0, coarser: 1 },
        { rekeyed: 0, unmatched: 0, coarser: 1 },
      ]);
      expect(await queryAs(store.db.urls.admin, "select id from ledger.cards")).toEqual([]);
      expect((await store.writer.refoldOrganizations(seed.derive, { dryRun: false })).rederived).toBe(true);
      // The ruling keeps its key and covers Ash by address, never alder.test, so Ash stays withheld,
      // Cy is not, and no name moved onto Cy's organization.
      const ash = fingerprint(store.db.keys, "address", ASH.address);
      expect(
        await queryAs(
          store.db.urls.admin,
          "select value_fps, address_fps from knowledge.ignore_rulings where ruling_id = $1",
          [ruling],
        ),
      ).toEqual([{ value_fps: [team], address_fps: [ash] }]);
      expect(
        await queryAs(
          store.db.urls.admin,
          "select domain_fp from knowledge.organization_names where lifted_at is null",
        ),
      ).toEqual([{ domain_fp: team }]);
      const { token } = await store.admin.clients.addClient(registration("k1-coarse", ["own"]));
      expect(await store.reader.getEntity(token, { id: seed.entityOf(ASH.address) })).toEqual({
        ok: false,
        code: "not_found",
      });
      expect(outcomeValue(await store.reader.getEntity(token, { id: seed.entityOf(CY.address) })).id).toBe(
        seed.entityOf(CY.address),
      );
      // One card for the owner, by system:identity, naming the ruling by id, and the new domain to
      // ignore as its body, from the address.
      const cards = await queryAs<{ id: CardId }>(store.db.urls.admin, "select id from ledger.cards");
      expect(
        await queryAs(store.db.urls.admin, "select kind, created_by, options, case_key, body_from from ledger.cards"),
      ).toEqual([
        {
          kind: "ignore_narrowed",
          created_by: "system:identity",
          options: ["acknowledge"],
          case_key: `ignore_narrowed:${ruling}`,
          body_from: "source",
        },
      ]);
      const opened = await store.admin.cards.card(cards[0]?.id as CardId);
      expect(asWords(opened?.lines ?? [])).toEqual(
        expect.arrayContaining([
          { text: `ruling: ${ruling}`, from: "code" },
          { text: "alder.test", from: "source" },
        ]),
      );
      // Nothing more to re-key, and the ruling is not counted as covering nothing stored.
      expect((await store.writer.refoldOrganizations(seed.derive, { dryRun: true })).ignores).toEqual({
        rekeyed: 0,
        unmatched: 0,
        coarser: 0,
      });
    }));

  // A name left on its key holds it. A name with no stored holder is left on `quarry.example.org`;
  // an older name whose holders now fold there would move onto it, and a second live name on one
  // key fails the re-derive.
  it("a refold leaves a name on its key when a live name that stays already holds its new fold", () =>
    withOrganizations(async (store, seed, accounts) => {
      const QUARRY = { address: "ash@quarry.example.org", name: "Ash Quarry" };
      await seed.mail(accounts.personalMail, { id: "k1-held-ash", from: QUARRY, to: [owner], at: AT(1) });
      const fp = (domain: string): string => fingerprint(store.db.keys, "domain", domain);
      const old = fp("example.org");
      const now = fp("quarry.example.org");
      await queryAs(store.db.urls.admin, "update knowledge.accounts set domain_fp = $1 where domain_fp = $2", [
        old,
        now,
      ]);
      await queryAs(store.db.urls.admin, "update knowledge.domains set domain_fp = $1 where domain_fp = $2", [
        old,
        now,
      ]);
      const [moving] = await queryAs<{ entity_id: string }>(
        store.db.urls.admin,
        "select entity_id from knowledge.domains where domain_fp = $1",
        [old],
      );
      await store.admin.identity.nameOrganization(moving?.entity_id as EntityId, "Quarry Works", {
        requestId: "k1-held-0001",
      });
      // A newer name on the new fold, which no stored account holds.
      await store.admin.identity.nameOrganization(
        (await oldOrganization(store, "quarry.example.org")) as EntityId,
        "Quarry Old",
        { requestId: "k1-held-0002" },
      );
      const keys = () =>
        queryAs<{ domain_fp: string }>(
          store.db.urls.admin,
          "select domain_fp from knowledge.organization_names where lifted_at is null order by created_at",
        );
      expect(await keys()).toEqual([{ domain_fp: old }, { domain_fp: now }]);

      expect((await store.writer.refoldOrganizations(seed.derive, { dryRun: true })).names).toEqual({
        rekeyed: 0,
        unmatched: 2,
        coarser: 0,
      });
      await oldOrganization(store, "team.alder.test");
      expect(await store.writer.refoldOrganizations(seed.derive, { dryRun: false })).toMatchObject({
        names: { rekeyed: 0, unmatched: 2, coarser: 0 },
        rederived: true,
      });
      expect(await keys()).toEqual([{ domain_fp: old }, { domain_fp: now }]);
    }));

  // Two names swapping keys in one refold. B is keyed `example.org`, whose
  // holders now fold to `quarry.example.org`; A is keyed `org`, whose holder now folds to
  // `example.org`. A, the newer, moves onto B's key while B moves away.
  it("a refold moves two names when one moves onto the key the other leaves", () =>
    withOrganizations(async (store, seed, accounts) => {
      const EX = { address: "ex@example.org", name: "Ex Ample" };
      const QUARRY = { address: "ash@quarry.example.org", name: "Ash Quarry" };
      await seed.mail(accounts.personalMail, { id: "k1-swap-quarry", from: QUARRY, to: [owner], at: AT(1) });
      await seed.mail(accounts.personalMail, { id: "k1-swap-ex", from: EX, to: [owner], at: AT(2) });
      const fp = (domain: string): string => fingerprint(store.db.keys, "domain", domain);
      for (const [from, to] of [
        [fp("example.org"), fp("org")],
        [fp("quarry.example.org"), fp("example.org")],
      ] as const) {
        await queryAs(store.db.urls.admin, "update knowledge.accounts set domain_fp = $1 where domain_fp = $2", [
          to,
          from,
        ]);
        await queryAs(store.db.urls.admin, "update knowledge.domains set domain_fp = $1 where domain_fp = $2", [
          to,
          from,
        ]);
      }
      const orgOf = async (domainFp: string): Promise<EntityId> =>
        (
          await queryAs<{ entity_id: string }>(
            store.db.urls.admin,
            "select entity_id from knowledge.domains where domain_fp = $1",
            [domainFp],
          )
        )[0]?.entity_id as EntityId;
      await store.admin.identity.nameOrganization(await orgOf(fp("example.org")), "Quarry Works", {
        requestId: "k1-swap-0001",
      });
      await store.admin.identity.nameOrganization(await orgOf(fp("org")), "Example Org", { requestId: "k1-swap-0002" });

      expect((await store.writer.refoldOrganizations(seed.derive, { dryRun: true })).names).toEqual({
        rekeyed: 2,
        unmatched: 0,
        coarser: 0,
      });
      await oldOrganization(store, "team.alder.test");
      expect(await store.writer.refoldOrganizations(seed.derive, { dryRun: false })).toMatchObject({
        names: { rekeyed: 2, unmatched: 0, coarser: 0 },
        rederived: true,
      });
      const { token } = await store.admin.clients.addClient(registration("k1-swap", ["own"]));
      const nameOf = async (domain: string) =>
        outcomeValue(await store.reader.getEntity(token, { id: await orgOf(fp(domain)) })).names;
      expect(await nameOf("quarry.example.org")).toEqual([{ untrusted: "Quarry Works" }]);
      expect(await nameOf("example.org")).toEqual([{ untrusted: "Example Org" }]);
    }));
});
