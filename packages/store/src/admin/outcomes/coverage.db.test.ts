import { type AddressInfo, createServer, type Socket } from "node:net";
import { CoverageRow } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { AdminError } from "../../core/admin-error.ts";
import { RUNTIME_ROLES } from "../../test-support/catalogue-grants.ts";
import { insertClient, sha256Hex, testId } from "../../test-support/clients.ts";
import { one, session, sqlState } from "../../test-support/connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "../../test-support/database.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { type LensDevice, seeder } from "../../test-support/seeder.ts";
import { withDatabase, withStore } from "../../test-support/store.ts";
import { type Admin, createAdmin } from "../admin.ts";
import { recordJobRun } from "./coverage.ts";

// By ids and counts, on synthetic rows written in SQL under each table's own role. The window is up
// to now: the admin is given the test's clock, which is the real one.

const TIMEOUT = 180_000;
const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;
const NOW = new Date();
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * MINUTE).toISOString();

type Row = CoverageRow;
type Kind = Row["kind"];

async function withAdmin<T>(db: TestDatabase, fn: (admin: Admin) => Promise<T>): Promise<T> {
  const { log } = recordingLogger();
  const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log, now: () => NOW });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

const coverageOf = (db: TestDatabase, days = 7, generation = 1): Promise<Row[]> =>
  withAdmin(db, (made) => made.box.coverage(days, { generation }));

const stateOf = (rows: Row[], kind: Kind, id: string): string | undefined =>
  rows.find((row) => row.kind === kind && row.id === id)?.state;
const rowOf = (rows: Row[], kind: Kind, id: string): Row | undefined =>
  rows.find((row) => row.kind === kind && row.id === id);

// One committed insert as pi_owner, as the definer functions write the ledger.
async function asOwnerInsert(db: TestDatabase, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await session(db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(
      `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, at) => `$${at + 1}`).join(", ")})`,
      columns.map((column) => row[column]),
    );
  });
}

const admin = (db: TestDatabase, text: string, values?: unknown[]) => queryAs(db.urls.admin, text, values);

// A source account, as the seeder makes it (`google_mail`, under `own`).
const account = (db: TestDatabase): Promise<string> =>
  session(db.urls.admin, (query) => seeder(db, query).sourceAccount(["own"]));
// A Lens device with its clients and accounts.
const device = (db: TestDatabase, name?: string): Promise<LensDevice> =>
  session(db.urls.admin, (query) => seeder(db, query).lensDevice(name === undefined ? {} : { name }));

// One sync's outcome of an account, as recordOutcome writes it, as pi_writer.
type Outcome = {
  minutesAgo: number;
  code?: string;
  added?: number | null;
  decided?: number;
  stored?: number;
  kind?: "full" | "fast";
};
const outcome = (db: TestDatabase, accountId: string, given: Outcome): Promise<unknown> =>
  queryAs(
    db.urls.writer,
    `insert into vault.sync_outcomes (account_id, sync_kind, started_at, code, added, stored, held, junk, decided, removed, compartments)
     values ($1, $2, $3, $4, $5, $6, 0, 0, $7, 0, '{own}')`,
    [
      accountId,
      given.kind ?? "full",
      ago(given.minutesAgo),
      given.code ?? "ok",
      given.added === undefined ? 3 : given.added,
      given.stored ?? given.decided ?? 0,
      given.decided ?? 0,
    ],
  );

// One run of a scheduled job, as the job writes it under its own role.
type Run = {
  job: "sync" | "erase_settle" | "work_tick";
  minutesAgo: number;
  kind?: "full" | "fast";
  readHold?: boolean;
};
const urlOfJob = (db: TestDatabase, job: Run["job"]): string =>
  job === "sync" ? db.urls.writer : job === "work_tick" ? db.urls.work : db.urls.admin;
async function runs(db: TestDatabase, list: Run[]): Promise<void> {
  for (const run of list) {
    const sync = run.job === "sync";
    await queryAs(
      urlOfJob(db, run.job),
      "insert into ledger.job_runs (job, sync_kind, read_hold, started_at, ended_at, code) values ($1, $2, $3, $4, $5, 'ok')",
      [
        run.job,
        sync ? (run.kind ?? "full") : null,
        sync ? (run.readHold ?? false) : null,
        ago(run.minutesAgo),
        ago(run.minutesAgo - 0.5),
      ],
    );
  }
}
// Syncs every `every` minutes from `from` minutes ago down to `to`, each with a settle a minute
// after and a tick two minutes after unless `without` says otherwise for that sync.
function timer(
  from: number,
  to: number,
  every: number,
  without: { settle?: number[]; tick?: number[]; readHold?: number[] } = {},
): Run[] {
  const list: Run[] = [];
  for (let at = from; at >= to; at -= every) {
    const readHold = without.readHold?.includes(at) === true;
    list.push({ job: "sync", minutesAgo: at, readHold });
    if (!(without.settle?.includes(at) ?? false)) list.push({ job: "erase_settle", minutesAgo: at - 1 });
    if (!readHold && !(without.tick?.includes(at) ?? false)) list.push({ job: "work_tick", minutesAgo: at - 2 });
  }
  return list;
}

