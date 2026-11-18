import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mention } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type EntityId,
  FiledMention,
  type MentionBindingId,
  type MentionId,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { allRulings } from "../core/identity-rulings.ts";
import { openRow } from "../core/seal.ts";
import { QUENTIN, SOLO, WORK_ONLY } from "../test-support/cast.ts";
import { MENTION_TABLES } from "../test-support/catalogue.ts";
import { insertClient } from "../test-support/clients.ts";
import { one, readAs, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import {
  batchOf,
  beliefsComputed,
  claimRecord,
  countOf,
  type PipelineStore,
  rowsOf,
  stored,
  withPipeline,
} from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { lines, snapshot } from "../test-support/snapshot.ts";

// The filed mentions and the owner's bindings, through the Pipeline as pi_pipeline and the Admin as
// pi_admin. Each refusal has its positive control in the same test.

const TIMEOUT = 240_000;
const at = "2026-09-01T09:00:00.000Z";
const nameOf = (value: string): Mention => ({ key: { kind: "name", value }, observedAt: at }) as Mention;
const filed = (name: string, field = "subject") => FiledMention.parse({ name, type: "role", field });
// The support of each belief `own` is given now, by stored claim id: computed when asked.
const supports = async (db: PipelineStore["db"]): Promise<string[][]> =>
  (await beliefsComputed(db, ["own"], BELIEF_TYPES, new Date().toISOString())).map((one) =>
    one.belief.support.map((id) => fingerprint(db.keys, "claim", id)).sort(),
  );

type World = PipelineStore & { admin: Admin; quentin: EntityId; solo: EntityId; item: string };

// The canary message, the owner's reply (written to Quentin), Quentin's own and Solo's: Quentin and
// Solo have aliases of their names, and only Quentin is established.
async function withMentions<T>(fn: (world: World) => Promise<T>): Promise<T> {
  return withPipeline(async (store) => {
    const { writer, accounts, db } = store;
    await stored(writer, accounts.personalMail, MAIL.canary);
    await stored(writer, accounts.personalMail, MAIL.reply);
    await stored(writer, accounts.personalMail, MAIL.fromQuentin);
    const item = await stored(writer, accounts.personalMail, MAIL.solo);
    const entityOf = async (address: string) =>
      one(
        await rowsOf<{ entity_id: EntityId }>(db, "select entity_id from knowledge.accounts where value_fp = $1", [
          fingerprint(db.keys, "address", address),
        ]),
      ).entity_id;
    // A journal of its own, for the erasure.
    const folder = await mkdtemp(join(tmpdir(), "pi-mentions-"));
    const admin = createAdmin({
      url: db.urls.admin,
      keys: db.keys,
      log: recordingLogger().log,
      journal: join(folder, "keys.json.erasures"),
    });
    try {
      return await fn({
        ...store,
        admin,
        quentin: await entityOf(QUENTIN.address),
        solo: await entityOf(SOLO.address),
        item,
      });
    } finally {
      await admin.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
}

const mentionsOf = (world: World, evidenceId = world.item) =>
  rowsOf<{ id: MentionId; name_fp: string; compartments: string[]; facts_enc: unknown; extractor_generation: number }>(
    world.db,
    "select id, name_fp, compartments, facts_enc, extractor_generation from vault.unresolved_mentions where evidence_id = $1 order by id",
    [evidenceId],
  );

const statusOf = async (world: World, evidenceId: string) => {
  const row = one(
    await rowsOf<{ waiting: boolean; facts_enc: unknown; compartments: string[] }>(
      world.db,
      "select waiting, facts_enc, compartments from vault.pipeline_items where evidence_id = $1",
      [evidenceId],
    ),
  );
  return {
    waiting: row.waiting,
    facts: JSON.parse(
      openRow(
        world.db.keys,
        row.compartments[0] ?? "",
        { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
        row.facts_enc as never,
      ),
    ) as Record<string, unknown>,
  };
};

const refused = (call: Promise<unknown>): Promise<string | undefined> =>
  call.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );

// The two people's display names, as their aliases hold them.
const QUENTIN_NAME = QUENTIN.name ?? "";
const SOLO_NAME = SOLO.name ?? "";

const req = (): string => `req_${Math.random().toString(36).slice(2, 12)}`;

// One saved call for the item, as a run saves it.
async function saveCall(world: World, evidenceId: string, mark: string): Promise<void> {
  await world.pipeline.calls("configured/model").save({
    key: {
      evidenceId,
      revision: 0,
      extractorGeneration: 1,
      promptId: "personal_correspondence",
      promptVersion: "2",
      inputHash: mark.repeat(64),
    },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput: JSON.stringify({ claims: [], narrowing: "none" }),
    outputHash: "b".repeat(64),
    label: { compartments: ["own"], readers: ["m-owner"] },
    origin: "live",
  } as never);
}

// A filed mention of each name in the item, through the Pipeline's commit.
async function file(world: World, names: string[], evidenceId = world.item): Promise<MentionId[]> {
  expect(
    await world.pipeline.commit(
      batchOf(evidenceId, [], { unresolved: names.length, mentions: names.map((name) => filed(name)) }),
    ),
  ).toBe("committed");
  return (await mentionsOf(world, evidenceId)).map((row) => row.id);
}

describe("the two tables", { timeout: TIMEOUT }, () => {
  it("the clear columns of each new table are exactly those listed, and no foreign key cascades", () =>
    withMentions(async ({ db }) => {
      const columns = await queryAs<{ table: string; column: string }>(
        db.urls.admin,
        `select table_schema || '.' || table_name as "table", column_name as "column" from information_schema.columns
         where table_schema || '.' || table_name = any($1) order by 1, 2`,
        [[...MENTION_TABLES]],
      );
      const of = (table: string) => columns.filter((one) => one.table === table).map((one) => one.column);
      expect(of("vault.unresolved_mentions")).toEqual([
        "compartments",
        "evidence_id",
        "extractor_generation",
        "facts_enc",
        "first_hand",
        "has_speaker",
        "id",
        "name_fp",
        "relation",
      ]);
      // `origin`: owner or code.
      expect(of("knowledge.mention_bindings")).toEqual([
        "address_fp",
        "compartments",
        "created_at",
        "evidence_id",
        "id",
        "lifted_at",
        "mention_fp",
        "origin",
        "ruling_id",
      ]);
      const keys = await queryAs<{ table: string; action: string }>(
        db.urls.admin,
        `select conrelid::regclass::text as "table", confdeltype::text as action from pg_constraint
         where contype = 'f' and conrelid::regclass::text = any($1) order by 1`,
        [[...MENTION_TABLES]],
      );
      // The filed mention's evidence and the binding's decision; the binding has no key to evidence.
      expect(keys).toEqual([
        { table: "knowledge.mention_bindings", action: "a" },
        { table: "vault.unresolved_mentions", action: "a" },
      ]);
    }));

  it("pi_reader cannot read vault.unresolved_mentions or knowledge.mention_bindings, whatever its clearance", () =>
    withMentions(async (world) => {
      const [mention] = await file(world, [QUENTIN_NAME]);
      await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() });
      const client = await insertClient(world.db, "wide-reader", ["own", "employer:example"]);
      for (const table of MENTION_TABLES) {
        expect(
          await sqlState(() => readAs(world.db, client.token, (query) => query(`select id from ${table}`))),
          table,
        ).toBe("42501");
        // The positive control: the admin's same statement reads its row.
        expect(await queryAs(world.db.urls.admin, `select id from ${table}`), `control: ${table}`).toHaveLength(1);
      }
    }));

  it("the pipeline files and removes mentions and reads bindings, and writes no binding; the writer removes filed mentions and no binding", () =>
    withMentions(async (world) => {
      const { db } = world;
      const [mention] = await file(world, [QUENTIN_NAME]);
      const binding = await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() });
      expect(await sqlState(() => queryAs(db.urls.pipeline, "select id from knowledge.mention_bindings"))).toBeNull();
      expect(
        await sqlState(() =>
          queryAs(db.urls.pipeline, "delete from knowledge.mention_bindings where id = $1", [binding]),
        ),
      ).toBe("42501");
      expect(
        await sqlState(() =>
          queryAs(db.urls.pipeline, "update knowledge.mention_bindings set lifted_at = now() where id = $1", [binding]),
        ),
      ).toBe("42501");
      expect(
        await sqlState(() => queryAs(db.urls.pipeline, "update vault.unresolved_mentions set name_fp = name_fp")),
      ).toBe("42501");
      expect(
        await sqlState(() =>
          queryAs(db.urls.pipeline, "delete from vault.unresolved_mentions where evidence_id = $1", [world.item]),
        ),
      ).toBeNull();
      // A binding outlives a deletion: the writer may not delete or lift one (only an erasure, as
      // pi_admin). It reads them and inserts its own code bindings alone. It may delete a live
      // code binding of a source moment alone, so its delete of an owner's binding removes nothing.
      expect(
        await queryAs(db.urls.writer, "delete from knowledge.mention_bindings where id = $1 returning id", [binding]),
      ).toEqual([]);
      expect(
        await queryAs(db.urls.admin, "select id from knowledge.mention_bindings where id = $1", [binding]),
      ).toEqual([{ id: binding }]);
      expect(
        await sqlState(() =>
          queryAs(db.urls.writer, "update knowledge.mention_bindings set lifted_at = now() where id = $1", [binding]),
        ),
      ).toBe("42501");
      expect(await sqlState(() => queryAs(db.urls.writer, "select id from knowledge.mention_bindings"))).toBeNull();
      // Never an owner's binding, nor one already lifted.
      const forged =
        "insert into knowledge.mention_bindings (id, ruling_id, evidence_id, mention_fp, address_fp, created_at, compartments, origin, lifted_at) values ($1, $2, $3, $4, $4, now(), '{own}', $5, $6)";
      const fp = "a".repeat(64);
      expect(
        await sqlState(() =>
          queryAs(db.urls.writer, forged, ["mbd_01JMEETNGS0000000000000001", null, world.item, fp, "owner", null]),
        ),
      ).not.toBeNull();
      expect(
        await sqlState(() =>
          queryAs(db.urls.writer, forged, [
            "mbd_01JMEETNGS0000000000000002",
            null,
            world.item,
            fp,
            "code",
            "2026-09-01T00:00:00Z",
          ]),
        ),
      ).not.toBeNull();
      // The positive control: a code binding.
      expect(
        await sqlState(() =>
          queryAs(db.urls.writer, forged, ["mbd_01JMEETNGS0000000000000003", null, world.item, fp, "code", null]),
        ),
      ).toBeNull();
      expect(await countOf(db, "knowledge.mention_bindings")).toBe(2);
      expect(await sqlState(() => queryAs(db.urls.writer, "delete from vault.unresolved_mentions"))).toBeNull();
    }));
});

