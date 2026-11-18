import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Timestamp } from "@intelligence/contracts";
import type { EntityId } from "@intelligence/contracts/personal";
import { warmthRules } from "@intelligence/personal-core/views";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import type { Query } from "../core/db.ts";
import { createDb } from "../core/job-db.ts";
import type { ErasureHook } from "../erasure/erasure-hook.ts";
import { ERASURE_HOOKS } from "../erasure/erasure-hooks.ts";
import { connect, OWNER, QUENTIN, WORK_ONLY } from "../test-support/cast.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { ingestMail, type MailFixture } from "../test-support/items.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, withDatabase } from "../test-support/store.ts";
import {
  age,
  buildAs,
  buildRowOf,
  rowsOf,
  runWarmth,
  type WarmthWorld,
  warmthWorld,
} from "../test-support/warmth-fixtures.ts";
import { removeSourceItem } from "../write/writer-item-removal.ts";
import { removeWarmth } from "./warmth-build.ts";
import { buildLabelDays } from "./warmth-days.ts";

// Warmth kept as days per label: the day build, its cadence and its removals, through
// the store's own functions as pi_pipeline, pi_writer and pi_admin, and the ranking each clearance
// reads from the days within it, computed at read as the owner reads it. The synthetic world of
// warmth-fixtures.ts; no model.

