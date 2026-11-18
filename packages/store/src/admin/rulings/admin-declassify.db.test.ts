import type { SourceDeletion } from "@intelligence/contracts";
import { type FactId, FactView, type RulingId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CANARY_PERSON, OWNER } from "../../test-support/cast.ts";
import { insertClient, revokeClient, testId } from "../../test-support/clients.ts";
import { one } from "../../test-support/connections.ts";
import {
  admin,
  commit,
  commitment,
  copies,
  entityOf,
  finder,
  inWorld,
  stored,
  type World,
} from "../../test-support/declassified-fixtures.ts";
import { mailSourceId } from "../../test-support/items.ts";
import { MAIL } from "../../test-support/items-named.ts";
import { opened } from "../../test-support/snapshot.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { holdingLock as holding, outcome, pending } from "../../test-support/waits.ts";
import { createAdmin } from "../admin.ts";

// The owner's declassification and its revocation. Each refusal has its positive control in the
// same test. The tests on two connections follow pipeline-locks.db.test.ts.

const BELIEFS = "select pg_advisory_xact_lock(hashtext('intelligence personal beliefs'))";
const TABLE = "projections.declassified_facts";
const req = (): string => testId("req");

const count = async (world: World, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(world, `select count(*)::int as n from ${table} where ${where}`, values)).n;

// What a refused declassification must leave as it was.
const written = async (world: World): Promise<number[]> => [
  await count(world, TABLE),
  await count(world, "knowledge.owner_decisions"),
];

// One claim of `own` on the canary's message, committed.
async function oneClaim(
  world: World,
  options: Parameters<typeof commitment>[3] = {},
): Promise<{ claim: FactId; evidence: string }> {
  const evidence = await stored(world, MAIL.canary);
  const [claim] = await commit(world, evidence, [commitment(world, evidence, "own", options)]);
  if (claim === undefined) throw new Error("no claim");
  return { claim, evidence };
}

type CopyRow = {
  id: string;
  ruling_id: string;
  claim_fp: string;
  evidence_id: string;
  type: string;
  valid_from: Date;
  fact_enc: unknown;
  compartments: string[];
};
const copyOf = async (world: World, claim: string): Promise<CopyRow> =>
  one(await admin<CopyRow>(world, `select * from ${TABLE} where claim_fp = $1`, [claim]));
const openCopy = (world: World, row: CopyRow, compartment = "declassified"): string =>
  opened(world.store.db, compartment, { table: TABLE, id: row.id, column: "fact_enc" }, row.fact_enc);

