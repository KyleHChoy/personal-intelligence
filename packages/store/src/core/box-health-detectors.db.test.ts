import type { CardId, CoverageRow } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { withAdminAt as withAdmin } from "../test-support/ruling-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { endOwnPool, ownPool } from "./db.ts";

// The box health detectors on synthetic rows: each raises one card while its condition stands and
// withdraws it at the first coverage record that finds the condition ended; and the two older kinds
// that now close by code, a silent row's card and a failure streak's.

const TIMEOUT = 180_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const record = (db: TestDatabase, now: Date, rows: CoverageRow[] = []) =>
  withAdmin(db, now, (admin) => admin.box.recordCoverage(rows));
// The open cards, as `kind:about`.
const open = async (db: TestDatabase, now: Date): Promise<string[]> =>
  (await withAdmin(db, now, (admin) => admin.accounts.status())).boxHealth.map((row) => `${row.kind}:${row.about}`);
const cardOf = async (db: TestDatabase, now: Date, kind: string): Promise<CardId> =>
  (await withAdmin(db, now, (admin) => admin.accounts.status())).boxHealth.find((row) => row.kind === kind)
    ?.card as CardId;
// Every card ever raised under a case key, and the latest event of the newest.
const raised = async (db: TestDatabase, caseKey: string): Promise<{ cards: number; event?: string; by?: string }> => {
  const rows = await queryAs<{ event: string; by: string }>(
    db.urls.admin,
    `select (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as event,
       (select r.by from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as by
     from ledger.cards c where c.case_key = $1 order by c.created_at desc, c.id desc`,
    [caseKey],
  );
  return { cards: rows.length, ...rows[0] };
};
const seen = (db: TestDatabase, now: Date, card: CardId) =>
  withAdmin(db, now, (admin) =>
    admin.cards.decide({ cards: [card], answer: "seen", requestId: testId("req").slice(4) }),
  );
const job = (db: TestDatabase, now: Date, name: "dream" | "reasoner" | "extract", code: string, backlog?: number) =>
  withAdmin(db, now, (admin) =>
    admin.box.recordJob({
      job: name,
      code,
      startedAt: new Date(now.getTime() - MINUTE),
      ...(backlog === undefined ? {} : { backlog }),
    }),
  );