const TIMEOUT = 180_000;
const DAY_MS = 86_400_000;
const TODAY = new Date("2026-10-22T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(TODAY.getTime() - days * DAY_MS).toISOString();
const OWN = ["own"];
const WORK = ["employer:example"];
const BOTH = ["employer:example", "own"];

// A two-way exchange: the owner writes, the person answers in the same thread.
async function exchange(
  world: WarmthWorld,
  label: string[],
  person: string,
  days: number,
  thread = testId("thr"),
): Promise<string[]> {
  return [
    await world.mail(label, { at: daysAgo(days), to: [person], thread }),
    await world.mail(label, { at: daysAgo(days - 0.1), from: person, thread }),
  ];
}

const runOf = runWarmth;

const removeAsWriter = async (db: TestDatabase, world: WarmthWorld, evidenceId: string): Promise<void> => {
  const { account, fp } = await world.source(evidenceId);
  const writer = createDb(db.urls.writer, recordingLogger().log);
  try {
    await writer.transaction((query) => removeSourceItem({ query, keys: db.keys }, account, fp, "deleted"));
  } finally {
    await writer.close();
  }
};

// The people of a clearance's ranking as of today, none while it is being rebuilt.
const ids = (rows: { entity_id: string }[] | null): string[] | null => rows?.map((row) => row.entity_id) ?? null;
const ranked = (db: TestDatabase, clearance: string[], today = TODAY) => rowsOf(db, clearance, today);
// How many days the labels hold, as pi_admin counts them.
const daysUnder = async (db: TestDatabase, label: string[]): Promise<number> =>
  (
    await queryAs<{ n: number }>(
      db.urls.admin,
      "select count(*)::int as n from projections.warmth_days where compartments = $1::text[]",
      [[...label].sort()],
    )
  )[0]?.n ?? 0;

describe("the warmth day build and the ranking read from it", { timeout: TIMEOUT }, () => {
  it("counts each label's days from the rows of exactly that label, and each clearance ranks one line per person from the labels within it", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      await insertClient(db, "personal", OWN);
      await insertClient(db, "both", BOTH);
      const close = await world.person(OWN);
      const colleague = await world.person(WORK);
      const stranger = await world.person(OWN);
      for (const days of [3, 10, 20, 40]) await exchange(world, OWN, close, days);
      await exchange(world, WORK, colleague, 5);
      await world.mail(OWN, { at: daysAgo(2), from: stranger });
      // Left out by warmth's rules: bulk, held, a cancelled or declined meeting, a crowd.
      const noisy = await world.person(OWN);
      await world.mail(OWN, { at: daysAgo(1), from: noisy, bulk: true });
      await world.mail(OWN, { at: daysAgo(1), to: [noisy], held: true });
      await world.meeting(OWN, [noisy], daysAgo(4), { cancelled: true });
      await world.meeting(OWN, [noisy], daysAgo(4), { response: "declined" });

      // Two labels, own's and the employer's: no row rests on both.
      expect(await runOf(db)).toMatchObject({ built: 2, failed: 0 });
      const personal = (await ranked(db, OWN)) ?? [];
      expect(ids(personal)?.sort()).toEqual([close, stranger].sort());
      const both = (await ranked(db, BOTH)) ?? [];
      expect(ids(both)?.sort()).toEqual([close, colleague, stranger].sort());
      const of = (rows: { entity_id: string }[], id: string) => rows.find((row) => row.entity_id === id) ?? {};
      expect(of(personal, close)).toMatchObject({
        two_way: true,
        tier: "inner",
        tier_source: "inferred",
        members: [close],
        compartments: OWN,
        channels: ["email"],
      });
      expect(of(personal, stranger)).toMatchObject({ two_way: false, tier: "one-way", active: 0, warmth: 0 });
      expect(of(both, colleague)).toMatchObject({ two_way: true, compartments: WORK });
      // Each label's build row, by the rule table in force; no label is built for the pair.
      expect(await buildRowOf(db, OWN)).toMatchObject({ removed: false, rule_version: warmthRules().version });
      expect(await buildRowOf(db, WORK)).toMatchObject({ removed: false, rule_version: warmthRules().version });
      expect((await buildRowOf(db, OWN))?.days).toBe(await daysUnder(db, OWN));
      expect(await buildRowOf(db, BOTH)).toBeUndefined();
    }));

  it("counts a meeting the owner kept with at most the cap of attendees, and not a larger one", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      await insertClient(db, "personal", OWN);
      const met = await world.person(OWN);
      const crowd = [met];
      for (let i = 0; i < 11; i += 1) crowd.push(await world.person(OWN));
      const big = crowd[1] ?? "";
      await world.meeting(OWN, [met], daysAgo(3));
      await world.meeting(OWN, crowd.slice(1), daysAgo(3), { response: null });
      await runOf(db);
      const rows = (await ranked(db, OWN)) ?? [];
      expect(rows.find((row) => row.entity_id === met)).toMatchObject({ two_way: true, channels: ["calendar"] });
      // Twelve attendees with the owner: no warmth line for anyone on it.
      expect(ids(rows)).not.toContain(big);
    }));

  it("replaces a label's days in one transaction: a reader ranks all the old days or all the new", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      const first = await world.person(OWN);
      await exchange(world, OWN, first, 3);
      await buildAs(db, OWN);
      const second = await world.person(OWN);
      await exchange(world, OWN, second, 2);
      const client = new pg.Client({ connectionString: db.urls.pipeline });
      await client.connect();
      try {
        const query: Query = async (text, values) => (await client.query(text, values)).rows;
        await query("begin");
        await buildLabelDays({ query, keys: db.keys }, OWN);
        expect(ids(await ranked(db, OWN))).toEqual([first]);
        await query("commit");
      } finally {
        await client.end();
      }
      expect(ids(await ranked(db, OWN))?.sort()).toEqual([first, second].sort());
    }));

  it("cadence: a run builds a missing label, skips one with no change, rebuilds a changed one at most every ten minutes; a day on, the reader's clock moves the decay with no build", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      await insertClient(db, "personal", OWN);
      const person = await world.person(OWN);
      await exchange(world, OWN, person, 3);
      expect((await runOf(db)).built).toBe(1);
      // Built within ten minutes, rows held: skipped.
      expect((await runOf(db)).built).toBe(0);
      // Eleven minutes later with no new input: skipped.
      await age(db, 11);
      expect((await runOf(db)).built).toBe(0);
      // A new mail row within the label: rebuilt.
      const other = await world.person(OWN);
      await exchange(world, OWN, other, 1);
      expect((await runOf(db)).built).toBe(1);
      expect(ids(await ranked(db, OWN))?.sort()).toEqual([person, other].sort());
      // Another within ten minutes of that build: skipped.
      await world.mail(OWN, { at: daysAgo(0.5), to: [other] });
      expect((await runOf(db)).built).toBe(0);
      // A day on, with nothing new since, nothing is built: the decay moves with the reader's clock.
      await age(db, 25 * 60);
      expect((await runOf(db)).built).toBe(0);
      const before = (await ranked(db, OWN))?.find((row) => row.entity_id === person)?.active as number;
      const after = (await ranked(db, OWN, new Date(TODAY.getTime() + 30 * DAY_MS)))?.find(
        (row) => row.entity_id === person,
      )?.active as number;
      expect(after).toBeLessThan(before);
      expect(after).toBeGreaterThan(0);
    }));

  it("a label built with no days ranks an empty list, not rebuilding, and is not rebuilt on every run", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      // The employer's only mail is bulk, which warmth leaves out: its label holds no day.
      await world.mail(WORK, { at: daysAgo(3), from: await world.person(WORK), bulk: true });
      expect(await runOf(db)).toMatchObject({ built: 1, days: 0 });
      expect(await buildRowOf(db, WORK)).toMatchObject({ days: 0, removed: false });
      expect(await ranked(db, WORK)).toEqual([]);
      expect((await runOf(db)).built).toBe(0);
      await age(db, 11);
      expect((await runOf(db)).built).toBe(0);
    }));
});