describe("declassify", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a declassified fact is one row under declassified alone, sealed under its key, and its claim and label are unchanged", () =>
    inWorld(async (world) => {
      const { claim, evidence } = await oneClaim(world);
      const before = await admin<{ xmin: string; compartments: string[] }>(
        world,
        "select xmin::text, compartments from knowledge.claims where id = $1",
        [claim],
      );
      const ruling = await world.admin.releases.declassify(claim, { requestId: req() });
      expect(await copies(world)).toEqual([claim]);
      const row = await copyOf(world, claim);
      expect(row).toMatchObject({
        ruling_id: ruling,
        evidence_id: evidence,
        type: "commitment",
        compartments: ["declassified"],
      });
      expect(row.id).toMatch(/^dcl_/);
      const fact = FactView.parse(JSON.parse(openCopy(world, row)));
      expect(fact).toMatchObject({
        id: claim,
        type: "commitment",
        message: null,
        thirdParty: false,
        agentReported: false,
      });
      expect(fact).not.toHaveProperty("status");
      // Under no other key.
      expect(() => openCopy(world, row, "own")).toThrow();
      expect(
        await admin(world, "select xmin::text, compartments from knowledge.claims where id = $1", [claim]),
      ).toEqual(before);
      // One decision, of the claim's compartments, naming the claim.
      expect(
        await admin(world, "select kind, details, compartments from knowledge.owner_decisions where id = $1", [ruling]),
      ).toEqual([{ kind: "declassify", details: { claim }, compartments: ["own"] }]);
      // A repeated request id returns the first ruling and writes nothing.
      const requestId = req();
      const second = await oneMore(world);
      expect(await world.admin.releases.declassify(second, { requestId })).toBe(
        await world.admin.releases.declassify(second, { requestId }),
      );
      expect(await count(world, TABLE)).toBe(2);
    }));

  it("its owner has no name and no address, and no value of an owner account row is in its sealed body", () =>
    inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      await world.admin.releases.declassify(claim, { requestId: req() });
      const text = openCopy(world, await copyOf(world, claim));
      const fact = FactView.parse(JSON.parse(text));
      const owner = { id: world.owner, kind: "owner", name: null, address: null };
      expect(fact.subject).toEqual(owner);
      expect(fact.type === "commitment" ? fact.fields.counterparty : null).toEqual(owner);
      const accounts = await admin<{ id: string; compartments: string[]; value_enc: unknown }>(
        world,
        "select a.id, a.compartments, a.value_enc from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'owner' order by a.id",
      );
      // The control: the owner has accounts, and their values open.
      expect(accounts.length).toBeGreaterThan(0);
      for (const account of accounts) {
        const value = opened(
          world.store.db,
          account.compartments[0] ?? "",
          { table: "knowledge.accounts", id: account.id, column: "value_enc" },
          account.value_enc,
        );
        expect(value.length).toBeGreaterThan(0);
        expect(text).not.toContain(value);
      }
      expect(text).not.toContain(OWNER.name);
    }));

  it("a person it names is given as a client cleared for the claim's compartments sees them, and nothing seen only under another compartment", () =>
    inWorld(async (world) => {
      const evidence = await stored(world, MAIL.canary);
      // The canary person writes later under the employer's compartment, by another name: the
      // owner's latest name for them is that one.
      const workName = "Canary Workname-Only";
      await stored(
        world,
        {
          ...MAIL.workCanary,
          id: "gm-work-declassify-01",
          messageId: "declassify-01@harbor-canary.test",
          from: { address: CANARY_PERSON.address, name: workName },
        },
        world.accounts.workMail,
      );
      const person = await entityOf(world, CANARY_PERSON.address);
      const [claim] = await commit(world, evidence, [commitment(world, evidence, "own", { counterparty: person })]);
      await world.admin.releases.declassify(claim as FactId, { requestId: req() });
      const text = openCopy(world, await copyOf(world, claim as string));
      const fact = FactView.parse(JSON.parse(text));
      expect(fact.type === "commitment" ? fact.fields.counterparty : null).toEqual({
        id: person,
        kind: "person",
        name: { untrusted: CANARY_PERSON.name },
        address: { untrusted: CANARY_PERSON.address },
      });
      expect(text).not.toContain(workName);
    }));

  it("a claim of the employer's compartment naming the owner is declassified, the owner known by the owner's account under that compartment", () =>
    inWorld(async (world) => {
      // The owner's lowest account is `own`'s, made first; a client cleared for employer:example
      // alone knows the owner by the work account.
      const evidence = await stored(world, MAIL.workCanary, world.accounts.workMail);
      const person = await entityOf(world, CANARY_PERSON.address);
      const made = commitment(world, evidence, "employer:example");
      const record = {
        ...made,
        subjectKind: "person",
        entities: [person],
        claim: { ...made.claim, content: { ...made.claim.content, subject: person } },
      } as typeof made;
      const [claim] = await commit(world, evidence, [record]);
      await world.admin.releases.declassify(claim as FactId, { requestId: req() });
      const fact = FactView.parse(JSON.parse(openCopy(world, await copyOf(world, claim as string))));
      expect(fact.subject).toMatchObject({ id: person, kind: "person" });
      expect(fact.type === "commitment" ? fact.fields.counterparty : null).toEqual({
        id: world.owner,
        kind: "owner",
        name: null,
        address: null,
      });
    }));

  it("a third-party claim, an agent-reported claim and a claim of a system message are not_declassifiable, each writing nothing", () =>
    inWorld(async (world) => {
      const evidence = await stored(world, MAIL.canary);
      const system = await stored(world, MAIL.solo);
      const held = await stored(world, MAIL.fromQuentin);
      const [thirdParty, agent, plain] = await commit(world, evidence, [
        commitment(world, evidence, "own", { n: 1, thirdParty: true }),
        commitment(world, evidence, "own", { n: 2, agentReported: true }),
        commitment(world, evidence, "own", { n: 3 }),
      ]);
      const [fromSystem] = await commit(world, system, [commitment(world, system, "own")]);
      const [ofHeld] = await commit(world, held, [commitment(world, held, "own")]);
      await admin(world, "update vault.evidence_items set system_originated = true where id = $1", [system]);
      await admin(world, "update knowledge.messages set held = true where evidence_id = $1", [held]);
      const before = await written(world);
      for (const id of [thirdParty, agent, fromSystem, ofHeld]) {
        await expect(world.admin.releases.declassify(id as FactId, { requestId: req() })).rejects.toMatchObject({
          code: "not_declassifiable",
        });
      }
      await admin(
        world,
        "update vault.evidence_items set system_originated = false, answers_system = true where id = $1",
        [system],
      );
      await expect(world.admin.releases.declassify(fromSystem as FactId, { requestId: req() })).rejects.toMatchObject({
        code: "not_declassifiable",
      });
      await expect(
        world.admin.releases.declassify(`${"0".repeat(64)}` as FactId, { requestId: req() }),
      ).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await written(world)).toEqual(before);
      // The control: a claim of the same item that is none of these is declassified.
      await world.admin.releases.declassify(plain as FactId, { requestId: req() });
      expect(await copies(world)).toEqual([plain]);
    }));

  it("a key file without declassified is unknown_compartment, writing nothing", async () => {
    await inWorld(
      async (world) => {
        const { claim } = await oneClaim(world);
        const before = await written(world);
        await expect(world.admin.releases.declassify(claim, { requestId: req() })).rejects.toMatchObject({
          code: "unknown_compartment",
        });
        expect(await written(world)).toEqual(before);
      },
      { compartments: ["own", "employer:example"] },
    );
    // The control: the same claim, with the key, is declassified.
    await inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      await world.admin.releases.declassify(claim, { requestId: req() });
      expect(await copies(world)).toEqual([claim]);
    });
  });

  it("a second declassification is already_declassified, writing nothing", () =>
    inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      await world.admin.releases.declassify(claim, { requestId: req() });
      const before = await written(world);
      await expect(world.admin.releases.declassify(claim, { requestId: req() })).rejects.toMatchObject({
        code: "already_declassified",
      });
      expect(await written(world)).toEqual(before);
    }));
});

