import type { CardId, CoverageRow, WorkNoticeId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Admin } from "../admin/admin.ts";
import { RUNTIME_ROLES } from "../test-support/catalogue-grants.ts";
import { testId } from "../test-support/clients.ts";
import { session, sqlState } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { withAdminAt as withAdmin } from "../test-support/ruling-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { insertWorkClient } from "../test-support/work-clients.ts";
import { createNotices, setWebhook } from "../work/notices.ts";
import { createDb } from "./job-db.ts";

// The box health cards and what raises them, on synthetic rows: a timed-out run, a failure streak raised
// once and again only after three new failures, the backup reminder after eight days or a day after an
// erasure, a coverage row that entered `silent`, a hold; what `pia status` lists; the sweep hour's answer;
// and pi_admin's widened insert on ledger.job_runs, with each other role's unchanged.

const TIMEOUT = 180_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const cases = async (db: TestDatabase): Promise<string[]> =>
  (
    await queryAs<{ case_key: string }>(
      db.urls.admin,
      "select case_key from ledger.cards where kind = 'box_health' order by created_at, id",
    )
  ).map((row) => row.case_key);
const seen = (db: TestDatabase, now: Date, card: CardId) =>
  withAdmin(db, now, (admin) =>
    admin.cards.decide({ cards: [card], answer: "seen", requestId: testId("req").slice(4) }),
  );