// What a device pushed: one inbox row of a kind, received at a time, still waiting for the drain or
// taken by it (rows stay after the drain). Written as policy.push_capture writes it, as pi_owner.
let pushes = 0;
async function pushed(
  db: TestDatabase,
  clientId: string,
  kind: "meeting" | "moment" | "block" | "task",
  minutesAgo: number,
  waiting = false,
): Promise<void> {
  pushes += 1;
  const sessionId = testId("ses");
  await asOwnerInsert(db, "ledger.sessions", { id: sessionId, client_id: clientId, compartments: ["own"] });
  const id = testId("cin");
  const at = ago(minutesAgo);
  await asOwnerInsert(db, "ledger.capture_inbox", {
    id,
    client_id: clientId,
    session_id: sessionId,
    batch: `coverage-batch-${pushes}`,
    source_key_fp: sha256Hex(`coverage key ${id}`),
    revision: 0,
    kind,
    content_fp: sha256Hex(`coverage content ${id}`),
    body_bytes: 10,
    received_at: at,
    compartments: ["own"],
    body_enc: waiting ? sealRow(db.keys, "own", { table: "ledger.capture_inbox", id, column: "body_enc" }, "{}") : null,
    evidence_id: waiting ? null : testId("evi"),
    taken_at: waiting ? null : at,
  });
}

// A scope rule admitting `kinds`, by host.
async function scope(db: TestDatabase, host: string, kinds: string[]): Promise<void> {
  const id = testId("csr");
  await admin(
    db,
    "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds) values ($1, 'host', $2, $3, 'own', $4)",
    [
      id,
      fingerprint(db.keys, "capture_scope", host),
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, host),
      kinds,
    ],
  );
}

// The device's lens_tasks account, as `pi lens tasks NAME on` makes it.
const tasksOn = (db: TestDatabase, made: LensDevice): Promise<unknown> =>
  admin(
    db,
    "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, 'lens_tasks', 'owner_task', '{own}')",
    [testId("acc"), `device:${made.name}`],
  );

// A stored moment of a device (the seeder's), due for extraction while it has no status row.
const moment = (db: TestDatabase, made: LensDevice): Promise<{ evidenceId: string }> =>
  session(db.urls.admin, (query) => seeder(db, query).capture(["own"], made));