// A second claim, on Solo's message.
async function oneMore(world: World): Promise<FactId> {
  const evidence = await stored(world, MAIL.solo);
  const [claim] = await commit(world, evidence, [commitment(world, evidence, "own")]);
  if (claim === undefined) throw new Error("no claim");
  return claim;
}

describe("revokeDeclassified", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a revocation deletes the row, names each exposed client and raises one notice", () =>
    inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      const reading = await finder(world, "reading", ["own", "declassified"]);
      const outsider = await finder(world, "outsider", ["declassified"]);
      const gone = await finder(world, "gone-after-reading", ["declassified"]);
      const silentGone = await finder(world, "gone-silent", ["declassified"]);
      const uncleared = await finder(world, "uncleared", ["own"]);
      const ruling = await world.admin.releases.declassify(claim, { requestId: req() });
      for (const client of [reading, gone, uncleared])
        expect((await world.store.reader.findFacts(client.token, { type: "commitment" })).ok).toBe(true);
      // The control: before the revocation, a client cleared for declassified alone reads it.
      const before = await world.store.reader.findFacts(outsider.token, { type: "commitment" });
      expect(before.ok && before.value.facts.map((fact) => fact.id)).toEqual([claim]);
      expect(await world.admin.clients.revokeClient("gone-after-reading")).toBe(true);
      expect(await world.admin.clients.revokeClient("gone-silent")).toBe(true);

      expect(await world.admin.releases.revokeDeclassified(ruling, { requestId: req() })).toEqual({ exposed: 3 });
      expect(await copies(world)).toEqual([]);
      const [revocation] = await admin<{ details: { exposed: string[] }; supersedes: string; compartments: string[] }>(
        world,
        "select details, supersedes, compartments from knowledge.owner_decisions where kind = 'declassify_revoke'",
      );
      expect(revocation).toEqual({
        details: { exposed: [reading.id, outsider.id, gone.id].sort() },
        supersedes: ruling,
        compartments: ["own"],
      });
      expect(revocation?.details.exposed).not.toContain(silentGone.id);
      expect(revocation?.details.exposed).not.toContain(uncleared.id);
      expect(await admin(world, "select kind, created_by, compartments from ledger.cards")).toEqual([
        { kind: "notice", created_by: "system:declassify", compartments: ["own"] },
      ]);
      // From its commit, no client reads the copy; a client cleared for the claim still reads it.
      const outside = await world.store.reader.findFacts(outsider.token, { type: "commitment" });
      expect(outside.ok && outside.value.facts).toEqual([]);
      const found = await world.store.reader.findFacts(reading.token, { type: "commitment" });
      expect(found.ok && found.value.facts.map((fact) => fact.id)).toEqual([claim]);
      // A second revocation, under a new request id, finds nothing standing.
      await expect(world.admin.releases.revokeDeclassified(ruling, { requestId: req() })).rejects.toMatchObject({
        code: "not_found",
      });
    }));

  it("an active client cleared for declassified that never called is named", () =>
    inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      const silent = await finder(world, "silent", ["declassified"]);
      const ruling = await world.admin.releases.declassify(claim, { requestId: req() });
      expect(await world.admin.releases.revokeDeclassified(ruling, { requestId: req() })).toEqual({ exposed: 1 });
      expect(
        one(
          await admin<{ details: unknown }>(
            world,
            "select details from knowledge.owner_decisions where kind = 'declassify_revoke'",
          ),
        ).details,
      ).toEqual({ exposed: [silent.id] });
    }));

  it("a revocation with 300 exposed clients succeeds", () =>
    inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      const clients = [];
      for (let n = 0; n < 300; n += 1) clients.push(await insertClient(world.store.db, `crowd-${n}`, ["declassified"]));
      const ruling = await world.admin.releases.declassify(claim, { requestId: req() });
      const requestId = req();
      expect(await world.admin.releases.revokeDeclassified(ruling, { requestId })).toEqual({ exposed: 300 });
      // A repeated request id returns the first count.
      expect(await world.admin.releases.revokeDeclassified(ruling, { requestId })).toEqual({ exposed: 300 });
      expect(await count(world, "knowledge.owner_decisions", "kind = 'declassify_revoke'")).toBe(1);
      expect(await count(world, "ledger.cards")).toBe(1);
    }));

  it("a revocation with no exposed client raises none", () =>
    inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      const client = await insertClient(world.store.db, "revoked-early", ["declassified"]);
      await revokeClient(world.store.db, client);
      const ruling = await world.admin.releases.declassify(claim, { requestId: req() });
      expect(await world.admin.releases.revokeDeclassified(ruling, { requestId: req() })).toEqual({ exposed: 0 });
      expect(await copies(world)).toEqual([]);
      expect(await count(world, "ledger.cards")).toBe(0);
      // The control: with one active client cleared for it, the next revocation raises one.
      await insertClient(world.store.db, "active", ["declassified"]);
      const again = await world.admin.releases.declassify(claim, { requestId: req() });
      expect(await world.admin.releases.revokeDeclassified(again, { requestId: req() })).toEqual({ exposed: 1 });
      expect(await count(world, "ledger.cards")).toBe(1);
    }));

  it("a revoked fact can be declassified again", () =>
    inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      const first = await world.admin.releases.declassify(claim, { requestId: req() });
      await world.admin.releases.revokeDeclassified(first, { requestId: req() });
      const second = await world.admin.releases.declassify(claim, { requestId: req() });
      expect(second).not.toBe(first);
      expect((await copyOf(world, claim)).ruling_id).toBe(second);
    }));

  it("list shows standing, revoked and gone", () =>
    inWorld(async (world) => {
      const { claim: revoked } = await oneClaim(world);
      const standing = await oneMore(world);
      const goneEvidence = await stored(world, MAIL.fromQuentin);
      const [gone] = await commit(world, goneEvidence, [commitment(world, goneEvidence, "own")]);
      const revokedRuling = await world.admin.releases.declassify(revoked, { requestId: req() });
      const standingRuling = await world.admin.releases.declassify(standing, { requestId: req() });
      const goneRuling = await world.admin.releases.declassify(gone as FactId, { requestId: req() });
      await world.admin.releases.revokeDeclassified(revokedRuling, { requestId: req() });
      const deletion = {
        sourceAccount: world.accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.fromQuentin),
      } as SourceDeletion;
      await world.store.writer.applyDeletion(world.accounts.personalMail, deletion);

      const listed = await world.admin.releases.listDeclassified();
      expect(listed.map((one) => [one.id, one.claim, one.type, one.state, one.revokedAt === null])).toEqual([
        [revokedRuling, revoked, "commitment", "revoked", false],
        [standingRuling, standing, "commitment", "standing", true],
        [goneRuling, gone, "commitment", "gone", true],
      ]);
      // A revocation names one declassification: an id that is none is not_found.
      await expect(world.admin.releases.revokeDeclassified(goneRuling, { requestId: req() })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        world.admin.releases.revokeDeclassified(`rul_${"0".repeat(26)}` as RulingId, { requestId: req() }),
      ).rejects.toMatchObject({ code: "not_found" });
    }));
});