describe("filing", { timeout: TIMEOUT }, () => {
  it("a commit files each mention under the item's label, its name sealed and its fingerprint clear", () =>
    withMentions(async (world) => {
      await file(world, [QUENTIN_NAME, "Nobody Atall"]);
      const rows = await mentionsOf(world);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.compartments).toEqual(["own"]);
        expect(row.extractor_generation).toBe(1);
        const facts = FiledMention.parse(
          JSON.parse(
            openRow(
              world.db.keys,
              "own",
              { table: "vault.unresolved_mentions", id: row.id, column: "facts_enc" },
              row.facts_enc as never,
            ),
          ),
        );
        expect(row.name_fp).toBe(fingerprint(world.db.keys, "name", facts.name));
        expect(JSON.stringify(row.facts_enc)).not.toContain(facts.name);
      }
    }));

  it("a retried item's filed mentions are replaced, not added, and a commit with none removes them", () =>
    withMentions(async (world) => {
      const first = await file(world, [QUENTIN_NAME]);
      const again = await file(world, [QUENTIN_NAME]);
      expect(again).toHaveLength(1);
      expect(again).not.toEqual(first);
      expect(await world.pipeline.commit(batchOf(world.item, [], { status: "skipped", code: "bulk" }))).toBe(
        "committed",
      );
      expect(await mentionsOf(world)).toEqual([]);
    }));

  it("a deleted message and a new revision leave no filed mention", () =>
    withMentions(async (world) => {
      const { writer, accounts } = world;
      const quentin = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      await file(world, [SOLO_NAME]);
      await file(world, [SOLO_NAME], quentin);
      await writer.applyDeletion(accounts.personalMail, {
        sourceAccount: accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.fromQuentin),
      } as never);
      expect(await mentionsOf(world, quentin)).toEqual([]);
      // The new revision of Solo's message: the earlier one's filed mention goes with its claims.
      expect(await mentionsOf(world)).toHaveLength(1);
      await writer.ingestItem(
        accounts.personalMail,
        mailRevision(MAIL.soloAgain, accounts.personalMail),
        mailFacts(MAIL.soloAgain),
      );
      expect(await mentionsOf(world)).toEqual([]);
    }));
});