// Its status row: done in the moment lane at `generation`, `minutesAgo`.
const committed = (db: TestDatabase, evidenceId: string, generation: number, minutesAgo: number): Promise<unknown> =>
  admin(
    db,
    "insert into vault.pipeline_items (evidence_id, waiting, withheld, screened, extractor_generation, updated_at, compartments, facts_enc) values ($1, false, false, true, $2, $3, '{own}', $4)",
    [
      evidenceId,
      generation,
      ago(minutesAgo),
      sealRow(
        db.keys,
        "own",
        { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
        JSON.stringify({
          lane: "moment",
          override: false,
          status: "done",
          attempts: 1,
          claims: 0,
          unmapped: 0,
          unresolved: 0,
        }),
      ),
    ],
  );
// One extraction run's row, with the lanes it had off.
const COUNTS = [
  "done",
  "skipped",
  "withheld",
  "failed",
  "waiting",
  "claims",
  "unmapped",
  "unresolved",
  "live_calls",
  "beliefs",
  "beliefs_changed",
  "beliefs_mixed",
  "beliefs_failed",
  "beliefs_removed",
  "rebuild_ms",
];
const extractionRun = (db: TestDatabase, lanesOff: string[] | null): Promise<unknown> =>
  admin(
    db,
    `insert into vault.extraction_runs (day, code, ${COUNTS.join(", ")}, compartments, lanes_off) values ($1, 'ok', ${COUNTS.map(() => "0").join(", ")}, '{own}', $2)`,
    [NOW.toISOString().slice(0, 10), lanesOff],
  );

describe("coverage", { timeout: TIMEOUT }, () => {
  it("source accounts: added and none decided is silent, decided is covered, the cursor alone is covered, failing syncs are silent, no sync is inactive", () =>
    withDatabase(async (db) => {
      const silentAdded = await account(db);
      const covered = await account(db);
      const cursorOnly = await account(db);
      const failing = await account(db);
      const recovered = await account(db);
      const old = await account(db);
      const never = await account(db);
      // History listed 3 added in each sync and nothing was decided.
      await outcome(db, silentAdded, { minutesAgo: 60, added: 3, decided: 0 });
      await outcome(db, silentAdded, { minutesAgo: 30, added: 3, decided: 0 });
      // The control: the same additions, decided.
      await outcome(db, covered, { minutesAgo: 60, added: 3, decided: 3 });
      // The cursor moved on label and read changes, with no message added: never silent by itself.
      await outcome(db, cursorOnly, { minutesAgo: 60, added: 0, decided: 0 });
      await admin(db, "update vault.source_accounts set cursor_updated_at = $2 where id = $1", [cursorOnly, ago(59)]);
      // Syncs ran and none succeeded; the control, one that did.
      await outcome(db, failing, { minutesAgo: 60, code: "rate_limited", added: null });
      await outcome(db, failing, { minutesAgo: 30, code: "unavailable", added: null });
      await outcome(db, recovered, { minutesAgo: 60, code: "rate_limited", added: null });
      await outcome(db, recovered, { minutesAgo: 30, code: "ok", added: null });
      // A sync before the window only, and none at all.
      await outcome(db, old, { minutesAgo: 10 * DAY_MINUTES, added: 3, decided: 0 });

      const rows = await coverageOf(db);
      expect(stateOf(rows, "account", silentAdded)).toBe("silent");
      expect(stateOf(rows, "account", covered)).toBe("covered");
      expect(stateOf(rows, "account", cursorOnly)).toBe("covered");
      expect(stateOf(rows, "account", failing)).toBe("silent");
      expect(stateOf(rows, "account", recovered)).toBe("covered");
      expect(stateOf(rows, "account", old)).toBe("inactive");
      expect(stateOf(rows, "account", never)).toBe("inactive");
      expect(rowOf(rows, "account", silentAdded)?.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(rows.filter((row) => row.kind === "account").every((row) => row.state !== "not_read")).toBe(true);
      // A longer window reaches the old sync: its additions were not decided either.
      expect(stateOf(await coverageOf(db, 30), "account", old)).toBe("silent");
    }));

  it("Lens devices: an inbox row waiting past two full syncs is silent, past one full sync (fast ones beside) covered, a device that pushed nothing inactive", () =>
    withDatabase(async (db) => {
      const waitedTwo = await device(db);
      const waitedOne = await device(db);
      const taken = await device(db);
      const quiet = await device(db);
      await runs(db, [
        { job: "sync", minutesAgo: 40, kind: "full" },
        { job: "sync", minutesAgo: 30, kind: "fast" },
        { job: "sync", minutesAgo: 15, kind: "fast" },
        { job: "sync", minutesAgo: 10, kind: "full" },
      ]);
      // Two full syncs began after it, and it still waits.
      await pushed(db, waitedTwo.capture.id, "moment", 50, true);
      // One full sync and two fast ones began after it: a fast sync drains nothing.
      await pushed(db, waitedOne.capture.id, "moment", 35, true);
      // Taken by the drain.
      await pushed(db, taken.capture.id, "moment", 50, false);
      // Pushed only before the window.
      await pushed(db, quiet.capture.id, "moment", 10 * DAY_MINUTES, false);

      const rows = await coverageOf(db);
      expect(stateOf(rows, "device", waitedTwo.capture.id)).toBe("silent");
      expect(stateOf(rows, "device", waitedOne.capture.id)).toBe("covered");
      expect(stateOf(rows, "device", taken.capture.id)).toBe("covered");
      expect(stateOf(rows, "device", quiet.capture.id)).toBe("inactive");
    }));

  it("capture classes: silent on three days the device pushed others, covered when it pushed, inactive when the device pushed nothing, not_admitted outside the scope (never meetings) and without a lens_tasks account", () =>
    withDatabase(async (db) => {
      await scope(db, "wiki.example.org", ["moment", "block"]);
      const threeDays = await device(db);
      const pushedBoth = await device(db);
      const twoDays = await device(db);
      const nothing = await device(db);
      // A device that pushed moments on three days and no block on any of them.
      for (const day of [1, 2, 3]) await pushed(db, threeDays.capture.id, "moment", day * DAY_MINUTES + 60);
      // The control: moments on the same three days, and a block on one; with a lens_tasks account
      // and a task on another.
      for (const day of [1, 2, 3]) await pushed(db, pushedBoth.capture.id, "moment", day * DAY_MINUTES + 60);
      await pushed(db, pushedBoth.capture.id, "block", 2 * DAY_MINUTES + 90);
      await tasksOn(db, pushedBoth);
      await pushed(db, pushedBoth.capture.id, "task", DAY_MINUTES + 90);
      // Two days of moments only: under three.
      for (const day of [1, 2]) await pushed(db, twoDays.capture.id, "moment", day * DAY_MINUTES + 60);

      const rows = await coverageOf(db);
      const cls = (made: LensDevice, kind: string): string | undefined =>
        stateOf(rows, "capture_class", `${made.capture.id}:${kind}`);
      expect(cls(threeDays, "block")).toBe("silent");
      expect(cls(threeDays, "moment")).toBe("covered");
      expect(cls(pushedBoth, "block")).toBe("covered");
      expect(cls(pushedBoth, "moment")).toBe("covered");
      expect(cls(twoDays, "block")).not.toBe("silent");
      expect(cls(twoDays, "block")).toBeDefined();
      expect(cls(nothing, "moment")).toBe("inactive");
      expect(cls(nothing, "block")).toBe("inactive");
      // Every meeting is admitted whatever the scope, and days without one are never silent.
      expect(cls(threeDays, "meeting")).toBe("covered");
      expect(cls(pushedBoth, "meeting")).toBe("covered");
      expect(cls(nothing, "meeting")).toBe("inactive");
      // A device with no lens_tasks account has task not_admitted; the control, one that has it.
      expect(rowOf(rows, "capture_class", `${threeDays.capture.id}:task`)).toMatchObject({
        state: "not_read",
        code: "not_admitted",
      });
      expect(cls(pushedBoth, "task")).toBe("covered");
    }));

  it("a device with no lens_tasks account has task not_admitted, and its task class is read once the account is made", () =>
    withDatabase(async (db) => {
      await scope(db, "wiki.example.org", ["moment"]);
      const made = await device(db);
      await pushed(db, made.capture.id, "moment", 60);
      expect(rowOf(await coverageOf(db), "capture_class", `${made.capture.id}:task`)).toMatchObject({
        state: "not_read",
        code: "not_admitted",
      });
      await tasksOn(db, made);
      const after = rowOf(await coverageOf(db), "capture_class", `${made.capture.id}:task`);
      expect(after).toBeDefined();
      expect(after?.state).not.toBe("not_read");
    }));

  it("a device in deny mode has its block class read with no block rule, and a device on allow does not", () =>
    withDatabase(async (db) => {
      await scope(db, "wiki.example.org", ["moment"]);
      const deny = await device(db);
      const allow = await device(db);
      await admin(db, "update policy.lens_devices set browsing = 'deny' where capture_client_id = $1", [
        deny.capture.id,
      ]);
      for (const made of [deny, allow]) await pushed(db, made.capture.id, "block", 60);
      const rows = await coverageOf(db);
      expect(rowOf(rows, "capture_class", `${deny.capture.id}:block`)?.state).toBe("covered");
      expect(rowOf(rows, "capture_class", `${deny.capture.id}:meeting`)?.state).toBe("covered");
      // The control: the same push on a device on allow is not admitted.
      expect(rowOf(rows, "capture_class", `${allow.capture.id}:block`)).toMatchObject({
        state: "not_read",
        code: "not_admitted",
      });
    }));

  it("extraction lanes: due items with no commit are silent, with a commit covered, nothing due inactive", async () => {
    await withDatabase(async (db) => {
      const made = await device(db);
      // A stored moment with no status row: due.
      await moment(db, made);
      const rows = await coverageOf(db, 90);
      expect(stateOf(rows, "lane", "moment")).toBe("silent");
      // Nothing is due in the meeting lane.
      expect(stateOf(rows, "lane", "meeting")).toBe("inactive");
    });
    // The control: one moment due and another committed within the window.
    await withDatabase(async (db) => {
      const made = await device(db);
      await moment(db, made);
      const done = await moment(db, made);
      await committed(db, done.evidenceId, 1, 60);
      await extractionRun(db, []);
      expect(stateOf(await coverageOf(db, 90), "lane", "moment")).toBe("covered");
    });
  });

  it("a lane's due items are counted at the generation coverage is given", () =>
    withDatabase(async (db) => {
      const made = await device(db);
      const done = await moment(db, made);
      await committed(db, done.evidenceId, 1, 60);
      // Done at generation 1: nothing is due at 1, and the item is due again at 2.
      expect(stateOf(await coverageOf(db, 90, 1), "lane", "moment")).toBe("inactive");
      const later = stateOf(await coverageOf(db, 90, 2), "lane", "moment");
      expect(later).toBeDefined();
      expect(later).not.toBe("inactive");
    }));

  it("a lane switched off in the latest extraction run is not_read switched_off, whatever is due; one switched off only earlier is read", () =>
    withDatabase(async (db) => {
      const made = await device(db);
      await moment(db, made);
      await extractionRun(db, ["meeting"]);
      await extractionRun(db, ["moment"]);
      const rows = await coverageOf(db, 90);
      expect(rowOf(rows, "lane", "moment")).toMatchObject({ state: "not_read", code: "switched_off" });
      expect(stateOf(rows, "lane", "meeting")).toBeDefined();
      expect(stateOf(rows, "lane", "meeting")).not.toBe("not_read");
      // Once the latest run has it on, the due moment is silent again.
      await extractionRun(db, []);
      expect(stateOf(await coverageOf(db, 90), "lane", "moment")).toBe("silent");
    }));

  it("scheduled jobs: a timer that ran every ten minutes, a settle and a tick after each, is covered, and a sync under the read hold expects no tick", () =>
    withDatabase(async (db) => {
      // The last sync, five minutes ago, has no settle or tick yet: within its 30 minutes.
      const list = timer(125, 15, 10, { readHold: [65] });
      list.push({ job: "sync", minutesAgo: 5 });
      await runs(db, list);
      const rows = await coverageOf(db);
      expect(stateOf(rows, "job", "sync")).toBe("covered");
      expect(stateOf(rows, "job", "erase_settle")).toBe("covered");
      expect(stateOf(rows, "job", "work_tick")).toBe("covered");
    }));

  it("scheduled jobs: a sync gap that ended over half an hour ago is covered; a settle missing after a sync and a tick missing after one without the read hold are each silent", () =>
    withDatabase(async (db) => {
      // Syncs at 200 to 180 minutes ago, then none for 50 minutes, then every ten minutes to 10.
      // No settle follows the syncs at 100 to 70, and no tick those at 50 to 20.
      await runs(db, [
        ...timer(200, 180, 10),
        ...timer(130, 10, 10, { settle: [100, 90, 80, 70], tick: [50, 40, 30, 20] }),
      ]);
      const rows = await coverageOf(db);
      // The sync is judged by where it stands now: it has run for two hours since the gap.
      expect(stateOf(rows, "job", "sync")).toBe("covered");
      expect(stateOf(rows, "job", "erase_settle")).toBe("silent");
      expect(stateOf(rows, "job", "work_tick")).toBe("silent");
    }));

  it("scheduled jobs: a sync that resumed under half an hour ago after a gap of over 30 minutes is still silent, unless the sync hold's card was raised in the gap", () =>
    withDatabase(async (db) => {
      // Syncs at 200 to 180 minutes ago, none for 155 minutes, then at 25, 15 and 5.
      await runs(db, [...timer(200, 180, 10), ...timer(25, 5, 10)]);
      const judged = rowOf(await coverageOf(db), "job", "sync");
      expect(judged).toMatchObject({ state: "silent", code: "sync_gap" });
      // The gap it was judged by is the outage, not the minutes since the last sync.
      expect(judged?.counts.gap_minutes).toBeGreaterThan(150);
      // The timer raised the hold's card an hour into the gap: the gap is the hold's.
      const { log } = recordingLogger();
      const then = new Date(Date.now() - 100 * 60_000);
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log, now: () => then });
      try {
        expect(await admin.box.recordHold("sync_hold")).toMatch(/^crd_/);
      } finally {
        await admin.close();
      }
      expect(
        await queryAs(
          db.urls.admin,
          "select created_at < now() - interval '99 minutes' as early from ledger.cards where case_key = 'box:hold:sync_hold'",
        ),
      ).toEqual([{ early: true }]);
      expect(stateOf(await coverageOf(db), "job", "sync")).toBe("covered");
    }));

  it("scheduled jobs: a timer that stopped 40 minutes ago is silent up to now, never inactive, and its settles and ticks are covered", () =>
    withDatabase(async (db) => {
      await runs(db, timer(160, 40, 10));
      const rows = await coverageOf(db);
      expect(stateOf(rows, "job", "sync")).toBe("silent");
      expect(stateOf(rows, "job", "erase_settle")).toBe("covered");
      expect(stateOf(rows, "job", "work_tick")).toBe("covered");
    }));

  it("scheduled jobs: syncs all under the read hold with no tick at all leave the tick covered", () =>
    withDatabase(async (db) => {
      const list = timer(125, 5, 10).filter((run) => run.job !== "work_tick");
      await runs(
        db,
        list.map((run) => (run.job === "sync" ? { ...run, readHold: true } : run)),
      );
      const rows = await coverageOf(db);
      expect(stateOf(rows, "job", "sync")).toBe("covered");
      expect(stateOf(rows, "job", "work_tick")).toBe("covered");
    }));

  // The timer starts the settle and the tick when the sync ends, and the
  // next sync after them, so each 30 minutes runs from a sync's end, not its start.
  it("scheduled jobs: syncs of 45 minutes each, each followed by its settle, its tick and the next sync, are covered", () =>
    withDatabase(async (db) => {
      for (let start = 300; start > 50; start -= 48) {
        const end = start - 45;
        await queryAs(
          db.urls.writer,
          "insert into ledger.job_runs (job, sync_kind, read_hold, started_at, ended_at, code) values ('sync', 'full', false, $1, $2, 'ok')",
          [ago(start), ago(end)],
        );
        await queryAs(
          db.urls.admin,
          "insert into ledger.job_runs (job, started_at, ended_at, code) values ('erase_settle', $1, $1, 'ok')",
          [ago(end - 1)],
        );
        await queryAs(
          db.urls.work,
          "insert into ledger.job_runs (job, started_at, ended_at, code) values ('work_tick', $1, $1, 'ok')",
          [ago(end - 2)],
        );
      }
      const rows = await coverageOf(db);
      expect(stateOf(rows, "job", "sync")).toBe("covered");
      expect(stateOf(rows, "job", "erase_settle")).toBe("covered");
      expect(stateOf(rows, "job", "work_tick")).toBe("covered");
    }));

  // A run with no lanes_off (a run of one capture, `pi extract age`) was
  // started from a shell that may not hold the switches, so the newest run that recorded them rules.
  it("a lane switched off by the newest run that recorded its lanes stays switched_off after a run that recorded none", () =>
    withDatabase(async (db) => {
      const made = await device(db);
      await moment(db, made);
      await extractionRun(db, ["moment"]);
      await extractionRun(db, null);
      expect(rowOf(await coverageOf(db, 90), "lane", "moment")).toMatchObject({
        state: "not_read",
        code: "switched_off",
      });
      // The control: a later run that recorded its lanes, with the moment lane on.
      await extractionRun(db, []);
      await extractionRun(db, null);
      expect(stateOf(await coverageOf(db, 90), "lane", "moment")).toBe("silent");
    }));

  it("agent clients: a lease that expired with no report is silent, an unexpired one covered, no call inactive; a job is never inactive, and a box with no runs reads its sync silent", () =>
    withDatabase(async (db) => {
      const expired = await insertClient(db, "coverage-expired", ["own"]);
      const held = await insertClient(db, "coverage-held", ["own"]);
      const idle = await insertClient(db, "coverage-idle", ["own"]);
      for (const client of [expired, held])
        await asOwnerInsert(db, "policy.calls", {
          client_id: client.id,
          tool: "search",
          at: ago(90),
          rows: 1,
          outcome: "ok",
        });
      await asOwnerInsert(db, "queue.leases", {
        resource_kind: "opportunity",
        resource_id: testId("opp"),
        holder: expired.id,
        lease_until: ago(60),
        first_taken_at: ago(120),
      });
      await asOwnerInsert(db, "queue.leases", {
        resource_kind: "opportunity",
        resource_id: testId("opp"),
        holder: held.id,
        lease_until: new Date(NOW.getTime() + 60 * MINUTE).toISOString(),
        first_taken_at: ago(30),
      });
      const rows = await coverageOf(db);
      expect(stateOf(rows, "client", expired.id)).toBe("silent");
      expect(stateOf(rows, "client", held.id)).toBe("covered");
      expect(stateOf(rows, "client", idle.id)).toBe("inactive");
      // No job row was ever written: a stopped timer reads silent, never inactive.
      expect(stateOf(rows, "job", "sync")).toBe("silent");
      const jobs = rows.filter((row) => row.kind === "job");
      expect(jobs.map((row) => row.id).sort()).toEqual(["dream", "erase_settle", "sync", "work_tick"]);
      // The night's pass alone is inactive when the timer tried none.
      expect(jobs.filter((row) => row.state === "inactive").map((row) => row.id)).toEqual(["dream"]);
    }));

  it("the night's pass: covered with an ok or budget run in 36 hours, silent when tried with none, inactive when not tried or the lane is off", () =>
    withDatabase(async (db) => {
      const dreamRun = (minutesAgo: number, code: string) =>
        admin(db, "insert into ledger.job_runs (job, started_at, ended_at, code) values ('dream', $1, $2, $3)", [
          ago(minutesAgo),
          ago(minutesAgo - 1),
          code,
        ]);
      // Only an ok pass 40 hours ago: no try within 36 hours.
      await dreamRun(40 * 60, "ok");
      expect(rowOf(await coverageOf(db), "job", "dream")).toMatchObject({
        state: "inactive",
        counts: { runs: 0, ok: 0 },
      });
      // The lane turned off (the dream hold): the timer records `lane_off` once a day, which is no try.
      await dreamRun(20 * 60, "lane_off");
      await dreamRun(11 * 60, "lane_off");
      expect(rowOf(await coverageOf(db), "job", "dream")).toMatchObject({
        state: "inactive",
        counts: { runs: 0, ok: 0 },
      });
      // Tried twice today, failed and busy: silent.
      await dreamRun(10 * 60, "exit_1");
      await dreamRun(9 * 60, "busy");
      expect(rowOf(await coverageOf(db), "job", "dream")).toMatchObject({
        state: "silent",
        code: "dream_missing",
        counts: { runs: 2, ok: 0 },
      });
      // A pass that stopped at its budget counts.
      await dreamRun(8 * 60, "budget");
      expect(rowOf(await coverageOf(db), "job", "dream")).toMatchObject({
        state: "covered",
        counts: { runs: 3, ok: 1 },
      });
    }));

  it("the answer holds no name, subject, address, title or host: a scan of the JSON for every seeded string", () =>
    withStore(async ({ db, writer }) => {
      const seeded = {
        label: "lighthouse",
        address: "keeper@lighthouse-coverage.test",
        device: "kestrel-coverage-mac",
        client: "coverage-scan-agent",
        host: "wiki.lighthouse-coverage.test",
      };
      const mail = await writer.ensureSourceAccount(seeded.label, "google_mail", "own", seeded.address);
      await outcome(db, mail.id, { minutesAgo: 30, added: 3, decided: 0 });
      const made = await device(db, seeded.device);
      await scope(db, seeded.host, ["moment"]);
      await pushed(db, made.capture.id, "moment", 50, true);
      await moment(db, made);
      const client = await insertClient(db, seeded.client, ["own"]);
      await asOwnerInsert(db, "policy.calls", {
        client_id: client.id,
        tool: "search",
        at: ago(90),
        rows: 1,
        outcome: "ok",
      });
      await runs(db, timer(60, 10, 10));

      const rows = await coverageOf(db, 90);
      // The control: the answer has the rows the scan reads, each of the contract's shape.
      expect(rows.map((row) => row.kind)).toEqual(
        expect.arrayContaining(["account", "device", "capture_class", "lane", "job", "client"]),
      );
      for (const row of rows) expect(CoverageRow.safeParse(row).success, JSON.stringify(row)).toBe(true);
      const text = JSON.stringify(rows);
      for (const [what, value] of Object.entries(seeded)) expect(text.includes(value), what).toBe(false);
      expect(text).not.toContain("@");
      // The scan would see them: the ids it carries are there.
      expect(text).toContain(mail.id);
      expect(text).toContain(made.capture.id);
    }));

  it("refuses a window outside whole days from 1 to 90", () =>
    withDatabase(async (db) => {
      for (const days of [0, 91, 1.5, -1]) {
        await expect(
          withAdmin(db, (made) => made.box.coverage(days, { generation: 1 })),
          String(days),
        ).rejects.toMatchObject({ code: "invalid_argument" });
      }
      await expect(withAdmin(db, (made) => made.box.coverage(0, { generation: 1 }))).rejects.toBeInstanceOf(AdminError);
      // The controls: both ends are taken.
      for (const days of [1, 90]) expect(Array.isArray(await coverageOf(db, days)), String(days)).toBe(true);
    }));
});