describe("a declassification and a deletion of its item at once", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  const deletionOf = (world: World): SourceDeletion =>
    ({ sourceAccount: world.accounts.personalMail.id, sourceItemId: mailSourceId(MAIL.canary) }) as SourceDeletion;

  it("leave no copy: the declassification first", () =>
    inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      const side = createAdmin({ url: world.store.db.urls.admin, keys: world.store.db.keys, log: world.store.log });
      try {
        const lock = await holding(world.store.db.urls.admin, BELIEFS);
        const declassified = outcome(side.releases.declassify(claim, { requestId: req() }));
        expect(await pending(declassified)).toBe(true);
        const deletion = world.store.writer.applyDeletion(world.accounts.personalMail, deletionOf(world));
        expect(await pending(deletion)).toBe(true);
        await lock.release();
        expect(await declassified).toMatch(/^rul_/);
        await deletion;
        expect(await copies(world)).toEqual([]);
        expect((await world.admin.releases.listDeclassified()).map((one) => one.state)).toEqual(["gone"]);
      } finally {
        await side.close();
      }
    }));

  it("leave no copy: the deletion first", () =>
    inWorld(async (world) => {
      const { claim } = await oneClaim(world);
      const side = createAdmin({ url: world.store.db.urls.admin, keys: world.store.db.keys, log: world.store.log });
      try {
        const lock = await holding(world.store.db.urls.admin, BELIEFS);
        const deletion = world.store.writer.applyDeletion(world.accounts.personalMail, deletionOf(world));
        expect(await pending(deletion)).toBe(true);
        const declassified = outcome(side.releases.declassify(claim, { requestId: req() }));
        expect(await pending(declassified)).toBe(true);
        await lock.release();
        await deletion;
        expect(await declassified).toEqual({ rejected: "not_found" });
        expect(await copies(world)).toEqual([]);
        expect(await count(world, "knowledge.owner_decisions", "kind = 'declassify'")).toBe(0);
      } finally {
        await side.close();
      }
    }));
});