describe("candidates and the binding", { timeout: TIMEOUT }, () => {
  it("a filed mention whose name matches an established person is listed first; one that matches nobody is not listed", () =>
    withMentions(async (world) => {
      const ids = await file(world, ["Nobody Atall", SOLO_NAME, QUENTIN_NAME, QUENTIN_NAME]);
      const listed = await world.admin.mentions.listMentions();
      expect(listed.map(({ entity, established, count }) => ({ entity, established, count }))).toEqual([
        { entity: world.quentin, established: true, count: 2 },
        { entity: world.solo, established: false, count: 1 },
      ]);
      expect(listed.map((one) => one.name.untrusted)).toEqual([QUENTIN_NAME, SOLO_NAME]);
      expect(ids).toContain(listed[0]?.mention);
      expect(await world.admin.mentions.listMentions({ limit: 1 })).toHaveLength(1);
      expect(await refused(world.admin.mentions.listMentions({ limit: 0 }))).toBe("invalid_argument");
      // A name bound in that item is not listed again.
      await world.admin.mentions.bindMention(listed[0]?.mention as MentionId, world.quentin, { requestId: req() });
      expect((await world.admin.mentions.listMentions()).map((one) => one.entity)).toEqual([world.solo]);
    }));

  it("bind writes its decision and binding, and sets the item waiting with its saved call kept, removing nothing", () =>
    withMentions(async (world) => {
      const { db, pipeline, owner, item } = world;
      const claim = claimRecord(item, "own", owner, { entities: [world.solo] });
      expect(await pipeline.commit(batchOf(item, [claim], { unresolved: 1, mentions: [filed(QUENTIN_NAME)] }))).toBe(
        "committed",
      );
      await saveCall(world, item, "a");
      const [mention] = (await mentionsOf(world)).map((row) => row.id);
      const binding = await world.admin.mentions.bindMention(mention as MentionId, world.quentin, {
        requestId: "bind-mntn-0001",
      });
      const row = one(
        await rowsOf<{
          ruling_id: string;
          evidence_id: string;
          mention_fp: string;
          address_fp: string;
          lifted_at: Date | null;
          compartments: string[];
        }>(db, "select * from knowledge.mention_bindings where id = $1", [binding]),
      );
      expect(row).toMatchObject({
        evidence_id: item,
        mention_fp: fingerprint(db.keys, "name", QUENTIN_NAME),
        address_fp: fingerprint(db.keys, "address", QUENTIN.address),
        lifted_at: null,
        compartments: ["own"],
      });
      expect(
        one(
          await rowsOf<{ kind: string; request_id: string }>(
            db,
            "select kind, request_id from knowledge.owner_decisions where id = $1",
            [row.ruling_id],
          ),
        ),
      ).toEqual({ kind: "mention_bind", request_id: "bind-mntn-0001" });
      // No claim could stand on the name: the item's claims and beliefs are as they were.
      expect(await countOf(db, "knowledge.claims", "evidence_id = $1", [item])).toBe(1);
      expect(await supports(db)).toHaveLength(1);
      expect(await countOf(db, "vault.model_calls", "evidence_id = $1", [item])).toBe(1);
      expect(await statusOf(world, item)).toMatchObject({
        waiting: true,
        facts: { status: "waiting", attempts: 0, unresolved: 1 },
      });
      // A repeat of the request returns the binding and writes nothing.
      const before = lines(await snapshot(db));
      expect(
        await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: "bind-mntn-0001" }),
      ).toBe(binding);
      expect(lines(await snapshot(db))).toEqual(before);
    }));

  it("unbind removes the item's claims that name the bound person, with their beliefs, and leaves its other claims; the item waits with its call kept", () =>
    withMentions(async (world) => {
      const { db, pipeline, owner, item } = world;
      const [mention] = await file(world, [QUENTIN_NAME]);
      const binding = await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() });
      // What the run after the bind commits: a claim naming Quentin, and one naming Solo alone.
      const naming = claimRecord(item, "own", owner, { n: 1, entities: [world.quentin] });
      const other = claimRecord(item, "own", owner, { n: 2, entities: [world.solo] });
      expect(await pipeline.commit(batchOf(item, [naming, other]))).toBe("committed");
      await saveCall(world, item, "e");
      expect(await world.admin.mentions.unbindMention(binding, { requestId: req() })).toBe(true);
      // The store keeps a claim under its own id, not the record's: the one left is Solo's.
      const left = (
        await rowsOf<{ id: string }>(db, "select id from knowledge.claims where evidence_id = $1", [item])
      ).map((one) => one.id);
      expect(left).toHaveLength(1);
      expect(
        await rowsOf<{ claim_id: string; entity_id: string }>(
          db,
          "select claim_id, entity_id from knowledge.claim_entities",
        ),
      ).toEqual([{ claim_id: left[0], entity_id: world.solo }]);
      expect(await supports(db)).toEqual([left]);
      expect(await countOf(db, "vault.model_calls", "evidence_id = $1", [item])).toBe(1);
      expect((await statusOf(world, item)).waiting).toBe(true);
    }));

  it("bind refuses what it cannot bind, and a second binding of the name in that item is already_settled", () =>
    withMentions(async (world) => {
      const { writer, accounts, owner } = world;
      const [mention] = await file(world, [QUENTIN_NAME]);
      await stored(writer, accounts.workMail, MAIL.workOnly);
      const workOnly = one(
        await rowsOf<{ entity_id: EntityId }>(
          world.db,
          "select entity_id from knowledge.accounts where value_fp = $1",
          [fingerprint(world.db.keys, "address", WORK_ONLY.address)],
        ),
      ).entity_id;
      const before = lines(await snapshot(world.db));
      expect(
        await refused(
          world.admin.mentions.bindMention(`umn_${"0".repeat(26)}` as MentionId, world.quentin, { requestId: req() }),
        ),
      ).toBe("not_found");
      expect(
        await refused(
          world.admin.mentions.bindMention(mention as MentionId, `ent_${"0".repeat(26)}` as EntityId, {
            requestId: req(),
          }),
        ),
      ).toBe("not_found");
      expect(
        await refused(world.admin.mentions.bindMention(mention as MentionId, owner as EntityId, { requestId: req() })),
      ).toBe("not_a_person");
      // A person with no account under the item's compartment: the port could never resolve to them.
      expect(
        await refused(world.admin.mentions.bindMention(mention as MentionId, workOnly, { requestId: req() })),
      ).toBe("compartment_mismatch");
      expect(lines(await snapshot(world.db))).toEqual(before);
      const binding = await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() });
      const second = await world.admin.mentions
        .bindMention(mention as MentionId, world.solo, { requestId: req() })
        .then(
          () => undefined,
          (error: { code?: string; rulings?: string[] }) => error,
        );
      expect(second).toMatchObject({ code: "already_settled", rulings: [binding] });
    }));

  it("a bind to a person whose every address another person holds is shared_address; a bound address two people hold resolves nobody", () =>
    withMentions(async (world) => {
      const { db, pipeline, item } = world;
      const [mention] = await file(world, [QUENTIN_NAME]);
      const binding = await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() });
      const ask = async () =>
        (await pipeline.open(item as never))?.context.identity.resolve(nameOf(QUENTIN_NAME), "personal", "r" as never);
      expect(await ask()).toEqual({ outcome: "linked", entity: world.quentin, epoch: 0 });
      // Solo comes to hold Quentin's address too, under the same compartment.
      await queryAs(
        db.urls.admin,
        `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments)
         select $1, $2, kind, value_fp, domain_fp, value_enc, compartments from knowledge.accounts where value_fp = $3 and compartments = '{own}'`,
        [`adr_${"0".repeat(25)}9`, world.solo, fingerprint(db.keys, "address", QUENTIN.address)],
      );
      expect(await ask()).toEqual({ outcome: "not_a_person" });
      // A bind to Quentin now, whose one address Solo holds, is refused; to Solo, whose own address
      // nobody else holds, it is made.
      expect(await world.admin.mentions.unbindMention(binding, { requestId: req() })).toBe(true);
      expect(
        await refused(world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() })),
      ).toBe("shared_address");
      const toSolo = await world.admin.mentions.bindMention(mention as MentionId, world.solo, { requestId: req() });
      expect(
        one(
          await rowsOf<{ address_fp: string }>(db, "select address_fp from knowledge.mention_bindings where id = $1", [
            toSolo,
          ]),
        ).address_fp,
      ).toBe(fingerprint(db.keys, "address", SOLO.address));
    }));

  it("the port resolves a bound name in that item only, under its compartment, to the bound person; unbound, to nobody", () =>
    withMentions(async (world) => {
      const { pipeline, writer, accounts, item } = world;
      const other = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const [mention] = await file(world, [QUENTIN_NAME]);
      const ask = async (evidenceId: string, name: string) =>
        (await pipeline.open(evidenceId as never))?.context.identity.resolve(nameOf(name), "personal", "r" as never);
      expect(await ask(item, QUENTIN_NAME)).toEqual({ outcome: "not_a_person" });
      const binding = await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() });
      // The model's spelling of the name, in another case and spacing, has the same fingerprint.
      expect(await ask(item, ` quentin  LAMPWICK `)).toEqual({ outcome: "linked", entity: world.quentin, epoch: 0 });
      const opened = await pipeline.open(item as never);
      await opened?.context.identity.resolve(nameOf(QUENTIN_NAME), "personal", "r" as never);
      expect(opened?.kindOf(world.quentin as never)).toBe("person");
      // Another item, and another name in this one, are nobody.
      expect(await ask(other, QUENTIN_NAME)).toEqual({ outcome: "not_a_person" });
      expect(await ask(item, SOLO_NAME)).toEqual({ outcome: "not_a_person" });
      expect(await world.admin.mentions.unbindMention(binding, { requestId: req() })).toBe(true);
      expect(await ask(item, QUENTIN_NAME)).toEqual({ outcome: "not_a_person" });
    }));

  it("unbind from A and bind to B before any run: the port answers B", () =>
    withMentions(async (world) => {
      const [mention] = await file(world, [QUENTIN_NAME]);
      const toA = await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() });
      expect(await world.admin.mentions.unbindMention(toA, { requestId: "unbind-mntn-0001" })).toBe(true);
      expect(await world.admin.mentions.unbindMention(toA, { requestId: "unbind-mntn-0001" })).toBe(true);
      expect(await world.admin.mentions.unbindMention(toA, { requestId: req() })).toBe(false);
      expect(
        one(
          await rowsOf<{ kind: string; supersedes: string }>(
            world.db,
            "select kind, supersedes from knowledge.owner_decisions where request_id = 'unbind-mntn-0001'",
          ),
        ),
      ).toMatchObject({ kind: "mention_unbind" });
      await world.admin.mentions.bindMention(mention as MentionId, world.solo, { requestId: req() });
      const opened = await world.pipeline.open(world.item as never);
      expect(await opened?.context.identity.resolve(nameOf(QUENTIN_NAME), "personal", "r" as never)).toEqual({
        outcome: "linked",
        entity: world.solo,
        epoch: 0,
      });
      expect(
        await world.admin.mentions.unbindMention(`mbd_${"0".repeat(26)}` as MentionBindingId, { requestId: req() }),
      ).toBe(false);
    }));

  it("bind, unbind and refile while a run holds the extract lock are extract_running and change nothing", () =>
    withMentions(async (world) => {
      const [mention] = await file(world, [QUENTIN_NAME]);
      const binding = await world.admin.mentions.bindMention(mention as MentionId, world.solo, { requestId: req() });
      expect(await world.admin.mentions.unbindMention(binding, { requestId: req() })).toBe(true);
      const before = lines(await snapshot(world.db));
      // The run's lock on the pipeline's connection, the commands on the admin's.
      const codes = await world.pipeline.withExtractLock(async () => [
        await refused(world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() })),
        await refused(world.admin.mentions.unbindMention(binding, { requestId: req() })),
        await refused(world.admin.mentions.refileMentions()),
      ]);
      expect(codes).toEqual(["extract_running", "extract_running", "extract_running"]);
      expect(lines(await snapshot(world.db))).toEqual(before);
      // The positive control: once the run gives the lock back, the bind is made.
      expect(await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() })).toMatch(
        /^mbd_/,
      );
    }));

  it("refile sets each done item of a naming lane with a saved call and an unresolved candidate waiting, its calls kept, and no other", () =>
    withMentions(async (world) => {
      const { pipeline, writer, accounts, db, item } = world;
      const quentin = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const reply = await stored(writer, accounts.personalMail, MAIL.reply);
      // Solo's: done with an unresolved candidate and a saved call, so refiled.
      expect(await pipeline.commit(batchOf(item, [], { unresolved: 1 }))).toBe("committed");
      await saveCall(world, item, "c");
      // Quentin's: done with every candidate resolved; the canary's: failed; the reply's: no call.
      expect(await pipeline.commit(batchOf(quentin, [], { unresolved: 0 }))).toBe("committed");
      await saveCall(world, quentin, "d");
      expect(
        await pipeline.commit(batchOf(canary, [], { status: "failed", code: "model_refused_item", unresolved: 1 })),
      ).toBe("committed");
      await saveCall(world, canary, "e");
      expect(await pipeline.commit(batchOf(reply, [], { unresolved: 1 }))).toBe("committed");
      expect(await world.admin.mentions.refileMentions()).toEqual({ items: 1 });
      expect((await statusOf(world, item)).waiting).toBe(true);
      for (const id of [quentin, canary, reply]) expect((await statusOf(world, id)).waiting, id).toBe(false);
      expect(await countOf(db, "vault.model_calls")).toBe(3);
    }));

  it("a binding moves no row and joins no group", () =>
    withMentions(async (world) => {
      const [mention] = await file(world, [QUENTIN_NAME]);
      const kept = [
        "knowledge.entities",
        "knowledge.accounts",
        "knowledge.aliases",
        "knowledge.interaction_log",
        "knowledge.identity_rulings",
        "knowledge.contacts",
        "knowledge.contact_addresses",
      ];
      const rowsOfKept = async () =>
        lines(await snapshot(world.db)).filter((line) => kept.some((table) => line.startsWith(`${table} `)));
      const before = await rowsOfKept();
      const rulings = await session(world.db.urls.admin, (query) => allRulings(query));
      await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() });
      expect(await rowsOfKept()).toEqual(before);
      expect(await session(world.db.urls.admin, (query) => allRulings(query))).toEqual(rulings);
    }));
});

describe("the erasure", { timeout: TIMEOUT }, () => {
  it("erasing a person deletes their bindings, counted in more; a dry run only counts", () =>
    withMentions(async (world) => {
      const [mention] = await file(world, [QUENTIN_NAME]);
      await world.admin.mentions.bindMention(mention as MentionId, world.quentin, { requestId: req() });
      const dry = await world.admin.erasure.erasePerson(world.quentin, { requestId: req(), dryRun: true });
      expect(dry.more.mention_bindings).toBe(1);
      expect(await countOf(world.db, "knowledge.mention_bindings")).toBe(1);
      const report = await world.admin.erasure.erasePerson(world.quentin, { requestId: req() });
      expect(report.more.mention_bindings).toBe(1);
      expect(await countOf(world.db, "knowledge.mention_bindings")).toBe(0);
      // The decision behind it stays, holding ids only.
      expect(await countOf(world.db, "knowledge.owner_decisions", "kind = 'mention_bind'")).toBe(1);
    }));
});
