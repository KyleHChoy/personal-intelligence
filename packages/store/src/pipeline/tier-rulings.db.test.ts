import { warmthRules } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { createDb } from "../core/job-db.ts";
import { openedUnder } from "../core/tx.ts";
import type { ErasureHook } from "../erasure/erasure-hook.ts";
import { ERASURE_HOOKS } from "../erasure/erasure-hooks.ts";
import { buildDueDays } from "../identity/warmth-days.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { age, buildRowOf, rowsOf, runWarmth, type WarmthWorld, warmthWorld } from "../test-support/warmth-fixtures.ts";

// The owner sets a person's tier. The owner's ruling through the Admin as pi_admin, the ranking's use
// of it at read (no day is built again for it), the day build's cadence as pi_pipeline,
// a re-derive's new ids and the erasure hook. The synthetic world of warmth-fixtures.ts.

const TIMEOUT = 180_000;
const DAY_MS = 86_400_000;
const TODAY = new Date("2026-10-22T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(TODAY.getTime() - days * DAY_MS).toISOString();
const OWN = ["own"];
const WORK = ["employer:example"];
const BOTH = ["employer:example", "own"];

async function exchange(world: WarmthWorld, label: string[], person: string, days: number): Promise<void> {
  const thread = testId("thr");
  await world.mail(label, { at: daysAgo(days), to: [person], thread });
  await world.mail(label, { at: daysAgo(days - 0.1), from: person, thread });
}

// A person with one account of their own address under the label (warmthWorld's people share one
// seed address, and a ruling is keyed by the address's fingerprint).
let people = 0;
async function personOf(db: TestDatabase, label: string[]): Promise<string> {
  people += 1;
  const address = `tier-person-${people}-${testId("x").slice(-6).toLowerCase()}@example.test`;
  return session(db.urls.admin, async (query) => {
    const entity = await seeder(db, query).entity("person");
    const id = testId("adr");
    await query(
      "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, compartments, value_enc) values ($1, $2, 'email', $3, $4, $5, $6)",
      [
        id,
        entity,
        fingerprint(db.keys, "address", address),
        fingerprint(db.keys, "domain", "example.test"),
        label,
        sealRow(db.keys, label[0] ?? "own", { table: "knowledge.accounts", id, column: "value_enc" }, address),
      ],
    );
    return entity;
  });
}

// A person the owner wrote with on four days: inferred `inner` on a small network.
async function closePerson(db: TestDatabase, world: WarmthWorld, label: string[]): Promise<string> {
  const person = await personOf(db, label);
  for (const days of [3, 10, 20, 40]) await exchange(world, label, person, days);
  return person;
}

const runOf = runWarmth;

async function withAdmin<T>(db: TestDatabase, fn: (admin: Admin) => Promise<T>): Promise<T> {
  const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

const req = (): { requestId: string } => ({ requestId: testId("req").slice(4) });

// The person's one address, opened under its row's label, and its fingerprint.
async function addressOf(db: TestDatabase, entity: string): Promise<{ address: string; fp: string }> {
  const [row] = await queryAs<{ id: string; compartments: string[]; value_enc: unknown; value_fp: string }>(
    db.urls.admin,
    "select id, compartments, value_enc, value_fp from knowledge.accounts where entity_id = $1 order by id limit 1",
    [entity],
  );
  if (row === undefined) throw new Error("no account");
  return {
    address: openedUnder(
      db.keys,
      row.compartments,
      { table: "knowledge.accounts", id: row.id, column: "value_enc" },
      row.value_enc,
    ),
    fp: row.value_fp,
  };
}

// A person's line in the clearance's ranking, as the owner reads it today.
const rowOf = async (db: TestDatabase, clearance: string[], entity: string) =>
  (await rowsOf(db, clearance, TODAY))?.find((row) => row.entity_id === entity);
const codeOf = async (fn: () => Promise<unknown>): Promise<unknown> =>
  fn().then(
    () => null,
    (error: { code?: unknown; rulings?: unknown }) => ({ code: error.code, rulings: error.rulings }),
  );

describe("the owner's tier rulings", { timeout: TIMEOUT }, () => {
  it("sets, replaces, clears and lists a ruling, one in force per fingerprint, each with its owner decision; refuses what is no person", () =>
    withDatabase(async (db) => {
      const person = await personOf(db, OWN);
      const { address, fp } = await addressOf(db, person);
      await withAdmin(db, async (admin) => {
        const first = await admin.tiers.setTier(person, "close", req());
        expect(await admin.tiers.listTiers()).toEqual([
          expect.objectContaining({ id: first, tier: "close", values: 1, people: [person] }),
        ]);
        // The same tier again writes nothing.
        expect(await codeOf(() => admin.tiers.setTier(person, "close", req()))).toEqual({
          code: "already_settled",
          rulings: [first],
        });
        // A new tier, by address, lifts the first with itself as the lift.
        const second = await admin.tiers.setTier(address, "regular", req());
        expect(
          await queryAs(
            db.urls.admin,
            "select ruling_id, tier, lifted_at is not null as lifted, lift_ruling_id, compartments from knowledge.tier_rulings order by created_at, ruling_id",
          ),
        ).toEqual([
          { ruling_id: first, tier: "close", lifted: true, lift_ruling_id: second, compartments: OWN },
          { ruling_id: second, tier: "regular", lifted: false, lift_ruling_id: null, compartments: OWN },
        ]);
        expect(
          await queryAs(
            db.urls.admin,
            "select count(*)::int as n from knowledge.tier_rulings where lifted_at is null and $1 = any(value_fps)",
            [fp],
          ),
        ).toEqual([{ n: 1 }]);
        expect(
          await queryAs(db.urls.admin, "select kind, answer, supersedes from knowledge.owner_decisions where id = $1", [
            second,
          ]),
        ).toEqual([{ kind: "warmth_tier", answer: "regular", supersedes: first }]);
        expect((await admin.tiers.listTiers()).map((one) => one.id)).toEqual([second]);
        // The lift, once; then nothing is in force.
        expect(await admin.tiers.clearTier(person, req())).toBe(true);
        expect(await admin.tiers.listTiers()).toEqual([]);
        expect(await admin.tiers.clearTier(person, req())).toBe(false);
        expect(
          await queryAs(
            db.urls.admin,
            "select kind, supersedes from knowledge.owner_decisions where kind = 'warmth_tier_lift'",
          ),
        ).toEqual([{ kind: "warmth_tier_lift", supersedes: second }]);
        // Refusals.
        const organization = await session(db.urls.admin, (query) => seeder(db, query).entity("organization"));
        expect(await codeOf(() => admin.tiers.setTier(organization, "inner", req()))).toMatchObject({
          code: "not_a_person",
        });
        expect(await codeOf(() => admin.tiers.setTier(testId("ent"), "inner", req()))).toMatchObject({
          code: "not_found",
        });
        expect(await codeOf(() => admin.tiers.setTier("nobody@example.test", "inner", req()))).toMatchObject({
          code: "not_found",
        });
        expect(await codeOf(() => admin.tiers.clearTier(testId("ent"), req()))).toMatchObject({ code: "not_found" });
      });
    }));

  it("the build places a ruled person at the ruled tier, beating the score, within the audiences that see the person's account and in no other (invariant 6); the ruling survives a re-derive", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      await insertClient(db, "personal", OWN);
      await insertClient(db, "work", WORK);
      await insertClient(db, "both", BOTH);
      const ruled = await closePerson(db, world, OWN);
      const colleague = await closePerson(db, world, WORK);
      // One label of days each, own's and the employer's.
      expect((await runOf(db)).built).toBe(2);
      expect(await rowOf(db, OWN, ruled)).toMatchObject({ tier: "inner", tier_source: "inferred" });
      const work = await rowsOf(db, WORK, TODAY);
      const workBuild = await buildRowOf(db, WORK);

      await withAdmin(db, (admin) => admin.tiers.setTier(ruled, "known", req()));
      // The clearances that see the person's account rank by it at once, with no day built again;
      // the work clearance, which does not see it, is unchanged.
      expect((await runOf(db)).built).toBe(0);
      expect(await rowOf(db, OWN, ruled)).toMatchObject({ tier: "known", tier_source: "owner", compartments: OWN });
      expect(await rowOf(db, BOTH, ruled)).toMatchObject({ tier: "known", tier_source: "owner" });
      expect(await rowOf(db, BOTH, colleague)).toMatchObject({ tier: "inner", tier_source: "inferred" });
      expect(await rowsOf(db, WORK, TODAY)).toEqual(work);
      expect((await buildRowOf(db, WORK))?.built_at).toEqual(workBuild?.built_at);

      // A re-derive's new ids: the same address under a new entity keeps the ruling.
      const renewed = await session(db.urls.admin, async (query) => {
        const id = await seeder(db, query).entity("person");
        await query("update knowledge.accounts set entity_id = $2 where entity_id = $1", [ruled, id]);
        return id;
      });
      await age(db, 25 * 60);
      await runOf(db);
      expect(await rowOf(db, OWN, renewed)).toMatchObject({ tier: "known", tier_source: "owner", compartments: OWN });
      expect(await rowOf(db, OWN, ruled)).toMatchObject({ tier_source: "inferred" });
    }));

  it("cadence: a ruling, its replacement and its lift each rank at once, with no day built again; a rule table version other than the days' rebuilds them at once", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      await insertClient(db, "personal", OWN);
      const person = await closePerson(db, world, OWN);
      expect((await runOf(db)).built).toBe(1);
      // New mail within ten minutes of the build waits out the throttle.
      await exchange(world, OWN, await personOf(db, OWN), 1);
      expect((await runOf(db)).built).toBe(0);
      // The owner's word needs no day built again: each ruling, its replacement and its lift rank at
      // once, past the throttle, and no run builds anything for them.
      await withAdmin(db, async (admin) => {
        await admin.tiers.setTier(person, "regular", req());
        expect(await rowOf(db, OWN, person)).toMatchObject({ tier: "regular", tier_source: "owner" });
        expect((await runOf(db)).built).toBe(0);
        await admin.tiers.setTier(person, "outer", req());
        expect(await rowOf(db, OWN, person)).toMatchObject({ tier: "outer", tier_source: "owner" });
        expect((await runOf(db)).built).toBe(0);
        expect(await admin.tiers.clearTier(person, req())).toBe(true);
        expect(await rowOf(db, OWN, person)).toMatchObject({ tier: "inner", tier_source: "inferred" });
        expect((await runOf(db)).built).toBe(0);
      });

      // A new rule table version: the days rebuilt at once, then not again under it.
      const rules = { ...warmthRules(), version: warmthRules().version + 1 };
      const pipeline = createDb(db.urls.pipeline, recordingLogger().log);
      try {
        const run = (with_: typeof rules) => buildDueDays(pipeline, db.keys, recordingLogger().log, { rules: with_ });
        expect((await run(rules)).built).toBe(1);
        expect(await buildRowOf(db, OWN)).toMatchObject({ rule_version: rules.version });
        expect((await run(rules)).built).toBe(0);
      } finally {
        await pipeline.close();
      }
      // And back to the version in force, at once.
      expect((await runOf(db)).built).toBe(1);
      expect(await buildRowOf(db, OWN)).toMatchObject({ rule_version: warmthRules().version });
    }));

  it("an erasure deletes the tier rulings holding an erased address's fingerprint, and counts them on a dry run", () =>
    withDatabase(async (db) => {
      const erased = await personOf(db, OWN);
      const kept = await personOf(db, OWN);
      const { fp } = await addressOf(db, erased);
      await withAdmin(db, async (admin) => {
        await admin.tiers.setTier(erased, "inner", req());
        await admin.tiers.setTier(kept, "close", req());
      });
      const hook = (ERASURE_HOOKS as ErasureHook[]).find((one) => one.name === "tier_rulings");
      if (hook === undefined) throw new Error("no tier_rulings hook");
      const names = ERASURE_HOOKS.map((one) => one.name);
      expect(names.indexOf("tier_rulings")).toBe(names.indexOf("identity") + 1);
      const input = {
        evidenceIds: [],
        refs: [],
        addressFps: [fp],
        sources: [],
        records: [],
        recordEvidenceIds: [],
        erasureId: null,
        factKeyFps: [],
        nameFps: [],
        claimKeys: [],
        claimIds: [],
      } as Parameters<ErasureHook["run"]>[1];
      const adminDb = createDb(db.urls.admin, recordingLogger().log);
      try {
        expect(
          await adminDb.transaction((query) =>
            hook.run(query, input, { dryRun: true, now: new Date(), keys: db.keys }),
          ),
        ).toBe(1);
        expect(await queryAs(db.urls.admin, "select count(*)::int as n from knowledge.tier_rulings")).toEqual([
          { n: 2 },
        ]);
        expect(
          await adminDb.transaction((query) =>
            hook.run(query, input, { dryRun: false, now: new Date(), keys: db.keys }),
          ),
        ).toBe(1);
      } finally {
        await adminDb.close();
      }
      expect(await queryAs(db.urls.admin, "select tier from knowledge.tier_rulings")).toEqual([{ tier: "close" }]);
    }));
});