describe("box health", { timeout: TIMEOUT }, () => {
  it("a timed-out run raises one card while it is open; three failed runs of a job raise one streak card, raised again only after three new failures", () =>
    withDatabase(async (db) => {
      const start = new Date(Date.now() - DAY);
      const at = (minutes: number): Date => new Date(start.getTime() + minutes * MINUTE);
      const job = (minutes: number, run: Parameters<Admin["box"]["recordJob"]>[0]) =>
        withAdmin(db, at(minutes), (admin) => admin.box.recordJob(run));

      const [timedOut] = await job(1, {
        job: "sync",
        code: "timed_out",
        startedAt: at(0),
        syncKind: "fast",
        readHold: false,
      });
      expect(timedOut).toMatch(/^crd_/);
      expect(await job(3, { job: "sync", code: "timed_out", startedAt: at(2), syncKind: "full" })).toEqual([]);
      expect(await cases(db)).toEqual(["box:timed_out:sync"]);
      expect(
        await queryAs(db.urls.admin, "select job, sync_kind, read_hold, code from ledger.job_runs order by id"),
      ).toEqual([
        { job: "sync", sync_kind: "fast", read_hold: false, code: "timed_out" },
        { job: "sync", sync_kind: "full", read_hold: false, code: "timed_out" },
      ]);

      // The reasoner: two failures and a success, then three failures.
      expect(await job(10, { job: "reasoner", code: "exit_1", startedAt: at(9) })).toEqual([]);
      expect(await job(11, { job: "reasoner", code: "ok", startedAt: at(10) })).toEqual([]);
      expect(await job(12, { job: "reasoner", code: "exit_1", startedAt: at(11) })).toEqual([]);
      expect(await job(13, { job: "reasoner", code: "exit_2", startedAt: at(12) })).toEqual([]);
      const [streak] = await job(14, { job: "reasoner", code: "exit_1", startedAt: at(13) });
      expect(streak).toMatch(/^crd_/);
      // Still failing, the card open: none more.
      expect(await job(15, { job: "reasoner", code: "exit_1", startedAt: at(14) })).toEqual([]);
      // Seen: the same streak goes on, three runs since the card, but not again until a day after
      // the answer from the owner; then a re-raise of it waits three days after their next.
      await seen(db, at(16), streak as CardId);
      expect(await job(17, { job: "reasoner", code: "exit_1", startedAt: at(17) })).toEqual([]);
      expect(await job(18, { job: "reasoner", code: "exit_1", startedAt: at(18) })).toEqual([]);
      expect(await job(19, { job: "reasoner", code: "exit_1", startedAt: at(19) })).toEqual([]);
      expect(await job(16 + 23 * 60, { job: "reasoner", code: "exit_1", startedAt: at(16 + 23 * 60) })).toEqual([]);
      const [again] = await job(17 + 24 * 60, { job: "reasoner", code: "exit_1", startedAt: at(17 + 24 * 60) });
      expect(again).toMatch(/^crd_/);
      await seen(db, at(18 + 24 * 60), again as CardId);
      for (const hours of [25, 26, 27, 24 + 71])
        expect(
          await job(hours * 60, { job: "reasoner", code: "exit_1", startedAt: at(hours * 60) }),
          `${hours}h`,
        ).toEqual([]);
      expect(
        await job(19 + (24 + 72) * 60, { job: "reasoner", code: "exit_1", startedAt: at(19 + (24 + 72) * 60) }),
      ).toHaveLength(1);
      // A busy or budget run does not fail: the dream's two budget stops and an ok raise nothing.
      for (const [minute, code] of [
        [20, "budget"],
        [21, "busy"],
        [22, "budget"],
      ] as const)
        expect(await job(minute, { job: "dream", code, startedAt: at(minute) })).toEqual([]);
      expect(await cases(db)).toEqual([
        "box:timed_out:sync",
        "box:failure_streak:reasoner",
        "box:failure_streak:reasoner",
        "box:failure_streak:reasoner",
      ]);

      // `pia status` lists the open ones, oldest first, each with its code computed now.
      const status = await withAdmin(db, at(30), (admin) => admin.accounts.status());
      expect(status.boxHealth.map(({ kind, about, code }) => ({ kind, about, code }))).toEqual([
        { kind: "timed_out", about: "sync", code: "timed_out" },
        { kind: "failure_streak", about: "reasoner", code: "exit_1" },
      ]);

      // A streak broken by a run that ended well is a new streak: raised at once, the wait reset.
      const [fresh] = await withAdmin(db, at(30), (admin) => admin.accounts.status()).then((one) =>
        one.boxHealth.filter((row) => row.kind === "failure_streak").map((row) => row.card),
      );
      await seen(db, at(20 + (24 + 72) * 60), fresh as CardId);
      const later = 30 + (24 + 72) * 60;
      expect(await job(later, { job: "reasoner", code: "ok", startedAt: at(later) })).toEqual([]);
      for (const minute of [1, 2])
        expect(await job(later + minute, { job: "reasoner", code: "exit_1", startedAt: at(later + minute) })).toEqual(
          [],
        );
      expect(await job(later + 3, { job: "reasoner", code: "exit_1", startedAt: at(later + 3) })).toHaveLength(1);
    }));

  // A card closes itself when what it told of mended.
  it("a timed-out card closes when its job next ends ok; a hold's when the hold is lifted; the page's when it joins again", () =>
    withDatabase(async (db) => {
      const start = new Date(Date.now() - DAY);
      const at = (minutes: number): Date => new Date(start.getTime() + minutes * MINUTE);
      const open = async (): Promise<string[]> =>
        (await withAdmin(db, at(60), (admin) => admin.accounts.status())).boxHealth.map(
          (row) => `${row.kind}:${row.about}`,
        );

      // The reasoner, recorded by the timer: its next ok run closes the card at once.
      await withAdmin(db, at(1), (admin) =>
        admin.box.recordJob({ job: "reasoner", code: "timed_out", startedAt: at(0) }),
      );
      await withAdmin(db, at(3), (admin) => admin.box.recordJob({ job: "reasoner", code: "exit_1", startedAt: at(2) }));
      expect(await open()).toEqual(["timed_out:reasoner"]);
      await withAdmin(db, at(5), (admin) => admin.box.recordJob({ job: "reasoner", code: "ok", startedAt: at(4) }));
      expect(await open()).toEqual([]);
      const [event] = await queryAs<{ event: string; by: string }>(
        db.urls.admin,
        "select r.event, r.by from ledger.record_events r join ledger.cards c on c.id = r.row_id where r.row_kind = 'card' and c.case_key = 'box:timed_out:reasoner' order by r.id desc limit 1",
      );
      expect(event).toEqual({ event: "withdrawn", by: "system:health" });

      // A sync, which records its own runs: its ok run closes the card at the next coverage record.
      await withAdmin(db, at(11), (admin) =>
        admin.box.recordJob({ job: "sync", code: "timed_out", startedAt: at(10), syncKind: "full" }),
      );
      await queryAs(
        db.urls.writer,
        "insert into ledger.job_runs (job, sync_kind, read_hold, started_at, ended_at, code) values ('sync', 'fast', false, $1, $1, 'ok')",
        [at(12)],
      );
      expect(await open()).toContain("timed_out:sync");
      await withAdmin(db, at(13), (admin) => admin.box.recordCoverage([]));
      expect(await open()).not.toContain("timed_out:sync");

      // A hold lifted, and the page joined again.
      await withAdmin(db, at(20), (admin) => admin.box.recordHold("wake_off"));
      expect(await withAdmin(db, at(21), (admin) => admin.box.recordDashboardDown())).toMatch(/^crd_/);
      expect(await withAdmin(db, at(22), (admin) => admin.box.recordRestarting("notify"))).toMatch(/^crd_/);
      expect(await open()).toEqual(
        expect.arrayContaining(["hold:wake_off", "dashboard_down:tailscale", "restarting:notify"]),
      );
      expect(await withAdmin(db, at(23), (admin) => admin.box.recordHold("wake_off", true))).toMatch(/^crd_/);
      expect(await withAdmin(db, at(24), (admin) => admin.box.recordDashboardDown(true))).toMatch(/^crd_/);
      expect(await withAdmin(db, at(25), (admin) => admin.box.recordDashboardDown(true))).toBeNull();
      expect(await open()).not.toContain("hold:wake_off");
      expect(await open()).not.toContain("dashboard_down:tailscale");
    }));

  // A card forwarded to each agent with an address cleared for it.
  it("a new box health card writes one notice per active agent with an address cleared for it, and the sender reads it while the card is open", () =>
    withDatabase(async (db) => {
      const told = await insertWorkClient(db, "health-told", ["own"]);
      const quiet = await insertWorkClient(db, "health-quiet", ["own"]);
      const narrow = await insertWorkClient(db, "health-narrow", ["employer:example"]);
      await session(db.urls.admin, async (query) => {
        await setWebhook(query, told.name, "https://told.example.org/hook", new Date());
        await setWebhook(query, narrow.name, "https://narrow.example.org/hook", new Date());
      });
      const now = new Date();
      const card = (await withAdmin(db, now, (admin) => admin.box.recordRestarting("wake"))) as CardId;
      expect(await withAdmin(db, now, (admin) => admin.box.recordRestarting("wake"))).toBeNull();
      const rows = await queryAs<{ client_id: string; card_id: string; kind: string; about: string; state: string }>(
        db.urls.admin,
        "select client_id, card_id, kind, about, state from ledger.health_notices",
      );
      expect(rows).toEqual([
        { client_id: told.id, card_id: card, kind: "restarting", about: "wake", state: "pending" },
      ]);
      expect(rows.some((row) => row.client_id === quiet.id || row.client_id === narrow.id)).toBe(false);

      const store = createNotices(db.urls.notify ?? "", recordingLogger().log);
      try {
        const due = await store.due(new Date(Date.now() + 60_000));
        expect(due.map((one) => ({ client: one.client, address: one.address, notice: one.notice }))).toEqual([
          {
            client: told.id,
            address: "https://told.example.org/hook",
            notice: expect.objectContaining({ event: "box_health", card, kind: "restarting", about: "wake" }),
          },
        ]);
        const id = due[0]?.notice.notice as WorkNoticeId;
        expect(await store.current(id)).toBe(true);
        await seen(db, now, card);
        expect(await store.current(id)).toBe(false);
        await store.mark(id, { state: "stale", attempts: 0, lastCode: null, nextTryAt: new Date(), deliveredAt: null });
        expect(await queryAs(db.urls.admin, "select state from ledger.health_notices")).toEqual([{ state: "stale" }]);
      } finally {
        await store.close();
      }
      // No other role writes a notice, nor the admin but through the function.
      expect(
        await sqlState(() =>
          queryAs(
            db.urls.admin,
            "insert into ledger.health_notices (id, client_id, card_id, kind, about) values ($1, $2, $3, 'hold', 'sync_hold')",
            [testId("ntc"), told.id, card],
          ),
        ),
      ).toBe("42501");
      expect(await sqlState(() => queryAs(db.urls.notify ?? "", "select ledger.health_notice($1)", [card]))).toBe(
        "42501",
      );
    }));

  it("the coverage record raises one card per row that entered silent, and the backup reminder after eight days or a day after an erasure", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const accountId = await session(db.urls.admin, (query) => seeder(db, query).sourceAccount(["own"]));
      const silent: CoverageRow = {
        kind: "account",
        id: accountId,
        state: "silent",
        code: "no_success",
        counts: { syncs: 2, ok: 0, added: 0, decided: 0 },
      };
      const record = (when: Date, rows: CoverageRow[]) =>
        withAdmin(db, when, (admin) => admin.box.recordCoverage(rows));

      // No dump ever recorded: the reminder at once, beside the silent row's card.
      await record(now, [silent]);
      expect(await cases(db)).toEqual([`box:silent:account/${accountId}`, "box:backup_due:backup"]);
      // Recorded again: nothing new, though both still hold.
      await record(new Date(now.getTime() + MINUTE), [silent]);
      expect(await cases(db)).toHaveLength(2);
      const status = await withAdmin(db, now, (admin) => admin.accounts.status());
      expect(status.boxHealth.map(({ kind, code }) => ({ kind, code }))).toEqual([
        { kind: "silent", code: "no_success" },
        { kind: "backup_due", code: null },
      ]);
      const backupCard = status.boxHealth.find((row) => row.kind === "backup_due")?.card as CardId;

      // A dump recorded closes the card that asked for it: none for eight days, then one.
      await withAdmin(db, new Date(now.getTime() + 2 * MINUTE), (admin) => admin.box.backupTaken());
      expect(
        await queryAs(
          db.urls.admin,
          "select event, by from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
          [backupCard],
        ),
      ).toEqual([{ event: "withdrawn", by: "system:health" }]);
      expect((await withAdmin(db, now, (admin) => admin.accounts.status())).boxHealth.map((row) => row.kind)).toEqual([
        "silent",
      ]);
      await record(new Date(now.getTime() + 7 * DAY), []);
      expect((await cases(db)).filter((key) => key === "box:backup_due:backup")).toHaveLength(1);
      await record(new Date(now.getTime() + 8 * DAY + 5 * MINUTE), []);
      expect((await cases(db)).filter((key) => key === "box:backup_due:backup")).toHaveLength(2);

      // An erasure after the last dump: due a day after it, with the eight days not passed.
      const late = await withAdmin(db, now, (admin) => admin.accounts.status());
      await seen(
        db,
        now,
        late.boxHealth.find((row) => row.kind === "backup_due" && row.about === "backup")?.card as CardId,
      );
      await withAdmin(db, new Date(now.getTime() + 9 * DAY), (admin) => admin.box.backupTaken());
      const ruling = testId("rul");
      const erased = new Date(now.getTime() + 9 * DAY + MINUTE);
      await queryAs(
        db.urls.admin,
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', $3, '{own}')",
        [ruling, testId("req"), erased],
      );
      await queryAs(
        db.urls.admin,
        "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'item', 1, $3, 0, 0, 0, '{own}')",
        [testId("ers"), ruling, erased],
      );
      await record(new Date(now.getTime() + 9 * DAY + 2 * MINUTE), []);
      expect((await cases(db)).filter((key) => /^box:backup_due:(backup|erasure)$/.test(key))).toHaveLength(2);
      // The card says why it is due: an erasure, where the dump's own age is a day.
      await record(new Date(now.getTime() + 10 * DAY + 2 * MINUTE), []);
      expect((await cases(db)).filter((key) => key === "box:backup_due:backup")).toHaveLength(2);
      expect((await cases(db)).filter((key) => key === "box:backup_due:erasure")).toHaveLength(1);
      const owed = (await withAdmin(db, now, (admin) => admin.accounts.status())).boxHealth.filter(
        (row) => row.kind === "backup_due",
      );
      // Beside the restore test's own reminder, which a dump does not answer.
      expect(owed.map((row) => row.about).sort()).toEqual(["erasure", "restore"]);
      // The dump it asked for closes it too.
      await withAdmin(db, new Date(now.getTime() + 10 * DAY + 3 * MINUTE), (admin) => admin.box.backupTaken());
      expect(
        (await withAdmin(db, now, (admin) => admin.accounts.status())).boxHealth
          .filter((row) => row.kind === "backup_due")
          .map((row) => row.about),
      ).toEqual(["restore"]);
    }));

  it("a silent row's card rests a day after code withdrew it, then is raised while the row is still silent", () =>
    withDatabase(async (db) => {
      const now = new Date();
      await withAdmin(db, now, (admin) => admin.box.backupTaken());
      const silent: CoverageRow = { kind: "job", id: "sync", state: "silent", code: "sync_gap", counts: {} };
      const covered: CoverageRow = { kind: "job", id: "sync", state: "covered", counts: {} };
      const record = (minutes: number, row: CoverageRow) =>
        withAdmin(db, new Date(now.getTime() + minutes * MINUTE), (admin) => admin.box.recordCoverage([row]));
      const cards = async () => (await cases(db)).filter((key) => key === "box:silent:job/sync").length;
      await record(0, silent);
      expect(await cards()).toBe(1);
      // It leaves silent: withdrawn. It comes back within the day: no second card.
      await record(5, covered);
      await record(10, silent);
      await record(15, silent);
      expect(await cards()).toBe(1);
      // Still silent a day after the withdrawal: its card.
      await record(24 * 60 + 6, silent);
      expect(await cards()).toBe(2);
      await record(24 * 60 + 11, silent);
      expect(await cards()).toBe(2);
    }));

  it("with no dump ever recorded, the reminder asks again eight days after its last card, once seen", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const record = (when: Date) => withAdmin(db, when, (admin) => admin.box.recordCoverage([]));
      const open = async (): Promise<CardId | undefined> =>
        (await withAdmin(db, now, (admin) => admin.accounts.status())).boxHealth.find(
          (row) => row.kind === "backup_due",
        )?.card;
      await record(now);
      const first = await open();
      expect(first).toMatch(/^crd_/);
      await seen(db, now, first as CardId);
      await record(new Date(now.getTime() + 7 * DAY));
      expect(await open()).toBeUndefined();
      await record(new Date(now.getTime() + 8 * DAY + MINUTE));
      expect(await open()).toMatch(/^crd_/);
      expect((await cases(db)).filter((key) => key === "box:backup_due:backup")).toHaveLength(2);
    }));

  it("the restore test: asked for once a dump is recorded, not again for a while, a pass stops it and a failure is a card", () =>
    withDatabase(async (db) => {
      const now = new Date("2026-11-05T12:00:00.000Z");
      const restoreCases = async () => (await cases(db)).filter((key) => key === "box:backup_due:restore");
      const recording = (at: Date) =>
        withAdmin(db, at, async (admin) => {
          await admin.box.recordCoverage([]);
        });
      await recording(now);
      expect(await restoreCases()).toEqual([]);
      await withAdmin(db, now, (admin) => admin.box.backupTaken());
      await recording(now);
      await recording(new Date(now.getTime() + DAY));
      expect(await restoreCases()).toHaveLength(1);
      // Its age counts no dump: taking one neither passes nor resets it.
      await withAdmin(db, new Date(now.getTime() + 2 * DAY), async (admin) => {
        await admin.box.backupTaken();
        const open = (await admin.accounts.status()).boxHealth.find((row) => row.about === "restore");
        await seen(db, new Date(now.getTime() + 2 * DAY), open?.card as CardId);
      });
      await recording(new Date(now.getTime() + 8 * DAY));
      expect(await restoreCases()).toHaveLength(2);

      const later = new Date(now.getTime() + 9 * DAY);
      await withAdmin(db, later, (admin) => admin.box.recordRestoreTest(false, later));
      expect(await cases(db)).toContain("box:failure_streak:restore_drill");
      await withAdmin(db, later, async (admin) => {
        expect((await admin.box.outcomes(7)).metrics.find((m) => m.metric === "restore_test_age_days")).toMatchObject({
          value: null,
          code: "last_test_failed",
        });
        // A dump taken after it does not make the failed test's card read as well.
        await admin.box.backupTaken();
        expect((await admin.accounts.status()).boxHealth.find((row) => row.kind === "failure_streak")).toMatchObject({
          about: "restore_drill",
          code: "failed",
        });
        // The capability ledger shows the drill as a job of its own, and the dump's as a dump.
        const ledger = new Map((await admin.box.capabilities()).capabilities.map((row) => [row.id, row]));
        expect(ledger.get("restore_drill")).toMatchObject({ runs: 1, lastStatus: "failed" });
        expect(ledger.get("backup")).toMatchObject({ lastStatus: "ok" });
        expect(await admin.box.openHealthCount()).toBeGreaterThan(0);
        await admin.box.recordRestoreTest(true, later);
        expect((await admin.box.capabilities()).capabilities.find((row) => row.id === "restore_drill")).toMatchObject({
          runs: 2,
          lastStatus: "ok",
        });
        const open = (await admin.accounts.status()).boxHealth;
        expect(open.some((row) => row.kind === "failure_streak")).toBe(false);
        // Nor does the card asking for this test stay.
        expect(open.some((row) => row.about === "restore")).toBe(false);
      });
      // A restore test is no dump: the reminder of a dump still counts from the last taken.
      const [dumped] = await queryAs<{ at: Date }>(
        db.urls.admin,
        "select max(ended_at) as at from ledger.job_runs where job = 'backup' and code = 'ok'",
      );
      expect(dumped?.at.toISOString()).toBe(later.toISOString());
      await recording(new Date(now.getTime() + 17 * DAY));
      expect(await restoreCases()).toHaveLength(2);
      // Due again 35 days after the drill that passed, and not a day before.
      await recording(new Date(later.getTime() + 34 * DAY));
      expect(await restoreCases()).toHaveLength(2);
      await recording(new Date(later.getTime() + 35 * DAY + MINUTE));
      expect(await restoreCases()).toHaveLength(3);
    }));

  it("a hold raises one card while it is open, and the sweep hour and the day are the owner's", () =>
    withDatabase(async (db) => {
      const now = new Date("2026-10-30T15:30:00.000Z");
      expect(await withAdmin(db, now, (admin) => admin.box.recordHold("sync_hold"))).toMatch(/^crd_/);
      expect(await withAdmin(db, now, (admin) => admin.box.recordHold("sync_hold"))).toBeNull();
      expect(await withAdmin(db, now, (admin) => admin.box.recordHold("read_hold"))).toMatch(/^crd_/);
      expect(await cases(db)).toEqual(["box:hold:sync_hold", "box:hold:read_hold"]);
      // The sweep hour, UTC while no zone is set.
      await queryAs(db.urls.admin, "update policy.work_settings set sweep_hour_utc = 16");
      expect(await withAdmin(db, now, (admin) => admin.box.dreamDue())).toEqual({ due: false, day: "2026-10-30" });
      await queryAs(db.urls.admin, "update policy.work_settings set sweep_hour_utc = 15");
      expect(await withAdmin(db, now, (admin) => admin.box.dreamDue())).toEqual({ due: true, day: "2026-10-30" });
      // The owner's zone set: the owner's own hour and day, here the day before UTC's.
      await queryAs(db.urls.admin, "update policy.owner_settings set time_zone = 'America/Chicago'");
      expect(await withAdmin(db, new Date("2026-10-31T02:00:00.000Z"), (admin) => admin.box.dreamDue())).toEqual({
        due: true,
        day: "2026-10-30",
      });
      expect(await withAdmin(db, new Date("2026-10-31T19:00:00.000Z"), (admin) => admin.box.dreamDue())).toEqual({
        due: false,
        day: "2026-10-31",
      });
    }));

  it("a job role's pool ends any one statement past five minutes; an owner command's sets none", () =>
    withDatabase(async (db) => {
      for (const url of [db.urls.work, db.urls.writer, db.urls.pipeline]) {
        const made = createDb(url, recordingLogger().log);
        try {
          expect(await made.query<{ statement_timeout: string }>("show statement_timeout")).toEqual([
            { statement_timeout: "5min" },
          ]);
        } finally {
          await made.close();
        }
      }
      expect(await queryAs(db.urls.admin, "show statement_timeout")).toEqual([{ statement_timeout: "0" }]);
    }));

  it("pi_admin inserts the timer's runs and a timed-out run of any job, never another job's other rows; every other role's insert is unchanged", () =>
    withDatabase(async (db) => {
      const urls: Record<(typeof RUNTIME_ROLES)[number], string> = {
        pi_admin: db.urls.admin,
        pi_writer: db.urls.writer,
        pi_reader: db.urls.reader,
        pi_pipeline: db.urls.pipeline,
        pi_work: db.urls.work,
        pi_proxy: db.urls.proxy,
        pi_restricted: db.urls.restricted,
      };
      const insert = (job: string, code: string) =>
        `insert into ledger.job_runs (job, sync_kind, read_hold, started_at, ended_at, code) values ('${job}', ${job === "sync" ? "'full'" : "null"}, ${job === "sync" ? "false" : "null"}, now(), now(), '${code}')`;
      const allowed = (role: string, job: string, code: string): boolean =>
        (role === "pi_admin" &&
          (["erase_settle", "extract", "dream", "reasoner", "backup"].includes(job) || code === "timed_out")) ||
        (role === "pi_writer" && job === "sync") ||
        (role === "pi_work" && job === "work_tick");
      for (const role of RUNTIME_ROLES) {
        for (const job of ["sync", "erase_settle", "work_tick", "extract", "dream", "reasoner", "backup"]) {
          for (const code of ["ok", "timed_out"]) {
            expect(await sqlState(() => queryAs(urls[role], insert(job, code))), `${role} inserts ${job} ${code}`).toBe(
              allowed(role, job, code) ? null : "42501",
            );
          }
        }
      }
      // A job outside the list is refused by its check, for the one role that could write it.
      expect(await sqlState(() => queryAs(db.urls.admin, insert("notify", "timed_out")))).toBe("23514");
    }));

  // imp_01M6ST6JZ4PW9BWNWVN61DHHMR (d): the night's row keeps the sweep's backlog and what each
  // stage spent; no other job's row carries either, and a row without them keeps nulls.
  it("a night's pass's row keeps its backlog and each stage's spend; no other job's row takes either", () =>
    withDatabase(async (db) => {
      const now = new Date();
      const startedAt = new Date(now.getTime() - MINUTE);
      await withAdmin(db, now, (admin) =>
        admin.box.recordJob({
          job: "dream",
          code: "budget",
          startedAt,
          backlog: 12,
          stageMicroUsd: { recall: 0, fulfils: 4, sweep: 30, source_check: 9, hot_check: 2 },
        }),
      );
      await withAdmin(db, now, (admin) => admin.box.recordJob({ job: "dream", code: "exit_1", startedAt }));
      expect(
        await queryAs(db.urls.admin, "select code, backlog, stage_micro_usd from ledger.job_runs order by id"),
      ).toEqual([
        {
          code: "budget",
          backlog: 12,
          stage_micro_usd: { recall: 0, fulfils: 4, sweep: 30, source_check: 9, hot_check: 2 },
        },
        { code: "exit_1", backlog: null, stage_micro_usd: null },
      ]);
      const row = (job: string, backlog: string, stages: string) =>
        `insert into ledger.job_runs (job, started_at, ended_at, code, backlog, stage_micro_usd) values ('${job}', now(), now(), 'ok', ${backlog}, ${stages})`;
      expect(await sqlState(() => queryAs(db.urls.admin, row("extract", "3", "null")))).toBe("23514");
      expect(await sqlState(() => queryAs(db.urls.admin, row("extract", "null", `'{"sweep":1}'`)))).toBe("23514");
      expect(await sqlState(() => queryAs(db.urls.admin, row("dream", "-1", "null")))).toBe("23514");
      expect(await sqlState(() => queryAs(db.urls.admin, row("dream", "null", "'[1]'")))).toBe("23514");
      expect(await sqlState(() => queryAs(db.urls.admin, row("dream", "0", `'{"sweep":1}'`)))).toBe(null);
    }));
});