describe("recordCoverage: a row that stays silent logs once", { timeout: TIMEOUT }, () => {
  it("a row that stays silent across two records logs once; one that leaves and re-enters logs twice", () =>
    withDatabase(async (db) => {
      const accountId = await account(db);
      const silent: Row = {
        kind: "account",
        id: accountId,
        state: "silent",
        code: "added_not_decided",
        counts: { added: 3, decided: 0 },
      };
      const covered: Row = { kind: "account", id: accountId, state: "covered", counts: { added: 3, decided: 3 } };
      const job: Row = { kind: "job", id: "sync", state: "covered", counts: {} };
      const record = (rows: Row[]) => withAdmin(db, (made) => made.box.recordCoverage(rows));
      const ids = (rows: Row[]) => rows.map((row) => `${row.kind}/${row.id}`);

      expect(ids(await record([silent, job]))).toEqual([`account/${accountId}`]);
      const [first] = await queryAs<{ state: string; since: Date }>(
        db.urls.admin,
        "select state, since from ledger.coverage_states where row_kind = 'account' and row_id = $1",
        [accountId],
      );
      expect(first?.state).toBe("silent");
      // Still silent: nothing logged, and its since kept.
      expect(await record([silent, job])).toEqual([]);
      const [second] = await queryAs<{ state: string; since: Date }>(
        db.urls.admin,
        "select state, since from ledger.coverage_states where row_kind = 'account' and row_id = $1",
        [accountId],
      );
      expect(second).toEqual(first);
      // It leaves silent, and re-enters: logged again.
      expect(await record([covered, job])).toEqual([]);
      expect(
        one(
          await queryAs<{ state: string }>(
            db.urls.admin,
            "select state from ledger.coverage_states where row_kind = 'account' and row_id = $1",
            [accountId],
          ),
        ).state,
      ).toBe("covered");
      expect(ids(await record([silent, job]))).toEqual([`account/${accountId}`]);
      // Each row's state is kept, the job's too.
      expect(
        await queryAs(db.urls.admin, "select row_kind, row_id, state from ledger.coverage_states order by row_kind"),
      ).toEqual([
        { row_kind: "account", row_id: accountId, state: "silent" },
        { row_kind: "job", row_id: "sync", state: "covered" },
      ]);
    }));
});