describe("removals", { timeout: TIMEOUT }, () => {
  it("a source deletion deletes the days of every label that could see a removed row, marks each removed, and leaves the others", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      await insertClient(db, "personal", OWN);
      await insertClient(db, "both", BOTH);
      const close = await world.person(OWN);
      const colleague = await world.person(WORK);
      const personal = await exchange(world, OWN, close, 3);
      const [work] = await exchange(world, WORK, colleague, 4);
      await runOf(db);
      const kept = await ranked(db, OWN);

      // The employer's label is emptied, so the clearance that holds it is rebuilding; own's is not.
      await removeAsWriter(db, world, work ?? "");
      expect(await daysUnder(db, WORK)).toBe(0);
      expect(await buildRowOf(db, WORK)).toMatchObject({ removed: true });
      expect(await ranked(db, BOTH)).toBeNull();
      expect(await ranked(db, OWN)).toEqual(kept);
      expect(await buildRowOf(db, OWN)).toMatchObject({ removed: false });

      // The next run rebuilds the emptied label at once, and only it.
      expect((await runOf(db)).built).toBe(1);
      expect(ids(await ranked(db, BOTH))?.sort()).toEqual([close, colleague].sort());
      expect(await buildRowOf(db, WORK)).toMatchObject({ removed: false });

      // A row under `own`: every clearance holding `own` is rebuilding.
      await removeAsWriter(db, world, personal[0] ?? "");
      expect(await daysUnder(db, OWN)).toBe(0);
      expect(await ranked(db, OWN)).toBeNull();
      expect(await ranked(db, BOTH)).toBeNull();
    }));

  it("a removal under a compartment no label holds deletes nothing and marks nothing; the delete is by containment alone, as pi_writer and pi_admin", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      await insertClient(db, "personal", OWN);
      await insertClient(db, "both", BOTH);
      await exchange(world, OWN, await world.person(OWN), 3);
      await exchange(world, WORK, await world.person(WORK), 4);
      await runOf(db);
      const before = [await ranked(db, OWN), await ranked(db, BOTH)];
      const workDays = await daysUnder(db, WORK);
      expect(workDays).toBeGreaterThan(0);
      for (const url of [db.urls.writer, db.urls.admin]) {
        const role = createDb(url, recordingLogger().log);
        try {
          expect(
            await role.transaction((query) =>
              removeWarmth(query, [["agent:nobody"], ["employer:example", "restricted:health"]]),
            ),
          ).toBe(0);
        } finally {
          await role.close();
        }
      }
      expect([await ranked(db, OWN), await ranked(db, BOTH)]).toEqual(before);
      expect(await buildRowOf(db, OWN)).toMatchObject({ removed: false });
      expect(await buildRowOf(db, WORK)).toMatchObject({ removed: false });
      // And a removal under `employer:example` reaches only the label that holds it.
      const writer = createDb(db.urls.writer, recordingLogger().log);
      try {
        expect(await writer.transaction((query) => removeWarmth(query, [WORK]))).toBe(workDays);
      } finally {
        await writer.close();
      }
      expect(await ranked(db, OWN)).toEqual(before[0]);
      expect(await buildRowOf(db, WORK)).toMatchObject({ removed: true });
      expect(await ranked(db, BOTH)).toBeNull();
    }));

  it("a stale build cannot write after a removal: the build waits on the beliefs lock and reads what the removal left", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      await insertClient(db, "both", BOTH);
      const close = await world.person(OWN);
      const colleague = await world.person(WORK);
      await exchange(world, OWN, close, 3);
      const work = await exchange(world, WORK, colleague, 4);
      await runOf(db);
      const removal = new pg.Client({ connectionString: db.urls.writer });
      await removal.connect();
      try {
        const query: Query = async (text, values) => (await removal.query(text, values)).rows;
        await query("begin");
        for (const evidence of work) {
          const { account, fp } = await world.source(evidence);
          await removeSourceItem({ query, keys: db.keys }, account, fp, "deleted");
        }
        // The build starts while the removal holds the lock, and can only finish after it commits.
        const build = buildAs(db, BOTH);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await query("commit");
        expect(await build).toBe(await daysUnder(db, OWN));
      } finally {
        await removal.end();
      }
      expect(ids(await ranked(db, BOTH))).toEqual([close]);
      expect(await buildRowOf(db, WORK)).toMatchObject({ days: 0, removed: false });
    }));

  it("an erasure, through the admin's own path, deletes only the days of labels that could see the erased rows; the person hook those that held the person's days", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-warmth-erase-"));
    const store = await openStore({ compartments: ["own", "employer:example"] });
    try {
      const db = store.db;
      const accounts = await connect(store.writer);
      await insertClient(db, "personal", OWN);
      await insertClient(db, "both", BOTH);
      const mail = (
        id: string,
        at: string,
        from: { address: string; name?: string },
        to: { address: string; name?: string }[],
        labels: string[],
      ): MailFixture =>
        ({
          id,
          threadId: `thread-${id}`,
          at: at as Timestamp,
          from,
          to,
          subject: "The lamp oil",
          labels,
          text: "Lamp oil.",
        }) as MailFixture;
      const owner = { address: OWNER.personal, name: OWNER.name };
      const work = { address: OWNER.work, name: OWNER.name };
      expect(
        await ingestMail(
          store.writer,
          accounts.personalMail,
          mail("gm-warmth-0001", daysAgo(3), owner, [QUENTIN], ["SENT"]),
        ),
      ).toBe("stored");
      expect(
        await ingestMail(
          store.writer,
          accounts.personalMail,
          mail("gm-warmth-0002", daysAgo(2.9), QUENTIN, [owner], ["INBOX"]),
        ),
      ).toBe("stored");
      expect(
        await ingestMail(
          store.writer,
          accounts.workMail,
          mail("gm-warmth-0003", daysAgo(4), work, [WORK_ONLY], ["SENT"]),
        ),
      ).toBe("stored");
      expect(
        await ingestMail(
          store.writer,
          accounts.workMail,
          mail("gm-warmth-0004", daysAgo(3.9), WORK_ONLY, [work], ["INBOX"]),
        ),
      ).toBe("stored");
      expect(await runOf(db)).toMatchObject({ built: 2, failed: 0 });
      const quentin =
        (
          await queryAs<{ entity_id: string }>(
            db.urls.admin,
            "select distinct entity_id from knowledge.accounts where value_fp = $1",
            [fingerprint(db.keys, "address", QUENTIN.address)],
          )
        )[0]?.entity_id ?? "";
      const wren =
        (
          await queryAs<{ entity_id: string }>(
            db.urls.admin,
            "select distinct entity_id from knowledge.accounts where value_fp = $1",
            [fingerprint(db.keys, "address", WORK_ONLY.address)],
          )
        )[0]?.entity_id ?? "";
      // Real ingestion's rows: each of them two-way in the clearances that read them.
      expect(await ranked(db, OWN)).toEqual([
        expect.objectContaining({ entity_id: quentin, two_way: true, compartments: OWN }),
      ]);
      expect(ids(await ranked(db, BOTH))?.sort()).toEqual([quentin, wren].sort());
      const kept = await ranked(db, OWN);

      const admin = new Admin({
        pool: store.adminPool,
        keys: db.keys,
        log: store.log,
        journal: join(dir, "keys.json.erasures"),
        recordEnabled: true,
      });
      const message =
        (
          await queryAs<{ id: string }>(
            db.urls.admin,
            "select m.id from knowledge.messages m where m.compartments = $1 and m.direction = 'inbound'",
            [WORK],
          )
        )[0]?.id ?? "";
      await admin.erasure.eraseItem({ kind: "message", id: message } as never, { requestId: testId("req") });
      expect(await daysUnder(db, WORK)).toBe(0);
      expect(await buildRowOf(db, WORK)).toMatchObject({ removed: true });
      expect(await ranked(db, BOTH)).toBeNull();
      expect(await ranked(db, OWN)).toEqual(kept);
      expect(await buildRowOf(db, OWN)).toMatchObject({ removed: false });

      // The person hook alone, on rebuilt days: the labels with a day of the person's.
      expect((await runOf(db)).built).toBe(1);
      const hook = (ERASURE_HOOKS as ErasureHook[]).find((one) => one.name === "warmth");
      if (hook === undefined) throw new Error("no warmth hook");
      const erased = {
        evidenceIds: [],
        refs: [{ kind: "entity", id: wren as EntityId }],
        addressFps: [],
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
        const dry = await adminDb.transaction((query) =>
          hook.run(query, erased, { dryRun: true, now: new Date(), keys: db.keys }),
        );
        expect(dry).toBe(await daysUnder(db, WORK));
        expect(dry).toBeGreaterThan(0);
        expect(
          await adminDb.transaction((query) =>
            hook.run(query, erased, { dryRun: false, now: new Date(), keys: db.keys }),
          ),
        ).toBe(dry);
      } finally {
        await adminDb.close();
      }
      expect(await daysUnder(db, WORK)).toBe(0);
      expect(await ranked(db, BOTH)).toBeNull();
      expect(await ranked(db, OWN)).toEqual(kept);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the owner's ignore list", { timeout: TIMEOUT }, () => {
  it("an ignored person takes no line and no rank slot, at once with no build; lifting the ruling brings them back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-warmth-ignore-"));
    const store = await openStore({ compartments: ["own", "employer:example"] });
    try {
      const db = store.db;
      const accounts = await connect(store.writer);
      await insertClient(db, "personal", OWN);
      const mail = (
        id: string,
        at: string,
        from: { address: string; name?: string },
        to: { address: string; name?: string }[],
        labels: string[],
      ): MailFixture =>
        ({
          id,
          threadId: `thread-${id}`,
          at: at as Timestamp,
          from,
          to,
          subject: "The lamp oil",
          labels,
          text: "Lamp oil.",
        }) as MailFixture;
      const owner = { address: OWNER.personal, name: OWNER.name };
      expect(
        await ingestMail(
          store.writer,
          accounts.personalMail,
          mail("gm-warmth-ign-1", daysAgo(3), owner, [QUENTIN], ["SENT"]),
        ),
      ).toBe("stored");
      expect(
        await ingestMail(
          store.writer,
          accounts.personalMail,
          mail("gm-warmth-ign-2", daysAgo(2.9), QUENTIN, [owner], ["INBOX"]),
        ),
      ).toBe("stored");
      const quentin =
        (
          await queryAs<{ entity_id: string }>(
            db.urls.admin,
            "select distinct entity_id from knowledge.accounts where value_fp = $1",
            [fingerprint(db.keys, "address", QUENTIN.address)],
          )
        )[0]?.entity_id ?? "";
      expect(await runOf(db)).toMatchObject({ built: 1, failed: 0 });
      expect(ids(await ranked(db, OWN))).toEqual([quentin]);

      const admin = new Admin({
        pool: store.adminPool,
        keys: db.keys,
        log: store.log,
        journal: join(dir, "keys.json.erasures"),
        recordEnabled: true,
      });
      const ruling = await admin.ignores.addIgnore("account", QUENTIN.address, { requestId: testId("req") });
      expect(await ranked(db, OWN)).toEqual([]);
      expect((await runOf(db)).built).toBe(0);

      await admin.ignores.liftIgnore(ruling, { requestId: testId("req") });
      expect(ids(await ranked(db, OWN))).toEqual([quentin]);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the budget", { timeout: 600_000 }, () => {
  it("builds the days of 3 000 people, 60 000 rows over ten years and 30 000 chat lines within 10 s, and ranks them all", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      // Templates: one person's account, one mail and one meeting, each copied in bulk below.
      const template = await world.person(OWN);
      const [mailEvidence] = await exchange(world, OWN, template, 1);
      const meetingEvidence = await world.meeting(OWN, [template], daysAgo(1));
      const PEOPLE = 3_000;
      const MAILS = 54_000;
      const MEETINGS = 6_000;
      const accounts = Array.from({ length: PEOPLE }, (_, i) => {
        const id = `adr_budget${String(i).padStart(6, "0")}`;
        const address = `budget-${i}@budget-people.test`;
        return {
          id,
          entity: `ent_budget${String(i).padStart(6, "0")}`,
          value_fp: fingerprint(db.keys, "address", address),
          value_enc: sealed(db, id, address),
        };
      });
      await queryAs(
        db.urls.admin,
        "insert into knowledge.entities (id, kind) select r.entity, 'person' from jsonb_to_recordset($1::jsonb) as r (entity text)",
        [JSON.stringify(accounts)],
      );
      await queryAs(
        db.urls.admin,
        `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments)
         select r.id, r.entity, 'email', r.value_fp, r.value_fp, r.value_enc, '{own}' from jsonb_to_recordset($1::jsonb) as r (id text, entity text, value_fp text, value_enc jsonb)`,
        [JSON.stringify(accounts)],
      );
      const span = 3_650 * DAY_MS;
      // Each row's person: a skewed draw, so a few people hold most rows, as a real network does.
      const personOf = (i: string): string =>
        `'ent_budget' || lpad(floor(3000 * power(((${i} * 7919) % 60000) / 60000.0, 2))::int::text, 6, '0')`;
      await queryAs(
        db.urls.admin,
        `insert into vault.evidence_blobs
         select (jsonb_populate_record(null::vault.evidence_blobs, to_jsonb(b) || jsonb_build_object('blob_ref', 'blb_budget_m' || i))).*
         from vault.evidence_blobs b join vault.evidence_items e on e.blob_ref = b.blob_ref, generate_series(1, $2::int) as i where e.id = $1`,
        [mailEvidence, MAILS],
      );
      await queryAs(
        db.urls.admin,
        `insert into vault.evidence_items
         select (jsonb_populate_record(null::vault.evidence_items, to_jsonb(base) || jsonb_build_object('id', 'evd_budget_m' || i, 'source_item_fp', md5('m' || i) || md5('mm' || i),
           'next_revision_id', 'evd_budget_m' || i || ':1', 'blob_ref', 'blb_budget_m' || i))).* from vault.evidence_items base, generate_series(1, $2::int) as i where base.id = $1`,
        [mailEvidence, MAILS],
      );
      await queryAs(
        db.urls.admin,
        `insert into knowledge.messages
         select (jsonb_populate_record(null::knowledge.messages, to_jsonb(base) || jsonb_build_object('id', 'msg_budget' || i, 'evidence_id', 'evd_budget_m' || i,
           'sent_at', to_timestamp($3::float8 / 1000 - (i::float8 / $2::float8) * $4::float8 / 1000),
           'direction', case when i % 2 = 0 then 'outbound' else 'inbound' end,
           'thread_fp', md5(${personOf("i")} || (i / 6)::text) || md5('t' || (i / 6)::text)))).*
         from knowledge.messages base, generate_series(1, $2::int) as i where base.evidence_id = $1`,
        [mailEvidence, MAILS, TODAY.getTime(), span],
      );
      await queryAs(
        db.urls.admin,
        `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
         select 'il-budget' || i, 'evd_budget_m' || i, 'm-owner', ${personOf("i")},
           case when i % 2 = 0 then 'outbound' else 'inbound' end, 'email',
           to_timestamp($1::float8 / 1000 - (i::float8 / $2::float8) * $3::float8 / 1000),
           case when i % 2 = 0 then 'recipient' else 'sender' end, '{own}', '{m-owner}'
         from generate_series(1, $2::int) as i`,
        [TODAY.getTime(), MAILS, span],
      );
      const event =
        (
          await queryAs<{ id: string }>(db.urls.admin, "select id from knowledge.events where evidence_id = $1", [
            meetingEvidence,
          ])
        )[0]?.id ?? "";
      await queryAs(
        db.urls.admin,
        `insert into vault.evidence_blobs
         select (jsonb_populate_record(null::vault.evidence_blobs, to_jsonb(b) || jsonb_build_object('blob_ref', 'blb_budget_e' || i))).*
         from vault.evidence_blobs b join vault.evidence_items e on e.blob_ref = b.blob_ref, generate_series(1, $2::int) as i where e.id = $1`,
        [meetingEvidence, MEETINGS],
      );
      await queryAs(
        db.urls.admin,
        `insert into vault.evidence_items
         select (jsonb_populate_record(null::vault.evidence_items, to_jsonb(base) || jsonb_build_object('id', 'evd_budget_e' || i, 'source_item_fp', md5('e' || i) || md5('ee' || i),
           'next_revision_id', 'evd_budget_e' || i || ':1', 'blob_ref', 'blb_budget_e' || i))).* from vault.evidence_items base, generate_series(1, $2::int) as i where base.id = $1`,
        [meetingEvidence, MEETINGS],
      );
      await queryAs(
        db.urls.admin,
        `insert into knowledge.events
         select (jsonb_populate_record(null::knowledge.events, to_jsonb(base) || jsonb_build_object('id', 'evt_budget' || i, 'evidence_id', 'evd_budget_e' || i))).* from knowledge.events base, generate_series(1, $2::int) as i where base.id = $1`,
        [event, MEETINGS],
      );
      await queryAs(
        db.urls.admin,
        `insert into knowledge.event_details
         select (jsonb_populate_record(null::knowledge.event_details, to_jsonb(base) || jsonb_build_object('event_id', 'evt_budget' || i, 'source_event_fp', md5('s' || i) || md5('ss' || i),
           'starts_at', to_timestamp($3::float8 / 1000 - (i::float8 / $2::float8) * $4::float8 / 1000)))).*
         from knowledge.event_details base, generate_series(1, $2::int) as i where base.event_id = $1`,
        [event, MEETINGS, TODAY.getTime(), span],
      );
      await queryAs(
        db.urls.admin,
        `insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments)
         select 'evt_budget' || i, ${personOf("(i * 10)")}, 'participant', '{own}' from generate_series(1, $1::int) as i`,
        [MEETINGS],
      );
      // 30 000 chat lines beside them, as the participant step writes
      // them (pi_writer), on the same skewed people, each chat one thread, a line each way in turn.
      const CHATS = 30_000;
      await queryAs(
        db.urls.writer,
        `insert into knowledge.chat_lines (id, evidence_id, line, entity_id, direction, occurred_at, others, thread_fp, compartments)
         select 'chl_' || upper(substr(md5('budget chat' || i), 1, 26)), 'evd_budget_m' || (i % ${MAILS} + 1), i, ${personOf("i")},
           case when i % 2 = 0 then 'outbound' else 'inbound' end,
           to_timestamp($1::float8 / 1000 - (i::float8 / $2::float8) * $3::float8 / 1000), 1,
           md5(${personOf("i")}) || md5('chat ' || ${personOf("i")}), '{own}'
         from generate_series(1, $2::int) as i`,
        [TODAY.getTime(), CHATS, span],
      );
      // Statistics, as autovacuum keeps them on a deployed box: as the tables' owner (a runtime role's
      // analyze skips a table it does not own).
      await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        for (const table of [
          "knowledge.chat_lines",
          "vault.evidence_items",
          "knowledge.entities",
          "knowledge.accounts",
          "knowledge.messages",
          "knowledge.interaction_log",
          "knowledge.events",
          "knowledge.event_details",
          "knowledge.event_participants",
        ])
          await query(`analyze ${table}`);
      });

      // The build rebuilds the same days, so it may be timed again: the quickest of up to three is
      // what it takes, whatever else this machine is doing.
      let ms = Number.POSITIVE_INFINITY;
      for (let tries = 0; tries < 3 && ms >= 10_000; tries += 1) {
        const started = Date.now();
        await buildAs(db, OWN);
        ms = Math.min(ms, Date.now() - started);
      }
      const people = (await ranked(db, OWN))?.length ?? 0;
      // The measurement, reported: the build's budget is 10 s on the test database, as asserted below.
      console.info(`warmth budget: ${people} people, ${MAILS + MEETINGS} rows and ${CHATS} chat lines, ${ms} ms`);
      expect(people).toBeGreaterThan(1_000);
      expect(ms).toBeLessThan(10_000);
    }));
});

// An account's address sealed as the writer seals it, under `own`, bound to its row and column.
const sealed = (db: TestDatabase, id: string, address: string): unknown =>
  sealRow(db.keys, "own", { table: "knowledge.accounts", id, column: "value_enc" }, address);