describe("the box health detectors", { timeout: TIMEOUT }, () => {
  it("stores_nothing: an account whose syncs end ok and store nothing for three days, after storing on most days before; withdrawn when it stores again", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const [busy, seldom] = await session(db.urls.admin, async (query) => [
        await seeder(db, query).sourceAccount(["own"]),
        await seeder(db, query).sourceAccount(["own"]),
      ]);
      const sync = (account: string, at: Date, stored: number, code = "ok") =>
        queryAs(
          db.urls.writer,
          "insert into vault.sync_outcomes (account_id, sync_kind, started_at, code, added, stored, held, junk, decided, removed, compartments) values ($1, 'full', $2, $3, $4, $4, 0, 0, $4, 0, '{own}')",
          [account, at, code, stored],
        );
      // The first stored on thirteen of the fourteen days before; the second on two.
      for (let day = 4; day <= 16; day += 1) await sync(busy as string, new Date(now.getTime() - day * DAY), 2);
      for (const day of [5, 9]) await sync(seldom as string, new Date(now.getTime() - day * DAY), 2);
      // Both: four syncs in the last three days, all ok, none storing.
      for (const account of [busy, seldom])
        for (const hours of [70, 48, 24, 1]) await sync(account as string, new Date(now.getTime() - hours * HOUR), 0);

      await record(db, now);
      const about = `account/${busy}`;
      expect((await open(db, now)).filter((one) => one.startsWith("stores_nothing:"))).toEqual([
        `stores_nothing:${about}`,
      ]);
      // Recorded again while it stands: the one card.
      await record(db, new Date(now.getTime() + MINUTE));
      expect(await raised(db, `box:stores_nothing:${about}`)).toMatchObject({ cards: 1, event: "pending" });

      // It stores an item again: the card is withdrawn.
      await sync(busy as string, new Date(now.getTime() + 2 * MINUTE), 1);
      await record(db, new Date(now.getTime() + 3 * MINUTE));
      expect(await raised(db, `box:stores_nothing:${about}`)).toEqual({
        cards: 1,
        event: "withdrawn",
        by: "system:health",
      });
    }));

  it("budget_stops: a job's last three runs all stopped on their budget; seen, not again for a week; withdrawn when a run ends ok", () =>
    withDatabase(async (db) => {
      const start = new Date(Date.now() - 20 * DAY);
      const at = (minutes: number): Date => new Date(start.getTime() + minutes * MINUTE);
      await job(db, at(1), "dream", "budget");
      await job(db, at(2), "dream", "budget");
      await record(db, at(3));
      expect(await open(db, at(3))).not.toContain("budget_stops:dream");
      // A try that found the lock held is no run of the pass.
      await job(db, at(4), "dream", "busy");
      await job(db, at(5), "dream", "budget");
      await record(db, at(6));
      expect(await open(db, at(6))).toContain("budget_stops:dream");

      await seen(db, at(7), await cardOf(db, at(7), "budget_stops"));
      await record(db, at(8));
      await record(db, new Date(at(7).getTime() + 6 * DAY));
      expect(await raised(db, "box:budget_stops:dream")).toMatchObject({ cards: 1, event: "decided" });
      const later = new Date(at(7).getTime() + 7 * DAY + MINUTE);
      await record(db, later);
      expect(await raised(db, "box:budget_stops:dream")).toMatchObject({ cards: 2, event: "pending" });

      await job(db, new Date(later.getTime() + MINUTE), "dream", "ok");
      await record(db, new Date(later.getTime() + 2 * MINUTE));
      expect(await raised(db, "box:budget_stops:dream")).toMatchObject({ cards: 2, event: "withdrawn" });
    }));

  // imp_01M747YJ5NK761XN776VSHN3ME item 8: a job that usually ends on its budget raises no card
  // every night; one whose stops are new, or whose backlog grows, does.
  it("budget_stops: a stop that is only usual stands no longer; one whose backlog grows stands again, and extract's stop with work left stands from the first", () =>
    withDatabase(async (db) => {
      const start = new Date(Date.now() - 40 * DAY);
      const night = (n: number): Date => new Date(start.getTime() + n * DAY);
      // The night's pass ends on its budget every night, its backlog flat.
      for (let n = 0; n < 3; n += 1) await job(db, night(n), "dream", "budget", 30);
      await record(db, night(2));
      expect(await open(db, night(2))).toContain("budget_stops:dream");
      for (let n = 3; n < 20; n += 1) await job(db, night(n), "dream", "budget", 30);
      await record(db, night(19));
      expect(await raised(db, "box:budget_stops:dream")).toMatchObject({ cards: 1, event: "withdrawn" });
      // Three nights of a growing backlog: worse, so it stands again.
      for (const [n, backlog] of [
        [20, 32],
        [21, 35],
        [22, 39],
      ] as const)
        await job(db, night(n), "dream", "budget", backlog);
      await record(db, night(22));
      expect(await raised(db, "box:budget_stops:dream")).toMatchObject({ cards: 2, event: "pending" });
      // It stops growing: withdrawn again, though every run still ends on its budget.
      for (const n of [23, 24, 25]) await job(db, night(n), "dream", "budget", 39);
      await record(db, night(25));
      expect(await raised(db, "box:budget_stops:dream")).toMatchObject({ cards: 2, event: "withdrawn" });

      // Extraction reaching its day's line: a card from its first stop, never an ok run, and withdrawn
      // once a run ends ok. Its row records no backlog, which is told rather than taken as none.
      const day = (n: number, hours: number): Date => new Date(night(n).getTime() + hours * HOUR);
      await job(db, day(26, 1), "extract", "ok");
      await job(db, day(26, 2), "extract", "budget");
      await record(db, day(26, 3));
      expect(await open(db, day(26, 3))).toContain("budget_stops:extract");
      await job(db, day(27, 1), "extract", "ok");
      await record(db, day(27, 1));
      expect(await raised(db, "box:budget_stops:extract")).toMatchObject({ cards: 1, event: "withdrawn" });
      // The next day's stop stands again: a day after the last was withdrawn.
      await job(db, day(28, 2), "extract", "budget");
      await record(db, day(28, 3));
      expect(await raised(db, "box:budget_stops:extract")).toMatchObject({ cards: 2, event: "pending" });
    }));

  it("extract_backlog: fifty items failed over this UTC day and the one before; withdrawn once those days have passed", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const run = (day: Date, failed: number) =>
        queryAs(
          db.urls.admin,
          `insert into vault.extraction_runs (day, code, done, skipped, withheld, failed, waiting, claims, unmapped, unresolved, live_calls,
             beliefs, beliefs_changed, beliefs_mixed, beliefs_failed, beliefs_removed, rebuild_ms, compartments)
           values ($1::timestamptz at time zone 'utc', 'ok', 0, 0, 0, $2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '{own}')`,
          [day, failed],
        );
      await run(new Date(now.getTime() - DAY), 30);
      await run(now, 19);
      await record(db, now);
      expect(await open(db, now)).not.toContain("extract_backlog:extract");
      await run(now, 1);
      await record(db, now);
      expect(await open(db, now)).toContain("extract_backlog:extract");

      await record(db, new Date(now.getTime() + 2 * DAY));
      expect(await raised(db, "box:extract_backlog:extract")).toEqual({
        cards: 1,
        event: "withdrawn",
        by: "system:health",
      });
    }));

  it("extract_backlog: a run under a compartment the card's label does not hold adds nothing to it", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const run = (failed: number, compartments: string[]) =>
        queryAs(
          db.urls.admin,
          `insert into vault.extraction_runs (day, code, done, skipped, withheld, failed, waiting, claims, unmapped, unresolved, live_calls,
             beliefs, beliefs_changed, beliefs_mixed, beliefs_failed, beliefs_removed, rebuild_ms, compartments)
           values ($1::timestamptz at time zone 'utc', 'ok', 0, 0, 0, $2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $3)`,
          [now, failed, compartments],
        );
      // Forty-nine under `own`, and hundreds a reader of the card cannot see.
      await run(49, ["own"]);
      await run(400, ["employer:example"]);
      await run(400, ["employer:example", "own"]);
      await record(db, now);
      expect(await open(db, now)).not.toContain("extract_backlog:extract");
      // Control: one more under `own` raises it.
      await run(1, ["own"]);
      await record(db, now);
      expect(await open(db, now)).toContain("extract_backlog:extract");
    }));

  it("detector_stopped: a daily job with runs recorded and none for three days on a box that ran; one that never ran raises nothing; withdrawn at its next run", () =>
    withDatabase(async (db) => {
      const now = new Date();
      await job(db, new Date(now.getTime() - 3 * DAY + HOUR), "dream", "ok");
      await record(db, now);
      expect((await open(db, now)).filter((one) => one.startsWith("detector_stopped:"))).toEqual([]);

      const late = new Date(now.getTime() + 2 * HOUR);
      // The box was held all that time for all its rows say: silence proves nothing, and nothing is raised.
      await record(db, late);
      expect((await open(db, late)).filter((one) => one.startsWith("detector_stopped:"))).toEqual([]);
      // A settle a day ago: the box ran, and the night's pass did not.
      await withAdmin(db, late, (admin) =>
        admin.box.recordJob({ job: "erase_settle", code: "ok", startedAt: new Date(late.getTime() - DAY) }),
      );
      await record(db, late);
      // The standing check never ran: it was never turned on.
      expect((await open(db, late)).filter((one) => one.startsWith("detector_stopped:"))).toEqual([
        "detector_stopped:dream",
      ]);

      await job(db, new Date(late.getTime() + MINUTE), "dream", "busy");
      await record(db, new Date(late.getTime() + 2 * MINUTE));
      expect(await raised(db, "box:detector_stopped:dream")).toEqual({
        cards: 1,
        event: "withdrawn",
        by: "system:health",
      });
    }));

  it("a silent row's card is withdrawn when the row leaves silent; a failure streak's when a later run ends ok, a failed restore test's aside", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const at = (minutes: number): Date => new Date(now.getTime() + minutes * MINUTE);
      const account = await session(db.urls.admin, (query) => seeder(db, query).sourceAccount(["own"]));
      const row = (state: "silent" | "covered"): CoverageRow => ({
        kind: "account",
        id: account,
        state,
        ...(state === "silent" ? { code: "no_success" } : {}),
        counts: { syncs: 2, ok: state === "silent" ? 0 : 2, added: 0, decided: 0 },
      });
      await record(db, at(0), [row("silent")]);
      expect(await open(db, at(0))).toContain(`silent:account/${account}`);
      await record(db, at(1), [row("covered")]);
      expect(await raised(db, `box:silent:account/${account}`)).toEqual({
        cards: 1,
        event: "withdrawn",
        by: "system:health",
      });

      for (const minute of [2, 3, 4]) await job(db, at(minute), "reasoner", "exit_1");
      expect(await open(db, at(5))).toContain("failure_streak:reasoner");
      // A run that found the lock held mends nothing; one that ended ok closes the card as it is recorded.
      await job(db, at(6), "reasoner", "busy");
      expect(await open(db, at(6))).toContain("failure_streak:reasoner");
      await job(db, at(7), "reasoner", "ok");
      expect(await raised(db, "box:failure_streak:reasoner")).toEqual({
        cards: 1,
        event: "withdrawn",
        by: "system:health",
      });

      // A failed restore drill: a dump recorded after it is no drill, and closes nothing.
      await withAdmin(db, at(10), (admin) => admin.box.recordRestoreTest(false, at(9)));
      await withAdmin(db, at(11), (admin) => admin.box.backupTaken());
      await record(db, at(12));
      expect(await open(db, at(12))).toContain("failure_streak:restore_drill");
    }));

  it("tls_unverified: stands while the admin's connection checks no certificate, as the box's does with no CA; withdrawn at the first record after a CA is set", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const at = (minutes: number): Date => new Date(now.getTime() + minutes * MINUTE);
      // The admin as the box would make it, its connection's TLS given: the test server is local,
      // so what `tlsUnverified` would read from a remote URL is given here.
      const recordAs = async (when: Date, unverified: boolean): Promise<void> => {
        const { log } = recordingLogger();
        const pool = ownPool(db.urls.admin, 2, log);
        try {
          await new Admin({ pool, keys: db.keys, log, now: () => when, tlsUnverified: unverified }).box.recordCoverage(
            [],
          );
        } finally {
          await endOwnPool(pool);
        }
      };
      // A local connection, as createAdmin makes it here: nothing to report.
      await record(db, now);
      expect((await open(db, now)).filter((one) => one.startsWith("tls_unverified:"))).toEqual([]);

      await recordAs(at(1), true);
      expect((await open(db, at(1))).filter((one) => one.startsWith("tls_unverified:"))).toEqual([
        "tls_unverified:database",
      ]);
      // Recorded again while it stands: the one card.
      await recordAs(at(2), true);
      expect(await raised(db, "box:tls_unverified:database")).toMatchObject({ cards: 1, event: "pending" });

      await recordAs(at(3), false);
      expect(await raised(db, "box:tls_unverified:database")).toEqual({
        cards: 1,
        event: "withdrawn",
        by: "system:health",
      });
    }));
});