describe("the coverage tables' writers", { timeout: TIMEOUT }, () => {
  it("recordOutcome writes one sync_outcomes row with a sync's kind and counts, and without counts a row with no kind, no added and zero counts", () =>
    withStore(async ({ db, writer }) => {
      const mail = await writer.ensureSourceAccount("coverage", "google_mail", "own", "owner@coverage-writer.test");
      const at = ago(30);
      await writer.recordOutcome(mail, "ok", at, 0, {
        kind: "fast",
        added: 3,
        stored: 1,
        held: 0,
        junk: 1,
        decided: 3,
        removed: 0,
      });
      await writer.recordOutcome(mail, "reconnect_google", ago(10));
      const rows = await queryAs<Record<string, unknown>>(
        db.urls.admin,
        "select account_id, sync_kind, code, added, stored, held, junk, decided, removed, compartments, started_at = $2::timestamptz as at_given from vault.sync_outcomes where account_id = $1 order by id",
        [mail.id, at],
      );
      expect(rows).toEqual([
        {
          account_id: mail.id,
          sync_kind: "fast",
          code: "ok",
          added: 3,
          stored: 1,
          held: 0,
          junk: 1,
          decided: 3,
          removed: 0,
          compartments: ["own"],
          at_given: true,
        },
        {
          account_id: mail.id,
          sync_kind: null,
          code: "reconnect_google",
          added: null,
          stored: 0,
          held: 0,
          junk: 0,
          decided: 0,
          removed: 0,
          compartments: ["own"],
          at_given: false,
        },
      ]);
      // Beside the update it makes now.
      expect(
        await queryAs(db.urls.admin, "select last_outcome from vault.source_accounts where id = $1", [mail.id]),
      ).toEqual([{ last_outcome: "reconnect_google" }]);
    }));

  it("recordJobRun writes each job's row under the job's own role", () =>
    withDatabase(async (db) => {
      const { log } = recordingLogger();
      await recordJobRun(
        { url: db.urls.writer, log },
        { job: "sync", syncKind: "full", readHold: true, startedAt: ago(10), endedAt: ago(9), code: "ok" },
      );
      await recordJobRun(
        { url: db.urls.writer, log },
        { job: "sync", syncKind: "fast", readHold: false, startedAt: ago(8), endedAt: ago(7), code: "rate_limited" },
      );
      await recordJobRun(
        { url: db.urls.admin, log },
        { job: "erase_settle", startedAt: ago(6), endedAt: ago(5), code: "ok" },
      );
      await recordJobRun(
        { url: db.urls.work, log },
        { job: "work_tick", startedAt: ago(4), endedAt: ago(3), code: "ok" },
      );
      expect(
        await queryAs(db.urls.admin, "select job, sync_kind, read_hold, code from ledger.job_runs order by started_at"),
      ).toEqual([
        { job: "sync", sync_kind: "full", read_hold: true, code: "ok" },
        { job: "sync", sync_kind: "fast", read_hold: false, code: "rate_limited" },
        { job: "erase_settle", sync_kind: null, read_hold: null, code: "ok" },
        { job: "work_tick", sync_kind: null, read_hold: null, code: "ok" },
      ]);
    }));

  // The jobs await the row at their end, so a database that accepts the
  // connection and never answers must not hold the timer for minutes.
  it("recordJobRun gives up within seconds on a database that never answers, as unavailable", async () => {
    const held: Socket[] = [];
    const server = createServer((socket) => void held.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const { log } = recordingLogger();
    const started = Date.now();
    try {
      await expect(
        recordJobRun(
          { url: `postgres://pi_work:local-only@127.0.0.1:${port}/pi_test`, log },
          { job: "work_tick", startedAt: ago(1), endedAt: ago(0), code: "ok" },
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("pi_writer, pi_work, pi_admin and pi_pipeline can each insert only their own job's rows, and no runtime role can update or delete one", () =>
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
      const own: Partial<Record<string, string>> = {
        pi_writer: "sync",
        pi_work: "work_tick",
        pi_admin: "erase_settle",
        pi_pipeline: "time_pass",
      };
      const insert = (job: string) =>
        `insert into ledger.job_runs (job, sync_kind, read_hold, started_at, ended_at, code) values ('${job}', ${job === "sync" ? "'full'" : "null"}, ${job === "sync" ? "false" : "null"}, now(), now(), 'ok')`;
      for (const role of RUNTIME_ROLES) {
        for (const job of ["sync", "erase_settle", "work_tick", "time_pass"]) {
          // The positive control is each role's own job's row.
          expect(await sqlState(() => queryAs(urls[role], insert(job))), `${role} inserts ${job}`).toBe(
            own[role] === job ? null : "42501",
          );
        }
      }
      expect(await queryAs(db.urls.admin, "select job from ledger.job_runs order by job")).toEqual([
        { job: "erase_settle" },
        { job: "sync" },
        { job: "time_pass" },
        { job: "work_tick" },
      ]);

      const accountId = await account(db);
      const outcomeRow = `insert into vault.sync_outcomes (account_id, sync_kind, started_at, code, added, stored, held, junk, decided, removed, compartments) values ('${accountId}', 'full', now(), 'ok', 0, 0, 0, 0, 0, 0, '{own}')`;
      for (const role of RUNTIME_ROLES)
        expect(await sqlState(() => queryAs(urls[role], outcomeRow)), `${role} inserts an outcome`).toBe(
          role === "pi_writer" ? null : "42501",
        );

      // No runtime role updates or deletes a run or an outcome, a row there or not.
      for (const role of RUNTIME_ROLES) {
        for (const sql of [
          "update ledger.job_runs set code = code",
          "delete from ledger.job_runs",
          "update ledger.job_runs set code = code where false",
          "delete from ledger.job_runs where false",
          "update vault.sync_outcomes set code = code",
          "delete from vault.sync_outcomes",
        ]) {
          expect(await sqlState(() => queryAs(urls[role], sql)), `${role}: ${sql}`).toBe("42501");
        }
      }
      expect(await queryAs(db.urls.admin, "select count(*)::int as n from ledger.job_runs")).toEqual([{ n: 4 }]);
      expect(await queryAs(db.urls.admin, "select count(*)::int as n from vault.sync_outcomes")).toEqual([{ n: 1 }]);
      // The control for the reads: pi_admin selects both; pi_pipeline reads its own job's rows, in three
      // columns; no other runtime role reads a run.
      expect(await queryAs(urls.pi_pipeline, "select job from ledger.job_runs")).toEqual([{ job: "time_pass" }]);
      expect(await sqlState(() => queryAs(urls.pi_pipeline, "select about from ledger.job_runs"))).toBe("42501");
      for (const role of RUNTIME_ROLES) {
        expect(
          await sqlState(() => queryAs(urls[role], "select count(*) from ledger.job_runs")),
          `${role} reads runs`,
        ).toBe(role === "pi_admin" || role === "pi_pipeline" ? null : "42501");
        expect(
          await sqlState(() => queryAs(urls[role], "select count(*) from vault.sync_outcomes")),
          `${role} reads outcomes`,
        ).toBe(role === "pi_admin" ? null : "42501");
      }
    }));

  it("pi_admin alone keeps the coverage states: it selects, inserts and updates state, code and since, and nothing else", () =>
    withDatabase(async (db) => {
      const insert =
        "insert into ledger.coverage_states (row_kind, row_id, state, code, since) values ('job', 'sync', 'silent', 'sync_gap', now())";
      expect(await sqlState(() => queryAs(db.urls.admin, insert))).toBeNull();
      expect(
        await sqlState(() =>
          queryAs(db.urls.admin, "update ledger.coverage_states set state = 'covered', code = null, since = now()"),
        ),
      ).toBeNull();
      expect(await sqlState(() => queryAs(db.urls.admin, "select state from ledger.coverage_states"))).toBeNull();
      expect(
        await sqlState(() => queryAs(db.urls.admin, "update ledger.coverage_states set row_id = 'work_tick'")),
      ).toBe("42501");
      expect(await sqlState(() => queryAs(db.urls.admin, "delete from ledger.coverage_states"))).toBe("42501");
      for (const url of [
        db.urls.writer,
        db.urls.reader,
        db.urls.pipeline,
        db.urls.work,
        db.urls.proxy,
        db.urls.restricted,
      ]) {
        expect(await sqlState(() => queryAs(url, "select count(*) from ledger.coverage_states")), url).toBe("42501");
        expect(await sqlState(() => queryAs(url, insert.replace("'sync'", "'work_tick'"))), url).toBe("42501");
      }
      expect(await queryAs(db.urls.admin, "select row_kind, row_id, state from ledger.coverage_states")).toEqual([
        { row_kind: "job", row_id: "sync", state: "covered" },
      ]);
    }));
});
