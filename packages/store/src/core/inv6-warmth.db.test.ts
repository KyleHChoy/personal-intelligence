import { describe, expect, it } from "vitest";
import { insertClient, sha256Hex, testId } from "../test-support/clients.ts";
import { readAs, session, sqlState } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import {
  buildAs,
  buildRowOf,
  rowsOf,
  runWarmth,
  type WarmthWorld,
  warmthWorld,
} from "../test-support/warmth-fixtures.ts";
import { removeSourceItem } from "../write/writer-item-removal.ts";
import { createDb } from "./job-db.ts";

// Invariant 6 for warmth, kept as days per label and ranked at read: nothing a viewer
// cannot see changes anything the viewer sees. Two clearances, one cleared for a compartment that
// holds mail with a person both see: the other's ranking, tiers and `rebuilding` state are the same
// with and without that mail, and with and without its removal; and a client never reads a day of a
// label outside its clearance, by the policy, not the query.

const TIMEOUT = 180_000;
const DAY_MS = 86_400_000;
const TODAY = new Date("2026-10-22T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(TODAY.getTime() - days * DAY_MS).toISOString();
const OWN = ["own"];
const WORK = ["employer:example"];
const BOTH = ["employer:example", "own"];

async function exchange(world: WarmthWorld, label: string[], person: string, days: number): Promise<string[]> {
  const thread = testId("thr");
  return [
    await world.mail(label, { at: daysAgo(days), to: [person], thread }),
    await world.mail(label, { at: daysAgo(days - 0.1), from: person, thread }),
  ];
}

const run = runWarmth;

// The personal clearance as its client sees it: its ranking, every line of it, and its label's build
// row's days and rebuilding state.
async function seen(db: TestDatabase): Promise<unknown> {
  const build = await buildRowOf(db, OWN);
  return { rows: await rowsOf(db, OWN, TODAY), days: build?.days, removed: build?.removed };
}

// Six people rank under `own`; `shared`, the first, is then also the busiest correspondent under
// `employer:example`, which only the BOTH clearance holds.
async function personalWorld(db: TestDatabase): Promise<{ world: WarmthWorld; shared: string }> {
  const world = warmthWorld(db);
  await insertClient(db, "personal", OWN);
  await insertClient(db, "both", BOTH);
  const people: string[] = [];
  for (let i = 0; i < 6; i += 1) people.push(await world.person(OWN));
  for (const [i, person] of people.entries())
    for (let n = 0; n <= i; n += 1) await exchange(world, OWN, person, 5 + n * 7);
  return { world, shared: people[0] ?? "" };
}

describe("invariant 6: warmth's days and the ranking read from them", { timeout: TIMEOUT }, () => {
  it("one clearance's ranking and state are the same with and without mail under a compartment only the other holds, and with and without its removal", () =>
    withDatabase(async (db) => {
      const { world, shared } = await personalWorld(db);
      await run(db);
      const without = await seen(db);
      expect((without as { rows: unknown[] }).rows).toHaveLength(6);

      const workMail: string[] = [];
      for (const days of [1, 2, 3, 4, 6, 8, 9, 11]) workMail.push(...(await exchange(world, WORK, shared, days)));
      await exchange(world, WORK, await world.person(WORK), 2);
      // Every label's days built again from scratch with the mail present.
      await buildAs(db, BOTH);
      // The other clearance did see it: its shared person's line rests on `employer:example` too.
      expect((await rowsOf(db, BOTH, TODAY))?.find((row) => row.entity_id === shared)?.compartments).toEqual(BOTH);
      expect(await seen(db)).toEqual(without);

      // Its removal empties the employer's label, so the other clearance is rebuilding, and leaves
      // this one as it was, not rebuilding.
      const writer = createDb(db.urls.writer, recordingLogger().log);
      try {
        for (const evidence of workMail) {
          const { account, fp } = await world.source(evidence);
          await writer.transaction((query) => removeSourceItem({ query, keys: db.keys }, account, fp, "deleted"));
        }
      } finally {
        await writer.close();
      }
      expect(await buildRowOf(db, WORK)).toMatchObject({ removed: true });
      expect(await rowsOf(db, BOTH, TODAY)).toBeNull();
      expect(await seen(db)).toEqual(without);
      await run(db);
      expect(await buildRowOf(db, WORK)).toMatchObject({ removed: false });
      expect(await seen(db)).toEqual(without);
    }));

  // The same for chat lines, as the participant step writes them, under a compartment only the
  // other clearance holds.
  it("one clearance's ranking and state are the same with and without chat lines under a compartment only the other holds, and with and without their removal", () =>
    withDatabase(async (db) => {
      const { shared } = await personalWorld(db);
      await run(db);
      const without = await seen(db);
      // A source moment under `employer:example`, with lines each way with the shared person, as the
      // writer's step writes them.
      const evidence = await session(db.urls.admin, (query) => seeder(db, query).evidence(WORK));
      const thread = sha256Hex("inv6 chat thread");
      for (const [line, days] of [1, 2, 3, 4, 6].entries()) {
        for (const direction of ["outbound", "inbound"]) {
          await queryAs(
            db.urls.writer,
            "insert into knowledge.chat_lines (id, evidence_id, line, entity_id, direction, occurred_at, others, thread_fp, compartments) values ($1, $2, $3, $4, $5, $6, 1, $7, $8)",
            [
              `chl_${testId("cli").slice(4)}`,
              evidence,
              line * 2 + (direction === "inbound" ? 1 : 0),
              shared,
              direction,
              daysAgo(days - (direction === "inbound" ? 0.01 : 0)),
              thread,
              WORK,
            ],
          );
        }
      }
      await buildAs(db, BOTH);
      const sharedRow = (await rowsOf(db, BOTH, TODAY))?.find((row) => row.entity_id === shared);
      expect(sharedRow?.compartments).toEqual(BOTH);
      expect(sharedRow?.channels).toEqual(expect.arrayContaining(["chat"]));
      expect(await seen(db)).toEqual(without);

      // Their removal (a forget) empties the employer's label and leaves this clearance as it was.
      const writer = createDb(db.urls.writer, recordingLogger().log);
      try {
        const [row] = await queryAs<{ source_account_id: string; source_item_fp: string }>(
          db.urls.admin,
          "select source_account_id, source_item_fp from vault.evidence_items where id = $1",
          [evidence],
        );
        await writer.transaction((query) =>
          removeSourceItem(
            { query, keys: db.keys },
            { id: row?.source_account_id ?? "", compartment: "employer:example" },
            row?.source_item_fp ?? "",
            "deleted",
          ),
        );
      } finally {
        await writer.close();
      }
      expect(await queryAs(db.urls.admin, "select count(*)::int as n from knowledge.chat_lines")).toEqual([{ n: 0 }]);
      expect(await buildRowOf(db, WORK)).toMatchObject({ removed: true });
      expect(await rowsOf(db, BOTH, TODAY)).toBeNull();
      expect(await seen(db)).toEqual(without);
    }));

  it("a client reads only the days and builds of labels within its clearance, by the policy; pi_work and pi_proxy read nothing", () =>
    withDatabase(async (db) => {
      const world = warmthWorld(db);
      const personal = await insertClient(db, "personal", OWN);
      const both = await insertClient(db, "both", BOTH);
      const work = await insertClient(db, "work", WORK);
      await exchange(world, OWN, await world.person(OWN), 3);
      await exchange(world, WORK, await world.person(WORK), 3);
      await run(db);
      const counts = async (token: string) =>
        readAs(db, token, async (query) => ({
          people: (
            await query<{ compartments: string[]; n: number }>(
              "select compartments, count(distinct entity_id)::int as n from projections.warmth_days group by compartments order by compartments",
            )
          ).map((row) => [row.compartments, row.n]),
          builds: (
            await query<{ compartments: string[] }>(
              "select compartments from projections.warmth_day_builds order by compartments",
            )
          ).map((row) => row.compartments),
        }));
      expect(await counts(personal.token)).toEqual({ people: [[OWN, 1]], builds: [OWN] });
      expect(await counts(both.token)).toEqual({
        people: [
          [WORK, 1],
          [OWN, 1],
        ],
        builds: [WORK, OWN],
      });
      expect(await counts(work.token)).toEqual({ people: [[WORK, 1]], builds: [WORK] });
      // Even a query that names the other label gets nothing back.
      expect(
        await readAs(db, personal.token, (query) =>
          query("select entity_id from projections.warmth_days where compartments = $1::text[]", [WORK]),
        ),
      ).toEqual([]);
      expect(await readAs(db, null, (query) => query("select entity_id from projections.warmth_days"))).toEqual([]);
      for (const url of [db.urls.work, db.urls.proxy]) {
        for (const table of ["projections.warmth_days", "projections.warmth_day_builds"])
          expect(await sqlState(() => queryAs(url, `select count(*) from ${table}`)), `${url} ${table}`).toBe("42501");
      }
    }));
});
